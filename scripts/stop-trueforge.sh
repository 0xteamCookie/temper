#!/usr/bin/env bash
# Stop the local TrueForge by killing whatever listens on port 8790.
set -euo pipefail

PORT=8790

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    pids="$(netstat -ano | grep -E ":${PORT} .*LISTENING" | awk '{print $5}' | sort -u || true)"
    if [ -z "$pids" ]; then
      echo "Nothing is listening on port ${PORT}"
      exit 0
    fi
    for pid in $pids; do
      taskkill //F //PID "$pid" >/dev/null && echo "Stopped PID $pid"
    done
    ;;
  *)
    pids="$(lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -z "$pids" ]; then
      echo "Nothing is listening on port ${PORT}"
      exit 0
    fi
    # shellcheck disable=SC2086
    kill $pids && echo "Stopped PID(s) $pids"
    ;;
esac
