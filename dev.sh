#!/usr/bin/env bash
# One command for the whole Cartly dev stack: API, AI service, storefront and admin panel.
#   ./dev.sh          start everything in this terminal (Ctrl-C stops it all)
#   ./dev.sh status   show what is on Cartly's ports
#   ./dev.sh stop     stop Cartly servers left running by an earlier session
# Before starting it checks Postgres and Redis (starting them with Homebrew if needed), installs packages that
# are missing or changed, applies new database migrations (and loads the demo store into an empty database),
# stops leftover Cartly servers, and refuses to start if another project holds one of the ports, naming it.
# For Docker instead (nothing to install but Docker): ./cartly up
# Ports: API_PORT and AI_PORT from backend/.env; the frontends are pinned in their vite.config.js.
set -o pipefail
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
ENV_FILE="$ROOT/backend/.env"

env_get() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1; }
API_PORT="${API_PORT:-$(env_get API_PORT)}"
AI_PORT="${AI_PORT:-$(env_get AI_PORT)}"
DATABASE_URL="${DATABASE_URL:-$(env_get DATABASE_URL)}"
REDIS_URL="${REDIS_URL:-$(env_get REDIS_URL)}"

NAMES=(api ai storefront admin)
PORTS=("${API_PORT:-4100}" "${AI_PORT:-8001}" 5173 5174)
DIRS=(backend/api backend/ai storefront admin)
CMDS=("npm run start:dev" "./run.sh" "npm run dev" "npm run dev")
URLS=("/api/v1 (docs: /docs)" "" "" "")
COLORS=(36 35 32 33)
# The long-running processes of each service, matched by their absolute paths inside this checkout.
SERVERS="$ROOT/(backend/api/node_modules/.bin/nest|backend/api/dist/main|backend/ai/.venv/bin/uvicorn|storefront/node_modules/.bin/vite|admin/node_modules/.bin/vite)([[:space:]]|$)"

