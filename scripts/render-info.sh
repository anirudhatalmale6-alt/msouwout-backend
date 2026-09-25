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
# 🚨 25 Sep 2026. haitibiznis-api was running a commit from days earlier: the
# push reached GitHub and never reached Render. Jeffery: "Please investigate why
# Render stopped deploying automatically. Manual deployment should not be our
# permanent solution."
# autoDeploy and the repo wiring are what decide that, so print them.
echo "== auto-deploy wiring (the answer to 'why did my push not deploy')"
get "$API/services?limit=100" | python3 -c '
import json, sys
for row in json.load(sys.stdin):
    s = row.get("service", row)
    d = s.get("serviceDetails", {}) or {}
    print("  %-28s autoDeploy=%-6s branch=%-10s repo=%s" % (
        s.get("name"), s.get("autoDeploy", "?"), s.get("branch", "?"), s.get("repo", "")))
'
echo
echo "== last 3 deploys per service, and what triggered them"
get "$API/services?limit=100" | python3 -c '
import json, sys
print(" ".join("%s|%s" % (r.get("service", r).get("id"), r.get("service", r).get("name"))
               for r in json.load(sys.stdin)))
' | tr " " "\n" | while IFS="|" read -r sid name; do
  [ -n "$sid" ] || continue
  echo "  -- $name"
  get "$API/services/$sid/deploys?limit=3" | python3 -c '
import json, sys
for row in json.load(sys.stdin):
    d = row.get("deploy", row)
    c = (d.get("commit") or {}).get("id", "")[:7]
    print("     %-10s %-9s commit=%-8s %s" % (
        d.get("status"), d.get("trigger", "?"), c, d.get("createdAt", "")))
' || echo "     (could not read deploys)"
done

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
