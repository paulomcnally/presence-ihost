# presence-ihost

Presence detection for devices on your home Wi-Fi/LAN, designed to run as a Docker container on a SONOFF iHost (eWeLink CUBE OS).

The container runs a presence detection **job every minute**: it scans your local network via ARP, detects which of your configured devices (identified by MAC address) are online, and notifies you **via webhook and/or VoiceMonkey** (Alexa text-to-speech) when someone arrives or leaves home. It also serves a **web UI** to configure everything (devices, VoiceMonkey announcements, webhook URL, scan options) and shows the current presence state. There is no HTTP presence API anymore — notification happens exclusively through webhooks/VoiceMonkey.

## How it works

1. Every minute a cron job runs `presence.py`, which loads the configuration and the previous state from a SQLite database.
2. It scans the local network using `arp-scan` (with a `ping` + `/proc/net/arp` fallback).
3. It marks a device `online` when its MAC address is seen. A device goes `offline` only after `GRACE` seconds (default 180s) have passed since it was last seen — this avoids false negatives from devices in sleep mode.
4. On every state change (`device_present`, `device_away`, `anyone_home`, `anyone_away`) it POSTs a JSON payload to the configured **webhook URL**.
5. When the first configured device arrives (anyone → home), it can send a **VoiceMonkey announcement** to your Alexa with the name of the device that arrived.
6. The new state is saved back to SQLite, ready for the next run.

> **Important:** the container must run with **host network mode**. A bridge network would isolate it from your LAN and it would not see any devices.

## Settings UI

Open `http://<ihost-ip>:8082` in your browser. Everything is stored in a SQLite database (`/app/data/presence.db`) and applied automatically by the job.

From the UI you can configure:

- **VoiceMonkey (Alexa):** enable announcements, set your API token and Speaker device ID, and write the message. Use `{device_name}` in the message to insert the name of the device that arrived, e.g. `{device_name} ha llegado a casa`. A **test button** sends a live announcement so you can verify the config.
- **Devices:** add/remove the devices to watch (name + MAC address).
- **Webhook URL:** optional URL that receives a POST JSON on every online/offline event.
- **Scan options:** grace, scan prefix and interfaces.
- **Current state:** shows live online/offline status of each configured device.

The `.env` file is only used as fallback defaults; the SQLite database takes precedence.

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
   - **Volume:** mount a host directory at `/app/data` (e.g. the same volume used by your SSH container)
3. Start the container and open the settings UI: `http://<ihost-ip>:8082`
4. Add your devices (name + MAC), set the webhook URL and/or VoiceMonkey config, and save.

The job runs every minute; you can inspect its logs in `/app/data/presence.log` (inside the container).

## Configuration

Configuration is stored in the SQLite database at `/app/data/presence.db` and managed through the settings UI on port `8082`. The optional `.env` file (mounted at `/app/data/.env`) only provides fallback defaults.

| Variable (fallback) | Default | Description |
| --- | --- | --- |
| `GRACE` | `180` | Seconds without being seen before a device is marked offline |
| `IFACES` | *(auto)* | Comma-separated network interfaces to scan, e.g. `eth0,wlan0`. Empty = auto-detect |
| `SCAN_PREFIX` | `24` | Max subnet size to scan (netmask). Interfaces with a larger subnet (e.g. `/16`) are reduced to this prefix to keep scans fast |
| `WEBHOOK_URL` | *(none)* | URL that receives a `POST` JSON on state changes (see payload schema below) |
| `DB_PATH` | `/app/data/presence.db` | SQLite database path |
| `SETTINGS_PORT` | `8082` | Settings UI / configuration API port |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |

## Settings API

| Endpoint | Description |
| --- | --- |
| `GET /api/config` | Current configuration (settings, devices, VoiceMonkey) |
| `PUT /api/config` | Save configuration |
| `GET /api/presence` | Current presence state (`anyone_home` + per-device `present`/`ip`/`last_seen`) |
| `POST /api/voicemonkey/test` | Send a test VoiceMonkey announcement |

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

The announcement is sent when `anyone_home` becomes true (the first configured device arrives). Use the **test button** in the UI to verify before relying on it.

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
./release.sh v0.2.1
```

This creates the git tag and a GitHub release; CI then builds and pushes the image.
Never run `docker build`/`docker push` locally for releases.

Docker Hub credentials are repository secrets (`DOCKERHUB_USERNAME`,
`DOCKERHUB_TOKEN`), used only by CI.

## Troubleshooting

- **Always shows offline / never detects:** make sure the container uses host network mode, devices are on the same subnet, and there is no client isolation on the router.
- **Stops detecting after a while:** the device is likely using a rotating private Wi-Fi address (iOS 18). Set it to `Fixed` or `Off` for that network.
- **No notifications:** open the settings UI at `http://<ihost-ip>:8082`, add your devices and set the webhook URL and/or VoiceMonkey. Check `/app/data/presence.log` for job output.
- **Offline takes ~3 minutes:** that is the expected `GRACE` (180s). Lower `GRACE` in the UI if you need faster offline detection.
- **Slow scans:** a large subnet (e.g. `/16` on a `dummy0` or secondary interface) was the main cause on iHost — `SCAN_PREFIX=24` mitigates it.