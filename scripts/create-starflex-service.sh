#!/usr/bin/env bash
# Provision the starflex-api web service on Render and point it at the existing
# Postgres instance (its own `starflex` schema — no new paid database needed).
# Needs RENDER_API_KEY. Safe to re-run: if the service exists we just print it.
set -euo pipefail
API="https://api.render.com/v1"
: "${RENDER_API_KEY:?RENDER_API_KEY not set}"
NAME="starflex-api"
REPO="https://github.com/anirudhatalmale6-alt/starflex-api"

auth=(-H "Authorization: Bearer ${RENDER_API_KEY}" -H "Content-Type: application/json")

existing="$(curl -sS "${auth[@]}" "$API/services?name=$NAME&limit=1")"
sid="$(printf '%s' "$existing" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d[0].get("service",d[0]))["id"] if d else "")')"

if [ -n "$sid" ]; then
  echo "SERVICE_EXISTS $sid"
else
  owner="$(curl -sS "${auth[@]}" "$API/owners?limit=1" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["owner"]["id"])')"
  # Internal connection string of the existing Postgres (never printed).
  pgid="$(curl -sS "${auth[@]}" "$API/postgres?limit=20" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d[0].get("postgres",d[0]))["id"] if d else "")')"
  [ -n "$pgid" ] || { echo "no postgres instance found"; exit 1; }
  dburl="$(curl -sS "${auth[@]}" "$API/postgres/$pgid/connection-info" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("internalConnectionString") or d.get("externalConnectionString") or "")')"
  [ -n "$dburl" ] || { echo "could not read connection string"; exit 1; }

  jwt="$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40)"

  payload="$(DBURL="$dburl" JWT="$jwt" OWNER="$owner" REPO="$REPO" NAME="$NAME" python3 -c '
import json, os
print(json.dumps({
  "type": "web_service",
  "name": os.environ["NAME"],
  "ownerId": os.environ["OWNER"],
  "repo": os.environ["REPO"],
  "branch": "main",
  "autoDeploy": "yes",
  "serviceDetails": {
    "env": "node",
    "plan": "free",
    "region": "oregon",
    "healthCheckPath": "/api/health",
    "envSpecificDetails": {"buildCommand": "npm install", "startCommand": "node src/server.js"}
  },
  "envVars": [
    {"key": "NODE_ENV",     "value": "production"},
    {"key": "DATABASE_URL", "value": os.environ["DBURL"]},
    {"key": "JWT_SECRET",   "value": os.environ["JWT"]},
    {"key": "EXPOSE_OTP",   "value": "true"}
  ]
}))')"

  resp="$(curl -sS -X POST "${auth[@]}" "$API/services" -d "$payload")"
  sid="$(printf '%s' "$resp" | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d.get("service",d); print(s.get("id",""))')"
  if [ -z "$sid" ]; then
    echo "CREATE_FAILED"; printf '%s\n' "$resp" | head -c 600; exit 1
  fi
  echo "SERVICE_CREATED $sid"
fi

url="$(curl -sS "${auth[@]}" "$API/services/$sid" | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d.get("service",d); print((s.get("serviceDetails") or {}).get("url",""))')"
echo "SERVICE_URL $url"
