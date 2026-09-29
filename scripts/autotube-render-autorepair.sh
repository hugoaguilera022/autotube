#!/usr/bin/env bash
set -euo pipefail
# Restore repository file modes after the workflow self-test chmod step so mode drift is never committed.
chmod a-x scripts/autotube-recovery-contract.sh scripts/autotube-render-autorepair.sh 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/autotube-recovery-contract.sh"

[ -n "${RENDER_API_KEY:-}" ] || { echo "RENDER_API_KEY unavailable; cannot inspect Render."; exit 0; }
# Gemini is no longer a hard prerequisite: HF_ZERO_GPU has a deterministic
# provider-switch recovery path and Gemini remains a secondary repair generator.

deploys="$(curl --fail-with-body -sS -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys?limit=5")"
latest="$(echo "$deploys" | jq '.[0].deploy // .[0]')"
status="$(echo "$latest" | jq -r '.status // empty')"
commit="$(echo "$latest" | jq -r '.commit.id // empty')"
deploy_id="$(echo "$latest" | jq -r '.id // empty')"

# A queued/building deploy must never hide a live runtime incident. Render can
# queue newer deploys behind the currently live revision, so inspect the newest
# LIVE deploy independently and use it for runtime diagnosis.
live="$(echo "$deploys" | jq -c '[.[] | (.deploy // .) | select(.status=="live")] | .[0] // empty')"
if [ -n "$live" ]; then
  live_status="live"
  live_commit="$(echo "$live" | jq -r '.commit.id // empty')"
  live_deploy_id="$(echo "$live" | jq -r '.id // empty')"
else
  live_status=""
  live_commit=""
  live_deploy_id=""
fi

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
    runtime_matches="$(jq -r '.logs[]?.message // empty' render-runtime-logs.json 2>/dev/null | grep -Ei 'RETRYABLE_AI_VIDEO_INCOMPLETE|REAL_AI_VIDEO_REQUIRED|visual-sources-all-scenes.*failed|AI video scene .* unavailable|ZeroGPU quota|MUSIC_PROVIDERS_EXHAUSTED|audio.*QA.*fail|502|503|504|ECONNRESET|ETIMEDOUT|out of memory|heap out of memory|ReferenceError|Cannot access .* before initialization' | tail -n 120 || true)"
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
    # Do not stop merely because a newer deploy is queued/in progress. If a
    # live revision exists, inspect its runtime logs before deciding there is
    # nothing to repair.
    if [ "$live_status" = "live" ]; then
      now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      since="$(date -u -d '35 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
      curl --fail-with-body -sS -G -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY"         --data-urlencode "ownerId=$RENDER_OWNER_ID" --data-urlencode "resource=$RENDER_SERVICE_ID"         --data-urlencode "startTime=$since" --data-urlencode "endTime=$now"         --data-urlencode "direction=forward" --data-urlencode "limit=100"         "https://api.render.com/v1/logs" > render-runtime-logs.json || true
      runtime_matches="$(jq -r '.logs[]?.message // empty' render-runtime-logs.json 2>/dev/null | grep -Ei 'RETRYABLE_AI_VIDEO_INCOMPLETE|REAL_AI_VIDEO_REQUIRED|visual-sources-all-scenes.*failed|AI video scene .* unavailable|ZeroGPU quota|MUSIC_PROVIDERS_EXHAUSTED|audio.*QA.*fail|402|429|502|503|504|ECONNRESET|ETIMEDOUT|out of memory|heap out of memory' | tail -n 120 || true)"
      if [ -n "$runtime_matches" ]; then
        runtime_incident="true"
        incident_kind="runtime"
        runtime_fingerprint="$(printf '%s
' "$runtime_matches" | sed -E 's/[0-9a-f]{8}-[0-9a-f-]{27,}/<ID>/g; s/20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z/<TIME>/g; s/[0-9]{10,}/<N>/g' | sha256sum | cut -d' ' -f1)"
        deploy_id="runtime-$runtime_fingerprint"
        commit="$live_commit"
        started="$since"
        finished="$now"
        export RENDER_LOG="$runtime_matches"
        echo "Detected LIVE runtime failure while latest deploy is $status; escalating to autonomous repair fingerprint=$runtime_fingerprint live_deploy=$live_deploy_id"
      else
        echo "Latest Render deploy $deploy_id status=$status; LIVE deploy $live_deploy_id has no repair-worthy runtime failure."
        exit 0
      fi
    else
      echo "Latest Render deploy $deploy_id status=$status; no live revision available for runtime diagnosis."
      exit 0
    fi
    ;;
