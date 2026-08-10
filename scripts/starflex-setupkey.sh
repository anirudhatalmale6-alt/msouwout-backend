#!/usr/bin/env bash
# Set SETUP_KEY on starflex-api, trigger a deploy, then run the one-time migration.
set -euo pipefail
API="https://api.render.com/v1"
: "${RENDER_API_KEY:?RENDER_API_KEY not set}"
: "${SETUP_KEY:?SETUP_KEY not set}"
auth=(-H "Authorization: Bearer ${RENDER_API_KEY}" -H "Content-Type: application/json")

sid="$(curl -sS "${auth[@]}" "$API/services?name=starflex-api&limit=1" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d[0].get("service",d[0]))["id"] if d else "")')"
[ -n "$sid" ] || { echo "service not found"; exit 1; }

# Add SETUP_KEY without clobbering the existing vars.
current="$(curl -sS "${auth[@]}" "$API/services/$sid/env-vars?limit=50")"
payload="$(SETUP_KEY="$SETUP_KEY" python3 -c '
import json, os, sys
cur = json.load(sys.stdin)
out = []
for row in cur:
    v = row.get("envVar", row)
    if v.get("key") == "SETUP_KEY":
        continue
    out.append({"key": v["key"], "value": v.get("value","")})
out.append({"key": "SETUP_KEY", "value": os.environ["SETUP_KEY"]})
print(json.dumps(out))' <<< "$current")"

curl -sS -X PUT "${auth[@]}" "$API/services/$sid/env-vars" -d "$payload" > /dev/null
echo "SETUP_KEY set"

did="$(curl -sS -X POST "${auth[@]}" "$API/services/$sid/deploys" -d '{"clearCache":"do_not_clear"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
echo "deploy $did"
for i in $(seq 1 60); do
  st="$(curl -sS "${auth[@]}" "$API/services/$sid/deploys/$did" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
  echo "[$i] $st"
  case "$st" in
    live) break ;;
    build_failed|update_failed|canceled|pre_deploy_failed) echo "deploy ended: $st"; exit 1 ;;
  esac
  sleep 15
done

echo "running migration..."
curl -sS -X POST "https://starflex-api.onrender.com/api/admin/migrate" -H "x-setup-key: ${SETUP_KEY}" --retry 5 --retry-delay 10 --retry-all-errors -m 120
echo
