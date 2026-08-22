# Phase 4A2B — Exact Existing Audio Reuse Before Synthesis Admission

## Verdict

VERDICT: PASS

The CLI now validates and returns a complete exact current M6 narration audio
artifact before entering the new-synthesis admission path. An invalid or
incomplete artifact falls through to the existing enqueue path, where the
contamination gate remains fail-closed.

## Root Cause

The previous order was:

```text
expected plan fence
  → enqueueNarrationAudioJobs
    → NARRATION_PLAN_CONTAMINATED
      → wait/finalize/current audio reuse
```

Golden `N062` is a historical `speech` unit containing `*【脚本结束】*`, and
its succeeded audio job is already part of the exact 50-job set. It therefore
cannot be classified as a non-speech structural marker. The problem was the
ordering of historical artifact reuse after the new synthesis gate.

## Fix

`getExactReusableNarrationAudioArtifact()` is called after the authoritative
expected-plan fence and before `enqueueNarrationAudioJobs()`.

The reuse path checks:

- current plan ID/version equals the requested exact identity;
- current artifact is production-supported `narration-audio@1.0`;
- manifest source ID/version equals the requested plan;
- master path is contained, regular, non-empty, RIFF/WAVE, and its physical
  data size matches the WAV header;
- master SHA-256 and ffprobe duration/sample rate/channels match the manifest;
- every plan unit has a corresponding manifest unit;
- every speakable speech unit has an exact succeeded TTS job, payload identity,
  result metadata, output path, duration, and SHA facts matching the manifest;
- current plan identity is re-read before returning.

Only after all checks pass does the CLI return `reusedExistingAudio: true`.
Otherwise it calls the unchanged enqueue function, including its existing
`NARRATION_PLAN_CONTAMINATED` gate.

## Safety Boundary

No project-specific or marker-specific exception was added. The rule applies
to any exact complete current M6 narration audio artifact. It does not allow a
contaminated plan to synthesize new audio.

## Tests

- isolated legacy reuse test: **5 PASS**
  - contaminated speech + exact audio reuse, zero job/artifact delta;
  - wrong source rejected;
  - master integrity mismatch rejected;
  - missing exact audio remains contamination-blocked;
  - clean plan still enqueues normally.
- `pnpm test:cli`: **36 PASS**
- M3-B TTS: **99 PASS / 0 FAIL**
- M3-C subtitles: **82 PASS / 0 FAIL**
- artifact/exact-job: **32 PASS / 0 FAIL**
- `pnpm typecheck`: **PASS**
- `pnpm build`: **PASS**
- `git diff --check`: **PASS**

The existing CLI regression covers the Phase 2 plan-drift waiter invariant:
an A waiter does not finalize or return B audio after the current plan advances.

## Architecture Guard

NEW_WORKFLOW_ABSTRACTIONS: NONE

DB_SCHEMA_CHANGES: NONE

WORKER_CHANGES: NONE

TTS_PROVIDER_CHANGES: NONE

SKILL_CHANGES: NONE

PRODUCTION_SERVICES_REPLACED: NO

## Compatibility Commit and Runner

COMPAT_FIX_SHA: `b76789dde1c03543f54fc40142923f58b0407375`

REMOTE_PUSH: PASS (`origin/m7` equals `b76789dde1c03543f54fc40142923f58b0407375`)

RUNNER_IMAGE: `zhiying-cli-runner:b76789d`

RUNNER_IMAGE_ID: `sha256:48ad9177337e29018d3312c896508b7faf687b96dd4627c5b2d65a61081eef6b`

OLD_RUNNER_PRESERVED: `zhiying-cli-runner:ca2ae95`

The new image was built from the exact compatibility SHA on Feiniu with the
fixed build-network tunnel. The tunnel was stopped after the build and no
runner container remains.

## Golden TTS Reuse Smoke

PROJECT: `2fda54fb-e5fa-4237-bda3-265fe1d7978d`

REQUESTED_PLAN: `c9f4f20f-bb90-440c-8591-6aa911efd31c@3`

INSPECT: PASS — current plan and current audio resolved exactly.

TTS_CLI: PASS

RETURNED_AUDIO: `451fad55-e449-46f1-be77-2241a7a6788e@2`

RETURNED_SOURCE: `c9f4f20f-bb90-440c-8591-6aa911efd31c@3`

TTS_JOBS_BEFORE_AFTER: `351 → 351`

EXACT_PLAN_TTS_JOBS_BEFORE_AFTER: `50 → 50`

TTS_JOBS_DELTA: `0`

NEW_SYNTHESIS: `0`

AUDIO_ARTIFACTS_BEFORE_AFTER: `2 → 2`

NEW_AUDIO_ARTIFACTS: `0`

The smoke used a read-only ephemeral runner invocation. Subtitles,
reconciliation, and render were intentionally not invoked.

## Final Status

EXACT_AUDIO_REUSE: PASS

CONTAMINATION_GATE_FOR_NEW_SYNTHESIS: PASS

SPEECH_CONTAMINATION_STILL_BLOCKED: YES

PLAN_DRIFT_REGRESSION: PASS

READY_FOR_GOLDEN_RERUN: YES
