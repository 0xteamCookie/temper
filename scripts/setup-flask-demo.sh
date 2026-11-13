#!/usr/bin/env bash
# Prepare the Flask demo project: clone pallets/flask at 3.1.3 and create a virtualenv.
# Usage: scripts/setup-flask-demo.sh [target-dir]   (default: ../flask)
set -euo pipefail

TAG="3.1.3"
EXPECTED_SHA="22d92470"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$ROOT/../flask}"

if [ ! -d "$TARGET/.git" ]; then
  git clone --branch "$TAG" --depth 1 https://github.com/pallets/flask.git "$TARGET"
fi

head_sha="$(git -C "$TARGET" rev-parse HEAD)"
case "$head_sha" in
  "$EXPECTED_SHA"*) echo "Flask HEAD is $head_sha" ;;
  *) echo "Unexpected Flask HEAD $head_sha (expected ${EXPECTED_SHA}...)" >&2; exit 1 ;;
esac

PY="${PYTHON:-python}"
command -v "$PY" >/dev/null || PY=python3

cd "$TARGET"
"$PY" -m venv .venv
if [ -x .venv/Scripts/python.exe ]; then VENV_PY=.venv/Scripts/python.exe; else VENV_PY=.venv/bin/python; fi

# pytest 9 breaks tests/test_cli.py, so pin it below 9.
"$VENV_PY" -m pip install -e . "pytest<9"

echo "Flask demo ready at $TARGET"
