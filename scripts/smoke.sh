#!/usr/bin/env bash
# A quick end-to-end check of a running Cartly (./cartly smoke), the way a shopper and an admin would use it:
# pages load, sign-in works, the catalog, Pip, festivals, Ask family, the stamp card and the admin API answer.
# Everything goes through the storefront's address (its /api proxy), like a browser. Needs bash and curl only.
# Whatever it creates (a shared look and its vote) it deletes again.
set -uo pipefail
STOREFRONT="${STOREFRONT:-http://localhost:5173}"
ADMIN="${ADMIN:-http://localhost:5174}"
API="$STOREFRONT/api/v1"
ok=0
fail=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n      %s\n' "$1" "${2:0:300}"; fail=$((fail + 1)); }
# check "<what>" "<text the body must contain>" curl-args…
check() {
  local what="$1" want="$2"; shift 2
  local body
  body="$(curl -sS --max-time 60 "$@" 2>&1)" || { bad "$what" "$body"; return 1; }
  if [[ "$body" == *"$want"* ]]; then pass "$what"; else bad "$what" "$body"; return 1; fi
  LAST="$body"
}
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" <<<"$LAST" | head -1; }
json=(-H 'content-type: application/json')

echo "Cartly smoke test against $STOREFRONT"

echo "Pages"
check "store page loads" '<div id="app"' "$STOREFRONT/"
check "a product page loads (SPA route)" '<div id="app"' "$STOREFRONT/product/17"
check "the Ask family voting page loads" '<div id="app"' "$STOREFRONT/look/example"
check "admin panel loads" '<div id="app"' "$ADMIN/"

echo "API through the store's proxy"
check "health: database, Redis, AI service" '"status":"ok"' "$API/health"
check "catalog bootstrap has products and quiz styles" '"styles":[' "$API/catalog"
check "product detail has real star counts and fit feedback" '"ratingCounts":[' "$API/products/17"
check "semantic search answers" '"items":[' "$API/products/search?q=red%20dress"
check "festival deadlines answer" '"moments":' "$API/festivals?tz=Asia/Dhaka&locale=bn-BD"
check "support contact answers" '"whatsapp":' "$API/support"

echo "Pip (rule brain without an AI key, Claude with one)"
check "Pip answers a shopping question" '"text":' "${json[@]}" -X POST "$API/assistant/chat" -d '{"message":"show me a red dress","context":{"timeZone":"Asia/Dhaka","locale":"en-US"}}'
check "Pip greets" '"text":' "${json[@]}" -X POST "$API/assistant/chat" -d '{"kind":"greet","context":{"timeZone":"Asia/Dhaka"}}'

echo "Shopper"
if check "demo shopper signs in" '"accessToken"' "${json[@]}" -X POST "$API/auth/login" -d '{"email":"demo@cartly.dev","password":"Demo1234!"}'; then
  TOKEN="$(field accessToken)"
  auth=(-H "authorization: Bearer $TOKEN")
  check "their account" '"email":"demo@cartly.dev"' "${auth[@]}" "$API/auth/me"
  check "their orders" '[' "${auth[@]}" "$API/orders"
  check "their stamp card (off unless the store turns it on)" '"enabled":' "${auth[@]}" "$API/me/stamps"
  check "their preferences (sizes, style quiz)" '"styles":' "${auth[@]}" "$API/me/preferences"
fi

echo "Ask family (share a look, vote without an account, stop sharing)"
if check "share a look" '"ownerKey"' "${json[@]}" -X POST "$API/looks" -d '{"items":[{"productId":17,"color":"Scarlet","size":"M"}],"note":"Smoke test","name":"Smoke"}'; then
  LOOK="$(field token)"
  KEY="$(field ownerKey)"
  VOTER="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || echo 3b241101-e2bb-4255-8caf-4136c566a962)"
  check "a family member votes" '"total":1' "${json[@]}" -X POST "$API/looks/$LOOK/votes" -d "{\"voterId\":\"$(tr 'A-Z' 'a-z' <<<"$VOTER")\",\"reaction\":\"love\",\"name\":\"Ammu\",\"tags\":[\"occasion\"]}"
  check "anyone with the link sees the votes" '"reactions":{"love":1' "$API/looks/$LOOK"
  code="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "x-look-key: $KEY" "$API/looks/$LOOK")"
  [ "$code" = 204 ] && pass "the sharer stops sharing" || bad "the sharer stops sharing" "HTTP $code"
fi

echo "Admin"
if check "admin signs in" '"accessToken"' "${json[@]}" -X POST "$API/auth/login" -d '{"email":"admin@cartly.dev","password":"Admin1234!"}'; then
  ADMIN_TOKEN="$(field accessToken)"
  check "dashboard figures" '"series":' -H "authorization: Bearer $ADMIN_TOKEN" "$API/admin/stats?days=7"
  check "reviews queue (with fit and photo fields)" '"items":' -H "authorization: Bearer $ADMIN_TOKEN" "$API/admin/reviews"
  check "stamp card settings" '"target":' -H "authorization: Bearer $ADMIN_TOKEN" "$API/admin/loyalty"
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32m✓ %d checks passed.\033[0m\n' "$ok"
else
  printf '\033[31m✗ %d of %d checks failed.\033[0m\n' "$fail" "$((ok + fail))"
  exit 1
fi
