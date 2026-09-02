# Extreme Long Video — Formal Render Attempt 2 Final Report

Date: 2026-09-02

Project: `8f955b4c-42dd-4a02-8e76-e721a37fab41`

Verdict: **PASS / INITIAL PRODUCTION BASELINE V1**

## Scope and frozen boundaries

This was the second and final authorized formal full-length render. The only pre-render content change was the approved archive visual usefulness patch. Research, script, narration plan, TTS, audio, subtitle content/timing, all 111 scene boundaries, visual thesis, dark theme, semantic state density, animation logic, sequence worlds, archive rights/provenance classification, database schema, and Remotion `4.0.492` remained frozen.

## Exact production chain

| Item | Exact identity |
| --- | --- |
| Render job | `d822fcb9-2625-4586-83af-00af4fe5dcef` |
| Scene design | `bae52f12-1686-420e-bf36-0d20a77ed10c@3` |
| Visual source | `576ce0f2-4653-403c-9d12-6e9747bf572d@2` |
| Narration plan | `43da40d7-ba4f-4016-8bf7-8de37b2c4c5c@1` |
| Audio V2 | `ae26c0bd-0d99-4557-9f39-44781b0d8bba@1` |
| Subtitles V2 | `277908e8-ad94-402d-8b8e-b1c3496bf4af@1` |
| Reconciliation | `1fc81651-3c16-4e62-90f1-c05001db7d64@2` |
| Final source artifact | `b40dbd77-d4fb-42cb-8b38-28f29d169fb4@2` |
| Renderer commit | `511b8b26772fb87488b40943511504437e7f7865` |
| Worker image | `sha256:eeb8b6f1eaa5f287512b19b3ebf38d6a89a8533e144fa595bd0382c68d7ff300` |
| Remotion | `4.0.492` |

The production runner checked out the exact renderer commit, passed the relevant 91/91 tests, typecheck, build, image build, backup integrity, scoped Worker deployment, health check, and both Memory Lab and legacy renderer smoke tests. Web and IndexTTS2 were not redeployed.

## Formal media result

- Job state: `succeeded`, attempt `1`, kind `no-subtitles`, `showSubtitles=false`.
- Production path: `projects/8f955b4c-42dd-4a02-8e76-e721a37fab41/renders/d822fcb9-2625-4586-83af-00af4fe5dcef.mp4`.
- Local clean master: `outputs/extreme-long-video/final/master_clean.mp4`.
- SHA-256: `3f79bf4215964f2dbb35d64da61ebdee5a6a58e0aafaed61f53c47df2f865239`.
- Size: `130,058,310` bytes.
- Video: H.264, 1920×1080, 30 fps, 30,399 decoded frames.
- Audio: AAC stereo, 48 kHz.
- Duration: `1013.354 s` (`16:53.354`).
- Loudness: integrated `-16 LUFS`, true peak `-4.63 dBTP`, LRA `2.8`.
- Immutable manifest and production media SHA/size/probe: PASS.
- Full FFmpeg decode on production NAS: PASS.
- Full FFmpeg decode after local delivery copy: PASS.

## Final rendered-pixel review

The review used the actual formal clean MP4, not only the archive reel or source code. Review evidence is in `outputs/extreme-long-video/final/review-frames/` and `outputs/extreme-long-video/final/formal-attempt-2-review-contact-sheet.jpg`.

| Gate | Result | Rendered evidence |
| --- | --- | --- |
| Archive usefulness | PASS | Six visible archive images have declared evidence, identity, context, or content-bearing-document jobs; S079 is an editorial replacement. |
| S015 | PASS | Source-chain diagram is primary; the red source volume is a small supporting thumbnail with `不是《幽灵之战》的故事原页` disclosure. |
| S078 / S079 | PASS | S078 supplies judicial-setting context; S079 supplies the distinct early-record/later-version comparison. |
| S106 | PASS | `尽早写下 / 保留时间戳` and a dated written record jointly communicate the early-record action. |
| Coral overlay | PASS | Coral has semantic ownership; no giant unowned red text covers an established composition. |
| DRM chronology | PASS | The lure answer is not disclosed before its intended reveal. |
| Clean subtitle state | PASS | Exact payload is clean/no-subtitles and representative pixel checks show no burned subtitles. |

Independent GPT-5.6 review inspected the actual formal MP4 at the specified timestamps and returned `PASS`, with `P0=0`, `P1=0`, `P2=0`. It did not claim subjective audio listening; audio continuity and integrity are supported by stream probing and complete decoding.

## Freeze decision

`INITIAL_PRODUCTION_BASELINE = APPROVED`

`WORKFLOW_BASELINE = FROZEN_INITIAL_PRODUCTION`

`CURRENT_17_MIN_VIDEO = PASS`

`FORMAL_RENDER_ATTEMPT_1 = USED`

`FORMAL_RENDER_ATTEMPT_2 = USED`

This baseline is approved for initial production use. It is explicitly not a golden or permanent final design, and later evolution requires a new scoped decision rather than silently mutating this reference.
