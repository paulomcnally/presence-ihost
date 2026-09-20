#!/usr/bin/env python3
"""Passive presence sniffer daemon (Layer 1).

Runs for the lifetime of the container, listening on the configured
interface(s) with a tight BPF filter (ARP + mDNS + DHCP) and recording
sightings of configured MAC addresses into the SQLite `sightings` table.

The cron-based presence job (presence.py) fuses these passive sightings with
its active scans, so a device that quietly sends ARP/mDNS/DHCP traffic keeps
being counted as present even when it ignores active probes in that instant.

Degrades gracefully: if sniffing is disabled, unavailable or lacks the needed
permissions, it logs a WARNING and exits with code 0 so the supervisor loop in
entrypoint.sh stops restarting it. The system keeps working on active scans.
"""
import logging
import os
import re
import signal
import sqlite3
import subprocess
import threading
import time

LOG = logging.getLogger("presence.sniffer")
HEAD_RE = re.compile(
    r"^\S+\s+((?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})\s+>", re.IGNORECASE
)
# Docker/bridge-veth virtual interfaces to skip. Unlike the active scan, we
# keep real LAN bridges (e.g. br-lan, br0) because on the iHost they are where
# the LAN traffic is actually visible.
SKIP_IFACE_PREFIXES = ("docker", "veth", "virbr", "lo")
DOCKER_BRIDGE_RE = re.compile(r"^br-[0-9a-f]{12}$")
BPF_FILTER = "arp or port 5353 or port 67 or port 68"

DB_PATH = "/app/data/presence.db"
TCPDUMP_BIN = "tcpdump"
MAC_REFRESH = 30


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


def setting_bool(*values):
    for value in values:
        if value is None:
            continue
        return str(value).strip().lower() in ("1", "true", "yes", "on")
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


def db_connect():
    return sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)


def ensure_schema(conn):
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sightings ("
        "  mac TEXT PRIMARY KEY,"
        "  last_seen REAL NOT NULL,"
        "  source TEXT NOT NULL DEFAULT 'passive'"
        ")"
    )


def load_setting(conn, key):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def load_setting_value(key):
    conn = db_connect()
    try:
        return load_setting(conn, key)
    finally:
        conn.close()


def load_configured_macs(conn):
    rows = conn.execute("SELECT name, mac FROM devices ORDER BY id").fetchall()
    if rows:
        return {normalize_mac(row[1]) for row in rows}
    return {mac for _, mac in parse_devices()}


class MacProvider:
    def __init__(self, refresh_interval=None):
        self.refresh_interval = refresh_interval or MAC_REFRESH
        self._macs = set()
        self._last = 0.0

    def macs(self):
        now = time.time()
        if now - self._last >= self.refresh_interval:
            try:
                conn = db_connect()
                try:
                    self._macs = load_configured_macs(conn)
                finally:
                    conn.close()
                self._last = now
            except sqlite3.Error as exc:
                LOG.warning("cannot reload configured MACs: %s", exc)
        return self._macs


def extract_source_mac(line):
    match = HEAD_RE.match(line)
    return normalize_mac(match.group(1)) if match else None


def classify_source(line):
    if "ethertype ARP" in line or "ARP," in line or "is-at" in line:
        return "arp"
    if "BOOTP" in line or "DHCP" in line:
        return "dhcp"
    if "5353" in line:
        return "mdns"
    return "passive"


def record_sighting(conn, mac, source):
    try:
        conn.execute(
            "INSERT INTO sightings(mac, last_seen, source) VALUES(?, ?, ?) "
            "ON CONFLICT(mac) DO UPDATE SET last_seen = excluded.last_seen,"
            " source = excluded.source",
            (mac, time.time(), source),
        )
    except sqlite3.Error as exc:
        LOG.warning("cannot record sighting for %s: %s", mac, exc)


def sniff_flags(iface):
    """Return the extra tcpdump args that work on this interface, or None."""
    for extra in ([], ["-p"]):
        cmd = [TCPDUMP_BIN, "-i", iface, "-e", "-l", "-nn", "-c", "1", BPF_FILTER] + extra
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
            if result.returncode == 0:
                return extra
            LOG.debug(
                "tcpdump probe failed on %s with %r: %s",
                iface, extra, result.stderr.strip(),
            )
        except subprocess.TimeoutExpired:
            return extra
        except OSError as exc:
            LOG.warning("tcpdump binary not available: %s", exc)
            return None
    LOG.warning(
        "passive sniffing unavailable on %s (insufficient permissions or "
        "interface error); continuing with active scans only",
        iface,
    )
    return None


