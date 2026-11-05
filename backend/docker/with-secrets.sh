#!/bin/sh
# Runs a command with this install's secrets, for one-off commands in a running container:
#   docker compose exec api sh /app/docker/with-secrets.sh npm run catalog:export
set -e
. /app/docker/secrets.sh
exec "$@"
