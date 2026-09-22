# presence-ihost

Presence detection for devices on your home Wi-Fi/LAN, designed to run as a Docker container on a SONOFF iHost (eWeLink CUBE OS).

The container runs a **multi-layer presence detection job every minute**: it combines **passive sniffing** (a daemon that continuously listens to ARP/mDNS/DHCP traffic) with **active scans** (`arp-scan` + `nmap -sn` in parallel, plus directed unicast probes), detects which of your configured devices (identified by MAC address) are online, and notifies you **via webhook and/or VoiceMonkey** (Alexa text-to-speech) when someone arrives or leaves home. It also serves a **web UI** to configure everything (devices, VoiceMonkey announcements, webhook URL, scan options) and shows the current presence state. There is no HTTP presence API anymore — notification happens exclusively through webhooks/VoiceMonkey.

## How it works

Detection is split into **four layers** that work together to avoid false notifications:

### Layer 1 — Passive sniffing daemon (most important)

A background daemon (`sniffer.py`) runs for the whole life of the container. It listens on the configured interface(s) with a tight filter (`arp or port 5353 or port 67 or port 68`) and records a **sighting** every time it sees one of your devices' MAC addresses in:

- **ARP** requests/replies,
- **mDNS** traffic (port 5353) — Apple devices announce themselves regularly even with the screen off,
- **DHCP** requests/renewals (ports 67/68).

Sightings are stored in the `sightings` table of the SQLite database. This is much more reliable than a point-in-time probe: a phone in Wi-Fi power-save mode still emits organic traffic, so it keeps being counted as present even if it ignores the active scan that exact second. If the daemon dies it is restarted automatically; if it cannot run (missing `CAP_NET_RAW`/`CAP_NET_ADMIN`) the system **degrades safely** to the active layers only, logging a clear warning.

### Layer 2 — Active multi-method scan (every minute)

Every cron cycle the job runs several **independent** scan methods **in parallel** and unions the results (a device counts as seen if *any* method detected it):

1. `arp-scan` (broadcast) — the original method.
2. `nmap -sn` (ping/ARP scan) — a different implementation that detects hosts `arp-scan` sometimes misses, and vice versa.
3. Fallback `ping` sweep + `/proc/net/arp` when no active method is available.
4. **Directed unicast probe**: for each configured device with a known IP that was *not* found by the scans, it sends a unicast `arping` (or `ping`) directly to that IP — much more likely to wake a sleeping radio than a generic broadcast.

### Layer 3 — Fusion and state decision

For each device, the effective last-seen time is the maximum of the active signal this cycle and the latest passive sighting:

```
last_seen_efectivo = max(last_seen_activo_este_ciclo, last_seen_passive_de_sqlite)
```

- Within `GRACE` seconds of a signal → device stays `present`, counters reset.
- Past `GRACE` → a `miss_count` is incremented. The device only goes `away` (and notifies) after **`AWAY_CONFIRMATIONS`** (default 2) consecutive cycles with no signal of any kind.
- Any signal (active or passive) resets `miss_count` to 0.

### Layer 4 — Per-device notification debounce

A cooldown (`DEVICE_NOTIFY_COOLDOWN`, default 300s) limits `device_present`/`device_away` webhooks per device, absorbing any residual flapping (the state still flips, but extra webhooks are suppressed and logged).

1. Every minute a cron job runs `presence.py`, which loads the configuration and the previous state from a SQLite database.
2. It collects active signals (Layer 2) and passive sightings (Layer 1) and fuses them (Layer 3).
3. A device goes `offline` only after `AWAY_CONFIRMATIONS` consecutive cycles without *any* signal, and at least `GRACE` seconds since it was last seen.
4. On every state change (`device_present`, `device_away`, `anyone_home`, `anyone_away`) it POSTs a JSON payload to the configured **webhook URL** (rate-limited per device by Layer 4).
5. When the first configured device arrives (anyone → home), it can send a **VoiceMonkey announcement** to your Alexa with the name of the device that arrived. A **cooldown** (default 30 min) prevents duplicate welcome-home announcements when a phone that fell asleep or lost Wi-Fi briefly reappears.
6. The new state is saved back to SQLite, ready for the next run. A file lock (`presence.lock`) guarantees only one scan runs at a time, even if a previous run is still in progress.

