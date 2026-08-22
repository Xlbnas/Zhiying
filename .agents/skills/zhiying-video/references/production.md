# Production

Use this reference when producing audio, subtitles, reconciliation, assets, or a final render. The CLI and existing asset backend are execution authorities; this file does not replace their schemas or algorithms.

## Preconditions and identity

Before a derived operation, run `pnpm zhiying inspect --project <projectId>` and use the exact current identities it returns. Content should be stable enough that the cost of invalidating its derived results is acceptable. Never request or consume an unspecified latest artifact.

After every command, carry forward only the exact identity returned in its JSON result. If inspect shows that a source changed, discard the stale derived identity and regenerate only what depends on that source.

## TTS

Use M6 v1 through:

```bash
pnpm zhiying tts --project <projectId> --plan <planArtifactId>@<version> --wait
```

The existing Worker and fixed `default@1` voice are authoritative. Before TTS, ensure the narration is factually accepted, speakable, free of visual-only instructions, and intentionally punctuated. Do not choose another voice flag or call the provider directly.

## Subtitles and reconciliation

Build subtitles from exact current audio:

```bash
pnpm zhiying subtitles --project <projectId> --audio <audioArtifactId>@<version>
```

Build reconciliation from exact current scenes, audio, and subtitles:

```bash
pnpm zhiying reconcile --project <projectId> --scenes <scenesVersionId>@<version> --audio <audioArtifactId>@<version> --subtitles <subtitleArtifactId>@<version>
```

These commands own exact cue timing and frame reconciliation. Editorial judgment may identify a mismatch, but must not replace their calculations.

## Visual and asset strategy

Choose visuals by explanatory purpose rather than sentence count:

- Reality B-roll establishes context.
- Archive supports historical reality and should use authentic material.
- Motion graphics explain abstract relationships; use fast change followed by a readable hold.
- Minimal scenes create emphasis, boundaries, or breathing room.
- Editorial graphics present key text or data without becoming a card stack.

Avoid one-image-per-sentence cutting, consecutive identical layouts, long runs of pure motion graphics, generic dashboards, decorative HUDs, and visual styles unrelated to the project's audience and subject.

Use the existing asset backend only:

- acquire/resolve: `GET/POST /api/projects/:id/assets` and `POST /api/projects/:id/assets/resolve`;
- upload and bind: `POST /api/projects/:id/assets/upload`;
- generated candidate: `GET/POST /api/projects/:id/assets/generate`, then `POST /api/projects/:id/assets/generated/:candidateId/bind`.

For every real-material requirement, preserve exact scene/requirement binding, provenance, usable license, and physical-file readiness. Historical people, events, documents, artifacts, and places that require authenticity must not be replaced by AI imagery presented as archive. Generated or synthetic imagery is acceptable only where the requirement permits it and must remain identifiable by provenance. Never fabricate asset IDs or construct `assetMap`.

## Render

Render only after inspect confirms exact scenes/audio/subtitles/reconciliation and asset readiness:

```bash
pnpm zhiying render --project <projectId> --scenes <scenesVersionId>@<version> --audio <audioArtifactId>@<version> --subtitles <subtitleArtifactId>@<version> --reconciliation <reconciliationArtifactId>@<version> --wait
```

The existing render job and Worker own props construction, Remotion, media production, retries, and terminal status. Do not replace this path with custom rendering.

## Failure handling

On non-zero CLI output, read the structured error and inspect again. Do not switch to another artifact/job, edit DB state, ignore readiness, or repeatedly retry without identifying a transient cause. Missing assets require acquisition or binding; source mismatch requires fresh exact identities; invalid narration requires content correction; terminal job failure requires diagnosis. Stop when authority, source material, credentials, or a human content decision is required.
