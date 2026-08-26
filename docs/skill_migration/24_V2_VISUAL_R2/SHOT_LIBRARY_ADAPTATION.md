# Code Motion Explainer shot-library adaptation

The installed library was searched by semantic job. Sixteen catalog entries were
used as design references in the 44-beat choreography:

- `kinetic-statement`
- `reference-card-stack`
- `split-comparison`
- `story-timeline`
- `wide-causal-tag-map`
- `wide-chapter-transition`
- `wide-evidence-bridge`
- `wide-evidence-stack`
- `wide-exploded-workflow-board`
- `wide-knowledge-world`
- `wide-process-pill-builder`
- `wide-relationship-focus`
- `wide-ruler-chapter-progress`
- `wide-source-document`
- `wide-spotlight-reveal`
- `wide-tutorial-spotlight`

They informed composition and motion grammar: persistent object handoff, source
annotation, process paths, candidate competition, threshold/funnel motion, timeline
cues, evidence comparison, and final synthesis. No demo copy, brand, absolute asset
path, package dependency, or showcase component was copied into production.

The implementation is a Zhiying-owned `V2VisualR2Scene` route with small local
primitives (`Stage`, `Pill`, `Path`, `EvidenceRail`, `PersistentSpine`, and
`ArchiveFrame`). It consumes the existing scene and asset contracts, is deterministic
from Remotion frame state, and remains compatible with the frozen Remotion 4.0.492
runtime.

This component is project-specific rather than promoted as a general production
template. Promotion would require at least two independent fixtures and is outside
this task.
