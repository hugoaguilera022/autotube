# AutoTube — Autonomous Recovery, Optimization and Real-AI Video Plan

## Scope
This document is the operating plan for `autotube's workspace`. The autonomous cycle must diagnose root causes, repair them, deploy safely, validate the repaired stage, compare viable alternatives, and continue until a real final MP4 is validated or genuine user action is required.

## Non-negotiable final objective
The canonical E2E must produce an MP4 whose scene assets are **real AI-generated video clips**. A still image animated with FFmpeg is a continuity fallback only and must never be counted as successful real-AI video generation.

The environment flag `AUTOTUBE_REQUIRE_REAL_AI_VIDEO` controls the strict gate and defaults to enabled.

## Pipeline
1. YouTube reference URL
2. Source/reference audiovisual analysis
3. Production plan/storyboard
4. Scene prompts and continuity blueprint
5. Real AI video generation (T2V/I2V)
6. Per-scene video validation
7. Narration
8. Original music/ambience
9. Fast montage
10. Final MP4 validation
11. Reference-profile conformance validation
12. Artifact/report publication

## Video-generation hierarchy
1. Configured Replicate/HF or other known working AI-video provider.
2. Another configured AI-video provider/model.
3. A free/available model discovered by the provider manager.
4. Deterministic local FFmpeg fallback only for non-strict continuity/manual flows.
5. Canonical E2E: if only the deterministic fallback works, fail with `REAL_AI_VIDEO_REQUIRED` and reopen provider discovery/repair instead of declaring success.

## Provider state
Each provider should be treated as HEALTHY, DEGRADED, COOLDOWN, DISABLED or RECOVERING.

- 429/quota: cooldown; do not blindly retry.
- 401/403/missing credential: mark user/config blocking only when no configured alternative exists.
- 404/unsupported model: disable that model route.
- repeated 5xx: degrade and test an alternative.
- timeout: record latency and stop spending the entire cycle on the same route.
- success: record provider, model, duration, output dimensions, bytes and generation type.

## Error policy
First failure: diagnose and repair.
Second failure of the same root cause: broaden the investigation.
Third failure: do not repeat the same strategy; implement or test an alternative route.

A retry without a changed hypothesis/route is not considered recovery.

## Checkpoint policy
Successful stages must be reused when their checkpoint and artifacts are still valid. After a Render restart, in-memory checkpoints may disappear, so durable checkpoint persistence is a future priority.

Durable checkpoint fields should include:
- job id
- reference URL
- current stage
- completed stages
- artifact identifiers/paths
- provider/model
- generation type
- timestamps
- error history
- attempt count
- validation results

## Artifact validation
Every video clip:
- valid video stream
- decodable by FFmpeg
- duration >= 3s
- expected dimensions/FPS where applicable
- non-empty
- real frame-to-frame change

Canonical E2E:
- all required scenes must have generationType=ai-video
- final MP4 must contain video + AAC audio
- expected duration must match within tolerance
- final MP4 must pass motion validation
- final MP4 must pass reference-profile validation

## Render optimization without quality loss
Priority order:
1. eliminate redundant work;
2. reuse validated artifacts;
3. avoid re-encoding compatible AI clips;
4. stream-copy video where codec/container compatibility allows;
5. serialize memory-heavy FFmpeg operations;
6. parallelize only independent lightweight work with a strict concurrency limit;
7. avoid duplicate provider calls;
8. only consider quality reduction if all preservation-first optimizations are exhausted and explicitly approved.

Do not reduce resolution/FPS merely to hide a CPU bottleneck.

## Render recovery
If the final render fails:
1. inspect the exact FFmpeg command and stderr;
2. determine whether the failure is input, codec, muxing, audio, duration, memory or concurrency;
3. fix only the relevant layer;
4. rerun the smallest useful validation;
5. rerun full E2E only after the repaired stage passes.

## Resource protection
On Render Free:
- never run overlapping full generation jobs;
- never launch unbounded scene generation;
- keep downloads serialized where they compete for memory/sockets;
- monitor CPU and memory during render;
- prefer stream-copy and single-pass muxing.

## Watchdog
The GitHub watchdog remains the supervisor:
- preserve one canonical E2E owner;
- cancel stale/duplicate workflows;
- dispatch the canonical E2E when no valid owner exists;
- never mask an application failure with blind retries;
- allow self-heal/repair workflows to finish;
- stop only on validated final MP4 or genuine user action.

## Recovery loop
```
error
  -> classify
  -> collect logs/metrics
  -> identify root cause
  -> choose repair or alternative
  -> isolated branch
  -> validation
  -> PR/merge
  -> Render deploy
  -> exact-commit health check
  -> smallest useful test
  -> canonical E2E
  -> measure
  -> record outcome
```

## Real-AI video acceptance
The system must distinguish:
- `ai-video`: output created by an AI video generation provider/model.
- `deterministic-fallback`: image-to-motion FFmpeg fallback.

Only `ai-video` satisfies the canonical real-video objective.

## Future hardening
1. Durable checkpoints/artifact storage.
2. Persistent provider telemetry/error ledger.
3. Automatic provider capability discovery.
4. Per-provider circuit breakers and cooldown persistence.
5. Render stream-copy optimization.
6. Resume after Render restarts.
7. Failure-injection tests for 401/403/404/429/500/503/timeouts/OOM/deploy failures.
8. Full daily YouTube automation only after real-AI-video E2E is stable.

## Current implementation change
The autonomous full pipeline now carries `generationType` on every generated clip and enforces `AUTOTUBE_REQUIRE_REAL_AI_VIDEO=1` by default. A deterministic FFmpeg clip can keep the pipeline alive in non-strict contexts, but the canonical E2E will reject it and continue recovery instead of falsely declaring a real AI-video success.
