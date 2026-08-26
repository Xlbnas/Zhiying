# V2 Visual R2 Production Run

Date: 2026-08-26 CST

## Verdict

```text
VERDICT: PASS_WITH_MINOR_NOTES
TECHNICAL: PASS
P0: 0
P1: 0
P2: 1
NEXT_STEP: USER_REVIEW_V2_VISUAL_R2
```

The single P2 is the independent reviewer's long-form viewing note: the pale
grid/node/card design system remains visibly uniform across 243 seconds. The
reviewer classified it as different shots inside one visual world, not one shot
with changing data. It is not a reason to enqueue another render.

## Deployment

The build source was the clean archive of exact commit
`f6695efada9b4c81ce86f1439aacf83570569ed2`. No dirty worktree files entered
either image.

```text
RUNNER_IMAGE: zhiying-cli-runner:f6695ef
RUNNER_IMAGE_ID: sha256:eb55af974bd36d7b34a72a62feb5f72cfa4a595f41de4072e914666059c04a45
WORKER_BEFORE: zhiying:83a42b2
WORKER_BEFORE_IMAGE_ID: sha256:8e0098a40e158096424c70037ceda7016f6af9215b281c4a1889a2f9e4080eaa
WORKER_AFTER: zhiying:f6695ef
WORKER_AFTER_IMAGE_ID: sha256:eb55af974bd36d7b34a72a62feb5f72cfa4a595f41de4072e914666059c04a45
WEB_CHANGE: NO
INDEXTTS2_CHANGE: NO
REMOTION_VERSION: 4.0.492
```

Only `zhiying-worker` was recreated. At the final snapshot the Worker, Web,
IndexTTS2 adapter, and IndexTTS2 were healthy with restart count zero. Web and
adapter health endpoints returned HTTP 200. No build-network tunnel remained.

Safety backup:

```text
/vol1/1000/backups/zhiying/zhiying-v2-visual-r2-before-20260826-194508.db
size: 4091904
sha256: 7b89b407a08ac25ca5b9d7d64d20612985356926b29b36102ea0e786c7acc622
integrity_check: ok
```

## Authoritative source chain

```text
PROJECT: 3778ffb0-c430-4499-9f7f-2590f45cb8cb
SCRIPT_V2: 046bb456-ec8c-431e-b117-186bb63953ab@3
NARRATION_PLAN_V2: 76d3da1e-09dd-4af7-acc2-6116f3c3f4bb@2
NARRATION_AUDIO_V2: ff7ef85f-bf59-4814-ba9a-6306e56e8cb6@1
SUBTITLE_TIMING_V2: 68a8a73c-7863-4fa6-a89f-d9965f66c92f@1
MASTER_DURATION: 243.560s
MASTER_SHA256: 801fadc172e7e5f20ff34337a44d889985fdec04f8609228897239f77c877c2a
CHOREOGRAPHY: v2-visual-r2@1
```

## Visual and reconciliation artifacts

```text
V2_VISUAL_R2: 242dcee2-d98b-4053-b453-399d762d9c33@2
SCENES: 25
BEATS: 44
ASSETS_READY: 3/3
PLACEHOLDER: 0

RECONCILIATION: 2c4b691c-3b1c-487f-9100-1bb7a44be14f@3
REUSED: NO
UNRESOLVED: 0
TARGET_FRAMES: 7307
FRAME_DURATION: 243.56666666666666s
```

The production asset check verified all three bindings, physical files,
readability, source URLs, attribution, and usable license status. No current,
latest, default, or legacy stage resolver was used in the exact chain.

## Production render

Exactly one R2 render job was enqueued.

```text
JOB: af53e2a9-3ca3-45c9-b8b6-0fe657783141
JOB_STATUS: succeeded
JOB_ATTEMPT: 1
FINAL_RENDER_SOURCE: fd287d9b-0a3a-4357-b814-0a38202b59af@3
FINAL_RENDER_ATTEMPT: 6933a7c9-3f5b-42d3-b2de-5644aa77b762@3
RENDER_OUTPUT: e1ea2c97-7259-48c2-9f82-f4e2d8f90f4d@3
OUTPUT_PATH: projects/3778ffb0-c430-4499-9f7f-2590f45cb8cb/renders/af53e2a9-3ca3-45c9-b8b6-0fe657783141.mp4
DURATION: 243.626s
RESOLUTION: 1920x1080
FPS: 30
FRAMES: 7307
VIDEO_CODEC: h264
ENCODER: h264_nvenc
AUDIO_CODEC: aac
AUDIO_SAMPLE_RATE: 48000
AUDIO_CHANNELS: 2
SIZE: 40764504
SHA256: 1303812a5d14e4c55ae6a832f530b1aed2fb144fd7bfe4913308ccbefd6e31d0
```

