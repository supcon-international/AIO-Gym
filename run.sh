#!/usr/bin/env bash
# Run AIO-Gym. It is a pure client-side web app (no backend, no install) — this
# just serves the static files in frontend/.
#   ./run.sh            -> http://127.0.0.1:8000
#   PORT=9000 ./run.sh
set -e
cd "$(dirname "$0")"
exec python3 serve.py "${PORT:-8000}"
