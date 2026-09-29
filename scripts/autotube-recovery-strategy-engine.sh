#!/usr/bin/env bash
set -euo pipefail

# Adaptive Recovery Strategy Engine.
# Produces a ranked set of repair strategies from incident evidence, runtime
# constraints and prior strategy history. It never weakens REAL_AI_VIDEO_REQUIRED.

log="${RENDER_LOG:-}"
class="${RECOVERY_CLASS:-UNKNOWN}"
resource="${RECOVERY_RESOURCE:-UNKNOWN}"
history="${STRATEGY_HISTORY:-}"
attempt="${REPAIR_ATTEMPT:-1}"

has(){ grep -Eiq "$1" <<<"$log"; }
used(){ grep -Fq "strategy:$1" <<<"$history"; }

score=0
ranked=()

add_candidate() {
  local name="$1" base="$2" reason="$3"
  used "$name" && return
  local s="$base"
  if has '402|Payment Required|zero balance|insufficient balance'; then
    case "$name" in
      POLLINATIONS_RECOVERY|REPLICATE_RECOVERY|PAID_PROVIDER_SWITCH) s=$((s-80));;
    esac
  fi
  if has 'ZeroGPU quota|exceeded your ZeroGPU quota|remaining quota'; then
    case "$name" in
      HF_ZERO_GPU_PROVIDER_SWITCH) s=$((s-100));;
      HF_INFERENCE_RESOURCE_SWITCH|INDEPENDENT_FREE_PROVIDER) s=$((s+35));;
    esac
  fi
  if has '429|rate limit|Too Many Requests'; then
    case "$name" in
      PROVIDER_COOLDOWN|INDEPENDENT_FREE_PROVIDER|CODE_REPAIR) s=$((s+20));;
    esac
  fi
  if has 'ReferenceError|Cannot access .* before initialization|SyntaxError|Cannot find module'; then
    case "$name" in
      CODE_REPAIR|CASCADE_REPAIR) s=$((s+70));;
    esac
  fi
  if has 'ffmpeg|invalid data found|moov atom not found|Output file is empty|codec|mux'; then
    case "$name" in
      FFMPEG_PIPELINE_REPAIR|OUTPUT_VALIDATION_REPAIR) s=$((s+70));;
    esac
  fi
  if has '502|503|504|temporarily unavailable|queue'; then
    case "$name" in
      INDEPENDENT_FREE_PROVIDER|PROVIDER_COOLDOWN) s=$((s+30));;
    esac
  fi
  ranked+=( "$s|$name|$reason" )
}

case "$class|$resource" in
  QUOTA\|HF_ZERO_GPU)
    add_candidate HF_ZERO_GPU_PROVIDER_SWITCH 95 "deterministic independent-provider switch already implemented"
    add_candidate CODE_REPAIR 88 "repair local cascade if runtime evidence identifies a code defect"
    add_candidate INDEPENDENT_FREE_PROVIDER 84 "investigate and implement an independent free provider"
    add_candidate PROVIDER_ADAPTER_REPAIR 78 "repair provider integration contract"
    add_candidate CASCADE_REPAIR 76 "repair provider cascade so the next viable resource can execute"
    add_candidate HF_INFERENCE_RESOURCE_SWITCH 70 "use free HF inference when runtime credentials and endpoint are verified"
    ;;
  PAYMENT_OR_ACCESS\|EXTERNAL_API_ACCESS)
    add_candidate INDEPENDENT_FREE_PROVIDER 95 "avoid unavailable paid resource"
    add_candidate PROVIDER_ADAPTER_REPAIR 80 "repair access/integration only if credentials are valid"
    add_candidate CODE_REPAIR 70 "repair local cascade/access handling"
    add_candidate PAID_PROVIDER_SWITCH 5 "paid route, only if explicitly permitted"
    ;;
  QUOTA\|*)
    add_candidate PROVIDER_COOLDOWN 92 "avoid repeatedly hitting the same rate-limited resource"
    add_candidate INDEPENDENT_FREE_PROVIDER 88 "switch to an independent resource"
    add_candidate CODE_REPAIR 70 "repair retry/backoff/cascade logic"
    ;;
  CODE\|*)
    add_candidate CODE_REPAIR 100 "direct application-code root cause"
    add_candidate CASCADE_REPAIR 94 "repair fallback/state transition"
    add_candidate PROVIDER_ADAPTER_REPAIR 78 "repair integration contract"
    ;;
  OUTPUT_INVALID\|*)
    add_candidate FFMPEG_PIPELINE_REPAIR 100 "repair invalid media pipeline"
    add_candidate OUTPUT_VALIDATION_REPAIR 96 "repair output validation/assembly"
    add_candidate PROVIDER_ADAPTER_REPAIR 70 "repair malformed provider output"
    ;;
  *)
    add_candidate CODE_REPAIR 75 "local root-cause repair"
    add_candidate PROVIDER_ADAPTER_REPAIR 70 "provider integration repair"
    add_candidate INDEPENDENT_FREE_PROVIDER 65 "independent free resource"
    add_candidate DIAGNOSTIC_ESCALATION 50 "deepen diagnosis before mutation"
    ;;
esac

printf '%s\n' "${ranked[@]}" | sort -t'|' -k1,1nr > recovery-strategy-plan.txt
selected="$(head -n1 recovery-strategy-plan.txt || true)"

if [ -z "$selected" ]; then
  echo "RECOVERY_STRATEGY_PLAN=NO_UNUSED_STRATEGY"
  exit 2
fi

IFS='|' read -r score name reason <<< "$selected"
echo "RECOVERY_STRATEGY_PLAN_SELECTED=$name"
echo "RECOVERY_STRATEGY_SCORE=$score"
echo "RECOVERY_STRATEGY_REASON=$reason"
echo "RECOVERY_STRATEGY_ATTEMPT=$attempt"
echo "RECOVERY_STRATEGY_CANDIDATES=$(tr '\n' ';' < recovery-strategy-plan.txt)"