esac

# Recovery Engine contract: one canonical classifier shared by tests and runtime.
classification="$(recovery_classify "${RENDER_LOG:-}")"
IFS='|' read -r recovery_class recovery_resource recovery_strategy <<< "$classification"

incident_key="${runtime_incident}:$runtime_fingerprint:$deploy_id"
previous_repairs="$(git log --all --oneline --grep="runtime-fingerprint:$runtime_fingerprint" -n 10 || true)"
repair_attempt="$(printf '%s\\n' "$previous_repairs" | sed '/^$/d' | wc -l | tr -d ' ')"
repair_attempt=$((repair_attempt + 1))

# Hard circuit breaker: 12 recovery strategies per incident. A new causal
# fingerprint starts a new incident; the same fingerprint cannot loop forever.
MAX_RECOVERY_ATTEMPTS="${AUTOTUBE_MAX_RECOVERY_ATTEMPTS:-12}"
if [ "$repair_attempt" -gt "$MAX_RECOVERY_ATTEMPTS" ]; then
  gh issue create --repo "$REPOSITORY" --title "AutoTube recovery exhausted: $recovery_resource" --body "Incident $incident_key exhausted $MAX_RECOVERY_ATTEMPTS autonomous recovery attempts. Resource=$recovery_resource class=$recovery_class strategy=$recovery_strategy. Last deploy=$deploy_id fingerprint=$runtime_fingerprint." || true
  echo "RECOVERY_TERMINAL: maximum autonomous recovery attempts reached."
  exit 0
fi

if [ "$runtime_incident" != "true" ] && git log --all --oneline --grep="render-deploy:$deploy_id" -n 1 | grep -q .; then
  echo "This Render deploy incident was already repaired/processed."
  exit 0
fi

echo "RECOVERY ENGINE: class=$recovery_class resource=$recovery_resource strategy=$recovery_strategy attempt=$repair_attempt/$MAX_RECOVERY_ATTEMPTS"
export RECOVERY_RESOURCE="$recovery_resource"
export RECOVERY_CLASS="$recovery_class"
export RECOVERY_STRATEGY="$recovery_strategy"
export REPAIR_ATTEMPT="$repair_attempt"
export MAX_RECOVERY_ATTEMPTS="$MAX_RECOVERY_ATTEMPTS"

started="${started:-$(echo "$latest" | jq -r '.startedAt // .createdAt // empty')}"
finished="${finished:-$(echo "$latest" | jq -r '.finishedAt // .updatedAt // empty')}"
[ -n "$finished" ] || finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -z "${RENDER_LOG:-}" ]; then
  curl --fail-with-body -sS -G -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY" --data-urlencode "ownerId=$RENDER_OWNER_ID" --data-urlencode "resource=$RENDER_SERVICE_ID" --data-urlencode "startTime=$started" --data-urlencode "endTime=$finished" --data-urlencode "direction=forward" --data-urlencode "limit=100" "https://api.render.com/v1/logs" > render-logs.json || true
  export RENDER_LOG="$(jq -r '.logs[]?.message // empty' render-logs.json 2>/dev/null | tail -n 2500)"
fi
export DEPLOY_ID="$deploy_id" COMMIT="$commit"

# Every incident must progress through a strategy, verification, and escalation loop.
# If the same fingerprint has already produced a committed repair with the same
# strategy, never blindly replay that strategy: move to the next route.
strategy_history="$(git log --all --format='%s' --grep="runtime-fingerprint:$runtime_fingerprint" -n 20 || true)"
export STRATEGY_HISTORY="$strategy_history"
selected_strategy=""
strategy_selection_attempt=0
MAX_STRATEGY_SELECTION_ATTEMPTS=12
while [ "$strategy_selection_attempt" -lt "$MAX_STRATEGY_SELECTION_ATTEMPTS" ]; do
  strategy_selection_attempt=$((strategy_selection_attempt + 1))
  if ! bash scripts/autotube-recovery-strategy-engine.sh; then echo "RECOVERY_STRATEGY_PLAN=NO_EXECUTABLE_STRATEGY"; break; fi
  selected_strategy="$(head -n1 /tmp/autotube-recovery-strategy-plan.txt | cut -d'|' -f2-2 || true)"
  [ -n "$selected_strategy" ] || break
  export RECOVERY_STRATEGY="$selected_strategy"
  echo "RECOVERY ENGINE: adaptive planner candidate=$selected_strategy selectionAttempt=$strategy_selection_attempt"
  if bash scripts/autotube-recovery-preflight.sh "$selected_strategy"; then
    recovery_strategy="$selected_strategy"; echo "RECOVERY ENGINE: preflight PASS strategy=$recovery_strategy"; break
  fi
  echo "RECOVERY ENGINE: preflight FAIL strategy=$selected_strategy; selecting next ranked strategy."
  strategy_history="$strategy_history"$'\n'"strategy:$selected_strategy"
  export STRATEGY_HISTORY="$strategy_history"
  selected_strategy=""
