# Extreme Long Video — Formal Render Attempt 1 Report

Date: 2026-09-01

Project: `8f955b4c-42dd-4a02-8e76-e721a37fab41`

Verdict: **P1 FAIL / NOT READY FOR HUMAN ACCEPTANCE**

## Scope and authorization

- One authorized clean, full 17-minute production render was created.
- No second job was created, retried, cancelled, or altered.
- The prior cancelled job was left untouched.
- Frozen narration audio, subtitle timing/content, research/script, 111 scene boundaries, asset provenance, schema, `OLD_RUN_STAGE`, and Remotion `4.0.492` were not changed.

## Exact artifacts

| Item | Exact identity |
| --- | --- |
| Render job | `7f2cfa6a-ad81-4ee5-9746-160dd4ae977c` |
| Scene design | `bae52f12-1686-420e-bf36-0d20a77ed10c@3` |
| Visual source | `576ce0f2-4653-403c-9d12-6e9747bf572d@2` |
| Narration plan | `43da40d7-ba4f-4016-8bf7-8de37b2c4c5c@1` |
| Audio V2 | `ae26c0bd-0d99-4557-9f39-44781b0d8bba@1` |
| Subtitles V2 | `277908e8-ad94-402d-8b8e-b1c3496bf4af@1` |
| Reconciliation | `1fc81651-3c16-4e62-90f1-c05001db7d64@2` |
| Renderer code | `b602510611416ed25f60b24100391e44ea0ad49f` |

## Technical result

- Job status: `succeeded`, clean/no-subtitles mode, source artifact version `2`.
- Output: `projects/8f955b4c-42dd-4a02-8e76-e721a37fab41/renders/7f2cfa6a-ad81-4ee5-9746-160dd4ae977c.mp4`
- SHA-256: `61bcf37d5c5605d1270bb8848046505a36e57aceea13124c1bf7458285b5d8a5` (matches immutable render manifest).
- Size: `63,833,712` bytes.
- Probe: H.264, 1920×1080, 30 fps, 30,399 frames; AAC stereo 48 kHz; duration `1013.355 s`.
- Full FFmpeg decode completed with no errors.
- Loudness output: integrated `-16 LUFS`; true peak `-4.63 dBTP`; LRA `2.8`.
- Render audit: 111 scenes, placeholder `0`; seven bound archive assets, each used once.

## Independent actual-MP4 review

Method: 20-second whole-video sampling, 5-second sampling in the four A–D review ranges, and completed full decode. This review examined the rendered pixels rather than only V2.1 storyboards.

| Gate | Result | Evidence |
| --- | --- | --- |
| P0 | 0 | No corrupted media, blank archive surface, debug ID, or source-chain failure observed. |
| P1 | 1 | Actual opening `00:00–03:30` repeats the low-level combination “top-left short heading + large empty dark field + horizontal version cards/thin line”. Three-node curves, two-card comparisons, and input–condition–report arrangements recur with little visible information change. Family enums differ, but pixels still read as template interleaving. |
| P2 | 0 | No additional non-blocking issue found in the final review. |

### Passed visual checks

- No obvious high-frequency generic visual-thesis repetition in the reviewed rendered frames.
- No decorative full-length coral diagonal; observed diagonal marks were attached to version/difference meaning.
- No visible `Sxxx` or other debug overlay in sampled rendered frames.
- No empty archive frame or placeholder was observed. Actual archive frames contain research portraits, historical photographs, or document material.
- Clean render has no subtitles; primary visual content remains above the intended bottom subtitle safe area.

### Remaining blocker

`COMPOSITION_REPETITION / VISUAL_FATIGUE = P1 FAIL`.

This is not a failure of visual-thesis wording, archive provenance, media integrity, or the existing continuous-sequence logic. It is a rendered-pixel composition problem concentrated in the early explanatory sequence. The appropriate next action is a targeted redesign of the repeated composition primitives, followed by static review. Do not create another full formal render until that static correction is approved.

## Formal-render accounting

`FORMAL_RENDER_JOBS_CREATED: 1`

`FORMAL_RENDER_JOBS_RETRIED: 0`

`FORMAL_RENDER_JOBS_CANCELLED_BY_THIS_RUN: 0`

## Next action

Target the early repeated primitives (not all 111 scenes), regenerate static review evidence, and obtain user approval before spending the remaining formal-render capacity.
