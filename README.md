# presence-ihost

Presence detection for devices on your home Wi-Fi/LAN, designed to run as a Docker container on a SONOFF iHost (eWeLink CUBE OS).

The container scans your local network via ARP and reports which of your configured devices (identified by MAC address) are currently online. It also exposes a small HTTP API so you can query presence status from other automations (Node-RED, Home Assistant, scripts, etc.).

## How it works

1. Every `INTERVAL` seconds (default 30s) the container scans the local network using `arp-scan` (with a `ping` + `/proc/net/arp` fallback).
2. It tracks each configured device and marks it `online` when its MAC address is seen. A device goes `offline` only after `GRACE` seconds (default 180s) have passed since it was last seen — this avoids false negatives from devices in sleep mode.
3. When you query the HTTP API, it triggers a fresh scan if the last one is older than `SCAN_COOLDOWN` seconds (default 5s), so results are near real-time.

> **Important:** the container must run with **host network mode**. A bridge network would isolate it from your LAN and it would not see any devices.

## Requirements

- A SONOFF iHost with eWeLink CUBE OS (Docker support) — image is built for `linux/arm/v7` and `linux/amd64`.
- The device(s) you want to track must be on the same LAN as the iHost (same subnet, no client isolation, no separate VLAN).
- A `.env` configuration file mounted into the container.

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
3. Place a `.env` file in that directory (see `.env.example`).
4. Start the container and check the API:
   ```
   curl http://<ihost-ip>:8081/
   ```

Example response:

```json
[
  {
    "device_name": "Iphone de Paulo",
    "status": "online",
    "mac": "00:11:22:33:44:55",
    "ip": "192.168.1.100"
  }
]
```

## Configuration (.env)

Mount your `.env` at `/app/data/.env` (the path is configurable via the `ENV_FILE` variable). Environment variables passed to the container take precedence over the `.env` file.

| Variable | Default | Description |
| --- | --- | --- |
| `DEVICES` | *(required)* | Comma-separated list of `DEVICE_NAME:MAC_ADDRESS` pairs, e.g. `Iphone de Paulo:00:11:22:33:44:55,MacBook:aa:bb:cc:dd:ee:ff` |
| `PORT` | `8081` | HTTP server port |
| `INTERVAL` | `30` | Seconds between background scans |
| `GRACE` | `180` | Seconds without being seen before a device is marked offline |
| `IFACES` | *(auto)* | Comma-separated network interfaces to scan, e.g. `eth0,wlan0`. Empty = auto-detect |
| `SCAN_PREFIX` | `24` | Max subnet size to scan (netmask). Interfaces with a larger subnet (e.g. `/16`) are reduced to this prefix to keep scans fast |
| `SCAN_COOLDOWN` | `5` | Seconds of freshness allowed before the API triggers a new scan on request |
| `WEBHOOK_URL` | *(none)* | Optional URL that receives a `POST` JSON on state changes (`device_present`, `device_away`, `anyone_home`, `anyone_away`) |
| `STATE_FILE` | `/app/data/state.json` | Where the JSON state snapshot is written |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |

## HTTP API

| Endpoint | Description |
| --- | --- |
| `GET /` | Device presence list, e.g. `[{"device_name": "...", "status": "online", "mac": "...", "ip": "..."}]`. Triggers a fresh scan if stale |
| `GET /health` | `{"status": "ok"}` — liveness check |
| `GET /debug` | Diagnostics: interfaces found, last scan duration, number of devices seen |

If no `.env` file is found, the server still runs and `/` responds with:

```json
{"error": {"message": ".env file required"}}
```

## Running with Docker (non-iHost)

```bash
cp .env.example .env   # edit with your devices
mkdir -p data && cp .env data/.env
docker compose up -d
```

Or directly:

```bash
docker run -d --name presence-ihost \
  --network host \
  --restart unless-stopped \
  -v $PWD/data:/app/data \
  paulomcnally/presence-ihost:latest
```

## Building from source

```bash
docker buildx build --platform linux/arm/v7,linux/amd64 \
  -t <your-user>/presence-ihost:latest --push .
```

## Troubleshooting

- **Always shows offline / never detects:** make sure the container uses host network mode, devices are on the same subnet, and there is no client isolation on the router.
- **Stops detecting after a while:** the device is likely using a rotating private Wi-Fi address (iOS 18). Set it to `Fixed` or `Off` for that network.
- **`{"error": {"message": ".env file required"}}`:** the `.env` file is not mounted at `/app/data/.env`.
- **Offline takes ~3 minutes:** that is the expected `GRACE` (180s) + scan interval. Lower `GRACE` if you need faster offline detection.
- **Slow responses:** check `GET /debug` for `last_scan_ms`. A large subnet (e.g. `/16` on a `dummy0` or secondary interface) was the main cause on iHost — `SCAN_PREFIX=24` mitigates it.