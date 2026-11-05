#!/usr/bin/env bash
# Backs up and restores a whole Cartly store, to move it between machines (laptop → server) or keep a copy:
# the database, the uploaded photos, the AI spend meter and, if you ask for it, the key that encrypts the
# payment and courier credentials.
#
#   store-data.sh backup [--with-secrets]   → $BACKUP_DIR/cartly-backup-<UTC time>.tar.gz
#   store-data.sh restore <file> [--yes]    replaces this store's data with the backup's
#   store-data.sh inspect <file>            what a backup holds, without touching anything
#
# With Docker, use the workspace's ./cartly backup / ./cartly restore (they run this in the `tools` container
# with the API and AI service stopped). Without Docker, stop the API and AI service, then run it from backend/:
# it reads backend/.env and needs pg_dump/psql (15+) and redis-cli on the PATH.
#
# A backup from an older Cartly restores fine: the API applies the newer migrations when it starts.
# One from a newer Cartly is refused (update the code first).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [ -z "${DATABASE_URL:-}" ] && [ -f "$HERE/../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERE/../.env"
  set +a
fi
: "${DATABASE_URL:?Set DATABASE_URL (or run this from backend/, next to .env)}"
REDIS_URL="${REDIS_URL:-redis://localhost:6379/0}"
UPLOAD_DIR="${UPLOAD_DIR:-$HERE/../uploads}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$HERE/../api/prisma/migrations}"
BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
PUBLIC_URL="${API_PUBLIC_URL:-http://localhost:${API_PORT:-4100}}"
PUBLIC_URL="${PUBLIC_URL%/}"
# Inside the Docker tools container, Redis belongs to Cartly alone and the secrets live on a volume.
IN_DOCKER="${CARTLY_TOOLS:-}"
[ -f /.dockerenv ] && IN_DOCKER=1

# libpq rejects Prisma-only URL parameters (schema=, connection_limit=…).
PGURL="$(sed -E 's/([?&])(schema|connection_limit|pool_timeout|pgbouncer|socket_timeout)=[^&]*&?/\1/g; s/[?&]$//' <<<"$DATABASE_URL")"
export PGCONNECT_TIMEOUT=10
# Only warnings and errors from PostgreSQL ("drop cascades to …" notices are expected on a restore).
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

die() { echo "✗ $*" >&2; exit 1; }
# The temporary folder of the backup being made or read; removed however the script ends.
WORK=""
trap '[ -z "$WORK" ] || rm -rf "$WORK"' EXIT
need() { command -v "$1" >/dev/null || die "$1 isn't installed (it comes with ${2:-PostgreSQL})."; }
sql() { psql "$PGURL" -v ON_ERROR_STOP=1 -qAtX -c "$1"; }
rcli() { redis-cli -u "$REDIS_URL" --no-auth-warning "$@"; }
get() { sed -n "s/^$1=//p" "$2" | head -1; }
human() { du -h "$1" | cut -f1; }

