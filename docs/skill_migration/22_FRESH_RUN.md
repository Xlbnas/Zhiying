# Zhiying → Codex Skill Migration
# Phase 5A — Fresh End-to-End Production Run

Run date: 2026-08-25 (Asia/Shanghai)

## Verdict

VERDICT: `PARTIAL`

The run created one genuinely new production project, completed source-backed
research and accepted content, built a clean 25-unit narration plan, and
performed 25 new IndexTTS2 syntheses with the explicitly selected
`xlbnas@1` identity. All 25 jobs succeeded on attempt 1.

The run stopped at the exact-audio provenance gate. The new CLI wrote the
frozen reference SHA into every TTS job payload, but the still-deployed
production Worker (`8e92ba58a28900509e542394858200b1731d7afd`) did not carry
that optional field into `result_json.settings`. The frozen runner
`zhiying-cli-runner:4ca2e72` correctly refused to finalize a narration master
whose result snapshot lacks the exact reference SHA. No weaker manifest was
created, no DB row was patched, and subtitles/scenes/render were not started.

TECHNICAL_FRESH_RUN: `FAIL`

READY_FOR_FRESH_VISUAL_REVIEW: `NO`

## Requirement

TOPIC: `《刻意回避：日常生活的心理分析》——重新审视弗洛伊德的日常失误解释`

CORE_QUESTION: `口误、遗忘、拿错东西这些日常失误，真的都是潜意识在泄密吗？一百多年后，我们应该如何重新评价弗洛伊德关于日常失误的解释？`

AUDIENCE: `对心理学/人文话题感兴趣、无需心理学专业背景的普通观众`

TARGET_DURATION: `约 3–5 分钟`

LANGUAGE: `中文 / 普通话`

CLARIFICATION_COUNT: `0`

## Research

RESEARCH: `PASS`

EVIDENCE: `PASS`

RESEARCH_SOURCE_COUNT: `15`

The research distinguished `FREUD CLAIMED`, `MODERN EVIDENCE SUGGESTS`, and
`INTERPRETATION`. The accepted source map includes:

1. Sigmund Freud, *The Psychopathology of Everyday Life*, Project Gutenberg
   #67332 (primary text).
2. Freud Edition record for *Zur Psychopathologie des Alltagslebens* (1901).
3. Library of Congress, *Freud: Conflict & Culture* manuscript exhibit.
4. British Journal of Psychiatry, “The Psychopathology of Everyday Life,
   Sigmund Freud” (2017).
5. York University, Classics in the History of Psychology.
6. Dell (1986), spreading activation in sentence production,
   DOI `10.1037/0033-295X.93.3.283`.
7. Nozari, Dell & Schwartz (2011), conflict-based speech monitoring,
   PMCID `PMC3135428`.
8. Norman (1981), categorization of action slips,
   DOI `10.1037/0033-295X.88.1.1`.
9. Matos et al. (2020), systematic review of cognitive load and prospective
   memory, PMID `33149797`.
10. Modern tip-of-the-tongue review, PMCID `PMC8136240`.
11. “Unconscious knowledge: A survey”, PMCID `PMC3101524`.
12. Motley & Baars (1979), context and induced verbal slips,
    DOI `10.1044/jshr.2203.421`.
13. Bröder & Bredenkamp (1996), non-confirming replication/unconscious priming
    result, PMID `9005024`.
14. Rycroft (1979), Timpanaro and alternative explanations of slips.
15. Grünbaum (1986), evidential limits of psychoanalytic clinical data.

Research completion reason: Freud's claim and self-limitation, historical
importance, language/memory/action alternatives, limited supportive evidence,
replication limits, and post-hoc/alternative-explanation criticism were all
adequately sourced. No remaining gap could change the core direction.

## Writing

SCRIPT: `PASS`

CONTENT_FACTUAL_SUPPORT: `PASS`

ARGUMENT_LOGIC: `PASS`

SPOKEN_READABILITY: `PASS`

CONTAMINATION_CHECK: `PASS`

Accepted argument:

> Daily errors can sometimes be influenced by associations, motives, and
> context outside current awareness. Modern cognitive mechanisms also explain
> many errors without hidden wishes. A single slip cannot establish repressed
> content.

Accepted Script V2 contains four chapters and approximately 1,131 speakable
Chinese characters. The deterministic M6 compiler produced 25 speech units.
Every speech unit was scanned by the existing directive-leakage detector and
an explicit forbidden-token check. None contained end markers, narrator
labels, internal/editor/scene instructions, prompt residue, or control DSL.

## Project

FRESH_PROJECT_ID: `3778ffb0-c430-4499-9f7f-2590f45cb8cb`

PROJECT_TITLE: `你真的只是“口误”了吗？重新审视弗洛伊德的日常生活心理分析`

