# Phase 5A0-C — Register Selected Voice & Minimal M6 Voice Selection

## Verdict

VOICE_SELECTION: PASS locally and on the built ephemeral runner.

The selected, user-authorized reference is registered as `xlbnas@1`. The
historical `default@1` registry entry and `default-v1.wav` bytes are unchanged.
No Fresh Run or full production TTS was started.

## Selected voice

| Field | Value |
|---|---|
| voice identity | `xlbnas@1` |
| speaker name | `xlbnas-1-42a32a1fc12b` |
| discovery candidate | `/vol1/1000/docker/zhiying/voice-probe/phase-5a0-b2-20260825/candidate_03.wav` |
| canonical production asset | `/vol1/1000/docker/zhiying/voices/xlbnas-v1.wav` |
| registry reference path | `/voices/xlbnas-v1.wav` |
| canonical format | PCM s16le, mono, 48 kHz |
| reference SHA-256 | `42a32a1fc12b12752e1f2f6050108f458cd47c240208c353a7dd9a7d4fd7a999` |
| provider health | `indextts2`, model `IndexTTS-2`, ready |

The source candidate was the previously selected Phase 5A0-B2 recording; no
recording rediscovery or reselection was performed. The canonical production
asset was created from that candidate with the existing ffmpeg path.

## Production registry mutation

Active registry:

`/vol1/1000/docker/zhiying/voice-registry/voice-registry.json`

The registry was backed up before mutation at:

`/vol1/1000/docker/zhiying/voice-registry/voice-registry.json.bak-phase-5a0-c-20260825`

Evidence:

- registry SHA before: `1dab4a313689736aad081b2b0367f9b036eeec0f9a751647192498ce9ee21827`
- backup SHA: `1dab4a313689736aad081b2b0367f9b036eeec0f9a751647192498ce9ee21827`
- registry SHA after: `d87ff44f7689b6ef2c8823efa23731f5e43728c2dd7f150ef8f8ef5926245c1`
- default reference before/after: `2d85800fe261d106c3274fa792cbb952458c4b0b2e1b908340a8cd0d63c73a30`
- adapter reload: ready, degraded=false, speakerCount=2
- adapter `/registry-status`: ready, lastReloadError=null
- adapter `/health`: ready, provider=`indextts2`, model=`IndexTTS-2`

The registry update used a same-directory temporary file followed by atomic
rename. The active compose mount uses the registry directory above. Temporary
IndexTTS2 probe speakers were not deleted.

## CLI contract

`src/cli/zhiying.ts` now accepts `tts --voice <profile>@<revision>`.

- Omitting `--voice` preserves the historical default@1 path and its behavior.
- An explicit voice is resolved against the active registry before enqueue.
- Registry entry, path containment, regular-file status, and reference SHA are
  validated fail-closed; invalid identity creates zero jobs and has no fallback.
- Job payload, result settings, and narration manifest carry the exact
  reference SHA when an explicit registered voice is used.
- Existing audio reuse includes voice identity and reference SHA. A plan with
  default@1 audio cannot reuse for `xlbnas@1`; exact same-voice audio can be
  reused.
- Historical manifests/results without the optional reference field remain
  backward-compatible for the no-flag default path.

No new service, worker, scheduler, workflow abstraction, DB table, migration,
or project voice state machine was added.

## Tests and build

- CLI v1: `36 PASS`
- legacy exact-audio reuse: `5 PASS`
- voice-selection contract: `6 PASS`
- M3-B TTS: `99 PASS / 0 FAIL`
- M3-C subtitles: `82 PASS / 0 FAIL`
- artifact/exact-job: `32 PASS / 0 FAIL`
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- scoped `git diff --check` for this phase: PASS

The unscoped repository `git diff --check` still reports trailing whitespace
inside the previously installed official Remotion Skill files. Those Skill
files were not modified in this phase.

## Commit and runner

VOICE_SELECTION_SHA: `4ca2e72d0a2e0abea673febdbebd343b55f4a4c1` (`feat(tts): add explicit legacy voice selection`)

The commit was created locally and used as the exact source for the runner
build. GitHub publication was attempted but blocked by the local GitHub
credentials: the HTTPS remote requested a username and `gh auth status`
reported an invalid token; the configured SSH key was also rejected. Therefore
`REMOTE_PUSH` is `BLOCKED`, not PASS.

Runner:

- image: `zhiying-cli-runner:4ca2e72`
- image ID: `sha256:9365137385a8844c5812bab3b00250d23165a71637b5e345b039adc11f7693f3`
- build checkout: `/vol1/1000/docker/zhiying-cli-runner/4ca2e72`
- old runners preserved: `zhiying-cli-runner:ca2ae95`, `zhiying-cli-runner:b76789d`
- persistent service replaced: NO
- production web/worker image or service restarted: NO

## Phase result

REMOTION_RUNTIME_VERSION: `4.0.492`

LATEST_REMOTION_STABLE_OBSERVED: `4.0.516`

REMOTION_UPGRADE: `DEFERRED_UNTIL_AFTER_FRESH_RUN`

PRODUCTION_VOICE_CHANGED: `YES — added xlbnas@1; default@1 unchanged`

NEW_WORKFLOW_ABSTRACTIONS: `NONE`

DB_SCHEMA_CHANGES: `NONE`

PRODUCTION_DB_SCHEMA_CHANGES: `0`

FULL_FRESH_TTS: `NO`

READY_FOR_FRESH_RUN: `NO — complete after GitHub credentials allow push of 4ca2e72`