cmd_backup() {
  local with_secrets=0
  for a in "$@"; do
    case "$a" in
      --with-secrets) with_secrets=1 ;;
      *) die "Unknown option $a" ;;
    esac
  done
  need pg_dump; need psql; need redis-cli redis
  sql 'SELECT 1' >/dev/null || die "Can't reach the database."
  local name dir
  name="cartly-backup-$(date -u +%Y%m%d-%H%M%S)"
  WORK="$(mktemp -d)"
  dir="$WORK/$name"
  mkdir -p "$dir" "$BACKUP_DIR"

  echo "Database…"
  # Cartly's own tables only: the AI service rebuilds its search index (schema "ai") by itself.
  pg_dump "$PGURL" --schema=public --no-owner --no-privileges --clean --if-exists | gzip -6 > "$dir/database.sql.gz"
  sql "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1" > "$dir/migrations.txt"

  echo "Uploaded photos…"
  if [ -d "$UPLOAD_DIR" ]; then
    tar -C "$UPLOAD_DIR" --exclude='._*' --exclude='.DS_Store' -cf "$dir/uploads.tar" .
  else
    tar -cf "$dir/uploads.tar" -T /dev/null
  fi

  echo "AI spend meter…"
  : > "$dir/meter.redis"
  local key field value ttl
  while read -r key; do
    [ -n "$key" ] && [ "$(rcli TYPE "$key")" = hash ] || continue
    rcli --raw HGETALL "$key" | paste - - | while IFS=$'\t' read -r field value; do
      printf 'HSET %s "%s" %s\n' "$key" "$field" "$value"
    done >> "$dir/meter.redis"
    ttl="$(rcli TTL "$key")"
    [ "${ttl:-0}" -gt 0 ] && printf 'EXPIRE %s %s\n' "$key" "$ttl" >> "$dir/meter.redis"
  done < <(rcli --scan --pattern 'usage:*' | sort)

  if [ "$with_secrets" = 1 ]; then
    local key_value="${PAYMENT_SECRETS_KEY:-}"
    [ -z "$key_value" ] && [ -n "${SECRETS_FILE:-}" ] && [ -f "$SECRETS_FILE" ] && key_value="$(get PAYMENT_SECRETS_KEY "$SECRETS_FILE")"
    [ -n "$key_value" ] || die "No PAYMENT_SECRETS_KEY to include."
    printf 'PAYMENT_SECRETS_KEY=%s\n' "$key_value" > "$dir/secrets.env"
  fi

  {
    echo "FORMAT=1"
    echo "CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "PUBLIC_URL=$PUBLIC_URL"
    echo "LAST_MIGRATION=$(tail -1 "$dir/migrations.txt")"
    echo "PRODUCTS=$(sql 'SELECT count(*) FROM "Product"')"
    echo "ORDERS=$(sql 'SELECT count(*) FROM "Order"')"
    echo "USERS=$(sql 'SELECT count(*) FROM "User"')"
    echo "UPLOADS=$(tar -tf "$dir/uploads.tar" | grep -cv '/$' || true)"
    echo "WITH_SECRETS=$with_secrets"
  } > "$dir/manifest.txt"

  local out="$BACKUP_DIR/$name.tar.gz"
  (umask 077; tar -C "$WORK" -czf "$out" "$name")
  echo "✓ Backup: $out ($(human "$out")): $(get PRODUCTS "$dir/manifest.txt") products, $(get ORDERS "$dir/manifest.txt") orders, $(get USERS "$dir/manifest.txt") accounts, $(get UPLOADS "$dir/manifest.txt") photos."
  echo "  It holds customers' names, addresses and orders: keep it somewhere private."
  [ "$with_secrets" = 1 ] && echo "  It also holds PAYMENT_SECRETS_KEY, which unlocks the payment and courier credentials inside it."
  return 0
}

# Unpacks a backup into $WORK and sets $dir to its folder.
unpack() {
  local file="$1"
  [ -f "$file" ] || die "No such file: $file"
  WORK="$(mktemp -d)"
  tar -C "$WORK" -xzf "$file" || die "$file isn't a Cartly backup (.tar.gz)."
  dir="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
  [ -n "$dir" ] && [ -f "$dir/manifest.txt" ] && [ -f "$dir/database.sql.gz" ] || die "$file isn't a Cartly backup (no manifest)."
  [ "$(get FORMAT "$dir/manifest.txt")" = 1 ] || die "This backup's format is newer than this script. Update Cartly first."
}

describe() {
  local m="$dir/manifest.txt"
  echo "Backup from $(get CREATED "$m") at $(get PUBLIC_URL "$m")"
  echo "  $(get PRODUCTS "$m") products · $(get ORDERS "$m") orders · $(get USERS "$m") accounts · $(get UPLOADS "$m") photos"
  echo "  database schema: $(get LAST_MIGRATION "$m")"
  [ "$(get WITH_SECRETS "$m")" = 1 ] && echo "  includes PAYMENT_SECRETS_KEY (payment and courier credentials stay readable)"
  return 0
}

cmd_inspect() {
  [ $# -ge 1 ] || die "Usage: store-data.sh inspect <backup.tar.gz>"
  local dir
  unpack "$1"
  describe
}

cmd_restore() {
  local file="" yes=0
  for a in "$@"; do
    case "$a" in
      --yes | -y) yes=1 ;;
      -*) die "Unknown option $a" ;;
      *) file="$a" ;;
    esac
  done
  [ -n "$file" ] || die "Usage: store-data.sh restore <backup.tar.gz> [--yes]"
  need psql; need redis-cli redis
  local dir
  unpack "$file"
  describe

  # A backup can be older than this code (migrations fill the gap) but not newer.
  if [ -d "$MIGRATIONS_DIR" ]; then
    local unknown
    unknown="$(while read -r m; do [ -z "$m" ] || [ -d "$MIGRATIONS_DIR/$m" ] || echo "$m"; done < "$dir/migrations.txt")"
    [ -z "$unknown" ] || die "This backup comes from a newer Cartly (database changes this code doesn't have: $(echo $unknown)). Update the code, then restore."
  fi
  sql 'SELECT 1' >/dev/null || die "Can't reach the database."

  if [ "$yes" != 1 ]; then
    local here
    here="$(sql "SELECT (SELECT count(*) FROM \"Product\") || ' products, ' || (SELECT count(*) FROM \"Order\") || ' orders'" 2>/dev/null || echo "nothing yet")"
    echo
    echo "This REPLACES everything in this store ($here) with the backup."
    [ -t 0 ] || die "Run it with --yes to confirm."
    read -r -p "Type 'restore' to go on: " answer
    [ "$answer" = restore ] || die "Nothing changed."
  fi

  echo "Database…"
  # The search index (schema "ai") is rebuilt by the AI service when it starts. pgvector lives in public and goes
  # with it; the AI service creates it again.
  sql 'DROP SCHEMA IF EXISTS ai CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
  gunzip -c "$dir/database.sql.gz" | grep -v '^SET transaction_timeout' | psql "$PGURL" -v ON_ERROR_STOP=1 -qX --single-transaction >/dev/null

  # Photo addresses point at the old install; move them to this one.
  local old_url
  old_url="$(get PUBLIC_URL "$dir/manifest.txt")"
  if [ -n "$old_url" ] && [ "$old_url" != "$PUBLIC_URL" ]; then
    echo "Photo addresses: $old_url → $PUBLIC_URL"
    psql "$PGURL" -v ON_ERROR_STOP=1 -qX -v old="$old_url/api/v1/uploads/" -v new="$PUBLIC_URL/api/v1/uploads/" >/dev/null <<'SQL'