done
if [ -z "$selected_strategy" ]; then
  echo "RECOVERY_TERMINAL: no strategy passed executable preflight."
  gh issue create --repo "$REPOSITORY" --title "AutoTube recovery blocked: no executable strategy" --body "Incident $incident_key has no strategy that passed runtime preflight. Resource=$recovery_resource class=$recovery_class." || true
  exit 0
fi
if [ "$recovery_strategy" = "HF_ZERO_GPU_PROVIDER_SWITCH" ]; then export AUTOTUBE_SKIP_DETERMINISTIC_HF="0"; else export AUTOTUBE_SKIP_DETERMINISTIC_HF="1"; fi
DETERMINISTIC_PATCH_READY="false"
APPLIED_STRATEGY="$recovery_strategy"
if [ "$recovery_strategy" = "HF_INFERENCE_RESOURCE_SWITCH" ] || [ "$recovery_strategy" = "INDEPENDENT_FREE_PROVIDER" ]; then
  echo "RECOVERY ENGINE: executing selected HF Inference strategy."
  if bash scripts/autotube-hf-inference-recovery.sh render-repair.patch && grep -q '^diff --git ' render-repair.patch; then
    DETERMINISTIC_PATCH_READY="true"; APPLIED_STRATEGY="HF_INFERENCE_RESOURCE_SWITCH"; echo "RECOVERY ENGINE: deterministic HF Inference patch generated successfully."
  else
    echo "RECOVERY ENGINE: HF Inference patch generation failed; falling back to bounded repair generation."; rm -f render-repair.patch
  fi
fi
if [ "$recovery_strategy" = "HF_ZERO_GPU_PROVIDER_SWITCH" ] && [ "$recovery_resource" = "HF_ZERO_GPU" ] && [ "${AUTOTUBE_SKIP_DETERMINISTIC_HF:-0}" != "1" ]; then
  echo "RECOVERY ENGINE: attempting deterministic HF_ZERO_GPU provider switch before bounded repair generation."
  if bash scripts/autotube-hf-zerogpu-recovery.sh render-repair.patch && grep -q '^diff --git ' render-repair.patch; then
    DETERMINISTIC_PATCH_READY="true"; APPLIED_STRATEGY="HF_ZERO_GPU_PROVIDER_SWITCH"; echo "RECOVERY ENGINE: deterministic HF_ZERO_GPU patch generated successfully."
  else
    echo "RECOVERY ENGINE: deterministic HF_ZERO_GPU route could not produce a safe patch; falling back to bounded repair generation."
  fi
fi[ -n "$RENDER_LOG" ] || export RENDER_LOG="Render incident $deploy_id status=$status and no diagnostic log was returned."