> **Important:** the container must run with **host network mode** and with the `NET_RAW` + `NET_ADMIN` capabilities for passive sniffing. A bridge network would isolate it from your LAN and it would not see any devices.

## Settings UI

Open `http://<ihost-ip>:8082` in your browser. Everything is stored in a SQLite database (`/app/data/presence.db`) and applied automatically by the job.

From the UI you can configure:

- **VoiceMonkey (Alexa):** enable announcements, set your API token and Speaker device ID, and write the message. Use `{device_name}` in the message to insert the name of the device that arrived, e.g. `{device_name} ha llegado a casa`. A **test button** sends a live announcement so you can verify the config.
- **Devices:** add/remove the devices to watch (name + MAC address).
- **Webhook URL:** optional URL that receives a POST JSON on every online/offline event. A **test button** sends a synthetic event.
- **Scan options:** grace, scan prefix, interfaces, passive sniffing (enabled/interfaces), nmap (enabled/binary), `away_confirmations` and per-device notify cooldown.
- **Current state:** shows live online/offline status of each configured device (only after the job has run at least once).
- **Logs:** last lines of `presence.log`, with an optional auto-refresh every 10s.

The `.env` file is only used as fallback defaults; the SQLite database takes precedence.

### Access control (first run)

The UI is exposed on your LAN, so **by default it asks you to set up a username and password on first load** before showing any configuration. Choose *"Omitir por ahora"* only if you explicitly trust everyone on your network (not recommended). Once credentials exist, the UI (and the whole `/api/*`) requires HTTP Basic Auth.

Credentials are stored as a **bcrypt hash** (never the password in clear). You can also pre-configure them via environment:

| Variable | Description |
| --- | --- |
| `SETTINGS_USERNAME` | Username for the settings UI (fallback/pre-config) |
| `SETTINGS_PASSWORD_HASH` | bcrypt hash of the password. Generate one with `htpasswd -nbBC 10 "" "yourpassword"` (take the 2nd field). If stored in a file, the file must have permissions `600`. |

**Reset flow:** if you forget the credentials, delete the `auth_username` / `auth_password_hash` rows from the `settings` table in `presence.db` (e.g. `sqlite3 /app/data/presence.db "DELETE FROM settings WHERE key LIKE 'auth_%'"`), or set `SETTINGS_USERNAME`/`SETTINGS_PASSWORD_HASH` in `.env` as a rescue. The UI will then show the setup wizard again.

## Requirements

- A SONOFF iHost with eWeLink CUBE OS (Docker support) — image is built for `linux/arm/v7` and `linux/amd64`.
- The device(s) you want to track must be on the same LAN as the iHost (same subnet, no client isolation, no separate VLAN).

## Getting the MAC address of your device

To know which MAC to configure, check what the network actually sees:

- **iPhone/iPad:** `Settings > Wi-Fi > (i) next to your network > Wi-Fi Address`. This is the address your router and this container will see.
- Be aware of **Private Wi-Fi Address** (iOS 14+): your device may use a randomized MAC per network.
  - With iOS 18 you can set it to **Fixed** or **Off** for your home network so the address never rotates.
  - If it is set to *Rotating*, the MAC changes periodically and detection will break.
  - The address shown in `Settings > General > About > Wi-Fi Address` is the hardware MAC, which is **not** the one the network sees — don't use it.
- **Alternative:** check your router's DHCP client list to find the MAC of a connected device.

## Quick start (iHost)

1. In the iHost web console, open the **Docker** page and add the repository:
   `paulomcnally/presence-ihost`
2. Install the add-on and configure it:
   - **Network:** `Host`
   - **Capabilities:** enable `NET_RAW` and `NET_ADMIN` (needed for the passive sniffer; without them the system still works, but only with the active scan)
   - **Volume:** mount a host directory at `/app/data` (e.g. the same volume used by your SSH container)
3. Start the container and open the settings UI: `http://<ihost-ip>:8082`
4. Add your devices (name + MAC), set the webhook URL and/or VoiceMonkey config, and save.

The job runs every minute; you can inspect its logs in `/app/data/presence.log` (inside the container).

## Configuration

Configuration is stored in the SQLite database at `/app/data/presence.db` and managed through the settings UI on port `8082`. The optional `.env` file (mounted at `/app/data/.env`) only provides fallback defaults.

