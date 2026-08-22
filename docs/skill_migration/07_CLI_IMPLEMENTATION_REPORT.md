# Phase 2A — DB-Backed Thin CLI V1 Implementation Report

## Baseline

- Branch: `m7`
- HEAD: `e44949595be221e05874be0e05224ee352328682`
- Implementation gate: `IMPLEMENTATION_READY: YES`
- Pre-existing dirty files before this implementation: `.agents/skills/zhiying-architecture/SKILL.md`, `CONTRACT.md`, `package.json`, `pnpm-lock.yaml`, and `docs/skill_migration/01-06`.
- Phase 2A closure resumed from the existing CLI diff after `08_CLI_REVIEW.md` identified one TTS wait/finalize exact-plan defect; that review document was not edited in this implementation pass.
- No production database, container, registry, Compose file, or `.env.production` was changed.

## CLI Structure

- Entry: `src/cli/zhiying.ts`
- Package commands: `pnpm zhiying ...`
- Parsing is local and minimal; no new CLI framework, registry, plugin system, queue, scheduler, or worker was added.
- stdout emits one JSON document; diagnostics are written to stderr; non-zero exit is used for malformed identity, precondition failure, terminal job failure, media mismatch, and timeout.

## Commands Implemented

### inspect

- Inputs: `--project`, optional exact `--artifact <id>@<version>`, exact `--job <id>`, and `--media`.
- Reads project/stage/version/current narration/audio/subtitle/reconciliation facts, readiness, exact artifact rows, exact render/TTS jobs, manifests, file size/SHA, and media probe metadata.
- No enqueue and no latest-job fallback. Succeeded render jobs require their exact manifest and matching file; succeeded TTS jobs require their exact output/hash.

### tts

- Inputs: `--project`, exact `--plan <artifactId>@<version>`, optional `--wait`, optional `--timeout-seconds`.
- Calls `enqueueNarrationAudioJobs` with `expectedPlan`; the expected plan is checked inside the existing `BEGIN IMMEDIATE` transaction before jobs are created.
- Reuses `tts_jobs`, existing Worker execution, `getNarrationAudioOverview`, and `tryFinalizeNarrationAudio`.
- Wait mode revalidates the exact plan on every poll. `tryFinalizeNarrationAudio` accepts an optional expected plan and checks it before work and again inside its existing final `BEGIN IMMEDIATE`, so a stale waiter cannot finalize or return a newer plan's audio.
- No `--voice`, direct provider call, unit loop, or CLI manifest construction.

### subtitles

- Inputs: `--project`, exact `--audio <artifactId>@<version>`.
- Calls `buildSubtitleTiming` with an expected audio identity checked inside its existing transaction, then returns the deterministic artifact and readiness.

### reconcile

- Inputs: `--project`, exact `--scenes <projectVersionId>@<version>`, `--audio`, and `--subtitles` identities.
- Calls `buildTimingReconciliation` with all expected source identities. The transaction re-reads authoritative scenes/audio/subtitle sources and fails closed on mismatch.
- No frame, residual, cue, or timeline calculation was added to the CLI.

### render

- Inputs: `--project`, exact scenes/audio/subtitles/reconciliation identities, optional `--wait`, and optional `--timeout-seconds`.
- Calls `enqueueFinalRender` with all expected source identities. The existing source fence, asset readiness, final visual gate, `render_jobs`, Worker, and final-render artifacts remain authoritative.
- Wait mode resolves only the exact returned job and exact manifest; it never calls `renderMedia` directly.

## Production Code Changes

- `src/lib/narration/audio.ts`: optional expected narration-plan identity for enqueue and finalize; backward compatible for existing callers.
- `src/lib/subtitles/timing.ts`: optional expected audio identity; backward compatible for existing callers.
- `src/lib/reconciliation/timing.ts`: optional expected scenes/audio/subtitle identities; backward compatible for existing callers.
- `src/lib/final-render/bridge.ts`: optional expected scenes/audio/subtitle/reconciliation identities; checked after the existing authoritative source re-read and before readiness/enqueue side effects.
- These changes add only expected-source preconditions and do not change old UI/API behavior when options are omitted.

## New Abstractions

`NEW_WORKFLOW_ABSTRACTIONS: NONE`

