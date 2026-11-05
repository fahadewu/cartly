# Sourced by the Docker entrypoints. Fills JWT_SECRET, INTERNAL_API_KEY and PAYMENT_SECRETS_KEY when they
# aren't set, from a file on the `cartly-secrets` volume, so a fresh install needs no configuration.
# The API creates the file on its first start (SECRETS_CREATE=1 before sourcing it; `.` takes no arguments in
# dash); the AI service waits for it.
# Values set in the environment (the workspace .env) always win.
SECRETS_FILE="${SECRETS_FILE:-/var/lib/cartly/secrets.env}"

if [ "${SECRETS_CREATE:-}" = 1 ] && [ ! -s "$SECRETS_FILE" ]; then
  mkdir -p "$(dirname "$SECRETS_FILE")"
  (
    umask 077
    random() { head -c 36 /dev/urandom | base64 | tr -d '\n/+='; }
    {
      echo "JWT_SECRET=$(random)"
      echo "INTERNAL_API_KEY=$(random)"
      echo "PAYMENT_SECRETS_KEY=$(random)"
    } > "$SECRETS_FILE.tmp"
    mv "$SECRETS_FILE.tmp" "$SECRETS_FILE"
  )
  echo "Generated this install's secrets in $SECRETS_FILE (the cartly-secrets volume)."
fi

_waited=0
while [ ! -s "$SECRETS_FILE" ]; do
  if [ "$_waited" -ge 120 ]; then
    echo "No $SECRETS_FILE after 2 minutes: the API creates it on its first start. Is the api service running?" >&2
    exit 1
  fi
  sleep 1
  _waited=$((_waited + 1))
done

while IFS='=' read -r _key _value; do
  case "$_key" in
    JWT_SECRET | INTERNAL_API_KEY | PAYMENT_SECRETS_KEY)
      eval "_current=\${$_key:-}"
      [ -z "$_current" ] && export "$_key=$_value"
      ;;
  esac
done < "$SECRETS_FILE"
unset _key _value _current _waited SECRETS_CREATE
