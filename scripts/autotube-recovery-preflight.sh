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
    probe_url="https://router.huggingface.co/fal-ai/v1/videos/generations"
    probe_payload="$(jq -nc --arg model "$model" '{model:$model,prompt:"A short cinematic abstract motion test for AutoTube recovery",num_frames:8,fps:4}')"
    http_code="$(curl -sS --max-time 45 -o /tmp/autotube-hf-probe.json -w '%{http_code}' -X POST "$probe_url" -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data "$probe_payload" || true)"
    case "$http_code" in
      2??) echo "RECOVERY_PREFLIGHT_PASS strategy=$strategy provider=HF_INFERENCE"; exit 0;;
      401|403) echo "RECOVERY_PREFLIGHT_FAIL strategy=$strategy reason=HF_PROVIDER_ACCESS_DENIED"; exit 22;;
      402) echo "RECOVERY_PREFLIGHT_FAIL strategy=$strategy reason=HF_PROVIDER_CREDIT_EXHAUSTED"; exit 23;;
      429) echo "RECOVERY_PREFLIGHT_FAIL strategy=$strategy reason=HF_PROVIDER_RATE_LIMIT"; exit 24;;
      *) echo "RECOVERY_PREFLIGHT_FAIL strategy=$strategy reason=HF_PROVIDER_UNAVAILABLE_HTTP_${http_code:-000}"; exit 25;;
    esac
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
