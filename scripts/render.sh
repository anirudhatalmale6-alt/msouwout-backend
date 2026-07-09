#!/usr/bin/env bash
# Render operations for msouwout-backend, without the dashboard.
#
#   export RENDER_API_KEY=rnd_xxx
#   scripts/render.sh status     # services, latest deploy, live health
#   scripts/render.sh logs       # recent logs for the backend service
#   scripts/render.sh deploy     # trigger a deploy (clears build cache)
#   scripts/render.sh restart    # restart the running instance
#   scripts/render.sh db         # postgres instances and their expiry
#
# Exists because on 2026-07-09 the backend stopped answering and there was no
# way to see why from outside.

set -euo pipefail

API="https://api.render.com/v1"
KEY="${RENDER_API_KEY:?set RENDER_API_KEY}"
SERVICE_NAME="${SERVICE_NAME:-msouwout-backend}"

# Render answers errors with a JSON object, not the list the callers expect.
# Fail here with the actual message instead of a confusing parse error later.
api() {
  local body code
  body="$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $KEY" -H "Accept: application/json" "$@")"
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
    echo "Render API returned HTTP $code: $body" >&2
    return 1
  fi
  printf '%s' "$body"
}

service_id() {
  api "$API/services?limit=100" \
    | python3 -c "import json,sys
name=sys.argv[1]
for row in json.load(sys.stdin):
    s=row.get('service',row)
    if s.get('name')==name:
        print(s['id']); break
else:
    sys.exit('no service named '+name)" "$SERVICE_NAME"
}

owner_id() {
  api "$API/owners?limit=1" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['owner']['id'])"
}

case "${1:-status}" in
  status)
    echo "== services"
    SERVICES="$(api "$API/services?limit=100")"
    printf '%s' "$SERVICES" | python3 -c "import json,sys
for row in json.load(sys.stdin):
    s=row.get('service',row)
    print(f\"  {s['name']:<26} {s.get('type',''):<10} {s.get('suspended','')}  {s['id']}\")"
    SID="$(service_id)"
    echo
    echo "== last 5 deploys of $SERVICE_NAME ($SID)"
    DEPLOYS="$(api "$API/services/$SID/deploys?limit=5")"
    printf '%s' "$DEPLOYS" | python3 -c "import json,sys
for row in json.load(sys.stdin):
    d=row.get('deploy',row)
    c=(d.get('commit') or {}).get('message','').splitlines()[:1]
    print(f\"  {d.get('status',''):<12} {d.get('createdAt','')[:19]}  {c[0] if c else ''}\")"
    echo
    echo "== live health"
    curl -s -o /dev/null -w "  /api/health -> %{http_code} in %{time_total}s\n" -m 30 \
      https://msouwout-backend.onrender.com/api/health || true
    ;;
  logs)
    SID="$(service_id)"; OID="$(owner_id)"
    LOGS="$(api "$API/logs?ownerId=$OID&resource=$SID&limit=100")"
    printf '%s' "$LOGS" | python3 -c "import json,sys
d=json.load(sys.stdin)
for l in d.get('logs',[]):
    print(l.get('timestamp','')[:19], l.get('message',''))"
    ;;
  deploy)
    SID="$(service_id)"
    api -X POST "$API/services/$SID/deploys" \
      -H 'Content-Type: application/json' -d '{"clearCache":"clear"}' | head -c 400; echo
    ;;
  restart)
    SID="$(service_id)"
    api -X POST "$API/services/$SID/restart" >/dev/null && echo "restart requested for $SID"
    ;;
  db)
    PG="$(api "$API/postgres?limit=20")"
    printf '%s' "$PG" | python3 -c "import json,sys
for row in json.load(sys.stdin):
    p=row.get('postgres',row)
    print(f\"  {p['name']:<20} {p.get('status',''):<12} plan={p.get('plan','')} expires={p.get('expiresAt','never')}\")"
    ;;
  *) echo "usage: $0 {status|logs|deploy|restart|db}" >&2; exit 2 ;;
esac
