#!/usr/bin/env bash
set -euo pipefail

PATCH_FILE="${1:-render-repair.patch}"

python3 - <<'PY'
from pathlib import Path
p=Path("server.js")
s=p.read_text()
old="""  const allowHfInferenceRecovery =
    Boolean(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN) &&
    String(process.env.AUTOTUBE_ENABLE_HF_INFERENCE_VIDEO_RECOVERY??'1').trim()!=='0';
"""
new="""  // HF Inference is an independent resource class from ZeroGPU. The route is
  // attempted only when explicitly enabled; the client still requires a valid
  // HF credential at runtime and strict AI-video validation remains unchanged.
  const allowHfInferenceRecovery =
    String(process.env.AUTOTUBE_ENABLE_HF_INFERENCE_VIDEO_RECOVERY??'1').trim()!=='0' &&
    Boolean(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN);
"""
if s.count(old)!=1:
    raise SystemExit("HF_INFERENCE_RECOVERY_TARGET_NOT_UNIQUE")
# Make the free routed model the first deterministic candidate when no custom model is set.
old2="""    {model:'Wan-AI/Wan2.1-T2V-1.3B',provider:'fal-ai'},
    {model:'Wan-AI/Wan2.2-TI2V-5B',provider:'replicate'},
"""
new2="""    {model:'Wan-AI/Wan2.1-T2V-1.3B',provider:'fal-ai'},
    {model:'Lightricks/LTX-Video-0.9.8-13B-distilled',provider:'fal-ai'},
    {model:'Wan-AI/Wan2.2-TI2V-5B',provider:'replicate'},
"""
if s.count(old2)!=1:
    raise SystemExit("HF_INFERENCE_CANDIDATE_TARGET_NOT_UNIQUE")
s=s.replace(old,new,1).replace(old2,new2,1)
for marker in [
 "function requireRealAiVideoGeneration(){return String(process.env.AUTOTUBE_REQUIRE_REAL_AI_VIDEO??'1').trim()!=='0';}",
 "REAL_AI_VIDEO_REQUIRED: todos los proveedores de vídeo IA",
 "generationType:'ai-video'",
]:
    if marker not in s:
        raise SystemExit("HF_INFERENCE_SAFETY_MARKER_MISSING")
p.write_text(s)
PY

git diff -- server.js > "$PATCH_FILE"
git restore -- server.js
grep -q '^diff --git a/server.js b/server.js' "$PATCH_FILE"
grep -q 'allowHfInferenceRecovery' "$PATCH_FILE"
grep -q 'REAL_AI_VIDEO_REQUIRED' server.js
echo "DETERMINISTIC_HF_INFERENCE_PATCH_READY"
