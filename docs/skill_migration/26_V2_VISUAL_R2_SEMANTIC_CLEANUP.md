# V2 Visual R2 Semantic Motion Cleanup

Date: 2026-08-26 CST

## Verdict

```text
VERDICT: PASS
SEMANTIC_MOTION_CLARITY: PASS
P0: 0
P1: 0
P2: 0
NEXT_STEP: USER_REVIEW_SEMANTIC_MOTION_CLEANUP
```

## Baseline and frozen sources

```text
PROJECT: 3778ffb0-c430-4499-9f7f-2590f45cb8cb
SCRIPT_V2: 046bb456-ec8c-431e-b117-186bb63953ab@3
NARRATION_PLAN_V2: 76d3da1e-09dd-4af7-acc2-6116f3c3f4bb@2
NARRATION_AUDIO_V2: ff7ef85f-bf59-4814-ba9a-6306e56e8cb6@1
SUBTITLE_TIMING_V2: 68a8a73c-7863-4fa6-a89f-d9965f66c92f@1
MASTER_DURATION: 243.560s
MASTER_SHA256: 801fadc172e7e5f20ff34337a44d889985fdec04f8609228897239f77c877c2a
BASELINE_VISUAL: 242dcee2-d98b-4053-b453-399d762d9c33@2
BASELINE_RENDER: af53e2a9-3ca3-45c9-b8b6-0fe657783141
```

Script, narration plan, audio, and subtitle identities were not changed.

## Global cleanup

- Removed the persistent animated spine and automatic per-scene tail travel.
- Removed the permanent evidence HUD; EvidenceRail remains only in evidence-purpose scenes.
- Replaced numeric-looking confidence displays with qualitative support states.
- Removed unlabeled moving dots, decorative arcs, dangling dashed connectors, and paths without visible endpoints.
- Kept each clause-level beat to one primary action.

## Targeted repairs

- S001: two labeled word lanes compete for one OUTPUT; `前任` reaches it first.
- S002: the error token branches only to `普通口误` and `潜意识解释`.
- S003: `ERROR → MISSING EVIDENCE → HIDDEN MOTIVE` makes the evidential gap visible.
- S007: speech and prospective-memory routes use separate labeled lanes.
- S011: the same error is reframed from hidden motive to a fixed mechanism-analysis grid.
- S013: a fixed MONITOR gate accepts or misses a labeled candidate.
- S019: fixed `BEFORE → OUTCOME → AFTER`; the story attaches once after the outcome.
- S021: four ordinary-cause cards stay fixed; prediction fails before a separate post-hoc rewrite appears.
- S024: a central question connects directly to four 2×2 mechanism candidates, followed by VERDICT HOLD.

P2 scenes received only connector/HUD simplification. The approved compositions
for S005, S009, S010, S012, S016, and S025 were otherwise preserved.

## Preview gate

GPT-5.6 Luna reviewed the targeted previews without access to an earlier verdict.
The final preview gate was:

```text
PREVIEW_A: P0=0 P1=0 PASS
PREVIEW_B: P0=0 P1=0 PASS
PREVIEW_C: P0=0 P1=0 PASS
SEMANTIC_MOTION_CLARITY: PASS
```

The first C1 review found two dangling dashed lines at the S018→S019 boundary.
They were removed, C1 was rerendered, and the independent re-review returned
P0=0, P1=0, P2=0 with all prohibited-motion counters at zero.

## Exact identity repair

The first production `visuals` call correctly returned the old artifact with
`reused=true`: the semantic cleanup still advertised choreography identity
`v2-visual-r2@1`, so the exact builder's idempotency contract could not
distinguish it from the baseline. No render was created from that result.

The minimal repair published this cleanup as `v2-visual-r2@2`, synchronized the
renderer marker and existing tests, and retained the same exact script, plan,
audio, subtitle, design, and asset sources. No database schema or resolver was
added, and the old `@1` artifact was not modified.

## Production source chain

```text
COMMIT: bf474344574a473db1a400ba4cf592392816e642
RUNNER_IMAGE: zhiying-cli-runner:bf47434
WORKER_IMAGE: zhiying:bf47434
WORKER_IMAGE_ID: sha256:7bb973c886e798faff8b3e97fe60f97dc31afc7d8ef7eaf5453a812308be6ea0
CHOREOGRAPHY: v2-visual-r2@2
VISUAL_ARTIFACT: b5d26586-dd86-4cf6-8922-38581f646b2b@3
VISUAL_REUSED: NO
SCENES: 25
BEATS: 44
ASSETS_READY: 3/3
PLACEHOLDER: 0
RECONCILIATION: 59c717a9-07cc-44e4-8d1c-d24729b62c87@4
RECONCILIATION_REUSED: NO
UNRESOLVED: 0
TARGET_FRAMES: 7307
FINAL_RENDER_SOURCE: 0a3ff4b7-34b8-437f-847e-150d0dd160b2@4
FINAL_RENDER_ATTEMPT: 6720abf8-fce9-4841-a821-fabb6e336d34@4
RENDER_OUTPUT: 8a12debf-9ee9-4365-9b25-eeb001f52e37@4
```

