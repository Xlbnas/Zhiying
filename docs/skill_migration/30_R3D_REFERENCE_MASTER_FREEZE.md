# R3-D Reference Master Freeze

## Verdict

`REFERENCE_MASTER_STATUS = FROZEN`

`USER_VISUAL_REVIEW = PASS`

R3-D is the current quality reference for Zhiying knowledge and humanities videos. It is not a reusable art-direction preset.

## Exact frozen chain

| Object | Exact identity |
| --- | --- |
| Project | `3778ffb0-c430-4499-9f7f-2590f45cb8cb` |
| Script V2 | `046bb456-ec8c-431e-b117-186bb63953ab@3` |
| Narration Plan V2 | `76d3da1e-09dd-4af7-acc2-6116f3c3f4bb@2` |
| Narration Audio V2 | `ff7ef85f-bf59-4814-ba9a-6306e56e8cb6@1` |
| Subtitle Timing V2 | `68a8a73c-7863-4fa6-a89f-d9965f66c92f@1` |
| Visual R3-D | `4a4eec86-fe60-42cd-a6dd-8a71543baddc@7` |
| Reconciliation R3-D | `ebe44bfe-e971-42eb-968c-68f9b80f7d19@7` |
| Final Render Source | `884a690f-323f-4ff3-8cbc-287dce27e8f4@8` |
| Render Job | `f758355c-1bbd-4689-8c02-a63c45e5e98f` |
| Renderer | `dark-editorial-v1@3` |
| Reference implementation commit | `14586bddb9bbaba735eb752a3126b10a8028a2b7` |

The production job is `succeeded`, attempt 1, `kind=no-subtitles`. Its immutable source has `showSubtitles=false` and the exact visual/audio/subtitle/reconciliation identities above.

## Master media

- Path: `outputs/r3d-final/master_clean.mp4`
- SHA-256: `89d747e542f906488793c5e0d109dc50e30084d54ab97e571d4f2453b9f2cc66`
- Size: 30,163,791 bytes
- Duration: 243.626 seconds
- Video: H.264, 1920×1080, 30 fps
- Audio: AAC
- Beat boundaries: 19/19 PASS

## Evolution retained as evidence

- **V1:** The exact technical chain passed, but the visual result was too sparse to become a quality reference.
- **V2:** Information density improved, while repeated visual grammar and card-like layouts remained visible.
- **R2:** Semantic animation and a broader shot vocabulary were added; full review then exposed motion that existed without a clear explanatory role.
- **Semantic Cleanup:** Decorative drifting dots, lines, and paths were removed or converted into visible cause-and-effect motion.
- **R3-A/B:** The project gained its dark editorial direction, provenance-backed historical material, Chinese-first audience language, and clean-master plus external-subtitle delivery.
- **R3-C:** Visual actions settled earlier and held through sentence endings, so composition changes no longer rushed the narration.
- **R3-D:** Scene-persistent state was separated from beat-local animation. Completed objects, paths, positions, and camera focus no longer reset or replay at same-scene beat boundaries.
- **User review:** PASS. The four-minute sample ended iteration here.

Intermediate shortcomings are retained because they are the evidence behind the current general rules. A technical PASS alone never established visual acceptance.

## Reusable quality rules

- Carry exact artifact identities through every derived operation.
- Deliver a clean master with exact subtitle sidecars.
- Use restrained delivery variation according to rhetorical function.
- Keep factual and historical evidence traceable and narratively relevant.
- Write audience-facing, human editorial language; prefer Chinese for a general Chinese audience.
- Require motion to have a semantic actor, source, target, reason, and visible result.
- Let visual changes follow acoustic pauses, semantic completion, and object handoff.
- Preserve completed scene state across later beats and inspect every same-scene boundary for replay.
- Review the exact final MP4 independently; the user's informed viewing judgment is final.

## Project-specific art direction

Do not mechanically copy the Freud/Signorelli material, 25-scene structure, dark palette, chapter order, nodes, cards, or evidence-chain layouts. A new topic must choose its own visual system while meeting the quality rules above.

## Reference evidence index

All paths were verified as present at freeze time; large media are indexed rather than copied into documentation.

- `outputs/r3d-final/master_clean.mp4`
- `outputs/r3d-final/boundary-review/all-boundaries.png`
- `outputs/r3-final/subtitles.zh-CN.srt`
- `outputs/r3-final/subtitles.zh-CN.vtt`
- `outputs/r3-final/subtitles.zh-CN.ass`
- `outputs/r3-final/subtitle_timing_v2.json`
- `outputs/r3-final/narration_master.wav`

The master SHA identifies this accepted artifact. It is not a cross-machine byte-identity requirement for future renders.

## Regression baseline

The lightweight baseline validates the manifest, physical master SHA and media facts, exact parent identities, clean subtitle profile, exact sidecar source, renderer version, and 19 boundary evidence files. Existing focused tests cover no-replay semantics, exact artifact propagation, subtitle profiles, typecheck, and build. It does not render the four-minute master in CI.
