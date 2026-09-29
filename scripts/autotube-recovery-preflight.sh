#!/usr/bin/env bash
set -euo pipefail

strategy="${1:-}"
case "$strategy" in
  HF_INFERENCE_RESOURCE_SWITCH|INDEPENDENT_FREE_PROVIDER)
    token="${HF_TOKEN:-${HUGGINGFACE_TOKEN:-}}"
    [ -n "$token" ] || { echo "RECOVERY_PREFLIGHT_FAIL strategy=$strategy reason=HF_TOKEN_MISSING"; exit 20; }
    curl --fail-with-body -sS --max-time 20 -H "Authorization: Bearer $token" -H "Accept: application/json" https://huggingface.co/api/whoami-v2 >/tmp/autotube-hf-whoami.json || {
      echo "RECOVERY_PREFLIGHT_FAIL strategy=$strategy reason=HF_TOKEN_INVALID_OR_INACCESSIBLE"; exit 21;
    }
    model="${AUTOTUBE_HF_PREFLIGHT_MODEL:-Wan-AI/Wan2.1-T2V-1.3B}"
    # Availability probe: confirm that the selected text-to-video model is currently
    # mapped to at least one live Inference Provider. The actual clip generation
    # remains the authoritative provider test and E2E gate.
    model="${AUTOTUBE_HF_PREFLIGHT_MODEL:-Wan-AI/Wan2.1-T2V-1.3B}"
    encoded_model="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1],safe=""))' "$model")"
    mapping="$(curl --fail-with-body -sS --max-time 20       -H "Authorization: Bearer $token" -H "Accept: application/json"       "https://huggingface.co/api/models/$encoded_model?expand=inferenceProviderMapping")" || {
        echo "RECOVERY_PREFLIGHT_FAIL strategy=$strategy reason=HF_MODEL_MAPPING_UNAVAILABLE"; exit 25;
      }
    live_count="$(printf '%s' "$mapping" | jq '[.inferenceProviderMapping // {} | to_entries[] | select(.value.status=="live")] | length')"
    [ "$live_count" -gt 0 ] || {
      echo "RECOVERY_PREFLIGHT_FAIL strategy=$strategy reason=HF_NO_LIVE_VIDEO_PROVIDER"; exit 26;
    }
    echo "RECOVERY_PREFLIGHT_PASS strategy=$strategy provider=HF_INFERENCE liveProviders=$live_count model=$model"
    exit 0
    ;;
  HF_ZERO_GPU_PROVIDER_SWITCH)
    echo "RECOVERY_PREFLIGHT_FAIL strategy=$strategy reason=ZERO_GPU_NOT_SELECTED_BY_PREFLIGHT"; exit 30;;
  PAID_PROVIDER_SWITCH|POLLINATIONS_RECOVERY|REPLICATE_RECOVERY)
    if [ "${AUTOTUBE_ALLOW_PAID_RECOVERY:-0}" = "1" ]; then
      echo "RECOVERY_PREFLIGHT_PASS strategy=$strategy provider=PAID_OPT_IN"; exit 0
    fi
    echo "RECOVERY_PREFLIGHT_FAIL strategy=$strategy reason=PAID_RECOVERY_NOT_OPTED_IN"; exit 31
    ;;
  *)
    echo "RECOVERY_PREFLIGHT_PASS strategy=$strategy provider=LOCAL"; exit 0
    ;;
esac
