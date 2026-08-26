# V2 Visual R2 — full pre-render QC

## Scope and status

This is development/QC evidence for the exact 7,307-frame visual timeline. It is
not a production artifact and does not replace the CLI/runner/Worker render path.
The six contiguous preview clips cover source frames `0..7306` with no gap or
overlap:

`A (0..919) -> D (920..2820) -> B (2821..3831) -> E (3832..5513) -> C (5514..6753) -> F (6754..7306)`.

Evidence manifest: `outputs/v2-visual-r2/full-qc/manifest.json`.

## Coverage

- Decoded frames: 7,307 / 7,307 at 30 fps.
- One-second samples: 244.
- One-second contact sheets: 4.
- Scene six-frame strips: 25 / 25.
- Scene-boundary transition strips: 24 / 24; every boundary uses 10 frames before,
  the boundary frame, and 10 frames after.
- Motion windows: 49 contiguous windows, each 4.967–5.000 seconds.
- Each motion-window strip records setup, action, visible result, and handoff.
- Subtitle-excluded motion crop: source rows `0..859`; the subtitle region is not
  counted as primary-visual motion.

## Scene evidence

`max-info` is the global frame selected by the deterministic footprint sampler.
The content bounds of every maximum-information frame reach from approximately
5.6% to 94.4% of frame height, so no scene's main evidence is confined to the top
20%. Numeric motion is used only as a stall detector; the semantic verdict comes
from the rendered state changes and independent clip review.

| Scene | Frames | Max-info | Semantic action/result | Footprint / handoff |
|---|---:|---:|---|---|
| S001 | 0–156 | 119 | wrong word intrudes into intended path | center-to-lower system; error token persists |
| S002 | 157–306 | 265 | anomaly freezes, ordinary attribution enters | shared explanation slot remains |
| S003 | 307–424 | 404 | hidden-motive claim overlays ordinary error | evidence gap expands into S004 |
| S004 | 425–919 | 834 | claim strengths separate and strongest card flips | full-height claim map hands to archive |
| S005 | 920–1316 | 1230 | source document is located and annotated | evidence line persists to interference |
| S006 | 1317–1603 | 1385 | automatic-truth claim is rejected; interference bends path | error token remains invariant |
| S007 | 1604–1852 | 1690 | language and prospective-action paths split | missing target survives |
| S008 | 1853–2112 | 2059 | portrait/case context exposes missing target and substitutes | association trace exits frame |
| S009 | 2113–2491 | 2454 | association inference reconnects with explicit limitation | bounded hypothesis persists |
| S010 | 2492–2820 | 2778 | historical account moves into everyday observation | observation window flips to modern layer |
| S011 | 2821–3031 | 2989 | persistent error token is reframed as mechanism | camera advances to language process |
| S012 | 3032–3332 | 3329 | candidates race; temporary leader changes without fake values | winner reaches monitor gate |
| S013 | 3333–3572 | 3448 | monitor first intercepts, then misses once | unresolved target becomes retrieval input |
| S014 | 3573–3831 | 3829 | memory trace enters funnel and misses threshold | threshold extends into time line |
| S015 | 3832–4301 | 4298 | future intention is scheduled, load causes cue miss | missed trigger becomes action branch |
| S016 | 4302–4647 | 4634 | automatic path takes old branch; current goal arrives late | branch accepts context weight |
| S017 | 4648–4907 | 4906 | context changes relative candidate activation | results enter replication check |
| S018 | 4908–5187 | 5118 | support visibly weakens without invented percentages | unstable bridge becomes post-hoc path |
| S019 | 5188–5513 | 5481 | story is backfilled after outcome | story enters evidence bench |
| S020 | 5514–5724 | 5699 | coherence and testability are separated | prediction slot opens |
| S021 | 5725–6105 | 6023 | alternatives compete before outcome; failed story rewrites | weak path is demoted |
| S022 | 6106–6488 | 6451 | two extreme conclusions are rejected | middle path reconnects to error token |
| S023 | 6489–6753 | 6740 | answer decomposes into testable mechanisms | modules merge into viewer question |
| S024 | 6754–6984 | 6984 | question travels through evidence gate; premature closure pauses | gate becomes final branch |
| S025 | 6985–7306 | 7286 | clue/noise paths resolve into one evidence chain | accumulated system becomes final hold |

## Diagnostic outcome

- Empty maximum-information frames: 0 / 25.
- Placeholder frames observed in reviewed clips and strips: 0.
- Legacy whole-frame boundary crossfades in R2 path: 0 / 24.
- Reused generic three-node fixture across unrelated mechanisms: 0.
- Headline-only black cards: 0.
- Main visual depends on subtitle text for its causal result: no finding in the
  independent review.
- Low numeric motion remains possible during deliberate inspection/hold portions;
  it is not counted as a failure when the visible state and handoff are already
  established. Grain, background drift, and subtitle animation are excluded from
  the semantic decision.

## Evidence locations

- Contact sheets: `outputs/v2-visual-r2/full-qc/one-second-contact-sheets/`
- Scene strips: `outputs/v2-visual-r2/full-qc/scene-strips/`
- Transition strips: `outputs/v2-visual-r2/full-qc/transition-strips/`
- Motion-window strips: `outputs/v2-visual-r2/full-qc/motion-window-strips/`
- Per-frame diagnostic: `outputs/v2-visual-r2/full-qc/full-motion.json`