if [ "$DETERMINISTIC_PATCH_READY" != "true" ]; then
python3 - <<'PY'
import json, os, urllib.error, urllib.request, subprocess
prompt = """Return ONLY a unified git diff, optionally followed by a RENDER_ACTIONS block, or NO_SAFE_PATCH. Diagnose and repair the concrete Render/runtime incident. Compare at least TWO viable FREE alternatives for provider/infrastructure failures and implement the most stable route. Treat shared ZeroGPU Spaces as ONE resource, not independent providers. If the current resource is exhausted, switch resource class instead of adding more Spaces from the same resource. Preserve real AI video generation and strict QA. Never replace AI video with static images, stock, pan/zoom or fake video. Never weaken validation. Do not modify secrets, authentication, billing, permissions, repository or branch. Maximum 2 existing application files. No new dependency unless clearly necessary. If the current resource is unavailable and no independent free route is technically available from the repository/runtime context, return NO_SAFE_PATCH instead of inventing an API or weakening validation. Repair provider adapters, fallback selection, checkpoint/retry state, FFmpeg/render logic, YouTube acquisition, networking, memory, or deployment configuration when logs identify those as the root cause. Never merely retry the same failing operation. Resource=%s Class=%s Strategy=%s Attempt=%s/%s Incident=%s Commit=%s Logs=%s StrategyPlan=%s""" % (os.environ.get("RECOVERY_RESOURCE","UNKNOWN"),os.environ.get("RECOVERY_CLASS","UNKNOWN"),os.environ.get("RECOVERY_STRATEGY","PROVIDER_CASCADE"),os.environ.get("REPAIR_ATTEMPT","1"),os.environ.get("MAX_RECOVERY_ATTEMPTS","12"),os.environ.get("DEPLOY_ID",""),os.environ.get("COMMIT",""),os.environ.get("RENDER_LOG",""),open("/tmp/autotube-recovery-strategy-plan.txt").read() if os.path.exists("/tmp/autotube-recovery-strategy-plan.txt") else "unavailable")
body={"contents":[{"parts":[{"text":prompt}]}],"generationConfig":{"temperature":0,"maxOutputTokens":12000}}
# Discover the models currently exposed to THIS Gemini API key before trying repairs.
# This prevents stale/deprecated model IDs from consuming the recovery window.
preferred_models=[]
discovered_models=[]
try:
    req=urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100",
        headers={"x-goog-api-key":os.environ["GEMINI_API_KEY"],"accept":"application/json"},
        method="GET",
    )
    with urllib.request.urlopen(req,timeout=20) as response:
        catalog=json.load(response)
    for item in catalog.get("models",[]):
        methods=item.get("supportedGenerationMethods",[]) or []
        if "generateContent" in methods:
            name=str(item.get("name","")).strip()
            if name.startswith("models/"):
                name=name[7:]
            if name:
                lname=name.lower()
                excluded=("image" in lname or "tts" in lname or "live" in lname or "transcribe" in lname or "computer-use" in lname or "robotics" in lname or "lyria" in lname or "deep-research" in lname)
                stable_name = ((lname.startswith("gemini-2.5-") or lname.startswith("gemini-3.1-") or lname.startswith("gemini-3.5-")) and ("flash" in lname or "pro" in lname)) or lname in ("gemini-flash-latest","gemini-pro-latest")
                if stable_name and not excluded and "preview" not in lname and "customtools" not in lname and "omni" not in lname and "antigravity" not in lname:
                    discovered_models.append(name)
except Exception as exc:
    print("Gemini model discovery unavailable:",str(exc)[:300])

models=[]
for model in discovered_models:
    if model and model not in models:
        models.append(model)
models = models[:4]
print("Recovery Gemini bounded candidates:", " ".join(models))
for model in models:
    url="https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent"
    req=urllib.request.Request(url,data=json.dumps(body).encode(),headers={"content-type":"application/json","x-goog-api-key":os.environ["GEMINI_API_KEY"]},method="POST")
    try:
        with urllib.request.urlopen(req,timeout=12) as response: data=json.load(response)
        out=data["candidates"][0]["content"]["parts"][0]["text"].strip()
        if out.strip().startswith("NO_SAFE_PATCH"):
            print("Recovery model reports NO_SAFE_PATCH; continuing to next configured model:",model)
            continue
        if out.startswith("```"):
            lines=out.splitlines()
            if lines and lines[0].strip().startswith("```"): lines=lines[1:]
            if lines and lines[-1].strip()=="```": lines=lines[:-1]
            out="\n".join(lines).strip()
        # Gemini may wrap a valid diff in prose or append commentary.
        if "diff --git " in out: out=out[out.index("diff --git "):]
        lines=out.splitlines()
        valid=False
        for end in range(len(lines),0,-1):
            candidate="\n".join(lines[:end]).strip()+"\n"
            open("render-repair.patch","w").write(candidate)
            check=subprocess.run(["git","apply","--check","render-repair.patch"],capture_output=True,text=True)
            if check.returncode == 0:
                valid=True
                print("Recovery model succeeded with valid patch:",model)
                break
        if not valid:
            print("Recovery model produced invalid patch:",model)
            print(check.stderr[-2000:])
            continue
        break
    except urllib.error.HTTPError as ex:
        print("Recovery model failed:",model,ex.code)
        continue
    except Exception as ex:
        print("Recovery model failed:",model,type(ex).__name__,str(ex)[:240])
        continue
