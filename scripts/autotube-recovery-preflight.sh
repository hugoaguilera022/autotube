#!/usr/bin/env bash
set -euo pipefail

strategy="${1:-}"
case "$strategy" in
  HF_INFERENCE_RESOURCE_SWITCH|INDEPENDENT_FREE_PROVIDER)
    # Prefer a runtime preflight so the check sees the same Render credentials
    # that the production generator will use. Never expose the token.
    if [ -n "${AUTOTUBE_RUNTIME_PREFLIGHT_URL:-}" ]; then
      runtime="$(curl -sS --max-time 25 "${AUTOTUBE_RUNTIME_PREFLIGHT_URL}?strategy=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$strategy")" || true)"
      if printf '%s' "$runtime" | jq -e '.ok==true' >/dev/null 2>&1; then
        echo "RECOVERY_PREFLIGHT_PASS strategy=$strategy source=runtime $(printf '%s' "$runtime" | jq -r '.provider // "unknown"')"
        exit 0
      fi
      echo "RECOVERY_PREFLIGHT_RUNTIME_REJECTED strategy=$strategy detail=$(printf '%s' "$runtime" | jq -r '.reason // .error // "unknown"' 2>/dev/null || true)"
      exit 20
    fi
    if [ "$strategy" = "INDEPENDENT_FREE_PROVIDER" ]; then
      if [ -n "${FREE_AI_API_KEY:-}" ]; then
        echo "RECOVERY_PREFLIGHT_PASS strategy=$strategy provider=FREE_AI"
        exit 0
      fi
      if [ -n "${PIXAZO_API_KEY:-}" ]; then
        echo "RECOVERY_PREFLIGHT_PASS strategy=$strategy provider=PIXAZO_FREE"
        exit 0
      fi
      if [ -n "${AGNES_API_KEY:-}" ]; then
        echo "RECOVERY_PREFLIGHT_PASS strategy=$strategy provider=AGNES_FREE"
        exit 0
      fi
      echo "RECOVERY_PREFLIGHT_FAIL strategy=$strategy reason=NO_INDEPENDENT_FREE_PROVIDER_CREDENTIAL"
      exit 20
    fi
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
  CODE_REPAIR|PROVIDER_ADAPTER_REPAIR|CASCADE_REPAIR)
    [ -n "${GEMINI_API_KEY:-}" ] || { echo "RECOVERY_PREFLIGHT_FAIL strategy=$strategy reason=GEMINI_API_KEY_MISSING"; exit 32; }
    echo "RECOVERY_PREFLIGHT_PASS strategy=$strategy provider=GEMINI_REPAIR"
    exit 0
    ;;
  *)
    echo "RECOVERY_PREFLIGHT_PASS strategy=$strategy provider=LOCAL"; exit 0
    ;;
esac