PIPELINE_VERSION: `m6`

Created through existing business contracts only:

- `createProjectWithWorkflow`
- `generateVersion`
- `lockStage`
- `buildNarrationPlan`

The following new `project_versions@1` are locked:

- `project_definition`
- `research`
- `evidence`
- `argument_tree`
- `script_v1`
- `script_v2`

No Golden project row or artifact was read as a source or copied.

## Narration plan

NARRATION_PLAN: `1b97e9ba-447c-4d7c-ac1e-4752cec8af28@1`

NARRATION_PLAN_SCHEMA: `narration-plan@1.0`

NARRATION_COMPILER: `1.2`

SPEECH_UNITS: `25`

## Voice / TTS

VOICE: `xlbnas@1`

VOICE_PROFILE: `xlbnas`

VOICE_REVISION: `1`

VOICE_REFERENCE_SHA: `42a32a1fc12b12752e1f2f6050108f458cd47c240208c353a7dd9a7d4fd7a999`

RUNNER_IMAGE: `zhiying-cli-runner:4ca2e72`

RUNNER_IMAGE_ID: `sha256:9365137385a8844c5812bab3b00250d23165a71637b5e345b039adc11f7693f3`

PRODUCTION_WORKER_RELEASE: `8e92ba58a28900509e542394858200b1731d7afd`

TTS: `FAIL`

TTS_JOBS: `25`

NEW_SYNTHESIS: `25`

TTS_RETRIES: `0`

SUCCEEDED_JOBS: `25`

AUDIO_ARTIFACT: `NONE`

MASTER_WAV: `NONE`

The unit-level production facts are internally consistent:

- all 25 jobs have `status=succeeded` and `attempt=1`;
- all have `voice_profile_id=xlbnas`, `voice_profile_revision=1`;
- all 25 payloads contain the exact frozen `referenceAudioSha256`;
- all 25 physical unit WAV files exist with duration and SHA metadata;
- none fell back to `default@1` or another revision.

### Blocking mismatch

Every one of the 25 succeeded rows has:

```text
payload_json.referenceAudioSha256 =
42a32a1fc12b12752e1f2f6050108f458cd47c240208c353a7dd9a7d4fd7a999

result_json.settings =
{ voiceProfileId: "xlbnas", voiceProfileRevision: "1", useRandom: false }
```

The required `result_json.settings.referenceSha256` is absent in all 25 rows.
`tryFinalizeNarrationAudio(... referenceSha256=<frozen SHA>)` therefore returned
`null`, and no `narration_audio` artifact was inserted.

This is a runner/production-Worker compatibility gap discovered by the first
real new-voice synthesis. The earlier local/runner voice-selection tests did
not establish that the old deployed Worker would emit the new optional result
field.

### Transport event

The first waiting SSH session disconnected after all 25 jobs succeeded but
before master finalization. A same-source CLI continuation created zero new
jobs and reused the same succeeded rows. Source review confirmed the master
finalizer has unique temporary files and transactional winner/reuse behavior.
Both waiting commands eventually timed out because audio could never satisfy
the missing-result-provenance gate. This did not cause a Worker retry or a
second synthesis.

### Minimal repair boundary

Do not patch the 25 result rows, omit the reference SHA, or finalize a weaker
manifest. A separate compatibility change must establish how an old Worker
result can be accepted only when all of the following exact facts agree:

1. job voice identity is `xlbnas@1`;
2. immutable job payload carries the frozen reference SHA;
3. current registry entry and physical reference file match that SHA;
4. succeeded audio/result metadata and physical media pass existing integrity
   checks;
5. the resulting manifest records the exact reference SHA.

Alternatively, a reviewed deployment of the voice-aware Worker plus a new
source/job contract would need separate authorization. Neither option belongs
inside this frozen Fresh Run.

## Subtitle

SUBTITLES: `FAIL`

SUBTITLE_ARTIFACT: `NONE`

Reason: exact ready narration audio does not exist. Subtitle timing was not
started and no timestamps were hand-authored.

## Visual

SCENES: `FAIL`

SCENES_ID: `NONE`

REMOTION_SKILLS_USED: `NONE`

REMOTION_RUNTIME: `4.0.492`

ASSETS_READY: `NO`

ASSET_COUNT: `0`

PAID_IMAGE_GENERATION_COUNT: `0`

Visual production did not start because the exact audio and subtitle sources
were not ready. No Remotion API was selected, no runtime version changed, and
no historical or generated asset was acquired.

## Reconciliation

RECONCILIATION: `FAIL`

RECONCILIATION_ARTIFACT: `NONE`

Reason: exact scenes, audio, and subtitle sources do not exist.

## Render

RENDER: `FAIL`

