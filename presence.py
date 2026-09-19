#!/usr/bin/env python3
"""Presence detection job for the SONOFF iHost.

Runs as a one-shot job (scheduled every minute via cron in the container).
Loads configuration and the previous presence state from a SQLite database,
scans the LAN, detects transitions (device_present / device_away /
anyone_home / anyone_away) and notifies via webhook and/or VoiceMonkey.
No HTTP server is started.
"""
import ipaddress
import json
import logging
import os
import re
import sqlite3
import subprocess
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

LOG = logging.getLogger("presence")
IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
MAC_RE = re.compile(r"^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$", re.IGNORECASE)
SKIP_IFACE_PREFIXES = ("docker", "veth", "br-", "virbr", "lo")


def getenv(name, default=None):
    value = os.environ.get(name)
    return value if value not in (None, "") else default


VM_API = "https://api-v3.voicemonkey.io/announce"
DB_PATH = getenv("DB_PATH", "/app/data/presence.db")
ARP_SCAN_BIN = getenv("ARP_SCAN_BIN", "arp-scan")
PING_TIMEOUT = getenv("PING_TIMEOUT", "1")
MAX_HOSTS = int(getenv("MAX_HOSTS", "1024"))


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


def db_connect():
    return sqlite3.connect(DB_PATH, timeout=10)


