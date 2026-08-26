# V2 Visual R2 — failed-baseline frame audit

## Verdict and preserved evidence

`VISUAL_VERDICT = FAIL`

`PREVIOUS_VISUAL_REVIEW = FALSE_POSITIVE`

The previous report is preserved unchanged and is now classified as
`HISTORICAL_FALSE_POSITIVE`. The three historical files remain byte-identical:

| Evidence | SHA-256 |
| --- | --- |
| `outputs/fresh-v2-review/fresh-v2-final.mp4` | `5e00166894e12b06eee54a1d96642e180fc1e131801e87910ed6cc6001243a0d` |
| `outputs/fresh-v2-review/v2-final-contact-sheet.png` | `3358c67daae159a9c03208d1f43c1d97245e6a947ab5c54a633b265a5f6c4fae` |
| `outputs/fresh-v2-review/v2-final-review.md` | `b74c2b4646803681c7bdf930adbd0c3f54039ee6948f17955e539dd4bcb12d8b` |

The earlier PASS counted differently named templates and color families, but did
not verify clause-level visible reasoning, main-frame information, or state change
through time. That is the false-positive mechanism.

## Method

- Media: H.264, 1920×1080, 30 fps, 7,307 frames, 243.626 seconds.
- All 7,307 frames were decoded and compared after cropping the source to the top
  860 pixels, excluding the subtitle band.
- Per-frame measurements include mean absolute difference, changed-pixel fractions,
  movement by vertical third, luma variance, edge density, information score, and
  maximum-information frame per scene.
- 244 one-second samples cover the whole timeline.
- Each of the 25 scenes has entry, 25%, midpoint, maximum-information, 75%, and
  handoff frames.
- Each of the 24 scene boundaries has all 21 frames from `boundary - 10` through
  `boundary + 10` captured and inspected.
- Quantitative movement is only a static-window detector. Semantic classifications
  below also use the rendered evidence and renderer code. Subtitle fades, full-frame
  crossfades, background grain, Ken Burns, and one-time opacity reveals do not count
  as meaningful explanatory motion.

Evidence index:

- Per-frame metrics: `outputs/v2-visual-r2/frame-audit/baseline-motion.json`
- One-second samples: `outputs/v2-visual-r2/frame-audit/evidence/one-second-frames/`
- Four one-second sheets: `outputs/v2-visual-r2/frame-audit/evidence/one-second-contact-sheets/`
- Scene strips: `outputs/v2-visual-r2/frame-audit/evidence/scene-strips/`
- Boundary strips: `outputs/v2-visual-r2/frame-audit/evidence/boundary-strips/`
- Exact evidence manifest: `outputs/v2-visual-r2/frame-audit/evidence/evidence-manifest.json`

## Aggregate findings

- 36 of 49 non-overlapping five-second windows have fewer than 5% high-motion
  frames even under a permissive pixel-motion threshold.
- The remaining 13 windows are dominated by scene crossfades, initial element
  reveals, or archive Ken Burns. They do not form input → action → consequence →
  result → handoff chains.
- All 24 boundaries are full-frame eight-frame crossfades. No semantic actor or
  path persists across a boundary.
- 14 scenes are visibly top-heavy: S001, S002, S003, S004, S007, S011, S014, S015,
  S017, S019, S020, S022, S023, and S024.
- 22 scenes have low main-frame content footprint; only the three full-frame archive
  scenes substantially fill the canvas.
- Five black headline scenes occupy 37.433 seconds (15.37%).
- Three static archive scenes occupy 32.867 seconds (13.49%).
- Three near-identical three-node relation graphs occupy 33.733 seconds (13.85%).
- Those repeated families total 104.033 seconds, or 42.71% of all rendered frames.
- The subtitle band supplies the changing propositions during most static holds.
  The main frame usually supplies a topic label or noun list, not the narrated
  causal step.

## Per-scene audit

`Content footprint` refers only to the main visual above the subtitle band.

