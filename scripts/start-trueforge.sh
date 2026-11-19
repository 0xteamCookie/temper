#!/usr/bin/env bash
# Start a local TrueForge (pinned) bound to 127.0.0.1:8790 and wait until it is ready.
set -euo pipefail

TRUEFORGE_VERSION="0.185.0"
PORT=8790
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT/.trueforge"
LOG="$STATE_DIR/tf.log"
URL="http://127.0.0.1:${PORT}/"

mkdir -p "$STATE_DIR"

if curl -fs -o /dev/null "$URL"; then
  echo "TrueForge is already running at $URL"
  exit 0
fi

# Only 127.0.0.1 may be registered as an outbound MCP/provider host (exact-host match).
# Bind to IPv4 explicitly: TrueForge's default HOST=localhost resolves to ::1 on many Linux systems.
export HOST=127.0.0.1
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'
export SQLITE_PATH="$STATE_DIR/trueforge.db"

echo "Starting TrueForge ${TRUEFORGE_VERSION} (log: $LOG)"
nohup npx -y "@truefoundry/trueforge@${TRUEFORGE_VERSION}" >"$LOG" 2>&1 &
echo $! >"$STATE_DIR/tf.pid"

# The first start downloads the package and can take 60-90 seconds.
for _ in $(seq 1 180); do
  if curl -fs -o /dev/null "$URL"; then
    echo "TrueForge is ready at $URL"
    exit 0
  fi
  sleep 1
done

echo "TrueForge did not become ready within 180s. See $LOG" >&2
exit 1
