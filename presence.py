#!/usr/bin/env python3
import ipaddress
import json
import logging
import os
import re
import signal
import subprocess
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = logging.getLogger("presence")
STOP = threading.Event()
IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
MAC_RE = re.compile(r"^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$", re.IGNORECASE)
SKIP_IFACE_PREFIXES = ("docker", "veth", "br-", "virbr", "lo")

PRESENCE = None
SCANNING = threading.Event()
LAST_SCAN = {"t": 0.0, "duration": None, "devices": 0}
SCAN_LOCK = threading.Lock()


def getenv(name, default=None):
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def load_env_file(path):
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        LOG.info("loaded env file %s", path)
        return True
    except OSError:
        LOG.info("no env file at %s, using environment variables", path)
        return False


def normalize_mac(value):
    mac = value.strip().lower().replace("-", ":").replace(".", ":")
    if ":" not in mac and len(mac) == 12:
        mac = ":".join(mac[i:i + 2] for i in range(0, 12, 2))
    return mac


def parse_devices():
    devices = []
    raw = getenv("DEVICES")
    if raw:
        for item in raw.split(","):
            item = item.strip()
            if not item:
                continue
            if ":" in item:
                name, mac = item.split(":", 1)
            else:
                name, mac = item, item
            devices.append((name.strip(), normalize_mac(mac)))
        return devices

    names = [item.strip() for item in getenv("DEVICE_NAMES", "").split(",") if item.strip()]
    macs = [normalize_mac(item) for item in getenv("TARGET_MACS", "").split(",") if item.strip()]
    for index, mac in enumerate(macs):
        name = names[index] if index < len(names) else mac
        devices.append((name, mac))
    return devices


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def timestamp_iso(value):
    if not value:
        return None
    return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds")


load_env_file(getenv("ENV_FILE", "/app/data/.env"))

DEVICES = parse_devices()
INTERVAL = int(getenv("INTERVAL", "30"))
GRACE = int(getenv("GRACE", "180"))
PORT = int(getenv("PORT", "8081"))
IFACES = [item.strip() for item in getenv("IFACES", "").split(",") if item.strip()]
WEBHOOK_URL = getenv("WEBHOOK_URL")
STATE_FILE = getenv("STATE_FILE", "/app/data/state.json")
ARP_SCAN_BIN = getenv("ARP_SCAN_BIN", "arp-scan")
PING_TIMEOUT = getenv("PING_TIMEOUT", "1")
MAX_HOSTS = int(getenv("MAX_HOSTS", "1024"))
SCAN_COOLDOWN = int(getenv("SCAN_COOLDOWN", "5"))
SCAN_PREFIX = int(getenv("SCAN_PREFIX", "24"))


def list_ifaces():
    entries = []
    try:
        result = subprocess.run(
            ["ip", "-o", "-4", "addr", "show", "scope", "global"],
            capture_output=True, text=True, timeout=10,
        )
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 4 and "/" in parts[3]:
                ip = parts[3].partition("/")[0]
                entries.append((parts[1], ip, parts[3]))
    except (OSError, subprocess.SubprocessError) as exc:
        LOG.warning("cannot list interfaces with ip: %s", exc)

    if IFACES:
        selected = [entry for entry in entries if entry[0] in IFACES]
        return selected or [(name, None, None) for name in IFACES]

    selected = [
        entry for entry in entries
        if not entry[0].startswith(SKIP_IFACE_PREFIXES)
    ]
    return selected or [(None, None, None)]


def scan_network(ip, cidr):
    if not ip or not cidr:
        return None
    network = ipaddress.ip_network(cidr, strict=False)
    if network.prefixlen < SCAN_PREFIX:
        network = ipaddress.ip_network("%s/%s" % (ip, SCAN_PREFIX), strict=False)
    return network


def arp_scan(iface, network):
    cmd = [ARP_SCAN_BIN, "--plain", "--retry=1", "--timeout=100", "--ignoredups"]
    if iface:
        cmd.insert(1, "--interface=%s" % iface)
    cmd.append(str(network))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "exit code %s" % result.returncode)
    devices = {}
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and IP_RE.match(parts[0]) and MAC_RE.match(parts[1]):
            devices[normalize_mac(parts[1])] = parts[0]
    return devices


def read_arp_table(iface):
    devices = {}
    try:
        with open("/proc/net/arp", encoding="utf-8") as handle:
            next(handle, None)
            for line in handle:
                parts = line.split()
                if len(parts) >= 6 and parts[2] == "0x2" and parts[5] == iface:
                    devices[normalize_mac(parts[3])] = parts[0]
    except OSError as exc:
        LOG.warning("cannot read /proc/net/arp: %s", exc)
    return devices


def ping_sweep(iface, network):
    hosts = list(network.hosts())[:MAX_HOSTS]

    def ping(host):
        subprocess.run(
            ["ping", "-c", "1", "-W", PING_TIMEOUT, str(host)],
            capture_output=True,
        )

    with ThreadPoolExecutor(max_workers=64) as pool:
        list(pool.map(ping, hosts))
    return read_arp_table(iface)


def scan_once():
    seen = {}
    for iface, ip, cidr in list_ifaces():
        network = scan_network(ip, cidr)
        if not network:
            continue
        try:
            seen.update(arp_scan(iface, network))
        except Exception as exc:
            LOG.warning("arp-scan failed on %s (%s), falling back to ping sweep", iface, exc)
            seen.update(ping_sweep(iface, network))
    return seen