| Scene | Time | Narrative purpose | Current main visual | Visible action | Visible result | Handoff | Content footprint / top-heavy / subtitle-dependent | Meaningful motion / repetition | Severity | Repair direction |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S001 | 0.000–5.233 | Open the doubt around a slip | Black headline card | Headline fades in | No state changes | Full-screen crossfade/reset | Very low / yes / yes | No; black card 1/5 | P1 | Materialize intended word, competing word, and the first intrusion |
| S002 | 5.233–10.233 | Contrast accident with hidden-motive reading | Second black headline card | Replacement headline fades in | No comparison is visualized | Full-screen crossfade/reset | Very low / yes / yes | No; black card 2/5 | P1 | Keep the word object and branch it into competing interpretations |
| S003 | 10.233–14.167 | State the evidence-gap thesis | Beige editorial title at the top | Title and rule reveal | Thesis remains a sentence only | Full-screen crossfade/reset | Low / yes / yes | No; editorial title | P1 | Turn the gap into a spatial evidence path that survives into S004 |
| S004 | 14.167–30.667 | Separate three claim types | Small upper-left checklist | Three labels appear once | List is then held for about 13 seconds | Full-screen crossfade/reset | Low / yes / yes | No sustained semantic motion; generic list | P1 | Route one persistent claim through observation, interpretation, and testable claim states |
| S005 | 30.667–43.900 | Introduce the historical Freud source | Full-frame title-page archive plus one card | Slow crop/zoom | No source region or evidence relationship is exposed | Full-screen crossfade/reset | High image coverage / no / yes | Ken Burns only; archive 1/3 | P1 | Crop to supported regions, connect book/person/interpretation, then hand the claim forward |
| S006 | 43.900–53.467 | Show mutual interference in Freud's frame | Three circles and dashed edges | Nodes/edges fade in | Static triangle remains | Full-screen crossfade/reset | Low / no / yes | No process; repeated three-node graph 1/3 | P1 | Animate the spoken/intended/competing word path rather than nouns on a triangle |
| S007 | 53.467–61.767 | Contrast a slip and a forgotten action | Large editorial comparison line | Text reveals once | No causal distinction is demonstrated | Full-screen crossfade/reset | Low / yes / yes | No; editorial text | P1 | Split the persistent system into speech competition and prospective-memory paths |
| S008 | 61.767–70.433 | Introduce Freud as interpreter | Full-frame portrait archive plus one card | Slow crop/zoom | Portrait remains contextual only | Full-screen crossfade/reset | High image coverage / no / yes | Ken Burns only; archive 2/3 | P1 | Use a supported portrait/date/evidence bridge into the historical hypothesis |
| S009 | 70.433–83.067 | Show the historical conflict account | Three circles and dashed edges | Nodes/edges fade in | Static triangle remains | Full-screen crossfade/reset | Low / no / yes | No process; repeated three-node graph 2/3 | P1 | Show interpretation being inferred from an error, with the unsupported leap visible |
| S010 | 83.067–94.033 | Qualify the historical interpretation | Full-frame social archive plus one card | Slow crop/zoom | No competing explanation enters the frame | Full-screen crossfade/reset | High image coverage / no / yes | Ken Burns only; archive 3/3 | P1 | Annotate the supported context and bridge it into the modern alternative |
| S011 | 94.033–101.067 | Open the modern cognition section | Top-left editorial heading | Heading fades in | No modern mechanism appears | Full-screen crossfade/reset | Very low / yes / yes | No; editorial heading | P1 | Preserve the error token and reframe it as an activation system |
| S012 | 101.067–111.100 | Explain overlapping lexical activation | Small centered three-layer stack | Layers reveal sequentially | A taxonomy appears, not an activation race | Full-screen crossfade/reset | Low / no / yes | Weak semantic reveal; generic stack | P1 | Animate multiple lexical candidates racing and crossing a threshold |
| S013 | 111.100–119.100 | Explain monitoring/competition | Small four-node graph | Nodes/edges fade in | Static topology remains | Full-screen crossfade/reset | Low / no / yes | No causal state change; graph variant | P1 | Carry the winning word into a monitor that can accept/correct it |
| S014 | 119.100–127.733 | Explain the tip-of-the-tongue state | Black quotation card | Quote fades in | Retrieval failure is not visualized | Full-screen crossfade/reset | Very low / yes / yes | No; black card 3/5 | P1 | Send a memory trace through a retrieval funnel and show the missed threshold |
| S015 | 127.733–143.400 | Explain prospective-memory failure | Small upper-left checklist | Items appear once | Cue-trigger relationship is absent | Full-screen crossfade/reset | Low / yes / yes | No sustained semantic motion; generic list | P1 | Put intention on a timeline and visibly fire or miss an environmental cue |
| S016 | 143.400–154.933 | Explain interference without hidden motive | Three circles and dashed edges | Nodes/edges fade in | Static triangle remains | Full-screen crossfade/reset | Low / no / yes | No process; repeated three-node graph 3/3 | P1 | Layer old memory, new input, and target until the target path is displaced |
| S017 | 154.933–163.600 | Preserve a bounded role for motive | Top-left editorial statement | Statement fades in | Boundary/qualification is text only | Full-screen crossfade/reset | Low / yes / yes | No; editorial statement | P1 | Reuse the mechanism map and add motive as one weighted input, not a replacement slide |
| S018 | 163.600–172.933 | Compare bounded influence with post-hoc certainty | Two sparse cards | Cards fade in | Difference remains label-only | Full-screen crossfade/reset | Low / no / yes | No; generic split comparison | P1 | Let one observed error feed two inference paths with different evidential burdens |
| S019 | 172.933–183.800 | Warn about seductive post-hoc stories | Black headline card | Headline fades in | No failure mode is demonstrated | Full-screen crossfade/reset | Very low / yes / yes | No; black card 4/5 | P1 | Show a story attaching after the outcome and contrast it with a prior prediction |
| S020 | 183.800–190.833 | Define what makes an explanation credible | Small upper-left checklist | Items reveal once | No evaluation occurs | Full-screen crossfade/reset | Low / yes / yes | No; generic list | P1 | Start an evidence map and run the claim through explicit gates |
| S021 | 190.833–203.533 | Contrast falsifiable prediction with post-hoc story | Two sparse cards | Cards fade in | Comparison stays static | Full-screen crossfade/reset | Low / no / yes | No; repeated split-card language | P1 | Animate prediction before outcome, then reveal which branch survives evidence |
| S022 | 203.533–216.300 | State the balanced conclusion | Large editorial statement at top | Statement fades in | No supporting map is visible | Full-screen crossfade/reset | Low / yes / yes | No; editorial text | P1 | Accumulate claim, observation, alternative mechanism, confidence, and limitation |
| S023 | 216.300–225.133 | Summarize modern psychology's testable stance | Small upper-left checklist | Items reveal once | Evidence remains a noun list | Full-screen crossfade/reset | Low / yes / yes | No; generic list | P1 | Resolve the evidence gates into a calibrated confidence indicator |
| S024 | 225.133–232.833 | Give the viewer a practical question | Black headline card | Headline fades in | No question path or choice is shown | Full-screen crossfade/reset | Very low / yes / yes | No; black card 5/5 | P1 | Reuse the evidence map and focus the camera on the missing link to ask about |
| S025 | 232.833–243.567 | Deliver the final evidence-chain thesis | Sparse dark final statement | Text fades in | New final card replaces the prior system | Static hold to end | Low / no / yes | No; isolated final card | P1 | Collapse the accumulated map into one continuous final chain and hold the resolved state |

## Boundary audit

`FullCutV1.tsx` applies the same eight-frame opacity crossfade at every non-terminal
scene boundary. The 24 boundary strips confirm that this is a whole-frame replacement,
not an object/state handoff. Even when neighboring scenes discuss the same word,
claim, or mechanism, the previous object disappears and a new template starts.

## Root cause

The exact-source production chain is not the visual failure. The failure is the
renderer contract below it:

1. one scene selects one of six coarse templates;
2. each template performs a short opacity reveal;
3. the template then holds a static noun arrangement for the rest of the scene;
4. `FullCutV1` crossfades the entire canvas into the next unrelated component;
5. subtitles carry the clause-level changes that the main frame never renders.

The smallest correct repair is therefore a clause-level, data-driven choreography
inside existing `templateProps`, plus a persistent actor vocabulary and semantic
handoff states. Moving the old titles lower or adding decorative motion would not
address the cause.
