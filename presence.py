#!/usr/bin/env python3
"""Presence detection job for the SONOFF iHost.

Runs as a one-shot job (scheduled every minute via cron in the container).
Loads configuration and the previous presence state from a SQLite database,
combines active scans (arp-scan + nmap in parallel, plus directed unicast
probes) with passive sightings recorded by the sniffer daemon (sniffer.py),
detects transitions (device_present / device_away / anyone_home /
anyone_away) and notifies via webhook and/or VoiceMonkey.
A device only goes away after AWAY_CONFIRMATIONS consecutive cycles without
any signal (active or passive). No HTTP server is started.
"""
import fcntl
import ipaddress
import json
import logging
import os
import re
import sqlite3
import subprocess
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

LOG = logging.getLogger("presence")
IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
MAC_RE = re.compile(r"^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$", re.IGNORECASE)
SKIP_IFACE_PREFIXES = ("docker", "veth", "br-", "virbr", "lo", "dummy")


def setting_bool(*values):
    """Return the first boolean-like interpretation of the given values."""
    for value in values:
        if value is None:
            continue
        return str(value).strip().lower() in ("1", "true", "yes", "on")
    return False


def getenv(name, default=None):
    value = os.environ.get(name)
    return value if value not in (None, "") else default


VM_API = "https://api-v3.voicemonkey.io/announce"
VM_VOICE = "Lucia"
# Cloudflare bloquea el user-agent por defecto de urllib ("Python-urllib/x",
# error 1010). Hay que enviar un UA no marcado para que el request llegue a la API.
VM_USER_AGENT = "presence-ihost/1.0"
DB_PATH = getenv("DB_PATH", "/app/data/presence.db")
ARP_SCAN_BIN = getenv("ARP_SCAN_BIN", "arp-scan")
ARPING_BIN = getenv("ARPING_BIN", "arping")
ARP_RETRIES = int(getenv("ARP_RETRIES", "3"))
ARP_TIMEOUT = int(getenv("ARP_TIMEOUT", "500"))
PING_TIMEOUT = getenv("PING_TIMEOUT", "1")
MAX_HOSTS = int(getenv("MAX_HOSTS", "1024"))
LOCK_PATH = getenv("LOCK_PATH", "/app/data/presence.lock")
SCAN_TIMEOUT = int(getenv("SCAN_TIMEOUT", "50"))
ARP_SCAN_TIMEOUT = int(getenv("ARP_SCAN_TIMEOUT", "10"))
NMAP_SCAN_TIMEOUT = int(getenv("NMAP_SCAN_TIMEOUT", "10"))


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


def time_in_window(start, end, now_local=None):
    """True when the local time (HH:MM) is inside [start, end).

    Supports windows that wrap past midnight (23:00-07:00). Empty or equal
    start/end means no window.
    """
    if not start or not end or start == end:
        return False
    current = (now_local or datetime.now()).strftime("%H:%M")
    if start < end:
        return start <= current < end
    return current >= start or current < end


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
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enabled     INTEGER NOT NULL DEFAULT 0,
  api_key     TEXT NOT NULL DEFAULT '',
  device_id   TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT '',
  voice       TEXT NOT NULL DEFAULT '',
  language    TEXT NOT NULL DEFAULT '',
  chime       TEXT NOT NULL DEFAULT '',
  website_url TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS presence (
  mac       TEXT PRIMARY KEY,
  present   INTEGER NOT NULL DEFAULT 0,
  last_seen REAL,
  ip        TEXT,
  miss_count INTEGER NOT NULL DEFAULT 0,
  last_present_notify REAL,
  last_away_notify REAL
);
CREATE TABLE IF NOT EXISTS sightings (
  mac       TEXT PRIMARY KEY,
  last_seen REAL NOT NULL,
  source    TEXT NOT NULL DEFAULT 'passive'
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""
    )
    for col in ("voice", "language", "chime", "website_url"):
        existing = {r[1] for r in conn.execute("PRAGMA table_info(voicemonkey)")}
        if col not in existing:
            conn.execute(
                "ALTER TABLE voicemonkey ADD COLUMN %s TEXT NOT NULL DEFAULT ''" % col
            )
    presence_cols = {r[1] for r in conn.execute("PRAGMA table_info(presence)")}
    for col, ddl in (
        ("miss_count", "INTEGER NOT NULL DEFAULT 0"),
        ("last_present_notify", "REAL"),
        ("last_away_notify", "REAL"),
        ("hit_count", "INTEGER NOT NULL DEFAULT 0"),
    ):
        if col not in presence_cols:
            conn.execute("ALTER TABLE presence ADD COLUMN %s %s" % (col, ddl))
    conn.commit()