def run_scan():
    if SCANNING.is_set():
        return None
    SCANNING.set()
    try:
        started = time.time()
        seen = scan_once()
        with SCAN_LOCK:
            LAST_SCAN["t"] = time.time()
            LAST_SCAN["duration"] = int((time.time() - started) * 1000)
            LAST_SCAN["devices"] = len(seen)
        return seen
    finally:
        SCANNING.clear()


def refresh_if_stale():
    with SCAN_LOCK:
        stale = time.time() - LAST_SCAN["t"] >= SCAN_COOLDOWN
    if not stale:
        return
    seen = run_scan()
    if seen is not None:
        PRESENCE.update(seen)
        write_state(PRESENCE)


def emit(event, device=None):
    payload = {"event": event, "ts": now_iso()}
    if device:
        payload["device_name"] = device.name
        payload["mac"] = device.mac
        payload["ip"] = device.ip
    LOG.info("event %s", json.dumps(payload))
    if not WEBHOOK_URL:
        return
    try:
        request = urllib.request.Request(
            WEBHOOK_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(request, timeout=5).close()
    except Exception as exc:
        LOG.warning("webhook call failed: %s", exc)


class Device:
    def __init__(self, name, mac):
        self.name = name
        self.mac = mac
        self.present = False
        self.last_seen = None
        self.ip = None


class Presence:
    def __init__(self, devices):
        self.devices = devices
        self.anyone_home = False

    def update(self, seen):
        now = time.time()
        for device in self.devices:
            ip = seen.get(device.mac)
            if ip:
                device.ip = ip
                device.last_seen = now
                if not device.present:
                    device.present = True
                    emit("device_present", device)
            elif device.present and now - device.last_seen > GRACE:
                device.present = False
                emit("device_away", device)

        anyone = any(device.present for device in self.devices)
        if anyone != self.anyone_home:
            self.anyone_home = anyone
            emit("anyone_home" if anyone else "anyone_away")

    def status_list(self):
        return [
            {
                "device_name": device.name,
                "status": "online" if device.present else "offline",
                "mac": device.mac,
                "ip": device.ip,
            }
            for device in self.devices
        ]

    def snapshot(self):
        with SCAN_LOCK:
            last_scan_ms = LAST_SCAN["duration"]
        return {
            "anyone_home": self.anyone_home,
            "updated": now_iso(),
            "last_scan_ms": last_scan_ms,
            "devices": [
                {
                    "device_name": device.name,
                    "mac": device.mac,
                    "present": device.present,
                    "ip": device.ip,
                    "last_seen": timestamp_iso(device.last_seen),
                }
                for device in self.devices
            ],
        }


def error_payload():
    if not ENV_FILE_LOADED:
        return {"error": {"message": ".env file required"}}
    return {"error": {"message": "no devices configured in .env"}}


class StatusHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            payload = json.dumps({"status": "ok"}).encode("utf-8")
            code = 200
        elif self.path == "/debug":
            with SCAN_LOCK:
                last_scan_ms = LAST_SCAN["duration"]
                last_scan_devices = LAST_SCAN["devices"]
            payload = json.dumps(
                {
                    "ifaces": [[entry[0], entry[1], entry[2]] for entry in list_ifaces()],
                    "last_scan_ms": last_scan_ms,
                    "last_scan_devices": last_scan_devices,
                    "devices_configured": len(PRESENCE.devices) if PRESENCE else 0,
                    "cooldown_s": SCAN_COOLDOWN,
                }
            ).encode("utf-8")
            code = 200
        elif not PRESENCE or not PRESENCE.devices:
            payload = json.dumps(error_payload()).encode("utf-8")
            code = 400
        else:
            refresh_if_stale()
            payload = json.dumps(PRESENCE.status_list()).encode("utf-8")
            code = 200
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        LOG.debug("http %s", fmt % args)


def start_server(presence):
    global PRESENCE
    PRESENCE = presence
    server = ThreadingHTTPServer(("0.0.0.0", PORT), StatusHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    LOG.info("http server listening on 0.0.0.0:%s", PORT)
    return server


def write_state(presence):
    if not STATE_FILE:
        return
    try:
        directory = os.path.dirname(STATE_FILE)
        if directory:
            os.makedirs(directory, exist_ok=True)
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(presence.snapshot(), handle, indent=2)
        os.replace(tmp, STATE_FILE)
    except OSError as exc:
        LOG.warning("cannot write state file: %s", exc)


def request_stop(signum, frame):
    LOG.info("signal %s received, stopping", signum)
    STOP.set()


def main():
    logging.basicConfig(
        level=getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    LOG.info(
        "starting: devices=%s interval=%ss grace=%ss port=%s ifaces=%s scan_prefix=%s",
        DEVICES, INTERVAL, GRACE, PORT, IFACES or "auto", SCAN_PREFIX,
    )

    presence = Presence([Device(name, mac) for name, mac in DEVICES])
    server = start_server(presence)
    config_warning_logged = False
    try:
        while not STOP.is_set():
            if DEVICES:
                seen = run_scan()
                if seen is not None:
                    presence.update(seen)
                    LOG.info(
                        "scan: %d devices on LAN, anyone_home=%s (%d ms)",
                        len(seen), presence.anyone_home, LAST_SCAN["duration"],
                    )
                    write_state(presence)
            elif not config_warning_logged:
                LOG.error(
                    "no devices configured: mount a .env file at %s with DEVICES=name:mac,...",
                    ENV_FILE,
                )
                config_warning_logged = True
            STOP.wait(INTERVAL * 2 if not DEVICES else INTERVAL)
    finally:
        server.shutdown()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())