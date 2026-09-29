#!/usr/bin/env bash
set -euo pipefail

# Deterministic HF_ZERO_GPU recovery.
# This path deliberately does not ask a language model to invent a patch.
# It only enables the already-implemented Pollinations real-video provider
# ahead of the shared Hugging Face ZeroGPU pool when a Pollinations key exists.
#
# Contract:
#   HF_ZERO_GPU + POLLINATIONS_API_KEY -> one narrowly-scoped server.js diff
#   no key -> NO_SAFE_PATCH
#   never touches REAL_AI_VIDEO_REQUIRED or validators.

PATCH_FILE="${1:-render-repair.patch}"

if [ -z "${POLLINATIONS_API_KEY:-}" ]; then
  printf '%s\n' "NO_SAFE_PATCH"
  exit 2
fi

python3 - "$PATCH_FILE" <<'PY'
from pathlib import Path
import difflib
import sys

path = Path("server.js")
old = path.read_text()
needle = """  const order=[
    ...(allowPaid&&process.env.REPLICATE_API_TOKEN?['Replicate']:[]),
    ...(allowPaid&&(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN)?['HF-Inference']:[]),
    ...(allowPaid&&process.env.POLLINATIONS_API_KEY&&String(process.env.AUTOTUBE_ALLOW_POLLINATIONS_PAID||'0')==='1'?['Pollinations']:[]),
    ...(referenceFramePath?['LTX-2.3-ZeroGPU','Wan2.2-AoTI','Wan2.2-AoTI-R3GM','Wan2.2-AoTI-CB','Wan2.2-Rahul-AOT','Wan2.2-I2V','Wan2.1-VACE']:[]),
    'Wan2.2-Rahul-T2V',
    'Wan2.2-ZeroGPU','OpenKing-Wan2.2','LTX-2.5','Wan2.1','LTX-0.9.8'
  ];
"""
if old.count(needle) != 1:
    raise SystemExit("DETERMINISTIC_RECOVERY_TARGET_NOT_UNIQUE")

replacement = """  // HF_ZERO_GPU recovery uses the already-implemented Pollinations video
  // adapter as an independent resource class. It is opt-out only; the normal
  // paid-provider gate remains unchanged for all other runs.
  const allowPollinationsRecovery =
    Boolean(process.env.POLLINATIONS_API_KEY) &&
    String(process.env.AUTOTUBE_ENABLE_POLLINATIONS_VIDEO_RECOVERY??'1').trim()!=='0';
  const order=[
    ...(allowPaid&&process.env.REPLICATE_API_TOKEN?['Replicate']:[]),
    ...(allowPaid&&(process.env.HF_TOKEN||process.env.HUGGINGFACE_TOKEN)?['HF-Inference']:[]),
    ...(allowPaid&&process.env.POLLINATIONS_API_KEY&&String(process.env.AUTOTUBE_ALLOW_POLLINATIONS_PAID||'0')==='1'?['Pollinations']:[]),
    ...(allowPollinationsRecovery?['Pollinations']:[]),
    ...(referenceFramePath?['LTX-2.3-ZeroGPU','Wan2.2-AoTI','Wan2.2-AoTI-R3GM','Wan2.2-AoTI-CB','Wan2.2-Rahul-AOT','Wan2.2-I2V','Wan2.1-VACE']:[]),
    'Wan2.2-Rahul-T2V',
    'Wan2.2-ZeroGPU','OpenKing-Wan2.2','LTX-2.5','Wan2.1','LTX-0.9.8'
  ];
"""
new = old.replace(needle, replacement, 1)

# Refuse any semantic weakening of the strict real-video gate.
required = [
    "function requireRealAiVideoGeneration(){return String(process.env.AUTOTUBE_REQUIRE_REAL_AI_VIDEO??'1').trim()!=='0';}",
    "REAL_AI_VIDEO_REQUIRED: todos los proveedores de vídeo IA",
    "generationType:'ai-video'",
]
for marker in required:
    if marker not in new:
        raise SystemExit("DETERMINISTIC_RECOVERY_SAFETY_MARKER_MISSING")

diff = ''.join(difflib.unified_diff(
    old.splitlines(True),
    new.splitlines(True),
    fromfile="a/server.js",
    tofile="b/server.js",
))
if not diff.startswith("--- a/server.js\n") or "\n+++ b/server.js\n" not in diff:
    raise SystemExit("DETERMINISTIC_RECOVERY_INVALID_DIFF")
Path(sys.argv[1]).write_text("diff --git a/server.js b/server.js\n" + diff)
print("DETERMINISTIC_HF_ZERO_GPU_PATCH_READY")
PY