Safety backup:

```text
/vol1/1000/backups/zhiying/zhiying-v2-r2-semantic-before-20260826-222632.db
size: 4198400
sha256: 0a014f6e8cdaedfb353edc8fd54f5375d8391939e022907785c8c962b6b2840b
integrity_check: ok
```

Only the Worker was recreated. Web, IndexTTS2 adapter, and IndexTTS2 retained
their prior images. Final health: all four containers healthy with restart count
zero; Web and adapter returned HTTP 200; no build tunnel remained.

## Production render

Exactly one corrected render job was enqueued.

```text
JOB: 60f0fe98-a440-4417-939a-8be2b29cb1f7
STATUS: succeeded
ATTEMPT: 1
OUTPUT_PATH: projects/3778ffb0-c430-4499-9f7f-2590f45cb8cb/renders/60f0fe98-a440-4417-939a-8be2b29cb1f7.mp4
DURATION: 243.626s
RESOLUTION: 1920x1080
FPS: 30
FRAMES: 7307
VIDEO_CODEC: h264
ENCODER: h264_nvenc
AUDIO_CODEC: aac
AUDIO_SAMPLE_RATE: 48000
AUDIO_CHANNELS: 2
SIZE: 36934808
SHA256: 0e3a91a1f6d726c3ce0b9430729b61e10a124081689c52c6dfbadcaeaaa6e46e
```

The local review copy has the same size and SHA-256. Full ffmpeg decode passed;
black segments were 0 and silence segments of at least 0.8 seconds were 0.

## Independent final review

GPT-5.6 Luna independently inspected the actual complete production MP4 using a
full-timeline one-second scan, all-scene/boundary evidence, and continuous
inspection of the required windows.

| Time | Actor / source → target | Meaning and visible result |
|---|---|---|
| 00:00–00:14 | word/error cards → OUTPUT and two readings | Wrong word wins; the two interpretations remain explicit |
| 00:53–01:02 | speech and intention lanes → named outcomes | Two failure routes remain distinct and labeled |
| 01:34–01:59 | same error/candidate → mechanism frame and MONITOR | The explanatory frame changes; the monitor can be late |
| 02:53–03:04 | BEFORE → OUTCOME → AFTER | The story visibly attaches only after the result |
| 03:10–03:24 | fixed cause cards / prediction → opposite result → FAILED → rewrite | Prediction can fail without moving or rotating cause cards |
| 03:45–03:53 | central question → four direct mechanism branches → VERDICT HOLD | Alternatives remain parallel and judgment is delayed |

```text
UNLABELED_MOVING_NODES: 0
ORNAMENTAL_PATHS: 0
PATH_WITHOUT_VISIBLE_ENDPOINT: 0
AUTOMATIC_SPINE_TRAVEL: 0
SIMULTANEOUS_PRIMARY_ACTIONS_PER_BEAT_MAX: 1
S021_CARD_RESHUFFLE: 0
S021_ROTATING_CAUSE_CARDS: 0
S019_SNAKE_PATH: 0
S024_SERPENTINE_PATH: 0
SEMANTIC_MOTION_CLARITY: PASS
P0: 0
P1: 0
P2: 0
FINAL_VERDICT: PASS
```

## Verification and guards

```text
quality gate: 41 PASS, 0 FAIL
audio/subtitle/exact-source regression: 58 PASS, 0 FAIL
choreography gate: PASS (25 scenes, 44 beats, 44 cues, frames 0..7307)
typecheck: PASS
production build: PASS
full MP4 decode: PASS
one-second frames: 244
one-second contact sheets: 4
scene strips: 25
boundary strips: 24

SCRIPT_CHANGE: NO
AUDIO_CHANGE: NO
SUBTITLE_CHANGE: NO
NEW_TTS_JOBS: 0
TTS_RETRIES: 0
DB_SCHEMA_CHANGE: NO
WEB_CHANGE: NO
INDEXTTS_CHANGE: NO
RENDER_JOBS_CREATED: 1
RENDER_RETRIES: 0
OLD_RUN_STAGE_CALLS: 0
SILENT_LATEST_RESOLUTION: 0
REMOTION_VERSION: 4.0.492
```

Final production counts were 85 artifacts, 19 render jobs, 406 TTS jobs, and 50
LLM jobs, with zero queued/running jobs in all three job families.

## Deliverables

- Corrected MP4: `outputs/v2-visual-r2-semantic-clean/final/v2-visual-r2-semantic-clean-production.mp4`
- Full contact sheet: `outputs/v2-visual-r2-semantic-clean/final/evidence/contact-sheet-full.png`
- Motion audit: `outputs/v2-visual-r2-semantic-clean/final/production-motion.json`
- Independent final review: `outputs/v2-visual-r2-semantic-clean/final/FINAL_SEMANTIC_MOTION_REVIEW.md`

Work stops at user visual review. Skill hardening remains deferred until explicit
user confirmation, as requested.
