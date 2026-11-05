#!/bin/sh
# The AI service container's start: the shared secrets (made by the API), then uvicorn.
set -e
. /app/docker/secrets.sh
cd /app
exec uvicorn app.main:app --host 0.0.0.0 --port "${AI_PORT:-8001}"