RENDER_ATTEMPTS: `0`

RENDER_JOB: `NONE`

## Output

MP4: `NONE`

SHA256: `NONE`

DURATION: `NONE`

FRAMES: `NONE`

FPS: `NONE`

CODEC: `NONE`

AUDIO: `NONE`

ENCODER: `NONE`

VISUAL_GATE: `FAIL`

LOUDNESS: `FAIL`

## Agent Native

ARTIFACT_DRIVEN: `YES`

OLD_RUN_STAGE_CALLS: `0`

DEEPSEEK_STAGE_EXECUTOR_CALLS: `0`

WORKFLOW_UI_ACTIONS: `0`

WHOLE_PIPELINE_RETRIES: `0`

TTS_CLI_FINALIZE_CONTINUATIONS: `1`

MISSING_AGENT_NATIVE_ENTRYPOINT: `NONE`

CONTEXT_BLOAT_OBSERVED: `NO`

The content path used existing business functions directly in the frozen
runner. No `llm_jobs`, `generation_runs`, or old workflow stage executor was
used. Decisions followed exact project versions, narration plan identity, job
rows, media facts, and readiness.

## Review

CONTENT_REVIEW: `PASS`

AUDIO_REVIEW: `FAIL`

SUBTITLE_REVIEW: `FAIL`

TECHNICAL_REVIEW: `FAIL`

VISUAL_REVIEW_PACKAGE: `NONE`

No final visual verdict was attempted.

## Mutation accounting

| Object | Before | After | Delta |
|---|---:|---:|---:|
| projects | 3 | 4 | +1 |
| project_versions | 46 | 52 | +6 |
| artifacts | 59 | 60 | +1 narration plan |
| tts_jobs | 351 | 376 | +25 |
| render_jobs | 15 | 15 | 0 |
| llm_jobs | 50 | 50 | 0 |
| asset_generation_jobs | 1 | 1 | 0 |

No DB schema change, service replacement, service restart, Remotion upgrade,
Golden mutation, default voice mutation, subtitle artifact, scenes artifact,
asset row, reconciliation artifact, render job, or MP4 was created.

## Final Return

VERDICT: `PARTIAL`

TOPIC: `《刻意回避：日常生活的心理分析》`

FRESH_PROJECT_ID: `3778ffb0-c430-4499-9f7f-2590f45cb8cb`

RESEARCH: `PASS`

EVIDENCE: `PASS`

SCRIPT: `PASS`

CONTENT_REVIEW: `PASS`

CONTAMINATION_CHECK: `PASS`

VOICE: `xlbnas@1`

TTS: `FAIL`

NEW_SYNTHESIS: `25`

TTS_RETRIES: `0`

SUBTITLES: `FAIL`

SCENES: `FAIL`

REMOTION_SKILLS_USED: `NONE`

ASSETS_READY: `NO`

PAID_IMAGE_GENERATION_COUNT: `0`

RECONCILIATION: `FAIL`

RENDER: `FAIL`

RENDER_JOB: `NONE`

TECHNICAL_FRESH_RUN: `FAIL`

OLD_RUN_STAGE_CALLS: `0`

DEEPSEEK_STAGE_EXECUTOR_CALLS: `0`

WORKFLOW_UI_ACTIONS: `0`

MISSING_AGENT_NATIVE_ENTRYPOINT: `NONE`

WHOLE_PIPELINE_RETRIES: `0`

CONTEXT_BLOAT_OBSERVED: `NO`

VISUAL_REVIEW_PACKAGE: `NONE`

READY_FOR_FRESH_VISUAL_REVIEW: `NO`

REPORT: `docs/skill_migration/22_FRESH_RUN.md`

---

## Continuation — exact-source migration gaps (2026-08-25)

The initial partial verdict above is retained as the historical Fresh Run
checkpoint. The same project then continued without creating another project
and without synthesizing any additional TTS.

### Migration timeline

```text
Fresh start
  -> TTS provenance version skew
  -> fixed by the minimal Worker provenance deployment
  -> 25/25 fresh xlbnas@1 jobs provenance-valid and master finalized
  -> subtitles exact-audio entrypoint gap
  -> fixed at 2711465c51dd8075b26d962bd0e2a4c824b3cdb1
  -> scenes/assets completed (25 scenes, readiness 25/25, assets 3/3)
  -> reconciliation exact-source entrypoint gap
  -> fixed at 45882c006fb28b95fb39bb1c31694348a896c672
  -> exact reconciliation created
  -> render exact-source entrypoint gap
  -> stopped before enqueue
```

The two `MISSING_AGENT_NATIVE_ENTRYPOINT` findings were not bypassed: subtitles
and reconciliation each had a CLI boundary that accepted exact identities but
an internal builder that silently resolved current/default sources.

