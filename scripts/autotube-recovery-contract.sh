#!/usr/bin/env bash
set -euo pipefail

# AutoTube Recovery Engine contract helpers.
# These helpers are deliberately dependency-light so the recovery supervisor can
# validate an incident/patch before it is allowed to mutate the application.

AUTOTUBE_RECOVERY_MAX_ATTEMPTS_DEFAULT="${AUTOTUBE_MAX_RECOVERY_ATTEMPTS:-12}"
AUTOTUBE_RECOVERY_MAX_RECURSION="${AUTOTUBE_MAX_RECOVERY_RECURSION:-3}"

recovery_fingerprint() {
  printf '%s\n' "${1:-}" |
    sed -E 's/[0-9a-f]{8}-[0-9a-f-]{27,}/<ID>/g;
            s/20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z/<TIME>/g;
            s/[0-9]{10,}/<N>/g' |
    sha256sum | cut -d' ' -f1
}

recovery_classify() {
  local log="${1:-}"
  if grep -Eiq 'ZeroGPU quota|exceeded your ZeroGPU quota|remaining quota' <<<"$log"; then
    printf '%s\n' 'QUOTA|HF_ZERO_GPU|RESOURCE_SWITCH'
  elif grep -Eiq '402|Payment Required' <<<"$log"; then
    printf '%s\n' 'PAYMENT_OR_ACCESS|EXTERNAL_API_ACCESS|PROVIDER_SWITCH'
  elif grep -Eiq '429|rate limit|Too Many Requests' <<<"$log"; then
    printf '%s\n' 'QUOTA|PROVIDER_RATE_LIMIT|PROVIDER_COOLDOWN'
  elif grep -Eiq '502|503|504|Service Unavailable|temporarily unavailable|queue' <<<"$log"; then
    printf '%s\n' 'CAPACITY|PROVIDER_CAPACITY|PROVIDER_SWITCH'
  elif grep -Eiq 'out of memory|heap out of memory|exit 137' <<<"$log"; then
    printf '%s\n' 'INFRASTRUCTURE|RENDER_MEMORY|RESOURCE_OPTIMIZATION'
  elif grep -Eiq 'node --check|SyntaxError|ReferenceError|Cannot find module' <<<"$log"; then
    printf '%s\n' 'CODE|APPLICATION_CODE|CODE_REPAIR'
  elif grep -Eiq 'ffmpeg|invalid data found|moov atom not found|Output file is empty|corrupt|codec|mux' <<<"$log"; then
    printf '%s\n' 'OUTPUT_INVALID|FFMPEG_OUTPUT|RENDER_PIPELINE_REPAIR'
  elif grep -Eiq 'yt-dlp|Sign in to confirm|video.*unavailable|player response' <<<"$log"; then
    printf '%s\n' 'SOURCE_ACCESS|YOUTUBE_SOURCE|YOUTUBE_ACQUISITION_SWITCH'
  elif grep -Eiq 'ENOTFOUND|EAI_AGAIN|CERT|TLS|socket hang up|ECONNREFUSED|ECONNRESET|ETIMEDOUT' <<<"$log"; then
    printf '%s\n' 'NETWORK|NETWORK|NETWORK_RESILIENCE'
  elif grep -Eiq 'permission denied|EACCES|ENOENT|no such file or directory' <<<"$log"; then
    printf '%s\n' 'FILESYSTEM|FILESYSTEM|FILESYSTEM_REPAIR'
  elif grep -Eiq 'invalid json|JSON.parse|Unexpected token|response.*schema' <<<"$log"; then
    printf '%s\n' 'INVALID_RESPONSE|INTEGRATION_CONTRACT|ADAPTER_REPAIR'
  elif grep -Eiq 'health.?check|did not bind|listen.*failed' <<<"$log"; then
    printf '%s\n' 'DEPLOY|RENDER_RUNTIME|SERVICE_START_REPAIR'
  else
    printf '%s\n' 'UNKNOWN|UNKNOWN|DIAGNOSTIC_ESCALATION'
  fi
}

validate_recovery_contract() {
  local patch="${1:-}"
  [ -n "$patch" ] || return 10

  # A repair is only actionable when it is a real unified diff.
  grep -q '^diff --git ' <<<"$patch" || return 11
  grep -q '^--- ' <<<"$patch" || return 12
  grep -q '^+++ ' <<<"$patch" || return 13

  # Never permit a repair to weaken the core product contract.
  if grep -Eiq 'REAL_AI_VIDEO_REQUIRED|requireRealAiVideoGeneration|validateRenderedMp4|referenceSimilarityValidation' <<<"$patch"; then
    # Referencing validators is fine; deleting or weakening their enforcement is not.
    if grep -Eiq '^-.*(REAL_AI_VIDEO_REQUIRED|requireRealAiVideoGeneration|validateRenderedMp4|referenceSimilarityValidation)' <<<"$patch"; then
      return 20
    fi
  fi

  # Never allow secret/config mutation through the generated patch.
  if grep -Eiq '^(+++|--- ).*(\.env|secrets|credentials|package-lock\.json)' <<<"$patch"; then
    return 21
  fi

  return 0
}

recovery_strategy_is_new() {
  local history="${1:-}"
  local strategy="${2:-}"
  [ -n "$strategy" ] || return 1
  ! grep -Fq "strategy=$strategy" <<<"$history"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "${1:-}" = "--self-test" ]; then
    testlog='ZeroGPU quota exceeded'
    expected='QUOTA|HF_ZERO_GPU|RESOURCE_SWITCH'
    actual="$(recovery_classify "$testlog")"
    [ "$actual" = "$expected" ] || { echo "classification self-test failed: $actual"; exit 1; }

    fp1="$(recovery_fingerprint 'ZeroGPU quota run 1790644344806')"
    fp2="$(recovery_fingerprint 'ZeroGPU quota run 1790644344999')"
    [ "$fp1" = "$fp2" ] || { echo "fingerprint normalization self-test failed"; exit 1; }

    valid='diff --git a/server.js b/server.js
--- a/server.js
+++ b/server.js
@@ -1 +1 @@
-old
+new'
    validate_recovery_contract "$valid"

    unsafe='diff --git a/server.js b/server.js
--- a/server.js
+++ b/server.js
@@ -1 +1 @@
-old
+new
-REAL_AI_VIDEO_REQUIRED
'
    if validate_recovery_contract "$unsafe"; then
      echo "unsafe patch self-test failed"
      exit 1
    fi

    echo "AUTOTUBE_RECOVERY_CONTRACT_TEST=PASS"
    exit 0
  fi
fi