The immutable final-render source contains the exact R2 visual, Audio V2,
Subtitle V2, and new reconciliation identities above. The local review copy
has the same size and SHA-256 as the production artifact.

## Verification

```text
production quality gate: 41 PASS, 0 FAIL
R2 choreography: PASS (25 scenes, 44 beats, 44 cues, frames 0..7307)
exact-image typecheck: PASS
full MP4 decode: PASS
black frames: 0
silence >= 0.8s: 0
one-second frames: 244
one-second contact sheets: 4
scene six-frame strips: 25
boundary strips: 24
representative motion-window strips: 8
final tail images: 7
```

## Independent final visual review

The independent reviewer was launched with GPT-5.6 Luna in read-only mode. It
checked the complete production MP4 timeline and the evidence derived from that
same MP4, rather than reviewing contact sheets alone.

```text
FINAL_VISUAL_REVIEW: PASS_WITH_MINOR_NOTES
P0: 0
P1: 0
P2: 1

TOP_HEAVY_LAYOUT: PASS
EMPTY_CENTER: PASS
CONTENT_FOOTPRINT: PASS
SEMANTIC_MOTION: PASS
VISIBLE_CAUSE_EFFECT: PASS
PERSISTENT_OBJECT_HANDOFF: PASS
ARCHIVE_ANNOTATION: PASS
MECHANISM_DISTINCTION: PASS
SUBTITLE_DEPENDENCY: PASS
TEMPLATE_REPETITION: PASS
READABILITY: PASS
SAFE_AREA: PASS
FINAL_HOLD: PASS
VISUAL_WORLD_MONOTONY: MINOR_P2_ONLY
```

### Timestamped findings

| Timestamp | Scene / beat | Observation and finding | Severity |
|---|---|---|---|
| 00:00-00:05.23 | S001 / B001 | The red error path crosses the target word and lands on the wrong output; the opening establishes the persistent error-token logic. | PASS |
| 00:30.67-00:43.90 | S005 / B007-B011 | The Freud book card has archive/source annotation and progressively connects to the category cards. | PASS |
| 01:01.07-01:19.10 | S012-S013 / B019-B022 | Activation bars, monitoring gate, and the competing candidate change state; lexical competition is process-driven rather than label-only. | PASS |
| 01:59.10-02:07.73 | S014 / B023-B024 | The memory trace enters an inaccessible state while the output remains empty, showing retained-but-unavailable information. | PASS |
| 02:07.73-02:23.40 | S015 / B025-B026 | The future cue and high-load task card establish the visible chain from load to prospective-memory omission. | PASS |
| 02:23.40-02:34.93 | S016 / B027-B028 | Red habitual and teal current-goal paths split; the automatic program arrives first. | PASS |
| 02:43.57-02:52.93 | S018 / B031-B032 | Candidate-result cards are followed by the explicit unstable-replication limitation. | PASS |
| 03:03.53-03:23.53 | S020-S021 / B034-B037 | Prediction, ordinary alternatives, and reversed-result branches accumulate into an explicit falsifiability test. | PASS |
| 03:45.12-03:52.82 | S024 / B041-B042 | `VERDICT HOLD` blocks the conclusion while evidence slots remain incomplete. | PASS |
| 03:52.82-04:03.57 | S025 / B043-B044 | Clue/noise paths converge on the evidence chain and the final composition holds through the last subtitle. | PASS |
| 00:00-04:03.57 | Full video | Reused pale grid, progress chrome, nodes, and cards create some long-form uniformity, but scene geometry, object types, semantic motion, and hierarchy change materially. | MINOR_P2_ONLY |

## Guards

```text
OLD_RUN_STAGE_CALLS: 0
NEW_TTS_JOBS_AFTER_APPROVAL: 0
TTS_RETRIES: 0
NEW_LLM_JOBS_AFTER_APPROVAL: 0
RENDER_JOBS_CREATED_FOR_R2: 1
RENDER_RETRIES: 0
MANUAL_DB_PATCH: 0
FAKE_SUCCEEDED_JOBS: 0
SILENT_LATEST_RESOLUTION: 0
SCRIPT_CHANGE: NO
AUDIO_CHANGE: NO
SUBTITLE_CHANGE: NO
SCHEMA_CHANGE: NO
REMOTION_VERSION: 4.0.492
```

The production-after snapshot was `80 artifacts / 18 render jobs / 406 TTS
jobs / 50 LLM jobs`, with no queued or running jobs. Work stops here for the
user's final visual judgment; no retirement, benchmark, migration, upgrade, or
platform cleanup follows from this run.