### Exact reconciliation repair

RECONCILIATION_AUDIT: `SAFE_MINIMAL_EXACT_SOURCE_FIX`

ROOT_CAUSE: the reconciliation CLI validated only audio/subtitle row ownership
and version (and did not validate the scenes row), then
`buildTimingReconciliation()` always called the three legacy current-source
resolvers. The explicit `xlbnas@1` chain was therefore replaced by current
state before compilation.

The minimal repair adds exact scenes and subtitle readers, reuses the existing
exact narration-audio validator, passes the same verified objects to the
builder, and keeps the legacy current-source branch for existing callers. The
explicit CLI response is derived from the exact build result and does not call
current readiness afterward.

SILENT_CURRENT_RESOLUTION_AUDIO: `0`

SILENT_CURRENT_RESOLUTION_SUBTITLES: `0`

SILENT_CURRENT_RESOLUTION_SCENES: `0`

SCHEMA_CHANGE: `NO`

Runner deployment:

- commit: `45882c006fb28b95fb39bb1c31694348a896c672`
- image: `zhiying-cli-runner:45882c0`
- image ID: `sha256:9b8362e223a51431f17cfaaa29bc8f17224dd3731e53c179cefbd657d78e77c8`
- build source: exact `git archive` of the commit, stored at
  `/vol1/1000/docker/zhiying-cli-runner/45882c0`
- production checkout/services replaced: `NO`
- production service restarts: `0`
- build tunnel after build: `STOPPED`

Verification:

- CLI V1: `53 PASS, 0 FAIL`
- Subtitle Timing: `82 PASS, 0 FAIL`
- Subtitle Compiler V2: `15 PASS, 0 FAIL`
- Artifact/exact-job: `32 PASS, 0 FAIL`
- typecheck: `PASS`
- production build: `PASS`
- scoped `git diff --check`: `PASS`
- M3-D compiler assertions passed through `44b`; its existing high-level mock
  fixture stopped before reconciliation because its TTS helper does not release
  the `production_gpu` lease and audio finalization returned null. This unrelated
  historical fixture was not modified in this narrowly scoped repair.

### Fresh exact reconciliation

PROJECT: `3778ffb0-c430-4499-9f7f-2590f45cb8cb`

RECONCILIATION: `PASS`

RECONCILIATION_ARTIFACT: `4cd2ad1a-eebb-4191-b197-7e91d5da3da0@1`

SOURCE_SCENES: `71d22000-e038-4c54-83ad-616ed51b9e7e@2`

SOURCE_AUDIO: `bd6600e8-1f6b-4a61-9ad1-3227e764ec2c@1`

SOURCE_SUBTITLES: `1db0fb06-1176-4fd5-aee1-f7e55671dbec@1`

MASTER_SHA256: `71e3e97d4bc156947d1293ebc0df5dfb3b260384bbc42522619e0ee6056ab3fe`

MASTER_DURATION: `241.168s`

SCENE_COUNT: `25`

TARGET_FRAMES: `7235`

UNRESOLVED_NARRATION_UNITS: `0`

VISUAL_READINESS: `PASS (3/3 required assets, 0 missing)`

The post-write snapshot remained `tts_jobs=50`, `llm_jobs=0`, and
`render_jobs=0` for this Fresh project. This continuation created one
reconciliation artifact and no TTS, LLM, or render job.

### Render exact-source audit

RENDER_EXACT_SOURCE_AUDIT: `MISSING_AGENT_NATIVE_ENTRYPOINT`

The render CLI accepts `--scenes`, `--audio`, `--subtitles`, and
`--reconciliation`, but it only checks artifact row identity for three artifact
arguments and does not validate the scenes row. `enqueueFinalRender()` then
calls `readFinalSources()`, which resolves current locked scenes, current
narration audio, current subtitle timing, and current timing reconciliation.
This is the same boundary-leak class found in the previous two stages.

No render command was executed and no render job/source/attempt was created.

VERDICT: `MISSING_AGENT_NATIVE_ENTRYPOINT`

TECHNICAL_FRESH_RUN: `PARTIAL`

READY_FOR_FRESH_VISUAL_REVIEW: `NO`

NEXT_STEP: `FIX_RENDER_EXACT_ENTRYPOINT`

Guards for this continuation:

- `OLD_RUN_STAGE_CALLS=0`
- `DEEPSEEK_STAGE_EXECUTOR_CALLS=0`
- `WORKFLOW_UI_ACTIONS=0`
- `NEW_TTS_JOBS=0`
- `TTS_RETRIES=0`
- `LLM_JOBS=0`
- `RENDER_JOBS=0`
- `SCHEMA_CHANGE=NO`
- `REMOTION_VERSION=4.0.492`
