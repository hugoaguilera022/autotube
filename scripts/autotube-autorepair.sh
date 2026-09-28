#!/usr/bin/env bash
set -euo pipefail
run_id="${RUN_ID:-}"
if [ -z "$run_id" ]; then
  echo "No triggering E2E run id was supplied; refusing to guess from unrelated runs."
  exit 0
fi
run_json="$(gh run view "$run_id" --repo "$REPOSITORY" --json databaseId,status,conclusion,attempt,headSha)"
[ "$(echo "$run_json" | jq -r .conclusion)" = "failure" ] || exit 0
attempt="$(echo "$run_json" | jq -r ".attempt // 1")"
[ "$attempt" -ge 3 ] || exit 0
[ -n "${GEMINI_API_KEY:-}" ] || { gh issue create --repo "$REPOSITORY" --title "AutoTube repair needs Gemini secret" --body "Canonical E2E run $run_id exhausted its retry budget, but GEMINI_API_KEY is unavailable."; exit 0; }
gh run view "$run_id" --repo "$REPOSITORY" --log > failure.log || true
tail -n 2200 failure.log > failure-tail.log
signature="$(grep -Eai 'error|failed|failure|exception|timeout|429|502|503|504|ZeroGPU|ECONNRESET|ETIMEDOUT|no se pudo|incomplete' failure-tail.log | sed -E 's/[0-9]{10,}/<ID>/g; s/[0-9a-f]{7,40}/<SHA>/g; s/[[:space:]]+/ /g' | tail -n 120 | sha256sum | cut -d' ' -f1)"
echo "Failure signature: $signature"
if git log --all --oneline --grep="failure-signature:$signature" -n 1 | grep -q .; then
  gh issue create --repo "$REPOSITORY" --title "AutoTube repair circuit breaker: repeated failure" --body "Same failure signature already repaired: $signature. No duplicate patch created." || true
  exit 0
fi
if grep -Eiq 'user.?action|required.*login|sign in to confirm|authentication required|OAuth|permission denied' failure-tail.log; then
  gh issue create --repo "$REPOSITORY" --title "AutoTube needs user action" --body "Likely user-blocking E2E failure. Signature: $signature" || true
  exit 0
fi
# A Render deploy failure is a first-class repair signal, not a retry condition.
# When the failed E2E corresponds to the current Render deploy, replace the E2E
# log with Render build/update logs so the repair agent fixes the actual root cause.
if [ -n "${RENDER_API_KEY:-}" ] && [ -n "${RENDER_SERVICE_ID:-}" ] && [ -n "${RENDER_OWNER_ID:-}" ]; then
  render_deploys="$(curl --fail-with-body -sS -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys?limit=5" || true)"
  render_latest="$(echo "$render_deploys" | jq '.[0].deploy // .[0]' 2>/dev/null || true)"
  render_status="$(echo "$render_latest" | jq -r '.status // empty' 2>/dev/null || true)"
  render_commit="$(echo "$render_latest" | jq -r '.commit.id // empty' 2>/dev/null || true)"
  if [ "$render_commit" = "$(echo "$run_json" | jq -r .headSha)" ] && echo "$render_status" | grep -Eq '^(build_failed|update_failed|pre_deploy_failed)python3 - <<'PY'