else:
    open("render-repair.patch","w").write("NO_SAFE_PATCH\\n")
    print("Recovery Engine could not obtain a valid repair from any configured model.")
PY
fi

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
  if ! validate_recovery_contract "$(cat render-repair.patch)"; then
    echo "RECOVERY_PATCH_REJECTED: contract validation failed."
    gh issue create --repo "$REPOSITORY" --title "AutoTube recovery patch rejected: $recovery_resource" --body "The generated patch failed the Recovery Engine contract before application. Incident=$incident_key resource=$recovery_resource class=$recovery_class strategy=$recovery_strategy." || true
    exit 0
  fi
  if ! git apply --check render-repair.patch; then echo "RECOVERY_PATCH_APPLY_CHECK_FAILED"; git apply --check render-repair.patch 2>&1 || true; exit 1; fi && git apply render-repair.patch
fi
node --check server.js
echo "RECOVERY_STAGE: node-check-ok"

if [ -s render-actions.txt ]; then
  echo "RECOVERY_RENDER_ACTIONS_REJECTED: dynamic Render service/env mutation is disabled; only validated repository code changes may be applied."
  rm -f render-actions.txt
fi
git diff --check
echo "RECOVERY_STAGE: diff-check-ok"
changed="$(git diff --name-only)"
count="$(printf "%s\n" "$changed" | sed "/^$/d" | wc -l)"
echo "RECOVERY_STAGE: changed-files count=$count files=[$(printf "%s" "$changed" | tr "\n" " ")]"
[ "$count" -le 2 ] || { git reset --hard HEAD; exit 0; }
if printf "%s\n" "$changed" | grep -Eq "(^|/)\.github/|(^|/)\.env|(^|/)package-lock\.json$"; then git reset --hard HEAD; exit 0; fi
git config user.name "AutoTube Render Repair Bot"
git config user.email "actions@users.noreply.github.com"
if [ "$runtime_incident" = "true" ]; then
  repair_commit_message="[autotube-auto-repair] runtime repair $runtime_fingerprint strategy:$APPLIED_STRATEGY runtime-fingerprint:$runtime_fingerprint render-deploy:$deploy_id"
else
  repair_commit_message="[autotube-auto-repair] fix Render deploy $deploy_id render-deploy:$deploy_id"
fi
git add -A
echo "RECOVERY_STAGE: git-add-ok"
git commit -m "$repair_commit_message"
echo "RECOVERY_STAGE: git-commit-ok"
git push origin HEAD:main
echo "RECOVERY_STAGE: git-push-ok"

# Deployment handoff is part of recovery, not a best-effort side effect.
REPAIRED_SHA="$(git rev-parse HEAD)"
echo "RECOVERY_HANDOFF: pushed repaired SHA=$REPAIRED_SHA; waiting for Render."
LAST_KNOWN_GOOD_DEPLOY="$live_deploy_id"
LAST_KNOWN_GOOD_SHA="$live_commit"
AUTODEPLOY_DISABLED_FOR_ROLLBACK="false"

rollback_to_last_known_good() {
  if [ -z "$LAST_KNOWN_GOOD_DEPLOY" ] || [ -z "$LAST_KNOWN_GOOD_SHA" ]; then echo "RECOVERY_ROLLBACK_BLOCKED: no known-good deploy/SHA."; return 1; fi
  if ! curl --fail-with-body -sS -X PATCH -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" "https://api.render.com/v1/services/$RENDER_SERVICE_ID" --data '{"autoDeploy":"no"}' >/tmp/autotube-autodeploy-off.json; then return 1; fi
  AUTODEPLOY_DISABLED_FOR_ROLLBACK="true"
  rollback_json="$(curl --fail-with-body -sS -X POST -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/rollback" --data "$(jq -nc --arg id "$LAST_KNOWN_GOOD_DEPLOY" '{deployId:$id}')")" || return 1
  for rb_poll in $(seq 1 24); do
    current="$(curl --fail-with-body -sS -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys?limit=10" || true)"
    good="$(echo "$current" | jq -c --arg sha "$LAST_KNOWN_GOOD_SHA" 'map(.deploy // .) | map(select(.commit.id==$sha and .status=="live")) | .[0] // empty')"
    [ -n "$good" ] && { echo "RECOVERY_ROLLBACK_VERIFIED: known-good SHA=$LAST_KNOWN_GOOD_SHA is LIVE."; return 0; }
    sleep 20
  done
  return 1
}