def drain_stderr(proc, iface):
    for line in proc.stderr:
        line = line.strip()
        if line:
            LOG.debug("[tcpdump %s] %s", iface, line)


def sniff_loop(iface, extra, macs, stop):
    cmd = [TCPDUMP_BIN, "-i", iface, "-e", "-l", "-nn", "-s", "96", BPF_FILTER] + extra
    conn = db_connect()
    try:
        while not stop.is_set():
            LOG.info("starting passive sniffer on %s (filter: %s)", iface, BPF_FILTER)
            try:
                proc = subprocess.Popen(
                    cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
                )
            except OSError as exc:
                LOG.warning("cannot start tcpdump on %s: %s", iface, exc)
                return
            threading.Thread(target=drain_stderr, args=(proc, iface), daemon=True).start()
            try:
                for raw in proc.stdout:
                    if stop.is_set():
                        break
                    line = raw.strip()
                    if not line:
                        continue
                    mac = extract_source_mac(line)
                    if mac and mac in macs.macs():
                        record_sighting(conn, mac, classify_source(line))
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
            if stop.is_set():
                return
            LOG.warning("tcpdump on %s exited (code %s), restarting in 2s", iface, proc.returncode)
            stop.wait(2)
    finally:
        conn.close()


def auto_ifaces():
    ifaces = []
    try:
        result = subprocess.run(
            ["ip", "-o", "link", "show"], capture_output=True, text=True, timeout=10,
        )
        for line in result.stdout.splitlines():
            parts = line.split(":", 2)
            if len(parts) >= 2:
                name = parts[1].strip()
                if not name:
                    continue
                if name.startswith(SKIP_IFACE_PREFIXES):
                    continue
                if DOCKER_BRIDGE_RE.match(name):
                    continue
                ifaces.append(name)
    except (OSError, subprocess.SubprocessError) as exc:
        LOG.warning("cannot list interfaces with ip: %s", exc)
    return ifaces


def load_sniff_ifaces():
    conn = db_connect()
    try:
        configured = (
            (load_setting(conn, "passive_sniff_ifaces") or "")
            or (load_setting(conn, "ifaces") or "")
        )
    finally:
        conn.close()
    configured = configured.strip()
    if configured:
        return [item.strip() for item in configured.split(",") if item.strip()]
    return auto_ifaces()


def main():
    logging.basicConfig(
        level=getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    load_env_file(getenv("ENV_FILE", "/app/data/.env"))
    global DB_PATH, TCPDUMP_BIN, MAC_REFRESH
    DB_PATH = getenv("DB_PATH", DB_PATH)
    TCPDUMP_BIN = getenv("TCPDUMP_BIN", TCPDUMP_BIN)
    MAC_REFRESH = int(getenv("SNIFFER_MAC_REFRESH", str(MAC_REFRESH)))

    conn = db_connect()
    try:
        ensure_schema(conn)
    finally:
        conn.close()

    if not setting_bool(
        load_setting_value("passive_sniff_enabled"), getenv("PASSIVE_SNIFF_ENABLED", "true"),
    ):
        LOG.info("passive sniffing is disabled by configuration; exiting")
        return 0

    ifaces = load_sniff_ifaces()
    if not ifaces:
        LOG.warning("no interfaces available for passive sniffing; continuing with active scans only")
        return 0

    planned = []
    for iface in ifaces:
        extra = sniff_flags(iface)
        if extra is None:
            continue
        planned.append((iface, extra))
    if not planned:
        LOG.warning("passive sniffing unavailable on all interfaces; continuing with active scans only")
        return 0

    macs = MacProvider()
    stop = threading.Event()

    def handle_signal(signum, frame):
        LOG.info("received signal %s, stopping sniffer", signum)
        stop.set()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    threads = []
    for iface, extra in planned:
        thread = threading.Thread(
            target=sniff_loop, args=(iface, extra, macs, stop), daemon=True
        )
        thread.start()
        threads.append(thread)

    LOG.info("passive sniffer running on %s", ", ".join(i for i, _ in planned))
    while not stop.wait(1.0):
        pass
    for thread in threads:
        thread.join(timeout=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())