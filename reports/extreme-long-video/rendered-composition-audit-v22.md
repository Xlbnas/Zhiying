# Extreme Long Video — Rendered Composition Audit V2.2

## Evidence boundary

- User actual-MP4 review is authoritative for the P1: composition repetition and visual fatigue run through the film, with 00:00–03:30 the worst interval.
- Formal manifest identity: render `7f2cfa6a-ad81-4ee5-9746-160dd4ae977c`; expected SHA-256 `61bcf37d5c5605d1270bb8848046505a36e57aceea13124c1bf7458285b5d8a5`.
- The local same-name MP4 is not that immutable file: SHA-256 `26f2647928d06b8c12ce2736d14f8c7c6fd67f82083e52df33ba40c6b30c7f19`, 68999565 bytes. It shows an older light-canvas/debug-ID route and is excluded from V2.2 visual acceptance.
- Primitive counts below are reproducible rendered-pixel classifications from the frozen `b602510` renderer plus its exact V2.1 scene manifest. They count what the renderer draws, not family names alone.

## V2.1 perceptual primitive baseline

| Perceptual primitive | Occurrences | Pixel-level basis |
| --- | ---: | --- |
| top-left headline + empty field | 16 | all KINETIC_CLAIM modes shared the same headline/glow field |
| two horizontal cards | 16 | VERSION_DIFF side cards plus COMPARISON argument cards |
| three-node arc | 6 | CONCEPT_SPACE variant 0 |
| input–condition–report boxes | 5 | PROCESS_MAP variant 0 |
| overlapping version cards | 7 | VERSION_DIFF variant 0 |
| single horizontal divider | 16 | COMPARISON variants 0/1 |
| diamond + title interstitial | 16 | chapter diamonds plus diamond-led kinetic claims |
| small/contextual archive rectangle | 4 | four contextual archive bindings; the other three were archive-led |

These primitives overlap by scene; the counts are not intended to sum to 111.

## V2.2 replacement inventory

| Family | Semantic composition / sequence route | Scenes |
| --- | --- | ---: |
| CHAPTER_INTERSTITIAL | family-specific | 4 |
| CHAPTER_INTERSTITIAL | sequence:drm-mechanisms | 1 |
| CHAPTER_INTERSTITIAL | sequence:flashbulb-longitudinal | 1 |
| CHAPTER_INTERSTITIAL | sequence:opening-disagreement | 1 |
| CHAPTER_INTERSTITIAL | sequence:suggested-autobiographical | 1 |
| COMPARISON | before-after | 6 |
| COMPARISON | claim-vs-boundary | 2 |
| COMPARISON | condition-a-b | 5 |
| COMPARISON | evidence-table | 1 |
| COMPARISON | image-vs-report | 2 |
| COMPARISON | paired-documents | 3 |
| COMPARISON | split-screen | 5 |
| COMPARISON | two-axis | 4 |
| CONCEPT_SPACE | distance-scale | 3 |
| CONCEPT_SPACE | foreground-competition | 1 |
| CONCEPT_SPACE | nested-layers | 4 |
| CONCEPT_SPACE | overlap | 4 |
| CONCEPT_SPACE | source-cluster | 3 |
| CONCEPT_SPACE | threshold-field | 1 |
| EVIDENCE_ARCHIVE | family-specific | 1 |
| EVIDENCE_ARCHIVE | sequence:bartlett-to-loftus | 2 |
| FINAL_SYNTHESIS | family-specific | 3 |
| KINETIC_CLAIM | editorial-statement | 1 |
| KINETIC_CLAIM | object-led-claim | 5 |
| KINETIC_CLAIM | question-field | 3 |
| KINETIC_CLAIM | typographic-contradiction | 7 |
| PROCESS_MAP | branch | 4 |
| PROCESS_MAP | contamination-path | 2 |
| PROCESS_MAP | failure-point | 2 |
| PROCESS_MAP | feedback-loop | 1 |
| PROCESS_MAP | gate | 1 |
| PROCESS_MAP | literal-flow | 3 |
| PROCESS_MAP | progressive-accumulation | 4 |
| TIMELINE | sequence:confidence-eyewitness | 2 |
| TIMELINE | sequence:flashbulb-longitudinal | 3 |
| VERSION_DIFF | branching-versions | 2 |
| VERSION_DIFF | document-redline | 4 |
| VERSION_DIFF | layer-accumulation | 4 |
| VERSION_DIFF | split-memory | 1 |
| VERSION_DIFF | version-timeline | 4 |

The exact legacy primitives above are no longer renderer defaults. Sequence-world scenes bypass the generic family surface and retain stable objects across the whole sequence. Outside sequences, semantic modes select distinct geometry rather than a numeric variant alone.

## Sequence manifests

| Visual world | Scene range | Seconds | Scenes |
| --- | --- | ---: | ---: |
| opening-disagreement | S001–S012 | 0.0–93.4 | 12 |
| bartlett-to-loftus | S013–S025 | 93.4–215.8 | 13 |
| drm-mechanisms | S035–S056 | 307.3–497.1 | 22 |
| confidence-eyewitness | S058–S066 | 504.0–586.0 | 9 |
| flashbulb-longitudinal | S067–S077 | 586.0–679.1 | 11 |
| suggested-autobiographical | S089–S101 | 782.4–914.7 | 13 |

## Archive scale

- Binding/provenance changes: 0.
- Asset changes: 0.
- Archive-led layout: 1250×850 image surface (about 51% of a 1920×1080 frame before crop).
- Contextual layout: 1110×820 surface (about 44% of the frame), with explicit context disclosure retained.
- Large-format bound scenes: 7/7.

## Current gate

Six continuous 720p audio-bearing previews were rendered and independently reviewed twice. After the targeted B–E correction, the second review reported P0=0, P1=0, pixel repetition PASS, sequence continuity PASS, archive scale PASS, and experiment identity PASS. Content footprint and long-form fatigue remain PARTIAL as two P2 observations. See `visual-composition-v22-final-report.md`; no formal render job was created.
