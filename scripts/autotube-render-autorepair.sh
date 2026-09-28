#!/usr/bin/env bash
set -euo pipefail

[ -n "${RENDER_API_KEY:-}" ] || { echo "RENDER_API_KEY unavailable; cannot inspect Render."; exit 0; }
[ -n "${GEMINI_API_KEY:-}" ] || { echo "GEMINI_API_KEY unavailable; cannot repair safely."; exit 0; }

deploys="$(curl --fail-with-body -sS -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys?limit=5")"
latest="$(echo "$deploys" | jq '.[0].deploy // .[0]')"
status="$(echo "$latest" | jq -r '.status // empty')"
commit="$(echo "$latest" | jq -r '.commit.id // empty')"
deploy_id="$(echo "$latest" | jq -r '.id // empty')"

case "$status" in build_failed|update_failed|pre_deploy_failed) ;; *) echo "Latest Render deploy $deploy_id status=$status; no repair required."; exit 0 ;; esac

if git log --all --oneline --grep="render-deploy:$deploy_id" -n 1 | grep -q .; then echo "This Render deploy was already repaired/processed."; exit 0; fi

started="$(echo "$latest" | jq -r '.startedAt // .createdAt // empty')"
finished="$(echo "$latest" | jq -r '.finishedAt // .updatedAt // empty')"
[ -n "$finished" ] || finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
curl --fail-with-body -sS -G -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY" --data-urlencode "ownerId=$RENDER_OWNER_ID" --data-urlencode "resource=$RENDER_SERVICE_ID" --data-urlencode "startTime=$started" --data-urlencode "endTime=$finished" --data-urlencode "direction=forward" --data-urlencode "limit=100" "https://api.render.com/v1/logs" > render-logs.json || true
export RENDER_LOG="$(jq -r '.logs[]?.message // empty' render-logs.json 2>/dev/null | tail -n 2500)"
export DEPLOY_ID="$deploy_id" COMMIT="$commit"
[ -n "$RENDER_LOG" ] || export RENDER_LOG="Render deploy $deploy_id failed with status $status and no build log was returned."

python3 - <<'PY'
import json,os,urllib.request
prompt="""Return ONLY a unified git diff or NO_SAFE_PATCH.
Diagnose the concrete failed Render deployment below and repair its root cause.
Compare at least TWO viable FREE alternatives when the failure is provider/infrastructure related, then implement the most stable route.
Preserve real AI video generation, reference analysis, strict motion/video/MP4 QA.
Never replace AI video with static images, stock, pan/zoom or fake video.
Never weaken validation. Do not edit workflows, secrets, authentication, billing or deployment permissions.
Maximum 2 existing application files. No new dependency unless clearly necessary. Keep valid Node.js.

FAILED DEPLOY: """+os.environ["DEPLOY_ID"]+"\nCOMMIT: "+os.environ["COMMIT"]+"\nRENDER LOG:\n"+os.environ["RENDER_LOG"]
body={"contents":[{"parts":[{"text":prompt}]}],"generationConfig":{"temperature":0,"maxOutputTokens":12000}}
req=urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key="+os.environ["GEMINI_API_KEY"],data=json.dumps(body).encode(),headers={"content-type":"application/json"},method="POST")
with urllib.request.urlopen(req,timeout=90) as r: data=json.load(r)
out=data["candidates"][0]["content"]["parts"][0]["text"].strip()
if out.startswith("```"): out=out.split("\n",1)[1].rsplit("\n",1)[0]
open("render-repair.patch","w").write(out+"\n")
PY

if grep -qx "NO_SAFE_PATCH" render-repair.patch; then gh issue create --repo "$REPOSITORY" --title "AutoTube Render deploy needs manual repair: $deploy_id" --body "Render deploy $deploy_id failed and no safe patch was produced."; exit 0; fi
git apply --check render-repair.patch && git apply render-repair.patch
node --check server.js
git diff --check
changed="$(git diff --name-only)"
count="$(printf "%s\n" "$changed" | sed "/^$/d" | wc -l)"
[ "$count" -le 2 ] || { git reset --hard HEAD; exit 0; }
if printf "%s\n" "$changed" | grep -Eq "(^|/)\.github/|(^|/)\.env|(^|/)package-lock\.json$"; then git reset --hard HEAD; exit 0; fi
git config user.name "AutoTube Render Repair Bot"
git config user.email "actions@users.noreply.github.com"
git add -A && git commit -m "[autotube-auto-repair] fix Render deploy $deploy_id render-deploy:$deploy_id" && git push origin HEAD:main
echo "Repair pushed to main; Render auto-deploy and canonical cycle continue."