#!/usr/bin/env bash
set -euo pipefail
runs="$(gh run list --repo "$REPOSITORY" --workflow "AutoTube real YouTube to MP4 E2E" --limit 8 --json databaseId,status,conclusion)"
completed="$(echo "$runs" | jq '[.[] | select(.status=="completed")]')"
latest="$(echo "$completed" | jq '.[0] // empty')"
[ -n "$latest" ] || exit 0
[ "$(echo "$latest" | jq -r .conclusion)" = "success" ] && exit 0
count="$(echo "$completed" | jq '[.[0:3][] | select(.conclusion=="failure")] | length')"
[ "$count" -ge 3 ] || exit 0
[ -n "${GEMINI_API_KEY:-}" ] || { gh issue create --repo "$REPOSITORY" --title "AutoTube repair needs Gemini secret" --body "Three E2E failures detected but GEMINI_API_KEY is unavailable."; exit 0; }
run_id="$(echo "$latest" | jq -r .databaseId)"
gh run view "$run_id" --repo "$REPOSITORY" --log > failure.log || true
tail -n 2200 failure.log > failure-tail.log
signature="$(sed -E 's/[0-9]{10,}/<ID>/g; s/[0-9a-f]{7,40}/<SHA>/g' failure-tail.log | sha256sum | cut -d' ' -f1)"
echo "Failure signature: $signature"
if git log --all --oneline --grep="failure-signature:$signature" -n 1 | grep -q .; then
  gh issue create --repo "$REPOSITORY" --title "AutoTube repair circuit breaker: repeated failure" --body "Same failure signature already repaired: $signature. No duplicate patch created." || true
  exit 0
fi
if grep -Eiq 'user.?action|required.*login|sign in to confirm|authentication required|OAuth|permission denied' failure-tail.log; then
  gh issue create --repo "$REPOSITORY" --title "AutoTube needs user action" --body "Likely user-blocking E2E failure. Signature: $signature" || true
  exit 0
fi
if grep -Eiq '502|503|504|timeout|timed out|ECONNRESET|ETIMEDOUT|ZeroGPU quota|queue is full|temporarily unavailable|rate.?limit|429' failure-tail.log; then
  gh issue create --repo "$REPOSITORY" --title "AutoTube transient/provider failure after retries" --body "Transient/provider failure after three attempts. Signature: $signature" || true
  exit 0
fi
python3 - <<'PY'
import json,os,urllib.request
log=open("failure-tail.log","r",errors="replace").read()
prompt="""Return ONLY a unified git diff or NO_SAFE_PATCH. Fix the concrete AutoTube E2E failure below with the smallest safe change. Preserve real AI video generation, motion validation, reference analysis and final MP4 validation. Never add static-image, stock, pan/zoom or fake-video fallback. Never weaken validation. Never edit workflows, secrets, auth, billing or deployment permissions. Max 2 existing application files. No new dependency unless proven missing.\n\nFAILURE:\n"""+log
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
gh workflow run "AutoTube real YouTube to MP4 E2E" --repo "$REPOSITORY" --ref main