## Tests

- `pnpm test:cli`: `31 PASS` using one isolated temporary SQLite/data directory and mock TTS. It covers JSON/identity parsing, exact artifact/job reads, enqueue and finalize source fences, TTS plan drift during `--wait`, terminal TTS failure, exact subtitle/reconciliation refs, reconciliation/render mismatch with zero side effects, asset readiness, render exact source/job/attempt identity, and exact successful render wait resolution using a local ffmpeg fixture.
- `npx tsx scripts/test-m6311-artifact.ts`: `32 PASS / 0 FAIL` (exact-job resolution, no fallback, missing/mismatched media).
- `npx tsx scripts/test-workflow-resource-leases.ts`: `87 PASS / 0 FAIL` (existing Worker/GPU lease behavior).
- `npx tsx scripts/test-asset-bind-source-gate.ts`: `11 PASS / 0 FAIL`.
- `npx tsx scripts/test-m3b-tts.ts`: `99 PASS / 0 FAIL`.
- `npx tsx scripts/test-m3c-subtitle-timing.ts`: `82 PASS / 0 FAIL`.
- `npx tsx scripts/test-m3d-timing-reconciliation.ts`: existing suite remains blocked before its high-level reconciliation assertions by `audio finalize 失败`.
- `npx tsx scripts/test-m3e-final-render.ts`: existing suite remains blocked before its high-level Final Render assertions by the same `audio finalize 失败`.

The M3-D/M3-E fixture blocker is pre-existing and was reproduced from `HEAD` in the Phase 2B review. Its old helper does not release the production GPU lease after each mock TTS job, unlike the current job-runner lifecycle and the passing M3-C/isolated CLI fixture. It was recorded rather than modified. Phase 2A reconciliation and Final Render exact-match/mismatch/asset/job paths are exercised by the isolated CLI contract test without production services.

## Build

- `pnpm typecheck`: PASS after a standalone rerun following build completion.
- `pnpm build`: PASS on Next.js `15.5.21`.

## Production Impact

`PRODUCTION_DEPLOYED: NO`

No production DB, Worker, container, registry, voice, adapter, Compose, or production environment file was modified.

## Old Orchestrator Dependency

- CLI calls `run-stage`: NO
- CLI calls DeepSeek LLM executor: NO
- CLI calls workflow stage UI: NO
- Reading accepted/locked stage pointers is retained only as the frozen DB-backed exact-identity contract.

## Git Diff Summary

- Added `src/cli/zhiying.ts`.
- Added `scripts/test-cli-v1.ts`.
- Added package scripts `zhiying` and `test:cli`.
- Added only optional expected-source fences to the existing M6/M3 builders, TTS finalizer, and Final Render bridge.
- The pre-existing package diff also pins Next.js from the prior range to exact `15.5.21` and updates `pnpm-lock.yaml`, consistent with the repository's exact-version rule; this is not a CLI workflow abstraction.
- No DB schema changes, migrations, new runtime services, or new workflow abstractions.

## Final Verdict

`VERDICT: PASS`

CLI:

- inspect: PASS
- tts: PASS
- subtitles: PASS
- reconcile: PASS — isolated exact-match and mismatch/zero-side-effect paths pass; the unrelated historical M3-D fixture blocker remains recorded.
- render: PASS — exact enqueue/job/attempt, mismatch, asset gate, and exact successful wait resolution pass; the unrelated historical M3-E fixture blocker remains recorded.

`ARTIFACT_CONTRACT: DB_BACKED_EXACT_IDENTITY`

`TTS_CONTRACT: M6_V1`

`EXECUTOR: EXISTING_WORKER`

`ASSET_ENTRY: EXISTING_ASSET_API_BACKEND`

`NEW_WORKFLOW_ABSTRACTIONS: NONE`

`OLD_RUN_STAGE_CALLS: 0`

`DIRECT_TTS_PROVIDER_BYPASS: NO`

`DIRECT_RENDER_MEDIA_BYPASS: NO`

`DB_SCHEMA_CHANGES: NONE`

`PRODUCTION_DEPLOYED: NO`

`REPORT: docs/skill_migration/07_CLI_IMPLEMENTATION_REPORT.md`
