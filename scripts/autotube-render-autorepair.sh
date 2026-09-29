#!/usr/bin/env bash
set -euo pipefail

[ -n "${RENDER_API_KEY:-}" ] || { echo "RENDER_API_KEY unavailable; cannot inspect Render."; exit 0; }
[ -n "${GEMINI_API_KEY:-}" ] || { echo "GEMINI_API_KEY unavailable; cannot repair safely."; exit 0; }

deploys="$(curl --fail-with-body -sS -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys?limit=5")"
latest="$(echo "$deploys" | jq '.[0].deploy // .[0]')"
status="$(echo "$latest" | jq -r '.status // empty')"
commit="$(echo "$latest" | jq -r '.commit.id // empty')"
deploy_id="$(echo "$latest" | jq -r '.id // empty')"

runtime_incident="false"
runtime_fingerprint=""
case "$status" in
  build_failed|update_failed|pre_deploy_failed)
    incident_kind="deploy"
    ;;
  live)
    # A LIVE deploy can still be failing at runtime. Treat repeated production
    # failures as first-class repair incidents instead of waiting for Render
    # itself to mark the deploy failed.
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    since="$(date -u -d '35 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
    curl --fail-with-body -sS -G -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY"       --data-urlencode "ownerId=$RENDER_OWNER_ID"       --data-urlencode "resource=$RENDER_SERVICE_ID"       --data-urlencode "startTime=$since"       --data-urlencode "endTime=$now"       --data-urlencode "direction=forward"       --data-urlencode "limit=100"       "https://api.render.com/v1/logs" > render-runtime-logs.json || true
    runtime_matches="$(jq -r '.logs[]?.message // empty' render-runtime-logs.json 2>/dev/null | grep -Ei 'RETRYABLE_AI_VIDEO_INCOMPLETE|REAL_AI_VIDEO_REQUIRED|visual-sources-all-scenes.*failed|AI video scene .* unavailable|ZeroGPU quota|MUSIC_PROVIDERS_EXHAUSTED|audio.*QA.*fail|502|503|504|ECONNRESET|ETIMEDOUT|out of memory|heap out of memory' | tail -n 120 || true)"
    if [ -n "$runtime_matches" ]; then
      runtime_incident="true"
      incident_kind="runtime"
      runtime_fingerprint="$(printf '%s\n' "$runtime_matches" | sed -E 's/[0-9a-f]{8}-[0-9a-f-]{27,}/<ID>/g; s/20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z/<TIME>/g; s/[0-9]{10,}/<N>/g' | sha256sum | cut -d' ' -f1)"
      deploy_id="runtime-$runtime_fingerprint"
      commit="$commit"
      started="$since"
      finished="$now"
      export RENDER_LOG="$runtime_matches"
      echo "Detected repeated LIVE runtime failure; escalating to autonomous repair fingerprint=$runtime_fingerprint"
    else
      echo "Latest Render deploy $deploy_id is LIVE and no repair-worthy runtime failure was detected."
      exit 0
    fi
    ;;
  *)
    echo "Latest Render deploy $deploy_id status=$status; no repair required."
    exit 0
    ;;
esac

# Recovery Engine v1: distinguish retryable provider failures from resource-wide failures.
# A "recoverable" incident MUST produce a different recovery action; it is not a synonym for retry.
recovery_resource="UNKNOWN"
recovery_class="UNKNOWN"
recovery_strategy="PROVIDER_CASCADE"
if printf "%s\n" "${RENDER_LOG:-}" | grep -Eiq "ZeroGPU quota|exceeded your ZeroGPU quota|remaining quota"; then recovery_resource="HF_ZERO_GPU"; recovery_class="QUOTA"; recovery_strategy="RESOURCE_SWITCH"
elif printf "%s\n" "${RENDER_LOG:-}" | grep -Eiq "402|Payment Required"; then recovery_resource="EXTERNAL_API_ACCESS"; recovery_class="PAYMENT_OR_ACCESS"; recovery_strategy="PROVIDER_SWITCH"
elif printf "%s\n" "${RENDER_LOG:-}" | grep -Eiq "429|rate limit|Too Many Requests"; then recovery_resource="PROVIDER_RATE_LIMIT"; recovery_class="QUOTA"; recovery_strategy="PROVIDER_COOLDOWN"
elif printf "%s\n" "${RENDER_LOG:-}" | grep -Eiq "502|503|504|Service Unavailable|temporarily unavailable|queue"; then recovery_resource="PROVIDER_CAPACITY"; recovery_class="CAPACITY"; recovery_strategy="PROVIDER_SWITCH"
elif printf "%s\n" "${RENDER_LOG:-}" | grep -Eiq "out of memory|heap out of memory|exit 137"; then recovery_resource="RENDER_MEMORY"; recovery_class="INFRASTRUCTURE"; recovery_strategy="RESOURCE_OPTIMIZATION"
elif printf "%s\n" "${RENDER_LOG:-}" | grep -Eiq "ECONNRESET|ETIMEDOUT|network"; then recovery_resource="NETWORK"; recovery_class="NETWORK"; recovery_strategy="NETWORK_RESILIENCE"
elif printf "%s\n" "${RENDER_LOG:-}" | grep -Eiq "node --check|SyntaxError|ReferenceError|Cannot find module"; then recovery_resource="APPLICATION_CODE"; recovery_class="CODE"; recovery_strategy="CODE_REPAIR"
fi