| Variable (fallback) | Default | Description |
| --- | --- | --- |
| `GRACE` | `180` | Seconds without being seen before a device starts counting toward `away` |
| `AWAY_CONFIRMATIONS` | `2` | Consecutive cycles with no signal (active or passive) before a device is marked `away` |
| `DEVICE_NOTIFY_COOLDOWN` | `300` | Minimum seconds between `device_present`/`device_away` webhooks of the same device |
| `NOTIFY_COOLDOWN` | `1800` | Minimum seconds between two `anyone_home` announcements (avoids duplicate welcome-home when a device briefly drops off Wi-Fi) |
| `IFACES` | *(auto)* | Comma-separated network interfaces to scan, e.g. `eth0,wlan0`. Empty = auto-detect |
| `PASSIVE_SNIFF_ENABLED` | `true` | Enables/disables the passive sniffing daemon (Layer 1). Disable it if the iHost runtime lacks the needed capabilities |
| `PASSIVE_SNIFF_IFACES` | *(auto)* | Comma-separated interfaces for the sniffer. Empty = same as `IFACES` |
| `USE_NMAP` | `true` | Run `nmap -sn` in parallel with `arp-scan` (Layer 2) and union results |
| `NMAP_BIN` | `nmap` | Path to the `nmap` binary |
| `SCAN_PREFIX` | `24` | Max subnet size to scan (netmask). Interfaces with a larger subnet (e.g. `/16`) are reduced to this prefix to keep scans fast |
| `WEBHOOK_URL` | *(none)* | URL that receives a `POST` JSON on state changes (see payload schema below) |
| `ARP_RETRIES` | `3` | `arp-scan` retries per host (default 3). Raise if sleeping phones are missed and cause false `away` states |
| `ARP_TIMEOUT` | `500` | `arp-scan` reply timeout in ms per retry (default 500). Raise on congested/slow Wi-Fi |
| `DB_PATH` | `/app/data/presence.db` | SQLite database path |
| `SETTINGS_PORT` | `8082` | Settings UI / configuration API port |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |

## Settings API

| Endpoint | Description |
| --- | --- |
| `GET /api/auth/status` | Whether UI credentials are configured (`{configured, skipped}`) — used by the first-run wizard |
| `POST /api/auth/setup` | Create the initial user/password (`{username, password}`) or explicitly skip (`{skip: true}`); only works before credentials exist |
| `GET /api/config` | Current configuration (settings, devices, VoiceMonkey). `api_key` is returned **masked** as `api_key_masked` + `api_key_set`; never in full |
| `PUT /api/config` | Save configuration. Validates every field and returns `400` with `{ "errors": { "<field>": "<message>" } }`; an empty/masked `api_key` keeps the stored token |
| `GET /api/presence` | Current presence state (`anyone_home` + per-device `present`/`ip`/`last_seen`) plus `last_job_run` |
| `POST /api/voicemonkey/test` | Send a test VoiceMonkey announcement (rate-limited) |
| `POST /api/webhook/test` | Send a synthetic test event to the configured webhook URL (rate-limited) |

**Security notes:**

- Every `/api/*` route (except `/api/auth/status` and `/api/auth/setup`) requires HTTP Basic Auth once credentials are configured, and is blocked with `403 setup_required` on a fresh install until the wizard runs.
- State-changing requests (`PUT`, `POST`) must send the header `X-Requested-With: XMLHttpRequest`; this blocks simple cross-site `<form>` CSRF.
- `PUT /api/config` and the test endpoints are rate-limited (5 requests/min per IP).
- Responses include `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and a `Content-Security-Policy` (`default-src 'self'`). CORS is same-origin by default (override only via `SETTINGS_CORS_ORIGIN`).
- **Webhook SSRF limitation:** the webhook URL is only editable by whoever already has access to this authenticated UI (a single home user), so the risk of SSRF is low. If you ever expose this to untrusted users, you should additionally block private/LAN destinations.

## Webhook payload schema

When `WEBHOOK_URL` is set, every state change sends a `POST` with `Content-Type: application/json`. Example payload:

```json
{
  "event": "device_present",
  "ts": "2026-09-19T10:00:00+00:00",
  "device_name": "Iphone de Paulo",
  "mac": "00:11:22:33:44:55",
  "ip": "192.168.1.100",
  "status": "online"
}
```

- `event`: one of `device_present`, `device_away`, `anyone_home`, `anyone_away`.
- For `anyone_home`/`anyone_away` the fields `device_name`, `mac`, `ip` and `status` are omitted.
- `ts` is an ISO 8601 UTC timestamp.
- `status` is `online` when a device is present, `offline` when it goes away.

## VoiceMonkey

VoiceMonkey makes Alexa speak a text. Create a **Speaker** device in VoiceMonkey and link it to your Echo, then set in the UI:

- **API Key:** your VoiceMonkey API token.
- **Device ID:** the Speaker device ID.
- **Message:** the text Alexa will say. Use `{device_name}` to include the name of the device that just arrived.

The announcement is sent when `anyone_home` becomes true (the first configured device arrives), at most once per **cooldown** period (default 30 min, configurable as `NOTIFY_COOLDOWN` in the UI/Scan options). Use the **test button** in the UI to verify before relying on it.

## Running with Docker (non-iHost)

```bash
cp .env.example .env   # optional fallback defaults
mkdir -p data
docker compose up -d
# open http://localhost:8082 to configure devices, webhook and VoiceMonkey
```

Or directly:

```bash
docker run -d --name presence-ihost \
  --network host \
  --restart unless-stopped \
  -v $PWD/data:/app/data \
  paulomcnally/presence-ihost:latest
