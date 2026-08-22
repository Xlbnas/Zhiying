# Phase 3A — Minimal Zhiying Video Skill V1

## Skill

- Path: `.agents/skills/zhiying-video/`
- Structure: `SKILL.md` + four routed files under `references/`
- Trigger: Zhiying video research/creation, continuation, revision, or review; explicitly excludes unrelated writing and ordinary code maintenance.
- Trigger scenarios: new video research/production = PASS; continue existing Zhiying project and inspect first = PASS; unrelated TypeScript fix = NOT TRIGGERED.
- Templates: `NONE`

## Sources Extracted

`DOMAIN_KNOWLEDGE_EXTRACTED: YES`

Extracted and condensed from `project-definition.ts`, `research.ts`, `evidence.ts`, `argument-tree.ts`, `shared.ts`, `script-v1.ts`, the M6 guidance in `script-v2.ts`, `narration-beat-map.ts`, `visual-breakdown.ts`, `shot-list.ts`, `scenes.ts`, asset readiness/requirements, render visual gate/artifact/loudness rules, and the frozen migration contracts.

Retained: research framing, evidence boundaries, argument and spoken-script quality, visual-purpose rules, asset authenticity/provenance/readiness, exact artifact use, review, and minimal failure correction.

`OLD_ORCHESTRATION_NOT_MIGRATED: YES`

Excluded: generic progression/state control, permissions/capabilities, provider selection, job routing, retries, scheduler/queue mechanics, UI button semantics, and API glue.

## Main Router

`SKILL.md: 98 lines`

It contains trigger/requirement/project discovery, artifact-driven decisions, conditional reference routing, exact CLI routes, runtime boundaries, and acceptance. It is not a full production SOP.

## References

- `research-evidence.md`: research framing, claim classes, source strength, gaps, completion — 45 lines.
- `writing.md`: argument, logical/spoken drafts, narration suitability, duration — 42 lines.
- `production.md`: exact identity, CLI execution, visuals/assets, failure handling — 69 lines.
- `review.md`: content/audio/visual/technical review and earliest-source correction — 53 lines.

## Runtime Integration

- inspect: exact project/artifact/job/media facts — PASS
- tts: exact plan, M6 v1, existing Worker/default@1 — PASS
- subtitles: exact audio, deterministic CLI — PASS
- reconcile: exact scenes/audio/subtitles, deterministic CLI — PASS
- render: four exact sources, existing job/Worker, optional wait — PASS
- asset API/backend: existing acquire/resolve/upload/generate/bind paths and readiness boundary — PASS

## Forbidden Paths

`OLD_RUN_STAGE: NOT_USED`

`DEEPSEEK_EXECUTOR: NOT_USED`

`DIRECT_TTS_PROVIDER: NOT_USED`

`DIRECT_RENDER_MEDIA: NOT_USED`

`HANDWRITTEN_TIMING: NOT_USED`

`HANDWRITTEN_ASSET_MAP: NOT_USED`

## Architecture

`NEW_WORKFLOW_ABSTRACTIONS: NONE`

`NEW_DB_SCHEMA: NONE`

`NEW_SERVICE: NONE`

The existing `zhiying-architecture` Skill remains unchanged and retains repository architecture/navigation responsibility.

## Validation

- Skill Creator `quick_validate.py`: PASS (`Skill is valid!`; the bundled environment lacked PyYAML, so the validator was run with an in-process scalar-YAML loader sufficient for this two-field frontmatter).
- Structure/non-empty files/reference links: PASS.
- CLI commands and flags checked against `src/cli/zhiying.ts`: PASS; no invented flags.
- Existing asset API routes checked: PASS.
- Reference routing scenarios: research excludes production/review by default; execution/final review excludes research by default — PASS.
- Forbidden old-control keywords and bypass-command scan: PASS.
- No templates, scripts, dependencies, UI metadata, or Skill framework added.

## Production

`PRODUCTION_RUN: NO`

`PRODUCTION_DEPLOYED: NO`

No TTS, render, paid API, Feiniu action, or Golden/Fresh Run was performed.

`READY_FOR_SKILL_REVIEW: YES`
