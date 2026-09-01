# Extreme Long Video — Visual Grammar V2.1 Final Static Gate

## VERDICT

PASS — static pre-render gate only. A full formal render remains explicitly user-authorized work.

## VISUAL_THESIS

- unique: 111 / 111 exact thesis strings
- generic_repetition_before: `结论需要边界` 22, `来源需要判断` 9, `信心要看记录时点` 8, `让条件彼此对照` 5, `线索在关系中重组` 5
- generic_repetition_after: 0 of those generic headings; no exact thesis is repeated
- top_repeated: none
- status: PASS. The soft gate rejects an ordinary exact thesis appearing over three times; the current manifest has no repeated thesis.

## COMPOSITION_PRIMITIVES

- diagonal_lines: decorative coral diagonal = 0; remaining short diagonal only expresses a version edit/redaction
- three_node_maps: 6
- process_boxes: input-condition-output = 5
- version_cards: 7
- archive_full_bleed: FULL_ARCHIVE_EDITORIAL = 3
- experiment_result: 12
- argument_editorial: 12
- status: PASS. The maximum same-family sequence is 17.6s (S090–S091), while the independent pixel review found B/C/D materially different rather than enum interleaving.

## ARCHIVE_BINDING

- requirements: 19
- exact: 2
- contextual: 5
- editorial_replacement: 12
- blocked: 0
- empty_surfaces: 0
- rights: all seven retained files have verified provenance; the two exact assets are public domain / CC BY-SA 4.0, contextual assets are explicitly bounded on screen, and the remaining twelve claims use native editorial replacement rather than wrong archive imagery.
- status: PASS. `EVIDENCE_ARCHIVE` throws on a missing image instead of rendering an empty surface.

The complete per-scene table is in `visual-grammar-audit-v21.md`.

## STORYBOARD_A

- interval: 00:00–03:30
- contact sheet: `outputs/extreme-long-video/visual-grammar-v21/A-0000-0330-contact-sheet.png`
- frames: 9

## STORYBOARD_B

- interval: 05:00–08:30
- contact sheet: `outputs/extreme-long-video/visual-grammar-v21/B-0500-0830-contact-sheet.png`
- frames: 9

## STORYBOARD_C

- interval: 09:45–13:30
- contact sheet: `outputs/extreme-long-video/visual-grammar-v21/C-0945-1330-contact-sheet.png`
- frames: 9

## STORYBOARD_D

- interval: 13:15–16:52
- contact sheet: `outputs/extreme-long-video/visual-grammar-v21/D-1315-1652-contact-sheet.png`
- frames: 9

## INDEPENDENT_REVIEW

- P0: 0
- P1: 0
- P2: 1 — secondary provenance text is necessarily small at contact-sheet thumbnail scale; primary archive-scope labels are readable
- generic_thesis: PASS
- composition_repetition: PASS
- archive_binding: PASS
- visual_fatigue: PASS at static-design gate
- verdict: PASS

## TESTS

- `npx tsx scripts/test-extreme-long-video-visual-grammar.ts` — PASS (111 scenes, production visible Sxxx IDs = 0)
- `npx tsx scripts/audit-extreme-long-video-visual-grammar-v21.ts` — PASS (111 unique theses, 19 archive requirements, decorative diagonal = 0)
- `npx tsx scripts/test-m71-audio-subtitle-v2.ts` — PASS=91, FAIL=0

## BUILD

- `pnpm typecheck` — PASS
- `pnpm build` — PASS

## SOURCE_CHAIN

- PASS (the Audio V2 / Subtitle V2 / visual-source regression suite passed 91 checks)

## AUDIO_HASH_UNCHANGED

- `narration-master.wav`: `658235d97a94f67feb9bc50d0849e7b15c2edf85f95b8db229b40b12a2460997`

## SUBTITLE_HASH_UNCHANGED

- `subtitle_timing_v2.json`: `dfab1dab6b1ef7707b9d6173b44455428ec6e59b74c81c528a6ed8a3ea29237b`

## FORMAL_RENDER_JOBS_CREATED

0

## NEXT_STEP

USER_AUTHORIZE_LONG_VIDEO_FULL_RENDER