```

## Building from source (development only)

For local development you can build the Go binary and the frontend separately:

```bash
# requires Go 1.25+ and Node 20+
cd frontend && npm install && npm run build && cd ..
cd settings && go build -o settings-server . && cd ..
```

These local builds are **not** the release image. **Do not build or push the Docker
image locally** — it is built automatically by CI.

## Releases and Docker image

The Docker image is **built and published exclusively by GitHub Actions**
(`.github/workflows/docker-image.yml`), which runs when a `v*` tag is pushed. It
builds `linux/arm/v7` and `linux/amd64` and pushes `paulomcnally/presence-ihost`
with tags `vX.Y.Z` and `latest`.

To cut a release:

```bash
./release.sh
```

This derives the next patch version from the last image published on Docker Hub
(or accepts an explicit version: `./release.sh v0.2.1`), creates the git tag and
a GitHub release; CI then builds and pushes the image.
Never run `docker build`/`docker push` locally for releases.

Docker Hub credentials are repository secrets (`DOCKERHUB_USERNAME`,
`DOCKERHUB_TOKEN`), used only by CI.

## Troubleshooting

- **Always shows offline / never detects:** make sure the container uses host network mode, devices are on the same subnet, and there is no client isolation on the router.
- **Passive sniffing is not working on the iHost:** check the container has the `NET_RAW` and `NET_ADMIN` capabilities. If the iHost runtime does not allow them (no raw sockets / promiscuous mode), the sniffer logs a warning like `passive sniffing unavailable on ...` and the system degrades to active scans only — detection still works, but you may want to raise `GRACE`/`AWAY_CONFIRMATIONS` to compensate. Look for `passive sniffer running` in `/app/data/presence.log` to confirm Layer 1 is active. Note that the sniffer auto-detects real LAN bridges (e.g. `br-lan`, `br0`) for sniffing, so on the iHost you can usually leave `PASSIVE_SNIFF_IFACES` empty even when `IFACES` is set.
- **Stops detecting after a while:** the device is likely using a rotating private Wi-Fi address (iOS 18). Set it to `Fixed` or `Off` for that network.
- **No notifications:** open the settings UI at `http://<ihost-ip>:8082`, add your devices and set the webhook URL and/or VoiceMonkey. Check `/app/data/presence.log` for job output.
- **Offline takes a few minutes:** a device now goes away only after `GRACE` **and** `AWAY_CONFIRMATIONS` consecutive cycles with no signal (defaults: 180s and 2 cycles → ~3–4 min). Lower them in the UI if you need faster offline detection.
- **Receives «welcome home» twice:** the phone fell asleep / lost Wi-Fi for more than `GRACE` and then reappeared, flipping `anyone_away → anyone_home` again. Raise `NOTIFY_COOLDOWN` (default 1800s) or `GRACE`, and consider raising `ARP_RETRIES`/`ARP_TIMEOUT` so the scan misses fewer sleeping phones.
- **Slow scans:** a large subnet (e.g. `/16` on a `dummy0` or secondary interface) was the main cause on iHost — `SCAN_PREFIX=24` mitigates it. The active scan also has a global timeout (50s) and keeps partial results.