def load_devices(conn):
    rows = conn.execute("SELECT name, mac FROM devices ORDER BY id").fetchall()
    return [(row[0], normalize_mac(row[1])) for row in rows]


def load_setting(conn, key):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def load_vm(conn):
    row = conn.execute(
        "SELECT enabled, api_key, device_id, message, voice, language, chime, website_url"
        " FROM voicemonkey WHERE id = 1"
    ).fetchone()
    if not row:
        return {}
    return {
        "enabled": bool(row[0]),
        "api_key": row[1] or "",
        "device_id": row[2] or "",
        "message": row[3] or "",
        "voice": row[4] or "",
        "language": row[5] or "",
        "chime": row[6] or "",
        "website_url": row[7] or "",
    }


def load_presence(conn):
    state = {}
    for row in conn.execute(
        "SELECT mac, present, last_seen, ip, miss_count, hit_count, last_present_notify, last_away_notify"
        " FROM presence"
    ):
        state[row[0]] = {
            "present": bool(row[1]),
            "last_seen": row[2],
            "ip": row[3],
            "miss_count": row[4] or 0,
            "hit_count": row[5] or 0,
            "last_present_notify": row[6],
            "last_away_notify": row[7],
        }
    return state


def load_sightings(conn):
    out = {}
    for row in conn.execute("SELECT mac, last_seen FROM sightings"):
        out[row[0]] = row[1]
    return out


def load_anyone(conn):
    row = conn.execute("SELECT value FROM meta WHERE key = 'anyone_home'").fetchone()
    return row is not None and row[0] == "1"


def save_presence(conn, devices):
    for device in devices:
        conn.execute(
            "INSERT INTO presence(mac, present, last_seen, ip, miss_count, hit_count,"
            " last_present_notify, last_away_notify) VALUES(?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(mac) DO UPDATE SET present = excluded.present, "
            "last_seen = excluded.last_seen, ip = excluded.ip, "
            "miss_count = excluded.miss_count, hit_count = excluded.hit_count, "
            "last_present_notify = excluded.last_present_notify, "
            "last_away_notify = excluded.last_away_notify",
            (
                device.mac,
                int(device.present),
                device.last_seen,
                device.ip,
                device.miss_count,
                device.hit_count,
                device.last_present_notify,
                device.last_away_notify,
            ),
        )


def save_anyone(conn, value):
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('anyone_home', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ("1" if value else "0",),
    )


def load_last_home(conn):
    row = conn.execute("SELECT value FROM meta WHERE key = 'last_anyone_home'").fetchone()
    if not row:
        return None
    try:
        return float(row[0])
    except (TypeError, ValueError):
        return None


def save_last_home(conn, value):
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('last_anyone_home', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ("%.0f" % value,),
    )


def acquire_lock():
    try:
        os.makedirs(os.path.dirname(LOCK_PATH), exist_ok=True)
        handle = open(LOCK_PATH, "w")
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except OSError:
        LOG.info("another presence run is in progress, skipping this run")
        return None


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

    def usable(entry):
        if entry[1] is None:
            return True
        try:
            return not ipaddress.ip_address(entry[1]).is_link_local
        except ValueError:
            return False

    if configured:
        selected = [entry for entry in entries if entry[0] in configured]
        selected = [entry for entry in selected if usable(entry)]
        return selected or [(name, None, None) for name in configured]

    selected = [
        entry for entry in entries
        if not entry[0].startswith(SKIP_IFACE_PREFIXES) and usable(entry)
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
    cmd = [
        ARP_SCAN_BIN, "--plain", "--retry=%s" % ARP_RETRIES,
        "--timeout=%s" % ARP_TIMEOUT, "--ignoredups",
    ]
    if iface:
        cmd.insert(1, "--interface=%s" % iface)
    cmd.append(str(network))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=ARP_SCAN_TIMEOUT)
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


