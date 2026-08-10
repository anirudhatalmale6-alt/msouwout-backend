#!/usr/bin/env bash
# Read-only Render account inventory. Needs RENDER_API_KEY in the environment.
set -euo pipefail
API="https://api.render.com/v1"
: "${RENDER_API_KEY:?RENDER_API_KEY not set}"
get() { curl -sS -H "Authorization: Bearer ${RENDER_API_KEY}" "$1"; }

echo "== services"
get "$API/services?limit=100" | python3 -c '
import json, sys
for row in json.load(sys.stdin):
    s = row.get("service", row)
    print("  %-28s %-12s suspended=%-6s %s" % (s.get("name"), s.get("type",""), s.get("suspended",""), s.get("id")))
'
echo
echo "== postgres"
get "$API/postgres?limit=20" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if not d:
    print("  NONE")
for row in d:
    p = row.get("postgres", row)
    print("  %-24s status=%-10s plan=%-10s expires=%s  %s" % (p.get("name"), p.get("status"), p.get("plan"), p.get("expiresAt","never"), p.get("id")))
'
echo
echo "== owner"
get "$API/owners?limit=1" | python3 -c '
import json, sys
o = json.load(sys.stdin)[0]["owner"]
print("  %s  %s" % (o["id"], o.get("email","")))
'
