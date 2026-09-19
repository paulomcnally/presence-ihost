#!/bin/sh
set -e

# Start the settings server (Go) in the background
/app/settings-server &
SETTINGS_PID=$!

# Schedule the presence job every minute
echo "*/1 * * * * python3 -u /app/presence.py >> /app/data/presence.log 2>&1" > /etc/crontabs/root
crond -b -l 8

# Run once on startup so state is fresh immediately
python3 -u /app/presence.py >> /app/data/presence.log 2>&1 || true

# Keep the container alive
trap "kill $SETTINGS_PID 2>/dev/null || true" TERM INT
wait $SETTINGS_PID