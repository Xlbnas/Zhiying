# V2 Visual R2 — exact-source integration

## Frozen parents

- Project: `3778ffb0-c430-4499-9f7f-2590f45cb8cb`
- Script V2: `046bb456-ec8c-431e-b117-186bb63953ab@3`
- Narration plan V2: `76d3da1e-09dd-4af7-acc2-6116f3c3f4bb@2`
- Narration audio V2: `ff7ef85f-bf59-4814-ba9a-6306e56e8cb6@1`
- Subtitle timing V2: `68a8a73c-7863-4fa6-a89f-d9965f66c92f@1`
- Master duration: `243.560s`
- Master SHA-256: `801fadc172e7e5f20ff34337a44d889985fdec04f8609228897239f77c877c2a`

## Minimal implementation

The existing `visuals` CLI now accepts the optional explicit identity
`--choreography v2-visual-r2@1`. The builder validates that exact identity, embeds
the deterministic R2 marker and beat IDs in existing scene `templateProps`, and
persists the choreography identity in the existing `visual_source_v2` JSON. No DB
table, column, workflow state, Worker architecture, or scene container schema was
added.

Legacy callers that omit `--choreography` retain the prior visual-source behavior.
Unsupported choreography IDs or versions fail closed with `CHOREOGRAPHY_INVALID`.
Exact artifact revalidation reconstructs the same marked scenes and visual-family
set from the exact stored parent identities.

The visual builder's descending-version query is used only to find an idempotent
artifact whose fully recomputed JSON equals the requested exact chain. It does not
resolve any parent to current/latest/default. All four parent identities are
required inputs and are validated through the existing exact-source readers.

## Renderer path

`ProductionSceneRenderer` selects `V2VisualR2Scene` only when the exact marker is
present. Legacy scenes continue through the existing template routing. `FullCutV1`
suppresses the redundant legacy chapter label and whole-frame crossfade only for
R2-marked adjacent scenes, preserving continuous actors across boundaries.

## Production boundary

The new CLI/renderer code is local only. Creating the authoritative
`V2_VISUAL_R2` artifact and rendering it on production requires deploying the
runner/Worker code first. The task explicitly forbids Web/Worker/production-service
deployment without separate authorization, so no production write, reconciliation,
or render job was performed.