render_deploy_for_sha() {
  curl --fail-with-body -sS -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys?limit=20" |
    jq -c --arg sha "$REPAIRED_SHA" "map(.deploy // .) | map(select(.commit.id == \$sha)) | .[0] // empty"
}
RENDER_DEPLOY_ID=""
for attempt in $(seq 1 12); do
  matched="$(render_deploy_for_sha || true)"
  if [ -n "$matched" ]; then RENDER_DEPLOY_ID="$(echo "$matched" | jq -r '.id // empty')"; break; fi
  sleep 20
done
if [ -z "$RENDER_DEPLOY_ID" ]; then
  fallback_json="$(curl --fail-with-body -sS -X POST -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys" --data "$(jq -nc --arg sha "$REPAIRED_SHA" '{commitId:$sha,deployMode:"build_and_deploy"}')")"
  RENDER_DEPLOY_ID="$(echo "$fallback_json" | jq -r '.id // .deploy.id // empty')"
  [ -n "$RENDER_DEPLOY_ID" ] || { echo "RECOVERY_DEPLOY_BLOCKED: no deploy id for exact SHA."; exit 1; }
fi
live_verified="false"
for attempt in $(seq 1 24); do
  deploy_json="$(curl --fail-with-body -sS -H "Accept: application/json" -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys/$RENDER_DEPLOY_ID" || true)"
  deploy_status="$(echo "$deploy_json" | jq -r '.status // empty' 2>/dev/null || true)"
  deploy_sha="$(echo "$deploy_json" | jq -r '.commit.id // empty' 2>/dev/null || true)"
  if [ "$deploy_sha" != "$REPAIRED_SHA" ]; then sleep 20; continue; fi
  case "$deploy_status" in
    live) live_verified="true"; break ;;
    build_failed|update_failed|pre_deploy_failed|deactivated) rollback_to_last_known_good || true; exit 1 ;;
  esac
  sleep 20
done
[ "$live_verified" = "true" ] || { rollback_to_last_known_good || true; exit 1; }
echo "RECOVERY_DEPLOY_VERIFIED: Render LIVE with exact repaired SHA=$REPAIRED_SHA deploy=$RENDER_DEPLOY_ID."

e2e_run=""
for attempt in $(seq 1 18); do
  runs="$(gh api --paginate "/repos/$REPOSITORY/actions/workflows/autotube-e2e.yml/runs?branch=main&per_page=20" 2>/dev/null || true)"
  e2e_run="$(printf '%s' "$runs" | jq -r --arg sha "$REPAIRED_SHA" "map(.workflow_runs[]?) | map(select(.head_sha==\$sha)) | .[0].id // empty" | head -n1)"
  [ -n "$e2e_run" ] && break
  sleep 10
done
if [ -z "$e2e_run" ]; then rollback_to_last_known_good || true; exit 1; fi
for attempt in $(seq 1 24); do
  e2e_json="$(gh api "/repos/$REPOSITORY/actions/runs/$e2e_run" 2>/dev/null || true)"
  e2e_status="$(printf '%s' "$e2e_json" | jq -r '.status // empty')"
  e2e_conclusion="$(printf '%s' "$e2e_json" | jq -r '.conclusion // empty')"
  if [ "$e2e_status" = "completed" ]; then
    if [ "$e2e_conclusion" = "success" ]; then
      echo "RECOVERY_E2E_VERIFIED: canonical E2E succeeded on repaired SHA=$REPAIRED_SHA run=$e2e_run."
      if [ "$AUTODEPLOY_DISABLED_FOR_ROLLBACK" = "true" ]; then
        curl --fail-with-body -sS -X PATCH -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" "https://api.render.com/v1/services/$RENDER_SERVICE_ID" --data '{"autoDeploy":"yes"}' >/tmp/autotube-autodeploy-on.json || exit 1
      fi
      exit 0
    fi
    rollback_to_last_known_good || true
    exit 1
  fi
  sleep 20
done
rollback_to_last_known_good || true
exit 1
