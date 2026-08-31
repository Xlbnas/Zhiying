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

The existing Worker, exact narration plan, and explicitly selected voice identity are authoritative. Before TTS, ensure the narration is factually accepted, speakable, free of visual-only instructions, and intentionally punctuated. Do not call the provider directly.

Use restrained delivery variation according to rhetorical function. A hook, historical explanation, mechanism, counterargument, and conclusion may need different emphasis, but do not mechanically rotate delivery labels merely to create variety. Representative listening and user audio judgment outrank metadata-only judgments.

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

The default deliverable is a clean master plus sidecars derived from the exact subtitle artifact. Export SRT, VTT, ASS, and canonical JSON with the explicit subtitle identity; use `--subtitle-mode none` for the clean master. A burned-subtitle render is a review or publishing profile, not the canonical timing authority and not a substitute for sidecars.

```bash
pnpm zhiying subtitles --project <projectId> --artifact <subtitleArtifactId>@<version> --export-dir <outputDir>
```

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

For factual or historical material, prefer traceable primary material or reliable archives. An archive asset must support the argument, chronology, or evidence rather than act as decorative atmosphere. Label AI reconstruction explicitly and never present it as historical evidence.

For a general Chinese audience, prefer clear Chinese on-screen language. Remove unnecessary English, internal state-machine wording, debug UI, and prompt-like copy. Translate specialist terms into language the viewer can understand without the subtitle track.

## Semantic motion and visual pacing

A visible motion needs an actor, source, target, reason, and visible result. If its explanatory role cannot be stated, prefer a stable composition.

Per-beat progress may animate only the object or action introduced by that beat. State completed earlier in the same scene must remain complete in later beats unless the narration explicitly describes a reversal. At each same-scene beat boundary, inspect object re-entry, path retraction, position reset, camera reset, and repeated reveal.

A subtitle cue boundary is not automatically a visual cut point. Use acoustic pauses, semantic completion, and object handoff to decide when a visual change is justified. Continuous speech must not trigger an unexplained full-composition reset.

## Render

Render only after inspect confirms exact scenes/audio/subtitles/reconciliation and asset readiness:

```bash
pnpm zhiying render --project <projectId> --scenes <scenesVersionId>@<version> --audio <audioArtifactId>@<version> --subtitles <subtitleArtifactId>@<version> --reconciliation <reconciliationArtifactId>@<version> --subtitle-mode none --wait
```

The existing render job and Worker own props construction, Remotion, media production, retries, and terminal status. Do not replace this path with custom rendering.

## Failure handling

On non-zero CLI output, read the structured error and inspect again. Do not switch to another artifact/job, edit DB state, ignore readiness, or repeatedly retry without identifying a transient cause. Missing assets require acquisition or binding; source mismatch requires fresh exact identities; invalid narration requires content correction; terminal job failure requires diagnosis. Stop when authority, source material, credentials, or a human content decision is required.