def nmap_scan(iface, network, nmap_bin):
    cmd = [nmap_bin, "-sn", "-n"]
    if iface:
        cmd += ["-e", iface]
    cmd.append(str(network))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=NMAP_SCAN_TIMEOUT)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "exit code %s" % result.returncode)
    devices = {}
    current_ip = None
    for line in result.stdout.splitlines():
        match = re.match(r"Nmap scan report for (.+?)\s*$", line)
        if match:
            current_ip = match.group(1).strip()
            if not IP_RE.match(current_ip):
                current_ip = None
            continue
        mac_match = re.search(
            r"MAC Address: (([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})", line
        )
        if mac_match and current_ip:
            devices[normalize_mac(mac_match.group(1))] = current_ip
    return devices


def arping_probe(iface, ip):
    try:
        result = subprocess.run(
            [ARPING_BIN, "-c", "1", "-w", "2", "-I", iface, ip],
            capture_output=True, text=True, timeout=8,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return None


def unicast_probe(iface, ip):
    if iface:
        ok = arping_probe(iface, ip)
        if ok is not None:
            return ok
    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", PING_TIMEOUT, ip],
            capture_output=True, text=True, timeout=8,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def unicast_probe_pass(device_objs, configured_ifaces, seen):
    ifaces = list_ifaces(configured_ifaces)
    candidates = [
        entry for entry in ifaces
        if entry[0] and not entry[0].startswith(SKIP_IFACE_PREFIXES)
    ]
    if not candidates:
        return {}
    iface = candidates[0][0]
    found = {}
    for device in device_objs:
        if device.mac in seen or not device.ip:
            continue
        if unicast_probe(iface, device.ip):
            LOG.info("directed unicast probe confirmed %s at %s", device.name, device.ip)
            found[device.mac] = device.ip
    return found


def scan_once(configured_ifaces, scan_prefix, use_nmap, nmap_bin):
    seen = {}
    for iface, ip, cidr in list_ifaces(configured_ifaces):
        network = scan_network(ip, cidr, scan_prefix)
        if not network:
            continue

        methods = [("arp-scan", lambda i=iface, n=network: arp_scan(i, n))]
        if use_nmap:
            methods.append(("nmap", lambda i=iface, n=network, b=nmap_bin: nmap_scan(i, n, b)))

        results = {}
        with ThreadPoolExecutor(max_workers=len(methods)) as pool:
            futures = {pool.submit(fn): name for name, fn in methods}
            try:
                for future in as_completed(futures, timeout=SCAN_TIMEOUT):
                    name = futures[future]
                    try:
                        results[name] = future.result()
                    except Exception as exc:
                        LOG.warning("%s failed on %s: %s", name, iface, exc)
            except TimeoutError:
                LOG.warning(
                    "active scan on %s exceeded %ss, using partial results",
                    iface, SCAN_TIMEOUT,
                )

        for name, found in results.items():
            LOG.debug("%s on %s found %d devices", name, iface, len(found))
            seen.update(found)

        if not results:
            LOG.warning("active scan methods failed on %s, falling back to ping sweep", iface)
            try:
                seen.update(ping_sweep(iface, network))
            except Exception as exc:
                LOG.warning("ping sweep failed on %s: %s", iface, exc)
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


def maybe_device_notify(conn, webhook_url, device, event, cooldown, now):
    """Rate-limit device_present/device_away webhooks per device."""
    if event == "device_present":
        last = device.last_present_notify
    else:
        last = device.last_away_notify
    if last is not None and cooldown > 0 and now - last < cooldown:
        LOG.info(
            "suppressed %s for %s (%.0fs ago, cooldown %ss)",
            event, device.name, now - last, cooldown,
        )
        return
    if event == "device_present":
        device.last_present_notify = now
    else:
        device.last_away_notify = now
    emit_webhook(webhook_url, event, device)


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
    payload = {
        "token": api_key,
        "device": device_id,
        "speech": speech,
        "voice": vm.get("voice") or VM_VOICE,
    }
    if vm.get("language"):
        payload["language"] = vm["language"]
    if vm.get("chime"):
        payload["chime"] = vm["chime"]
    if vm.get("website_url"):
        payload["website_url"] = vm["website_url"]
    payload_json = json.dumps(payload).encode("utf-8")
    try:
        request = urllib.request.Request(
            VM_API,
            data=payload_json,
            headers={"Content-Type": "application/json", "User-Agent": VM_USER_AGENT},
            method="POST",
        )
        urllib.request.urlopen(request, timeout=10).close()
        LOG.info("voicemonkey announce sent for device %s", device.name)
    except Exception as exc:
        LOG.warning("voicemonkey announce failed: %s", exc)


class Device:
    def __init__(self, name, mac, present=False, last_seen=None, ip=None,
                 miss_count=0, hit_count=0, last_present_notify=None, last_away_notify=None):
        self.name = name
        self.mac = mac
        self.present = present
        self.last_seen = last_seen
        self.ip = ip
        self.miss_count = miss_count
        self.hit_count = hit_count
        self.last_present_notify = last_present_notify
        self.last_away_notify = last_away_notify


def run_once():
    load_env_file(getenv("ENV_FILE", "/app/data/.env"))

    lock = acquire_lock()
    if lock is None:
        return 0

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
        away_confirmations = int(load_setting(conn, "away_confirmations") or getenv("AWAY_CONFIRMATIONS", "2"))
        home_confirmations = int(load_setting(conn, "home_confirmations") or getenv("HOME_CONFIRMATIONS", "2"))
        night_start = load_setting(conn, "night_start") or getenv("NIGHT_START", "")
        night_end = load_setting(conn, "night_end") or getenv("NIGHT_END", "")
        night_grace = int(load_setting(conn, "night_grace") or getenv("NIGHT_GRACE", "600"))
        night_away_confirmations = int(load_setting(conn, "night_away_confirmations") or getenv("NIGHT_AWAY_CONFIRMATIONS", "4"))
        quiet_start = load_setting(conn, "quiet_hours_start") or getenv("QUIET_HOURS_START", "")
        quiet_end = load_setting(conn, "quiet_hours_end") or getenv("QUIET_HOURS_END", "")
        device_notify_cooldown = int(load_setting(conn, "device_notify_cooldown") or getenv("DEVICE_NOTIFY_COOLDOWN", "300"))
        passive_sniff_enabled = setting_bool(
            load_setting(conn, "passive_sniff_enabled"), getenv("PASSIVE_SNIFF_ENABLED", "true"),
        )
        use_nmap = setting_bool(
            load_setting(conn, "use_nmap"), getenv("USE_NMAP", "true"),
        )
        nmap_bin = load_setting(conn, "nmap_bin") or getenv("NMAP_BIN", "nmap") or "nmap"
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
                    miss_count=prev.get("miss_count", 0),
                    hit_count=prev.get("hit_count", 0),
                    last_present_notify=prev.get("last_present_notify"),
                    last_away_notify=prev.get("last_away_notify"),
                )
            )

        is_night = time_in_window(night_start, night_end)
        is_quiet = time_in_window(quiet_start, quiet_end)
        if is_night:
            effective_grace = night_grace
            effective_away_confirmations = night_away_confirmations
        else:
            effective_grace = grace
            effective_away_confirmations = away_confirmations

        LOG.info(
            "starting scan: devices=%s ifaces=%s scan_prefix=%s grace=%ss "
            "away_confirmations=%s home_confirmations=%s nmap=%s sniff=%s%s%s",
            [(d.name, d.mac) for d in device_objs], ifaces or "auto", scan_prefix,
            effective_grace, effective_away_confirmations, home_confirmations,
            use_nmap, passive_sniff_enabled,
            " night" if is_night else "", " quiet" if is_quiet else "",
        )

        seen = scan_once(ifaces, scan_prefix, use_nmap, nmap_bin)
        seen.update(unicast_probe_pass(device_objs, ifaces, seen))
        LOG.info("active scan found %d devices on LAN", len(seen))

        sightings = load_sightings(conn) if passive_sniff_enabled else {}
        passive_hits = sum(1 for device in device_objs if device.mac in sightings)
        if passive_hits:
            LOG.info("passive sniffing tracked %d of %d configured devices", passive_hits, len(device_objs))

        now = time.time()
        arrived = None
        for device in device_objs:
            ip = seen.get(device.mac)
            passive = sightings.get(device.mac)
            effective = max(now if ip else 0.0, passive or 0.0)
            in_grace = effective > 0 and (now - effective) <= effective_grace

            if in_grace:
                device.miss_count = 0
                if ip:
                    device.ip = ip
                if effective > (device.last_seen or 0):
                    device.last_seen = effective
                if not device.present:
                    device.hit_count += 1
                    if device.hit_count >= home_confirmations:
                        LOG.info(
                            "device %s confirmed home after %d consecutive hits (last via %s)",
                            device.name, home_confirmations, "active" if ip else "passive",
                        )
                        device.present = True
                        device.hit_count = 0
                        maybe_device_notify(conn, webhook_url, device, "device_present", device_notify_cooldown, now)
                        if arrived is None:
                            arrived = device
                    else:
                        LOG.info(
                            "device %s seen via %s but not yet confirmed home (%d/%d)",
                            device.name, "active" if ip else "passive",
                            device.hit_count, home_confirmations,
                        )
            else:
                device.hit_count = 0
                if device.present:
                    device.miss_count += 1
                    if device.miss_count >= effective_away_confirmations:
                        LOG.info(
                            "device %s away after %d consecutive misses (%.0fs since last seen)",
                            device.name, device.miss_count,
                            now - (device.last_seen or now),
                        )
                        device.present = False
                        device.miss_count = 0
                        maybe_device_notify(conn, webhook_url, device, "device_away", device_notify_cooldown, now)

        anyone = any(device.present for device in device_objs)
        if anyone != prev_anyone:
            if anyone and arrived is not None:
                cooldown = int(load_setting(conn, "notify_cooldown") or getenv("NOTIFY_COOLDOWN", "1800"))
                last_home = load_last_home(conn)
                if last_home is None or now - last_home > cooldown:
                    if is_quiet:
                        LOG.info(
                            "anyone_home notification suppressed during quiet hours (%s-%s); state recorded",
                            quiet_start, quiet_end,
                        )
                    else:
                        emit_webhook(webhook_url, "anyone_home")
                        send_voicemonkey(vm, arrived)
                    save_last_home(conn, now)
                else:
                    LOG.info(
                        "suppressed duplicate anyone_home notification "
                        "(%.0fs ago, cooldown %ss)", now - last_home, cooldown,
                    )
            elif anyone:
                if not is_quiet:
                    emit_webhook(webhook_url, "anyone_home")
                else:
                    LOG.info("anyone_home webhook suppressed during quiet hours")
            else:
                emit_webhook(webhook_url, "anyone_away")
            save_anyone(conn, anyone)

        save_presence(conn, device_objs)
        save_last_job_run(conn, now_iso())
        conn.commit()
        LOG.info(
            "done: anyone_home=%s grace=%ss away_confirmations=%s home_confirmations=%s%s",
            anyone, effective_grace, effective_away_confirmations, home_confirmations,
            " night" if is_night else "",
        )
        return 0
    finally:
        conn.close()
        lock.close()


def main():
    logging.basicConfig(
        level=getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    return run_once()


if __name__ == "__main__":
    raise SystemExit(main())