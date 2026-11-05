#!/usr/bin/env bash
# Run the AI service with auto-reload on AI_PORT (from ../.env, default 8001).
set -euo pipefail
cd "$(dirname "$0")"
source .venv/bin/activate
PORT="${AI_PORT:-$(grep -E '^AI_PORT=' ../.env 2>/dev/null | cut -d= -f2 || true)}"
PORT="${PORT:-8001}"
# Any listener on the port, IPv4 or IPv6: macOS would let uvicorn bind beside it and split the traffic.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
  echo "Stop that process, or set AI_PORT in backend/.env." >&2
  exit 1
fi
exec uvicorn app.main:app --reload --host 0.0.0.0 --port "$PORT"
