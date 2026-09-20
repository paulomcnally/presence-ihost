#!/bin/sh
set -e

# Start the settings server (Go) in the background
/app/settings-server &
SETTINGS_PID=$!

# Schedule the presence job every minute
echo "*/1 * * * * python3 -u /app/presence.py >> /app/data/presence.log 2>&1" > /etc/crontabs/root
crond -b -l 8

# Passive sniffing daemon (Layer 1). Restarts itself if it crashes.
# Exit code 0 means sniffing is disabled/unavailable by config -> stop for good.
start_sniffer() {
  while true; do
    if python3 -u /app/sniffer.py >> /app/data/presence.log 2>&1; then
      code=0
    else
      code=$?
    fi
    if [ "$code" -eq 0 ]; then
      echo "$(date) [sniffer] stopped (exit 0)"
      return
    fi
    echo "$(date) [sniffer] died with code $code, restarting in 2s"
    sleep 2
  done
}
start_sniffer &
SNIFFER_PID=$!

# Run once on startup so state is fresh immediately
python3 -u /app/presence.py >> /app/data/presence.log 2>&1 || true

# Keep the container alive
trap "kill $SETTINGS_PID $SNIFFER_PID 2>/dev/null || true" TERM INT
wait $SETTINGS_PID