import json,os,urllib.request
log=open("failure-tail.log","r",errors="replace").read()
prompt="""Return ONLY a unified git diff or NO_SAFE_PATCH. Diagnose the concrete AutoTube E2E failure below. If the current implementation/provider/path is the cause, compare at least TWO viable FREE alternatives that fit AutoTube's actual goal (real AI-generated video, reference-conditioned when possible, valid MP4, no fake/static-video fallback), select the most stable available route, and implement that route. Prefer changing provider routing/configuration over superficial retries. Fix the concrete failure with the smallest safe change. Preserve real AI video generation, motion validation, reference analysis and final MP4 validation. Never add static-image, stock, pan/zoom or fake-video fallback. Never weaken validation. Never edit workflows, secrets, auth, billing or deployment permissions. Max 2 existing application files. No new dependency unless proven missing.\n\nFAILURE:\n"""+log
body={"contents":[{"parts":[{"text":prompt}]}],"generationConfig":{"temperature":0,"maxOutputTokens":12000}}
req=urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key="+os.environ["GEMINI_API_KEY"],data=json.dumps(body).encode(),headers={"content-type":"application/json"},method="POST")
with urllib.request.urlopen(req,timeout=90) as r: data=json.load(r)
out=data["candidates"][0]["content"]["parts"][0]["text"].strip()
if out.startswith("```"): out=out.split("\n",1)[1].rsplit("\n",1)[0]
open("repair.patch","w").write(out+"\n")
PY
grep -qx NO_SAFE_PATCH repair.patch && exit 0
git apply --check repair.patch && git apply repair.patch
node --check server.js
git diff --check
changed="$(git diff --name-only)"
count_files="$(printf "%s\n" "$changed" | sed "/^$/d" | wc -l)"
[ "$count_files" -le 2 ] || { git reset --hard HEAD; exit 0; }
printf "%s\n" "$changed" | grep -Eq "(^|/)\.github/|(^|/)\.env|(^|/)package-lock\.json$" && { git reset --hard HEAD; exit 0; } || true
git config user.name "AutoTube Repair Bot"
git config user.email "actions@users.noreply.github.com"
git add -A && git commit -m "[autotube-auto-repair] fix E2E failure failure-signature:$signature" && git push origin HEAD:main
echo "Repair pushed to main; canonical E2E will start from the push trigger. No duplicate manual dispatch."
; then
    render_started="$(echo "$render_latest" | jq -r '.startedAt // .createdAt')"
    render_finished="$(echo "$render_latest" | jq -r '.finishedAt // empty')"
    [ -n "$render_finished" ] || render_finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    curl --fail-with-body -sS -G -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY"       --data-urlencode "ownerId=$RENDER_OWNER_ID"       --data-urlencode "resource=$RENDER_SERVICE_ID"       --data-urlencode "startTime=$render_started"       --data-urlencode "endTime=$render_finished"       --data-urlencode "direction=forward"       --data-urlencode "limit=100"       "https://api.render.com/v1/logs" > render-logs.json || true
    if [ -s render-logs.json ]; then
      jq -r '.logs[]?.message // empty' render-logs.json | tail -n 2500 > failure-tail.log
      echo "Using Render deploy failure logs for root-cause repair."
    fi
  fi
fi

if grep -Eiq '502|503|504|timeout|timed out|ECONNRESET|ETIMEDOUT|ZeroGPU quota|queue is full|temporarily unavailable|rate.?limit|429' failure-tail.log; then
  echo "Transient/provider signature detected: invoking alternative-route repair instead of stopping."
fi
python3 - <<'PY'
import json,os,urllib.request
log=open("failure-tail.log","r",errors="replace").read()
prompt="""Return ONLY a unified git diff or NO_SAFE_PATCH. Diagnose the concrete AutoTube E2E failure below. If the current implementation/provider/path is the cause, compare at least TWO viable FREE alternatives that fit AutoTube's actual goal (real AI-generated video, reference-conditioned when possible, valid MP4, no fake/static-video fallback), select the most stable available route, and implement that route. Prefer changing provider routing/configuration over superficial retries. Fix the concrete failure with the smallest safe change. Preserve real AI video generation, motion validation, reference analysis and final MP4 validation. Never add static-image, stock, pan/zoom or fake-video fallback. Never weaken validation. Never edit workflows, secrets, auth, billing or deployment permissions. Max 2 existing application files. No new dependency unless proven missing.\n\nFAILURE:\n"""+log
body={"contents":[{"parts":[{"text":prompt}]}],"generationConfig":{"temperature":0,"maxOutputTokens":12000}}
req=urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key="+os.environ["GEMINI_API_KEY"],data=json.dumps(body).encode(),headers={"content-type":"application/json"},method="POST")
with urllib.request.urlopen(req,timeout=90) as r: data=json.load(r)
out=data["candidates"][0]["content"]["parts"][0]["text"].strip()
if out.startswith("```"): out=out.split("\n",1)[1].rsplit("\n",1)[0]
open("repair.patch","w").write(out+"\n")
PY
grep -qx NO_SAFE_PATCH repair.patch && exit 0
git apply --check repair.patch && git apply repair.patch
node --check server.js
git diff --check
changed="$(git diff --name-only)"
count_files="$(printf "%s\n" "$changed" | sed "/^$/d" | wc -l)"
[ "$count_files" -le 2 ] || { git reset --hard HEAD; exit 0; }
printf "%s\n" "$changed" | grep -Eq "(^|/)\.github/|(^|/)\.env|(^|/)package-lock\.json$" && { git reset --hard HEAD; exit 0; } || true
git config user.name "AutoTube Repair Bot"
git config user.email "actions@users.noreply.github.com"
git add -A && git commit -m "[autotube-auto-repair] fix E2E failure failure-signature:$signature" && git push origin HEAD:main
echo "Repair pushed to main; canonical E2E will start from the push trigger. No duplicate manual dispatch."
