# Extreme Long Video — Visual Composition V2.2.1 Final Report

> **SUPERSEDED:** user review of the actual 720p full preview found an oversized coral-overlay problem and an early DRM answer leak. This V2.2.1 readiness verdict is revoked. Use `visual-composition-v222-final-report.md` instead.

## Verdict

```text
V2.2.1_LOCAL_QC = PASS
P0 = 0
P1 = 0
P2 = 3
READY_FOR_FULL_RENDER_ATTEMPT_2 = YES
FORMAL_RENDER_JOBS_CREATED = 0
FULL_RENDER_CAPACITY_REMAINING = 1
```

This is a full-length local-QC verdict, not a production render result or publication approval.

## Frozen chain

- Script, narration/TTS, subtitle timing, scene boundaries, 111 visual theses, archive bindings/assets, DB schema, and sequence manifests were not changed.
- Script, narration/TTS, subtitle timing, scene boundaries, 111 visual theses, archive bindings/assets, DB schema, and sequence manifests were not changed.
- Remotion remains `4.0.492`.
- Narration master SHA-256: `658235d97a94f67feb9bc50d0849e7b15c2edf85f95b8db229b40b12a2460997`.
- Subtitle timing V2 SHA-256: `dfab1dab6b1ef7707b9d6173b44455428ec6e59b74c81c528a6ed8a3ea29237b` (213 exact cues).
- The current local DB does not contain project `8f955b4c-42dd-4a02-8e76-e721a37fab41`; local physical artifacts and the 91/91 exact-chain test are the authority for this QC run. No production DB mutation was attempted.

## Opening progression

- S001–S005: one disagreement workspace evolves from version A, to A/B conflict, shared confidence, vividness/emotion boundary, and gist/detail separation.
- S006–S008: detail map, bounded statement, then the single certainty-tension oval; the former three-oval repetition is removed.
- S009–S012: coherence progression, branching boundary, video metaphor, and document reconstruction.
- Independent verdict: `OPENING_MACRO_REPETITION = PASS`.

## Semantic state density

- Scenes audited: `111/111`.
- V2.2 measured baseline: `48/91` scenes had a near-static run of at least about 8 seconds; `23/91` had at least about 10 seconds.
- V2.2.1 measured result: `0/111` non-deliberate near-static runs over 7 seconds.
- Planned long-static scenes: `0`.
- Exceptions: none required by the audit. The final rhetorical black hold is outside the unchanged-information-board failure class.
- Detailed evidence: `reports/extreme-long-video/semantic-state-density-audit-v221.md`.

## Full local previews

| File | Duration | Video | Audio | Decode | SHA-256 |
| --- | ---: | --- | --- | --- | --- |
| `outputs/extreme-long-video/visual-composition-v221/full-local-preview-720p.mp4` | 1013.354667s | H.264, 1280×720, 30fps | AAC, 48kHz, stereo | PASS | `a85af2a473f472088b25c36acf4960a518a18ae1166b069ed2e12a0195eadfe3` |
| `outputs/extreme-long-video/visual-composition-v221/full-local-preview-720p-burned.mp4` | 1013.354667s | H.264, 1280×720, 30fps | AAC, 48kHz, stereo | PASS | `5d278003d28f959d001c7637a6b7b919892ec5841f8b942d5a02c8991beaaceb` |

- Clean and burned files are byte-distinct and their subtitle-check frames are distinct.
- Extracted AAC stream MD5 is identical in both files: `28aaff4c909c61cb11cebba5a27838dd`.
- Clean carries no burned subtitle pixels; burned uses the frozen 213-cue timing artifact.

## Independent full-length review

The independent GPT-5.6 Luna reviewer inspected the clean full-length preview across all nine required intervals and sampled the burned version for subtitle/scene relations:

1. 00:00–01:33
2. 01:33–03:35
3. 03:35–05:07
4. 05:07–08:17
5. 08:17–10:30
6. 10:30–13:02
7. 13:02–15:15
8. 15:15–16:35
9. 16:35–16:53.3

| Gate | Verdict |
| --- | --- |
| OPENING_MACRO_REPETITION | PASS |
| LONG_STATIC_INFORMATION_BOARDS | PASS |
| SEMANTIC_STATE_DENSITY | PASS |
| CONTENT_FOOTPRINT | PASS |
| SEQUENCE_CONTINUITY | PASS |
| ARCHIVE_SCALE | PASS |
| EXPERIMENT_IDENTITY | PASS |
| LONG_FORM_FATIGUE | PASS |

Reviewer severity: `P0=0`, `P1=0`, `P2=3`.

Non-blocking P2 observations:

1. The dark editorial/two-card/title-plus-diagram macro grammar still recurs across the full film.
2. A few chapter-title or empty-frame construction states retain generous negative space.
3. One archive attribution reads `Unknown · No restrictions`; confirm its public-facing source wording before publication.

The reviewer did not subjectively listen to the audio and therefore makes no claim about narration performance, loudness, music, or subjective A/V sync. Full audio/video decode was verified separately.

## Verification

- Visual grammar: PASS (`111` scenes, `6` sequence worlds, `0` visible production scene IDs, `0` planned long-static scenes).
- Semantic-state rendered audit: PASS (`111/111`, measured long-static after = `0`).
- Archive semantic audit: PASS (`19` requirements: `2 exact + 5 contextual + 12 editorial replacement`; `7` retained provenance-backed assets; `0` unsafe filler).
- Exact narration/audio/subtitle/visual/reconciliation/render-profile chain: PASS (`91/91`).
- TypeScript typecheck: PASS.
- Next.js 15.5.21 production build: PASS.
- Full clean/burned media probe and decode: PASS.
- Scoped diff whitespace check: PASS.
- Formal render enqueue paths called: `0`.
- Unrelated legacy M3-E harness was not changed or used as a gate.

## Next step

The last formal full-render attempt may now be authorized. No formal job has been created in this V2.2.1 round.