SELECT set_config('cartly.old', :'old', false), set_config('cartly.new', :'new', false);
DO $$
DECLARE r record; o text := current_setting('cartly.old'); n text := current_setting('cartly.new');
BEGIN
  FOR r IN SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND data_type IN ('text', 'character varying') LOOP
    EXECUTE format('UPDATE public.%I SET %I = replace(%I, %L, %L) WHERE %I LIKE %L',
                   r.table_name, r.column_name, r.column_name, o, n, r.column_name, o || '%');
  END LOOP;
END $$;
SQL
  fi

  echo "Uploaded photos…"
  mkdir -p "$UPLOAD_DIR"
  find "$UPLOAD_DIR" -mindepth 1 -delete
  tar -C "$UPLOAD_DIR" -xf "$dir/uploads.tar"

  echo "Carts, chats and caches…"
  if [ -n "$IN_DOCKER" ]; then
    rcli FLUSHDB >/dev/null # Cartly's own Redis: carts and Pip's memory belong to the old accounts
  else
    # A shared local Redis: only what's tied to the old accounts and catalog.
    local pattern
    for pattern in 'cart:*' 'agent:*' 'pip:*' 'greet:*' 'search:*' 'profile:*' 'reco:*' 'usage:*'; do
      rcli --scan --pattern "$pattern" | xargs -r -n 200 redis-cli -u "$REDIS_URL" --no-auth-warning DEL >/dev/null
    done
    rcli INCR catalog:version >/dev/null
  fi
  [ -s "$dir/meter.redis" ] && rcli < "$dir/meter.redis" >/dev/null

  if [ -f "$dir/secrets.env" ]; then
    local key_value
    key_value="$(get PAYMENT_SECRETS_KEY "$dir/secrets.env")"
    if [ -n "${SECRETS_FILE:-}" ] && [ -f "$SECRETS_FILE" ]; then
      sed -i.bak "s#^PAYMENT_SECRETS_KEY=.*#PAYMENT_SECRETS_KEY=$key_value#" "$SECRETS_FILE" && rm -f "$SECRETS_FILE.bak"
      echo "PAYMENT_SECRETS_KEY: taken from the backup."
    elif [ -f "$HERE/../.env" ]; then
      cp "$HERE/../.env" "$HERE/../.env.before-restore"
      if grep -q '^PAYMENT_SECRETS_KEY=' "$HERE/../.env"; then
        sed -i.bak "s#^PAYMENT_SECRETS_KEY=.*#PAYMENT_SECRETS_KEY=$key_value#" "$HERE/../.env" && rm -f "$HERE/../.env.bak"
      else
        echo "PAYMENT_SECRETS_KEY=$key_value" >> "$HERE/../.env"
      fi
      echo "PAYMENT_SECRETS_KEY: taken from the backup into backend/.env (the old file is .env.before-restore)."
    fi
  elif [ "$(sql 'SELECT (SELECT count(*) FROM "PaymentGateway") + (SELECT count(*) FROM "Courier")')" != 0 ]; then
    echo "! Payment and courier credentials in it were encrypted on the old install. Unless both use the same"
    echo "  PAYMENT_SECRETS_KEY, enter them again (Admin → Payments → Settings, Delivery → Couriers), or restore a"
    echo "  backup made with --with-secrets."
  fi

  if [ -n "$IN_DOCKER" ]; then
    echo "✓ Data restored."
  else
    echo "✓ Restored. Start the API and AI service: the API brings the database schema up to date and the AI"
    echo "  service rebuilds the search index. Signed-in users stay signed in only if JWT_SECRET is the same."
  fi
}

case "${1:-help}" in
  backup) shift; cmd_backup "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  inspect) shift; cmd_inspect "$@" ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; [ "${1:-help}" = help ] || exit 2 ;;
esac
