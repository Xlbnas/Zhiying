---
name: zhiying-video
description: Research, create, continue, revise, or review a Zhiying knowledge-video project from a user idea through final acceptance. Use for Zhiying video production work; do not trigger for unrelated writing or ordinary code maintenance merely because the repository is Zhiying.
---

# Zhiying Video

Turn a video idea or an existing Zhiying project into a reliable final video by combining editorial judgment with the repository's deterministic execution layer.

## Requirement gate

For a new complex video, establish enough of the following to make the next decision safely:

- topic and researchable core question;
- intended audience and intended takeaway;
- target duration, language, and platform when relevant;
- key position without assuming the conclusion is already proven;
- mandatory sources, content boundaries, and exclusions;
- style requirements and observable completion criteria.

Investigate facts available from the repository or supplied materials before asking. Ask only for unknowns that would change the content direction or acceptance result. Do not mechanically interrogate the user for a small, local revision.

## Discover project facts

When a project already exists, inspect it before deciding what to do:

```bash
pnpm zhiying inspect --project <projectId>
```

Add `--artifact <artifactId>@<version>`, `--job <jobId>`, or `--media` only when that exact object or media validation is needed. Treat the returned project identity, accepted/locked content, exact source identities, readiness, jobs, and media facts as authoritative. Do not infer current state from chat history or choose an action merely from a generic status label.

## Decide from artifacts

Use real artifacts, their exact source identities, and readiness to select the smallest necessary action:

- If claims or the script are unreliable, return to the content or evidence problem that caused it.
- If a current narration plan exists but its audio does not, use TTS with that exact plan identity.
- If current audio is ready and subtitle timing is absent or stale, rebuild subtitles from that exact audio.
- Reconcile only the exact current scenes, audio, and subtitles.
- Render only when the four exact sources and visual readiness are satisfied.
- If a source changes, stop consuming derived artifacts that refer to the old source.
- If readiness fails, resolve the named missing source, binding, asset, or visual input instead of bypassing the gate.

These are causal dependencies, not a fixed workflow state machine. Preserve valid upstream work and redo only what the changed or faulty source invalidates.

## Route references on demand

Read only what the current request needs:

- Research, source assessment, factual claims, or evidence gaps: [references/research-evidence.md](references/research-evidence.md)
- Argument, script, narration text, or duration editing: [references/writing.md](references/writing.md)
- TTS, subtitles, reconciliation, assets, or render execution: [references/production.md](references/production.md)
- Content, audiovisual, technical review, or failure correction: [references/review.md](references/review.md)

Do not load production/review guidance for a research-only request. Do not reload research guidance for an execution-only render or final technical review unless a content-source problem is actually found.

## Use the deterministic execution layer

Run commands from the Zhiying repository. Always copy exact identities from a fresh inspect result or from the exact result returned by the preceding operation.

```bash
pnpm zhiying tts --project <projectId> --plan <planArtifactId>@<version> [--wait]

pnpm zhiying subtitles --project <projectId> --audio <audioArtifactId>@<version>

pnpm zhiying reconcile --project <projectId> \
  --scenes <scenesVersionId>@<version> \
  --audio <audioArtifactId>@<version> \
  --subtitles <subtitleArtifactId>@<version>

pnpm zhiying render --project <projectId> \
  --scenes <scenesVersionId>@<version> \
  --audio <audioArtifactId>@<version> \
  --subtitles <subtitleArtifactId>@<version> \
  --reconciliation <reconciliationArtifactId>@<version> [--wait]
```

Do not invent flags or substitute "latest" identities. A non-zero result is a failure to diagnose, not permission to switch sources, select another successful job, edit the database, or weaken a gate.

## Runtime boundary

- Artifact truth is DB-backed exact identity.
- TTS is M6 v1 through the existing jobs and Worker, using the fixed `default@1` voice; do not call the TTS provider yourself.
- Subtitle timing and frame reconciliation belong to their deterministic CLI commands; do not calculate or hand-author them.
- Final rendering belongs to the existing render job and Worker path; do not call Remotion, `renderMedia`, or FFmpeg as an alternative execution path.
- Assets use the existing asset API/backend with provenance, exact requirement binding, license, physical-file, and readiness checks. Do not construct `assetMap` yourself or treat a placeholder as ready.

## Acceptance

Before accepting a final result:

1. Inspect the exact returned render job with media facts.
2. Confirm its manifest/file/hash, probe data, source references, and visual readiness are valid.
3. Apply the relevant content and audiovisual checks from the review reference.
4. If review fails, locate the earliest faulty source and correct only the necessary portion.

- Different template filenames do not by themselves prove visual diversity; review rendered visual families, information density, and template repetition in actual frames.
- Audio review includes prosody variation, not only file validity and voice identity.

Do not perform production deployment or other external publication unless the user explicitly requests and authorizes it.