incident_key="${runtime_incident}:$runtime_fingerprint:$deploy_id"
previous_repairs="$(git log --all --oneline --grep="runtime-fingerprint:$runtime_fingerprint" -n 10 || true)"
repair_attempt="$(printf '%s\\n' "$previous_repairs" | sed '/^$/d' | wc -l | tr -d ' ')"
repair_attempt=$((repair_attempt + 1))

# Hard circuit breaker: after three distinct repair attempts for the same incident,
# do not keep producing blind patches. Surface the incident as a real blocker.
if [ "$repair_attempt" -gt 3 ]; then
  gh issue create --repo "$REPOSITORY" --title "AutoTube recovery exhausted: $recovery_resource" --body "Incident $incident_key exhausted 3 autonomous repair attempts. Resource=$recovery_resource class=$recovery_class strategy=$recovery_strategy. Last deploy=$deploy_id fingerprint=$runtime_fingerprint." || true
  echo "RECOVERY_TERMINAL: maximum autonomous repair attempts reached."
  exit 0
fi

if git log --all --oneline --grep="render-deploy:$deploy_id" -n 1 | grep -q .; then
  echo "This Render incident was already repaired/processed."
  exit 0
fi
if [ "$runtime_incident" = "true" ] && git log --all --oneline --grep="runtime-fingerprint:$runtime_fingerprint" -n 1 | grep -q .; then
  echo "This runtime failure fingerprint was already repaired/processed."
  exit 0
fi

echo "RECOVERY ENGINE: class=$recovery_class resource=$recovery_resource strategy=$recovery_strategy attempt=$repair_attempt/3"
export RECOVERY_RESOURCE="$recovery_resource"
export RECOVERY_CLASS="$recovery_class"
export RECOVERY_STRATEGY="$recovery_strategy"
export REPAIR_ATTEMPT="$repair_attempt"

started="${started:-$(echo "$latest" | jq -r '.startedAt // .createdAt // empty')}"
finished="${finished:-$(echo "$latest" | jq -r '.finishedAt // .updatedAt // empty')}"
[ -n "$finished" ] || finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -z "${RENDER_LOG:-}" ]; then
  curl --fail-with-body -sS -G -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY" --data-urlencode "ownerId=$RENDER_OWNER_ID" --data-urlencode "resource=$RENDER_SERVICE_ID" --data-urlencode "startTime=$started" --data-urlencode "endTime=$finished" --data-urlencode "direction=forward" --data-urlencode "limit=100" "https://api.render.com/v1/logs" > render-logs.json || true
  export RENDER_LOG="$(jq -r '.logs[]?.message // empty' render-logs.json 2>/dev/null | tail -n 2500)"
fi
export DEPLOY_ID="$deploy_id" COMMIT="$commit"
[ -n "$RENDER_LOG" ] || export RENDER_LOG="Render incident $deploy_id status=$status and no diagnostic log was returned."

python3 - <<'PY'
import json, os, urllib.error, urllib.request, subprocess
prompt = """Return ONLY a unified git diff, optionally followed by a RENDER_ACTIONS block, or NO_SAFE_PATCH. Diagnose and repair the concrete Render/runtime incident. Compare at least TWO viable FREE alternatives for provider/infrastructure failures and implement the most stable route. Preserve real AI video generation and strict QA. Never replace AI video with static images, stock, pan/zoom or fake video. Never weaken validation. Do not modify secrets, authentication, billing, permissions, repository or branch. Maximum 2 existing application files. No new dependency unless clearly necessary. Resource=%s Class=%s Strategy=%s Attempt=%s/3 Incident=%s Commit=%s Logs=%s""" % (os.environ.get("RECOVERY_RESOURCE","UNKNOWN"),os.environ.get("RECOVERY_CLASS","UNKNOWN"),os.environ.get("RECOVERY_STRATEGY","PROVIDER_CASCADE"),os.environ.get("REPAIR_ATTEMPT","1"),os.environ.get("DEPLOY_ID",""),os.environ.get("COMMIT",""),os.environ.get("RENDER_LOG",""))
body={"contents":[{"parts":[{"text":prompt}]}],"generationConfig":{"temperature":0,"maxOutputTokens":12000}}
models=["gemini-3.1-flash-lite","gemini-3.8-flash","gemini-2.5-flash-lite","gemini-2.5-flash"]
for model in models:
    url="https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent"
    req=urllib.request.Request(url,data=json.dumps(body).encode(),headers={"content-type":"application/json","x-goog-api-key":os.environ["GEMINI_API_KEY"]},method="POST")
    try:
        with urllib.request.urlopen(req,timeout=90) as response: data=json.load(response)
        out=data["candidates"][0]["content"]["parts"][0]["text"].strip()
        if out.startswith("```"): out=out.split("\n",1)[1].rsplit("\n",1)[0]
        open("render-repair.patch","w").write(out+"\n")
        check=subprocess.run(["git","apply","--check","render-repair.patch"],capture_output=True,text=True)
        if check.returncode != 0:
            print("Recovery model produced invalid patch:",model)
            print(check.stderr[-2000:])
            continue
        print("Recovery model succeeded with valid patch:",model)
        break
    except urllib.error.HTTPError as ex:
        print("Recovery model failed:",model,ex.code)
