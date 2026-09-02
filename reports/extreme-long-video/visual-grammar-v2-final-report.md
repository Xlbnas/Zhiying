# Extreme Long Video — Visual Grammar V2 Final Report

## VERDICT

READY FOR HUMAN VISUAL REVIEW — this is a static-storyboard/design delivery only. No new formal render authority was requested or used.

## ROOT_CAUSE

The first pass coupled a speech unit to its first narration sentence as the visual headline, then rotated a small set of light editorial layouts. The earlier continuity patch prevented full re-entry but left long, unchanged instances of the same layouts.

## WHY_PREVIOUS_REVIEW_WAS_INSUFFICIENT

It checked media/source correctness and the two persistent-state regressions, but did not audit the whole film for narration-copy, visual-family distribution, long contiguous layout use, bright-canvas persistence, or production debug copy.

## NARRATION_VISUAL_SEPARATION

- `narrationText`: unchanged narration authority for TTS/subtitles.
- `visualThesis`: one short, maximum-two-line visual proposition.
- `visualLabels`: short structural terms, not narration sentences.
- Exact/high-overlap scene count: **109 → 0**.
- Changed scenes: **111/111** receive the separated fields and a dark default canvas.
- Remaining exceptions: the user-requested four-character question `谁记错了？`; it is deliberately shorter than the normal 6–18-character target and is not narration copy.

## VISUAL_FAMILY_DISTRIBUTION

Nine families are used: `KINETIC_CLAIM`, `VERSION_DIFF`, `PROCESS_MAP`, `TIMELINE`, `EVIDENCE_ARCHIVE`, `CONCEPT_SPACE`, `COMPARISON`, `CHAPTER_INTERSTITIAL`, and `FINAL_SYNTHESIS`.

- Before: 10 legacy families, driven largely by chapter rotation; longest same-family interval **66.0s**.
- After: 9 semantic families; no contiguous same-family interval exceeds **18s** (audit result: 0 intervals over limit).
- `CHAPTER_INTERSTITIAL` is now only a chapter entry rather than a recurrent general-purpose layout.

## THEME

- Default theme: `backgroundMode = dark` for all 111 local design scenes.
- Light material is limited to source/document treatment inside `EVIDENCE_ARCHIVE`; it is not a light full-frame template.
- The visual-production rule now states that unspecified projects start dark, while paper/archive/magazine/medical-chart/brand requirements can justify light material or a light main background.

## DEBUG_OVERLAY

- Source: `src/remotion/templates/production/MemoryLabEditorialScene.tsx`.
- Fix: production defaults `debugOverlay=false`, `showSceneId=false`; no `scene.id` element is created unless either debug prop is explicitly true.
- Test: `scripts/test-extreme-long-video-visual-grammar.ts` verifies production props have zero scene-ID elements and debug gating remains available.
- Visible `Sxxx` count in the reviewed static preview frames: **0**.

## KEY_SEQUENCE_REDESIGNS

- Opening: overlapping record versions and fragments lead to `谁记错了？`; it no longer opens on five blocks or a narration headline.
- 01:35–02:10: archive/evidence material, version difference, and the three labels `遗漏 / 合理化 / 扭曲` lead to `复述 ≠ 必然更错` without transcribing narration.
- S069–S073: `TIMELINE → VERSION_DIFF → TIMELINE → COMPARISON → KINETIC_CLAIM`, using manifest `sequence` phase data rather than scene-ID code paths.
- S092–S095: spatial experience spectrum, layered sources, and a real contrast replace the five-box highlighter.
- Ending: evidence material types accumulate in `FINAL_SYNTHESIS`; `KINETIC_CLAIM` provides the final 4–6-second fade-ready proposition instead of a static generic map.

## ARCHIVE_USAGE

The design preserves its 19 local archive requirements and does not change any binding/provenance source. `EVIDENCE_ARCHIVE` displays an existing bound image at useful scale with crop/push behavior; the local storyboard deliberately shows an empty dark evidence surface when a locally available source file is absent, rather than inventing an archive page.

## SUBTITLE_SAFE_AREA

The main content is kept above the lower 224 px. This review preview has no burned subtitles; it uses the frozen subtitle timing only as an unchanged source boundary.

## FILES_CHANGED

- `src/remotion/templates/production/MemoryLabEditorialScene.tsx`
- `scripts/build-extreme-long-video-design.ts`
- `scripts/audit-extreme-long-video-visual-grammar.ts`
- `scripts/test-extreme-long-video-visual-grammar.ts`
- `scripts/render-extreme-long-video-v2-storyboard.mjs`
- `docs/long_video/scenes-design.json`
- `docs/long_video/narration-beat-map.md`
- `docs/long_video/visual-direction.md`
- `.agents/skills/zhiying-video/references/production.md`
- `reports/extreme-long-video/visual-grammar-audit-v2.md`
- `reports/extreme-long-video/visual-grammar-v2-final-report.md`

## TESTS

- `pnpm typecheck` — PASS.
- `npx tsx scripts/test-extreme-long-video-visual-grammar.ts` — PASS (111 scenes, 0 production scene IDs).
- `npx tsx scripts/test-m71-audio-subtitle-v2.ts` — PASS=91, FAIL=0.

## BUILD

`pnpm build` — PASS (Next.js optimized production build).

## SOURCE_CHAIN

The 91-pass V2 test validates exact narration/audio/subtitle/visual/reconciliation identity and the memory editorial route. No source binding or provenance file was edited in this change.

## AUDIO_HASH_UNCHANGED

`658235d97a94f67feb9bc50d0849e7b15c2edf85f95b8db229b40b12a2460997` — `outputs/extreme-long-video/audio/narration-master.wav`

## SUBTITLE_HASH_UNCHANGED

`dfab1dab6b1ef7707b9d6173b44455428ec6e59b74c81c528a6ed8a3ea29237b` — `outputs/extreme-long-video/subtitles/subtitle_timing_v2.json`

## PREVIEW_ARTIFACTS

- `outputs/extreme-long-video/visual-grammar-v2/contact-sheet-01.png` through `contact-sheet-05.png` — representative frames for all 111 scenes.
- `opening-storyboard.png`, `transcript-duplication-storyboard.png`, `flashbulb-storyboard.png`, `experience-spectrum-storyboard.png`, `ending-storyboard.png` — the five required local static previews.
- `preview-props.json` — static, no-audio Remotion preview props.

## FORMAL_RENDER_JOBS_CREATED

**0**

## READY_FOR_HUMAN_VISUAL_REVIEW

**YES**

## NEXT_ACTION

Wait for the user to review the Contact Sheets and five local storyboards. Do not request or create a new complete formal render until the user explicitly grants that authority.