def ensure_schema(conn):
    conn.executescript(
        """
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mac  TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS voicemonkey (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  enabled   INTEGER NOT NULL DEFAULT 0,
  api_key   TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  message   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS presence (
  mac       TEXT PRIMARY KEY,
  present   INTEGER NOT NULL DEFAULT 0,
  last_seen REAL,
  ip        TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""
    )
    conn.commit()


def load_devices(conn):
    rows = conn.execute("SELECT name, mac FROM devices ORDER BY id").fetchall()
    return [(row[0], normalize_mac(row[1])) for row in rows]


def load_setting(conn, key):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def load_vm(conn):
    row = conn.execute(
        "SELECT enabled, api_key, device_id, message FROM voicemonkey WHERE id = 1"
    ).fetchone()
    if not row:
        return {}
    return {
        "enabled": bool(row[0]),
        "api_key": row[1] or "",
        "device_id": row[2] or "",
        "message": row[3] or "",
    }


def load_presence(conn):
    state = {}
    for row in conn.execute("SELECT mac, present, last_seen, ip FROM presence"):
        state[row[0]] = {"present": bool(row[1]), "last_seen": row[2], "ip": row[3]}
    return state


def load_anyone(conn):
    row = conn.execute("SELECT value FROM meta WHERE key = 'anyone_home'").fetchone()
    return row is not None and row[0] == "1"


def save_presence(conn, devices):
    for device in devices:
        conn.execute(
            "INSERT INTO presence(mac, present, last_seen, ip) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(mac) DO UPDATE SET present = excluded.present, "
            "last_seen = excluded.last_seen, ip = excluded.ip",
            (device.mac, int(device.present), device.last_seen, device.ip),
        )


def save_anyone(conn, value):
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('anyone_home', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ("1" if value else "0",),
    )


def save_last_job_run(conn, value):
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('last_job_run', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (value,),
    )


def list_ifaces(configured):
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

    if configured:
        selected = [entry for entry in entries if entry[0] in configured]
        return selected or [(name, None, None) for name in configured]

    selected = [
        entry for entry in entries
        if not entry[0].startswith(SKIP_IFACE_PREFIXES)
    ]
    return selected or [(None, None, None)]


def scan_network(ip, cidr, scan_prefix):
    if not ip or not cidr:
        return None
    network = ipaddress.ip_network(cidr, strict=False)
    if network.prefixlen < scan_prefix:
        network = ipaddress.ip_network("%s/%s" % (ip, scan_prefix), strict=False)
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


def scan_once(configured_ifaces, scan_prefix):
    seen = {}
    for iface, ip, cidr in list_ifaces(configured_ifaces):
        network = scan_network(ip, cidr, scan_prefix)
        if not network:
            continue
        try:
            seen.update(arp_scan(iface, network))
        except Exception as exc:
            LOG.warning("arp-scan failed on %s (%s), falling back to ping sweep", iface, exc)
            seen.update(ping_sweep(iface, network))
    return seen


def emit_webhook(webhook_url, event, device=None):
    payload = {"event": event, "ts": now_iso()}
    if device:
        payload["device_name"] = device.name
        payload["mac"] = device.mac
        payload["ip"] = device.ip
        payload["status"] = "online" if device.present else "offline"
    LOG.info("webhook event %s", json.dumps(payload))
    if not webhook_url:
        return
    try:
        request = urllib.request.Request(
            webhook_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(request, timeout=5).close()
    except Exception as exc:
        LOG.warning("webhook call failed: %s", exc)


def send_voicemonkey(vm, device):
    if not vm.get("enabled"):
        return
    api_key = vm.get("api_key", "").strip()
    device_id = vm.get("device_id", "").strip()
    message = vm.get("message", "").strip()
    if not (api_key and device_id and message):
        LOG.warning("voicemonkey enabled but missing api_key/device_id/message")
        return
    speech = message.replace("{device_name}", device.name)
    payload = json.dumps(
        {"token": api_key, "device": device_id, "speech": speech}
    ).encode("utf-8")
    try:
        request = urllib.request.Request(
            VM_API,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(request, timeout=10).close()
        LOG.info("voicemonkey announce sent for device %s", device.name)
    except Exception as exc:
        LOG.warning("voicemonkey announce failed: %s", exc)


class Device:
    def __init__(self, name, mac, present=False, last_seen=None, ip=None):
        self.name = name
        self.mac = mac
        self.present = present
        self.last_seen = last_seen
        self.ip = ip


def run_once():
    load_env_file(getenv("ENV_FILE", "/app/data/.env"))

    conn = db_connect()
    ensure_schema(conn)

    try:
        configured = load_devices(conn)
        devices = configured if configured else parse_devices()
        if not devices:
            LOG.error(
                "no devices configured: open the settings UI (port %s) or set DEVICES in .env",
                getenv("SETTINGS_PORT", "8082"),
            )
            return 1

        grace = int(load_setting(conn, "grace") or getenv("GRACE", "180"))
        ifaces = [item.strip() for item in (load_setting(conn, "ifaces") or "").split(",") if item.strip()]
        webhook_url = load_setting(conn, "webhook_url") or getenv("WEBHOOK_URL")
        scan_prefix = int(load_setting(conn, "scan_prefix") or getenv("SCAN_PREFIX", "24"))
        vm = load_vm(conn)

        prev_state = load_presence(conn)
        prev_anyone = load_anyone(conn)

        device_objs = []
        for name, mac in devices:
            prev = prev_state.get(mac, {})
            device_objs.append(
                Device(
                    name,
                    mac,
                    present=prev.get("present", False),
                    last_seen=prev.get("last_seen"),
                    ip=prev.get("ip"),
                )
            )

        LOG.info(
            "starting scan: devices=%s ifaces=%s scan_prefix=%s",
            [(d.name, d.mac) for d in device_objs], ifaces or "auto", scan_prefix,
        )

        seen = scan_once(ifaces, scan_prefix)
        LOG.info("scan found %d devices on LAN", len(seen))

        now = time.time()
        arrived = None
        for device in device_objs:
            ip = seen.get(device.mac)
            if ip:
                device.ip = ip
                device.last_seen = now
                if not device.present:
                    device.present = True
                    emit_webhook(webhook_url, "device_present", device)
                    if arrived is None:
                        arrived = device
            elif device.present and (device.last_seen is None or now - device.last_seen > grace):
                device.present = False
                emit_webhook(webhook_url, "device_away", device)

        anyone = any(device.present for device in device_objs)
        if anyone != prev_anyone:
            emit_webhook(webhook_url, "anyone_home" if anyone else "anyone_away")
            if anyone and arrived is not None:
                send_voicemonkey(vm, arrived)
            save_anyone(conn, anyone)

        save_presence(conn, device_objs)
        save_last_job_run(conn, now_iso())
        conn.commit()
        LOG.info(
            "done: anyone_home=%s grace=%ss",
            anyone, grace,
        )
        return 0
    finally:
        conn.close()


def main():
    logging.basicConfig(
        level=getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    return run_once()


if __name__ == "__main__":
    raise SystemExit(main())