else:
    raise RuntimeError("All Gemini recovery models failed")
PY
if grep -qx "NO_SAFE_PATCH" render-repair.patch; then gh issue create --repo "$REPOSITORY" --title "AutoTube Render deploy needs manual repair: $deploy_id" --body "Render deploy $deploy_id failed and no safe patch was produced."; exit 0; fi

python3 - <<'PY'
from pathlib import Path
p=Path("render-repair.patch")
s=p.read_text()
if "RENDER_ACTIONS" not in s:
    Path("render-actions.txt").write_text("")
    raise SystemExit
head,tail=s.split("RENDER_ACTIONS",1)
actions=tail.split("END_RENDER_ACTIONS",1)[0]
p.write_text(head.rstrip()+"\n")
Path("render-actions.txt").write_text(actions.strip()+"\n")
PY

if [ -s render-repair.patch ]; then
  git apply --check render-repair.patch && git apply render-repair.patch
fi
node --check server.js

if [ -s render-actions.txt ]; then
  while IFS= read -r line; do
    case "$line" in
      RENDER_ENV_SET\ *)
        kv="${line#RENDER_ENV_SET }"
        key="${kv%%=*}"
        value="${kv#*=}"
        if ! [[ "$key" =~ ^(AUTOTUBE_|POLLINATIONS_MUSIC_MODEL$) ]]; then
          echo "Unsafe Render env key requested: $key"; git reset --hard HEAD; exit 0
        fi
        if [[ "$key" =~ (TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL) ]]; then
          echo "Secret-like Render env key rejected: $key"; git reset --hard HEAD; exit 0
        fi
        curl --fail-with-body -sS -X PUT -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/env-vars/$key" --data "$(jq -nc --arg v "$value" '{value:$v}')" >/dev/null
        ;;
      RENDER_SERVICE_PATCH\ *)
        json="${line#RENDER_SERVICE_PATCH }"
        if ! echo "$json" | jq -e 'type=="object" and ((keys - ["serviceDetails"])|length==0) and (.serviceDetails|type=="object") and ((.serviceDetails|keys) - ["buildCommand","startCommand","healthCheckPath"]|length==0)' >/dev/null; then
          echo "Unsafe Render service patch rejected."; git reset --hard HEAD; exit 0
        fi
        curl --fail-with-body -sS -X PATCH -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" "https://api.render.com/v1/services/$RENDER_SERVICE_ID" --data "$json" >/dev/null
        ;;
      ""|\#*) ;;
      *) echo "Unknown Render action rejected."; git reset --hard HEAD; exit 0 ;;
    esac
  done < render-actions.txt
  curl --fail-with-body -sS -X POST -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys" --data '{"deployMode":"build_and_deploy"}' >/dev/null
fi
git diff --check
changed="$(git diff --name-only)"
count="$(printf "%s\n" "$changed" | sed "/^$/d" | wc -l)"
[ "$count" -le 2 ] || { git reset --hard HEAD; exit 0; }
if printf "%s\n" "$changed" | grep -Eq "(^|/)\.github/|(^|/)\.env|(^|/)package-lock\.json$"; then git reset --hard HEAD; exit 0; fi
git config user.name "AutoTube Render Repair Bot"
git config user.email "actions@users.noreply.github.com"
if [ "$runtime_incident" = "true" ]; then
  repair_commit_message="[autotube-auto-repair] runtime repair $runtime_fingerprint runtime-fingerprint:$runtime_fingerprint render-deploy:$deploy_id"
else
  repair_commit_message="[autotube-auto-repair] fix Render deploy $deploy_id render-deploy:$deploy_id"
fi
git add -A && git commit -m "$repair_commit_message" && git push origin HEAD:main
echo "Repair pushed to main; Render auto-deploy and canonical cycle continue."