listeners() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u; }
cwd_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; }
ours() { case "$(cwd_of "$1")/" in "$ROOT"/*) return 0 ;; *) return 1 ;; esac; }
# "PID 123: next-server (v16.3.6) (in /path/to/project)", the program without its install path.
describe() { echo "PID $1: $(ps -o command= -p "$1" | awk '{ n = split($1, a, "/"); $1 = a[n]; print }' | cut -c1-70) (in $(cwd_of "$1"))"; }
kill_tree() { local c; for c in $(pgrep -P "$1"); do kill_tree "$c"; done; kill "$1" 2>/dev/null; }

# Something accepting connections at the host:port of a URL like postgresql://user@localhost:5432/db?
reachable() {
  local hp; hp=$(sed -E 's#^[a-z+]+://([^@/]*@)?([^/?]+).*#\2#' <<<"$1")
  (exec 3<>"/dev/tcp/${hp%:*}/${hp##*:}") 2>/dev/null
}

# Postgres and Redis: start the Homebrew service if it's down (it then also starts at every login).
need() {
  local name=$1 url=$2 formula=$3 i
  reachable "$url" && return 0
  if [ -n "$formula" ]; then
    echo "$name is down; starting it: brew services start $formula"
    brew services start "$formula" >/dev/null 2>&1
    for i in $(seq 1 20); do reachable "$url" && return 0; sleep 1; done
  fi
  echo "✗ $name isn't reachable at $(sed -E 's#^[a-z+]+://([^@/]*@)?([^/?]+).*#\2#' <<<"$url"). Start it and run ./dev.sh again." >&2
  exit 1
}
# The registered formula (postgresql@15 when several versions are installed), else the only one installed.
brew_formula() {
  command -v brew >/dev/null && brew services list 2>/dev/null |
    awk -v p="^$1" '$1 ~ p { n++; one = $1; if ($2 != "none" && !reg) reg = $1 } END { print reg ? reg : (n == 1 ? one : "") }'
}

# Cartly servers still running: matched by path, plus anything on our ports started from this checkout.
leftovers() {
  local i pid
  pgrep -f "$SERVERS"
  for i in 0 1 2 3; do
    for pid in $(listeners "${PORTS[$i]}"); do ours "$pid" && echo "$pid"; done
  done
}

stop_all() {
  local i pid pids
  pids=$(leftovers)
  [ -z "$pids" ] && return 0
  echo "$1"
  for pid in $pids; do kill_tree "$pid"; done
  for i in $(seq 1 20); do pids=$(leftovers); [ -z "$pids" ] && return 0; sleep 0.5; done
  kill -9 $pids 2>/dev/null
}

status() {
  local i pid
  for i in 0 1 2 3; do
    pid=$(listeners "${PORTS[$i]}" | head -1)
    if [ -z "$pid" ]; then state="free"
    elif ours "$pid"; then state="running  http://localhost:${PORTS[$i]}${URLS[$i]%% *}"
    else state="TAKEN by another project: $(describe "$pid")"; fi
    printf '  %-10s :%-5s %s\n' "${NAMES[$i]}" "${PORTS[$i]}" "$state"
  done
}

case "${1:-start}" in
  status) status; exit 0 ;;
  stop) stop_all "Stopping Cartly…"; status; exit 0 ;;
  start) ;;
  *) sed -n '2,5p' "$0"; exit 2 ;;
esac

# 1. Everything the servers need.
[ -f "$ENV_FILE" ] || { echo "✗ Missing backend/.env: cp backend/.env.example backend/.env" >&2; exit 1; }
for i in 0 1 2 3; do
  [ -d "$ROOT/${DIRS[$i]}" ] || { echo "✗ Missing ${DIRS[$i]}/ (clone the three Cartly repos side by side)" >&2; exit 1; }
done
reachable "$DATABASE_URL" || need Postgres "$DATABASE_URL" "$(brew_formula postgresql)"
reachable "$REDIS_URL" || need Redis "$REDIS_URL" "$(brew_formula redis || true)"

# Packages: installed when missing or when a pull changed the lock file / requirements.
for dir in backend/api storefront admin; do
  if [ ! -d "$ROOT/$dir/node_modules" ] || [ "$ROOT/$dir/package-lock.json" -nt "$ROOT/$dir/node_modules/.package-lock.json" ]; then
    echo "Installing $dir packages…"
    (cd "$ROOT/$dir" && npm install --no-audit --no-fund --loglevel=error) || { echo "✗ npm install failed in $dir" >&2; exit 1; }
  fi
done
AI="$ROOT/backend/ai"
if [ ! -x "$AI/.venv/bin/python" ]; then
  echo "Creating backend/ai/.venv…"
  python3 -m venv "$AI/.venv" || { echo "✗ Couldn't create the AI service's venv (needs Python 3.12+)" >&2; exit 1; }
fi
if [ ! -f "$AI/.venv/.installed" ] || [ "$AI/requirements.txt" -nt "$AI/.venv/.installed" ]; then
  echo "Installing the AI service's Python packages…"
  # (pip's "Ignoring invalid distribution" lines come from macOS ._ files on non-APFS drives: left out.)
  out=$("$AI/.venv/bin/pip" install -q -r "$AI/requirements.txt" 2>&1) && ok=1 || ok=0
  grep -v '^WARNING: Ignoring invalid distribution' <<<"$out" || true
  [ "$ok" = 1 ] || { echo "✗ pip install failed" >&2; exit 1; }
  touch "$AI/.venv/.installed"
fi

# The database schema: whatever migrations a pull brought (nothing to do most days), and on an empty database
# the demo store plus the test kit (scripts/first-run.ts; a database that has products is left as it is).
echo "Checking the database schema…"
(cd "$ROOT/backend/api" && npx prisma migrate deploy 2>&1 | grep -E "Applying|applied|No pending|Error|error" | sed 's/^/  /') || true
(cd "$ROOT/backend/api" && npx prisma migrate status >/dev/null 2>&1) || { echo "✗ The database schema isn't up to date: cd backend/api && npx prisma migrate deploy" >&2; exit 1; }
(cd "$ROOT/backend/api" && npx tsx scripts/first-run.ts 2>&1 | sed 's/^/  /') || echo "! First-run setup didn't finish (see above); the servers start anyway."

# 2. Ports: clear our own leftovers, refuse to touch anyone else's.
stop_all "Stopping Cartly servers left from an earlier session…"
taken=0
for i in 0 1 2 3; do
  for pid in $(listeners "${PORTS[$i]}"); do
    echo "✗ Port ${PORTS[$i]} (${NAMES[$i]}) is taken by $(describe "$pid")" >&2
    taken=1
  done
done
if [ "$taken" = 1 ]; then
  echo "  Stop that process, or move Cartly: API_PORT / AI_PORT in backend/.env, the frontend ports in their vite.config.js." >&2
  exit 1
fi

# 3. Start all four, output labelled, and stop them together.
PIDS=()
cleanup() {
  trap - INT TERM HUP EXIT
  echo; echo "Stopping Cartly…"
  local pid; for pid in "${PIDS[@]}"; do kill_tree "$pid"; done
  wait 2>/dev/null
}
trap cleanup INT TERM HUP EXIT
[ -t 1 ] && export FORCE_COLOR=1
for i in 0 1 2 3; do
  label=$(printf '%-10s|' "${NAMES[$i]}")
  [ -t 1 ] && label=$(printf '\033[%sm%s\033[0m' "${COLORS[$i]}" "$label")
  (cd "$ROOT/${DIRS[$i]}" && exec ${CMDS[$i]}) \
    > >(awk -v p="$label " '{ print p $0; fflush() }') 2>&1 < /dev/null &
  PIDS+=($!)
done

# 4. Report when each one answers.
pending="0 1 2 3"
for t in $(seq 1 120); do
  left=""
  for i in $pending; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:${PORTS[$i]}/")
    if [ "$code" != "000" ]; then printf '✓ %-10s http://localhost:%s%s\n' "${NAMES[$i]}" "${PORTS[$i]}" "${URLS[$i]}"
    elif ! kill -0 "${PIDS[$i]}" 2>/dev/null; then printf '✗ %-10s exited; see its log above\n' "${NAMES[$i]}"
    else left="$left $i"; fi
  done
  pending=$left
  [ -z "$pending" ] && break
  sleep 1
done
for i in $pending; do printf '… %-10s not answering after 2 minutes; see its log above\n' "${NAMES[$i]}"; done
echo "Cartly is running. Ctrl-C stops everything."
wait
