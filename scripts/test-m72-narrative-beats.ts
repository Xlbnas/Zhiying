/**
 * M7.2 Narrative Beats 测试（临时 DB + Scriptable Mock Provider，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m72-narrative-beats.ts
 * 覆盖：schema、coverage validator、input isolation、LLM/repair、idempotency、
 * candidate 生命周期、M7.1.1 active getter frozen-ruleset regression、API routes。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m72-beats');
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion, editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import {LLMError, type LLMProvider, type LLMRequest, type LLMResponse} from '../src/lib/llm/types';
import {buildNarrationPlanV2, getCurrentNarrationPlanV2} from '../src/lib/narration/plan-v2';
import type {NarrationPlanV2} from '../src/lib/narration/schema-v2';
import {
  buildNarrativeBeats,
  classifyNarrativeBeatsCandidate,
  getNarrativeBeatsArtifact,
  listNarrativeBeatsCandidates,
  NarrativeBeatsError,
} from '../src/lib/narrative-beats/plan';
import {
  NARRATIVE_BEATS_KIND,
  narrativeBeatsArtifactV1Schema,
  narrativeBeatsProposalSchema,
  type NarrativeBeatV1,
} from '../src/lib/narrative-beats/schema';
import {validateNarrativeBeatsCoverage} from '../src/lib/narrative-beats/validate';
import {
  computeSnapshotProvenanceHash,
  M7_ACTIVATION_RULESET_V1,
  M7_PIPELINE_SNAPSHOT_KIND,
  M7_PIPELINE_SNAPSHOT_SCHEMA_VERSION,
  type M7PipelineSnapshotArtifacts,
} from '../src/lib/m7-pipeline-snapshot';
import {
  activateM7Pipeline,
  getM7PipelineSnapshotId,
  getPipelineVersion,
  PipelineVersionError,
  switchPipelineToM7,
} from '../src/lib/pipeline-version';
import {GET as beatsGET, POST as beatsPOST} from '../src/app/api/projects/[id]/narrative-beats/route';
import {GET as beatsDetailGET} from '../src/app/api/projects/[id]/narrative-beats/[artifactId]/route';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail)?.slice(0, 400));
  }
}

async function expectBeatsError(code: string, fn: () => unknown, label: string): Promise<void> {
  try {
    await fn();
    ok(false, label, '意外成功（应抛错）');
  } catch (err) {
    ok(
      err instanceof NarrativeBeatsError && err.code === code,
      label,
      err instanceof Error ? `${err.name}: ${(err as {code?: string}).code ?? err.message}` : err,
    );
  }
}

// ── Scriptable Mock Provider（测试专用，确定性故障注入） ──
class ScriptableProvider implements LLMProvider {
  readonly name = 'scriptable-mock';
  readonly requests: LLMRequest[] = [];
  private queue: Array<{text?: string; finishReason?: string; error?: LLMError}> = [];

  push(resp: {text?: string; finishReason?: string; error?: LLMError}): void {
    this.queue.push(resp);
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (!next) return Promise.reject(new Error('scriptable provider: 无预置响应'));
    if (next.error) return Promise.reject(next.error);
    return Promise.resolve({
      text: next.text ?? '',
      requestId: `scr-${this.requests.length}`,
      model: request.model,
      finishReason: next.finishReason ?? 'stop',
      usage: {promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, completionTokens: 50},
    });
  }
}

const UPSTREAM: WorkflowStage[] = [
  'project_definition',
  'research',
  'evidence',
  'argument_tree',
  'script_v1',
];

/** strict DSL：2 章、6 units（4 speech + 2 silence，含 pause 与 visual_breath）。 */
const STRICT_MD = `# Script V2

## 第 1 章 开场（00:00–01:00）

第一句。第二句。

@silence 500ms reason=pause

第三句。

## 第 2 章 展开（01:00–02:00）

第四句。第五句。

@silence 800ms reason=visual_breath

第六句。
`;

const REVIEW_MD = `# Script V2

## 第 1 章 T（00:00–01:00）

（停顿）第一句。
`;

function newProjectWithScript(content: string, promptVersion: string): string {
  const projectId = createProjectWithWorkflow({topic: 'm72', coreQuestion: 'q'}).project.id;
  for (const stage of UPSTREAM) {
    generateVersion({projectId, stage, content: `# ${stage}`, contentType: 'markdown', source: 'manual_edit'});
    lockStage(projectId, stage);
  }
  generateVersion({
    projectId,
    stage: 'script_v2',
    content,
    contentType: 'markdown',
    source: 'manual_edit',
    promptVersion,
  });
  lockStage(projectId, 'script_v2');
  return projectId;
}

/** 每个 unit 独立成 beat 的合法基线：speech→explanation，silence→pause。 */
function makeValidBeats(plan: NarrationPlanV2): NarrativeBeatV1[] {
  return plan.units.map((unit, index) => ({
    beatId: `B${String(index + 1).padStart(3, '0')}`,
    chapter: unit.chapter,
    unitIds: [unit.id],
    role: unit.kind === 'silence' ? 'pause' : 'explanation',
    summary: `节拍 ${index + 1} 的编辑备注。`,
    payoff: null,
  }));
}

function proposalJson(beats: NarrativeBeatV1[]): string {
  return JSON.stringify({beats});
}

function usageCount(projectId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM llm_usage WHERE project_id = ? AND stage = 'm7_narrative_beats'`)
    .get(projectId) as {c: number};
  return row.c;
}

function beatsRows(projectId: string): Array<{id: string; version: number}> {
  return getDb()
    .prepare(`SELECT id, version FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version ASC`)
    .all(projectId, NARRATIVE_BEATS_KIND) as Array<{id: string; version: number}>;
}

// ── snapshot fixture（M7.1.1 regression 用；与 test-m711-activation 同构） ──
function insertArtifact(projectId: string, kind: string, content: unknown): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?,
         (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
         ?, NULL, ?)`,
    )
    .run(id, projectId, kind, projectId, kind, JSON.stringify(content), new Date().toISOString());
  return id;
}

function buildFullChain(projectId: string, narrationPlanArtifactId: string): {
  snapshotArtifactId: string;
  artifacts: M7PipelineSnapshotArtifacts;
} {
  const narrativeBeatsArtifactId = insertArtifact(projectId, 'narrative_beats', {});
  const visualIntentArtifactId = insertArtifact(projectId, 'visual_intent_plan', {});
  const visualSequencesArtifactId = insertArtifact(projectId, 'visual_sequence_plan', {});
  const shotsArtifactId = insertArtifact(projectId, 'shot_plan', {});
  const reconciledShotTimelineArtifactId = insertArtifact(projectId, 'timing_reconciliation_v2', {});
  const storyboardArtifactId = insertArtifact(projectId, 'storyboard', {});
  const storyboardApprovalId = insertArtifact(projectId, 'storyboard_approval', {
    artifactId: storyboardArtifactId,
    decision: 'approved',
  });
  const animaticSourceArtifactId = insertArtifact(projectId, 'animatic_source', {});
  const animaticRenderArtifactId = insertArtifact(projectId, 'animatic_render', {});
  const animaticApprovalId = insertArtifact(projectId, 'animatic_approval', {
    artifactId: animaticRenderArtifactId,
    decision: 'approved',
  });
  const editorialGateResultArtifactId = insertArtifact(projectId, 'editorial_gate_result', {
    result: 'pass',
    evaluatedArtifactIds: [reconciledShotTimelineArtifactId, storyboardArtifactId],
  });
  const artifacts: M7PipelineSnapshotArtifacts = {
    narrationPlanV2ArtifactId: narrationPlanArtifactId,
    narrativeBeatsArtifactId,
    visualIntentArtifactId,
    visualSequencesArtifactId,
    shotsArtifactId,
    reconciledShotTimelineArtifactId,
    storyboardArtifactId,
    storyboardApprovalId,
    animaticSourceArtifactId,
    animaticRenderArtifactId,
    animaticApprovalId,
    editorialGateResultArtifactId,
    finalRenderSourceArtifactId: '',
  };
  const finalRenderSourceArtifactId = insertArtifact(projectId, 'final_render_source', {
    artifactIds: {
      narrationPlanV2ArtifactId: narrationPlanArtifactId,
      narrativeBeatsArtifactId,
      visualIntentArtifactId,
      visualSequencesArtifactId,
      shotsArtifactId,
      reconciledShotTimelineArtifactId,
      storyboardArtifactId,
      storyboardApprovalId,
      animaticSourceArtifactId,
      animaticRenderArtifactId,
      animaticApprovalId,
      editorialGateResultArtifactId,
    },
  });
  artifacts.finalRenderSourceArtifactId = finalRenderSourceArtifactId;
  const base = {
    schemaVersion: M7_PIPELINE_SNAPSHOT_SCHEMA_VERSION,
    rulesetVersion: M7_ACTIVATION_RULESET_V1,
    projectId,
    generation: 1,
    artifacts,
  };
  const snapshotArtifactId = insertArtifact(projectId, M7_PIPELINE_SNAPSHOT_KIND, {
    ...base,
    provenanceHash: computeSnapshotProvenanceHash(base),
    createdAt: new Date().toISOString(),
  });
  return {snapshotArtifactId, artifacts};
}

async function main(): Promise<void> {
  // ============ 公共 fixture ============
  const projectA = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
  const buildA = buildNarrationPlanV2(projectA);
  const planA = buildA.plan;
  ok(planA.units.length === 6, '[setup] strict DSL 编译出 6 units', planA.units.map((u) => [u.id, u.kind]));
  ok(
    planA.units.filter((u) => u.kind === 'speech').length === 4 &&
      planA.units.filter((u) => u.kind === 'silence').length === 2,
    '[setup] speech=4 silence=2',
  );
  const validBeats = makeValidBeats(planA);
  const [n1, n2, n3, n4, n5, n6] = planA.units.map((u) => u.id) as [
    string, string, string, string, string, string,
  ];
  const chOf = (id: string): number => planA.units.find((u) => u.id === id)!.chapter;

  // ============ S：schema ============
  {
    const artifact = {
      schemaVersion: 'narrative-beats@1.0',
      compilerVersion: '1.0',
      promptVersion: 'narrative-beats@1.0',
      source: {
        narrationPlanV2ArtifactId: buildA.artifact.id,
        narrationPlanV2ContentHash: `sha256:${'a'.repeat(64)}`,
        narrationPlanSchemaVersion: 'narration-plan@2.0',
        narrationCompilerVersion: '2.0',
        scriptV2VersionId: planA.source.scriptV2VersionId,
        scriptV2ContentHash: planA.source.scriptV2ContentHash,
      },
      generation: {requestId: 'r1', provider: 'mock', model: 'm', attemptCount: 1},
      beats: validBeats,
    };
    ok(narrativeBeatsArtifactV1Schema.safeParse(artifact).success, '[S1] 完整合法 artifact 通过');
    ok(
      !narrativeBeatsArtifactV1Schema.safeParse({...artifact, extra: 1}).success,
      '[S2] 顶层未知字段 → strict 拒绝',
    );
    ok(
      !narrativeBeatsArtifactV1Schema.safeParse({
        ...artifact,
        beats: [{...validBeats[0]!, sequenceId: 'SQ1'}],
      }).success,
      '[S3] beat 含 sequenceId（下游字段）→ 拒绝',
    );
    ok(
      !narrativeBeatsArtifactV1Schema.safeParse({
        ...artifact,
        beats: [{...validBeats[0]!, startMs: 0}],
      }).success,
      '[S4] beat 含 startMs（timing 字段）→ 拒绝',
    );
    ok(
      !narrativeBeatsArtifactV1Schema.safeParse({
        ...artifact,
        beats: [{...validBeats[0]!, beatId: 'B1'}],
      }).success,
      '[S5] beatId 格式非法 → 拒绝',
    );
    ok(
      !narrativeBeatsArtifactV1Schema.safeParse({
        ...artifact,
        beats: [{...validBeats[0]!, unitIds: []}],
      }).success,
      '[S6] unitIds 为空 → 拒绝',
    );
    ok(
      !narrativeBeatsArtifactV1Schema.safeParse({
        ...artifact,
        beats: [{...validBeats[0]!, role: 'filler'}],
      }).success,
      '[S7] role 不在闭集 → 拒绝',
    );
    ok(
      !narrativeBeatsArtifactV1Schema.safeParse({
        ...artifact,
        beats: [{...validBeats[0]!, summary: 'x'.repeat(241)}],
      }).success,
      '[S8] summary 超长 → 拒绝',
    );
    ok(
      !narrativeBeatsArtifactV1Schema.safeParse({
        ...artifact,
        beats: [{...validBeats[0]!, payoff: 'x'.repeat(241)}],
      }).success,
      '[S9] payoff 超长 → 拒绝',
    );
    ok(
      !narrativeBeatsArtifactV1Schema.safeParse({
        ...artifact,
        source: {...artifact.source, narrationPlanV2ContentHash: 'md5:abc'},
      }).success,
      '[S10] source hash 格式非法 → 拒绝',
    );
    const {source: _s, ...noSource} = artifact;
    ok(!narrativeBeatsArtifactV1Schema.safeParse(noSource).success, '[S11] 缺 source → 拒绝');
    ok(
      !narrativeBeatsProposalSchema.safeParse({beats: validBeats, note: 'x'}).success,
      '[S12] LLM proposal 含额外字段 → 拒绝',
    );
  }

  // ============ C：coverage validator ============
  {
    ok(validateNarrativeBeatsCoverage(planA, validBeats).length === 0, '[C1] 合法基线 → 0 issues');

    const dup = validBeats.map((b) => ({...b}));
    dup[0] = {...dup[0]!, unitIds: [n1, n2]};
    ok(
      validateNarrativeBeatsCoverage(planA, dup).some((i) => i.code === 'DUPLICATE_UNIT'),
      '[C2] 重复 unit → DUPLICATE_UNIT',
    );

    const missing = validBeats.filter((_, i) => i !== 5).map((b, i) => ({...b, beatId: `B${String(i + 1).padStart(3, '0')}`}));
    ok(
      validateNarrativeBeatsCoverage(planA, missing).some((i) => i.code === 'MISSING_UNIT'),
      '[C3] 遗漏 unit → MISSING_UNIT',
    );

    const unknown = validBeats.map((b) => ({...b}));
    unknown[0] = {...unknown[0]!, unitIds: [n1, 'N999']};
    ok(
      validateNarrativeBeatsCoverage(planA, unknown).some((i) => i.code === 'UNKNOWN_UNIT_ID'),
      '[C4] 不存在 unit → UNKNOWN_UNIT_ID',
    );

    const nonContig = validBeats.map((b) => ({...b}));
    nonContig[0] = {...nonContig[0]!, unitIds: [n1, n3]};
    ok(
      validateNarrativeBeatsCoverage(planA, nonContig).some((i) => i.code === 'NON_CONTIGUOUS_RANGE'),
      '[C5] 非连续 range → NON_CONTIGUOUS_RANGE',
    );

    const reordered = [validBeats[1]!, validBeats[0]!, ...validBeats.slice(2)].map((b, i) => ({
      ...b,
      beatId: `B${String(i + 1).padStart(3, '0')}`,
    }));
    ok(
      validateNarrativeBeatsCoverage(planA, reordered).some((i) => i.code === 'BEAT_ORDER'),
      '[C6] beats 顺序错误 → BEAT_ORDER',
    );

    const crossChapter: NarrativeBeatV1[] = [
      {beatId: 'B001', chapter: chOf(n1), unitIds: [n1, n2], role: 'explanation', summary: '前段。', payoff: null},
      // n3 在 chapter 1、n4 在 chapter 2 → 本 beat 跨 chapter
      {beatId: 'B002', chapter: chOf(n3), unitIds: [n3, n4], role: 'claim', summary: '跨章中段。', payoff: null},
      {beatId: 'B003', chapter: chOf(n5), unitIds: [n5], role: 'pause', summary: '呼吸。', payoff: null},
      {beatId: 'B004', chapter: chOf(n6), unitIds: [n6], role: 'summary', summary: '收束。', payoff: null},
    ];
    const crossIssues = validateNarrativeBeatsCoverage(planA, crossChapter);
    ok(
      chOf(n1) !== chOf(n4) && crossIssues.some((i) => i.code === 'CHAPTER_MISMATCH'),
      '[C7] 跨 chapter beat → CHAPTER_MISMATCH',
      {chOfN1: chOf(n1), chOfN4: chOf(n4)},
    );

    const wrongChapter = validBeats.map((b) => ({...b}));
    wrongChapter[0] = {...wrongChapter[0]!, chapter: wrongChapter[0]!.chapter + 1};
    ok(
      validateNarrativeBeatsCoverage(planA, wrongChapter).some((i) => i.code === 'CHAPTER_MISMATCH'),
      '[C8] chapter 字段错误 → CHAPTER_MISMATCH',
    );

    const silenceBadRole = validBeats.map((b) => ({...b}));
    silenceBadRole[1] = {...silenceBadRole[1]!, role: 'context'};
    ok(
      validateNarrativeBeatsCoverage(planA, silenceBadRole).some((i) => i.code === 'SILENCE_BEAT_ROLE'),
      '[C9] 纯 silence beat role≠pause → SILENCE_BEAT_ROLE',
    );

    const speechPause = validBeats.map((b) => ({...b}));
    speechPause[0] = {...speechPause[0]!, role: 'pause'};
    ok(
      validateNarrativeBeatsCoverage(planA, speechPause).some((i) => i.code === 'SPEECH_BEAT_ROLE_PAUSE'),
      '[C10] speech beat role=pause → SPEECH_BEAT_ROLE_PAUSE',
    );

    // visual_breath 独立 pause beat（合法）+ pause silence 与 speech 组合（合法）
    const combo: NarrativeBeatV1[] = [
      {beatId: 'B001', chapter: chOf(n1), unitIds: [n1, n2], role: 'hook', summary: '开场加停顿。', payoff: null},
      {beatId: 'B002', chapter: chOf(n3), unitIds: [n3], role: 'explanation', summary: '解释。', payoff: null},
      {beatId: 'B003', chapter: chOf(n4), unitIds: [n4], role: 'claim', summary: '主张。', payoff: null},
      {beatId: 'B004', chapter: chOf(n5), unitIds: [n5], role: 'pause', summary: '视觉呼吸。', payoff: null},
      {beatId: 'B005', chapter: chOf(n6), unitIds: [n6], role: 'summary', summary: '收束。', payoff: null},
    ];
    ok(
      validateNarrativeBeatsCoverage(planA, combo).length === 0,
      '[C11] visual_breath 独立 pause beat + silence/speech 组合 → 合法',
    );

    const badSeq = validBeats.map((b) => ({...b}));
    badSeq[1] = {...badSeq[1]!, beatId: 'B003'};
    ok(
      validateNarrativeBeatsCoverage(planA, badSeq).some((i) => i.code === 'BEAT_ID_SEQUENCE'),
      '[C12] beatId 不连续 → BEAT_ID_SEQUENCE',
    );

    const leakySummary = validBeats.map((b) => ({...b}));
    leakySummary[0] = {...leakySummary[0]!, summary: '（停顿0.5秒）这里要放慢'};
    ok(
      validateNarrativeBeatsCoverage(planA, leakySummary).some((i) => i.code === 'SUMMARY_LEAKAGE'),
      '[C13] summary 指令泄漏 → SUMMARY_LEAKAGE',
    );

    const normalSummary = validBeats.map((b) => ({...b}));
    normalSummary[0] = {...normalSummary[0]!, summary: '谈话中出现了短暂停顿，随后给出结论。'};
    ok(
      validateNarrativeBeatsCoverage(planA, normalSummary).length === 0,
      '[C14] 正常语义「停顿」不误杀',
    );

    const leakyPayoff = validBeats.map((b) => ({...b}));
    leakyPayoff[0] = {...leakyPayoff[0]!, payoff: '旁白：此处收束'};
    ok(
      validateNarrativeBeatsCoverage(planA, leakyPayoff).some((i) => i.code === 'PAYOFF_LEAKAGE'),
      '[C15] payoff 指令泄漏 → PAYOFF_LEAKAGE',
    );
  }

  // ============ I：input isolation ============
  {
    await expectBeatsError(
      'NARRATION_PLAN_NOT_FOUND',
      () => buildNarrativeBeats({projectId: projectA, narrationPlanV2ArtifactId: crypto.randomUUID(), requestId: 'i-1'}),
      '[I1] 不存在的 plan artifact → NARRATION_PLAN_NOT_FOUND',
    );
    const projectX = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const buildX = buildNarrationPlanV2(projectX);
    await expectBeatsError(
      'NARRATION_PLAN_NOT_FOUND',
      () => buildNarrativeBeats({projectId: projectA, narrationPlanV2ArtifactId: buildX.artifact.id, requestId: 'i-2'}),
      '[I2] 跨项目 plan artifact → NARRATION_PLAN_NOT_FOUND',
    );
    const projectR = newProjectWithScript(REVIEW_MD, 'script-v2@1.0');
    const buildR = buildNarrationPlanV2(projectR);
    ok(buildR.plan.needsReview.length > 0, '[I3a] needsReview fixture 非空');
    await expectBeatsError(
      'NARRATION_PLAN_NOT_ELIGIBLE',
      () => buildNarrativeBeats({projectId: projectR, narrationPlanV2ArtifactId: buildR.artifact.id, requestId: 'i-3'}),
      '[I3b] needs_review plan → NARRATION_PLAN_NOT_ELIGIBLE',
    );
    await expectBeatsError(
      'REQUEST_ID_REQUIRED',
      () => buildNarrativeBeats({projectId: projectA, narrationPlanV2ArtifactId: buildA.artifact.id, requestId: '  '}),
      '[I4] 空 requestId → REQUEST_ID_REQUIRED',
    );
    // stale plan：script_v2 新版本后旧 plan candidate stale → 拒绝
    editVersion(
      {
        projectId: projectX,
        stage: 'script_v2',
        content: `${STRICT_MD}\n第七句。`,
        contentType: 'markdown',
        source: 'manual_edit',
        promptVersion: 'script-v2@2.0',
      },
      {confirmStale: true},
    );
    lockStage(projectX, 'script_v2');
    await expectBeatsError(
      'NARRATION_PLAN_NOT_ELIGIBLE',
      () => buildNarrativeBeats({projectId: projectX, narrationPlanV2ArtifactId: buildX.artifact.id, requestId: 'i-5'}),
      '[I5] stale plan → NARRATION_PLAN_NOT_ELIGIBLE（不 fallback latest）',
    );
  }

  // ============ L：LLM / repair ============
  const provider = new ScriptableProvider();
  let beatsArtifactId = '';
  {
    provider.push({text: proposalJson(validBeats)});
    const result = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'L-1',
      provider,
    });
    ok(!result.reused && result.beats.beats.length === 6, '[L1] 合法 proposal 一次通过');
    ok(result.beats.generation.attemptCount === 1, '[L2] attemptCount=1');
    ok(usageCount(projectA) === 1, '[L3] usage 记录恰好 1 行');
    beatsArtifactId = result.artifact.id;

    // prompt 内容隔离：不得含 sourceText / raw directive / 旧 beat_map / scenes
    const reqText = provider.requests.map((r) => `${r.system}\n${r.user}`).join('\n');
    ok(!reqText.includes('sourceText'), '[L4a] prompt 不含 sourceText 字段');
    ok(!reqText.includes('@silence'), '[L4b] prompt 不含 raw DSL directive');
    ok(!reqText.includes('visual_breakdown') && !reqText.includes('shot_list'), '[L4c] prompt 不含下游 stage 内容');
    ok(reqText.includes('第一句'), '[L4d] prompt 含 sanitized spokenText（投影生效）');

    // 第一次失败（重复 unit）→ repair 成功
    const dupBeats = validBeats.map((b) => ({...b}));
    dupBeats[0] = {...dupBeats[0]!, unitIds: [n1, n2]};
    provider.push({text: proposalJson(dupBeats)});
    provider.push({text: proposalJson(validBeats)});
    const repaired = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'L-2',
      provider,
    });
    ok(!repaired.reused && repaired.beats.generation.attemptCount === 2, '[L5] 重复 unit → repair 第 2 次成功');
    const repairReq = provider.requests[provider.requests.length - 1]!;
    ok(
      repairReq.user.includes('DUPLICATE_UNIT'),
      '[L6] repair prompt 携带精确 validation errors',
    );

    // 两次 repair 仍失败（遗漏 unit ×3）
    for (let i = 0; i < 3; i++) {
      const missing = validBeats.slice(0, 5);
      provider.push({text: proposalJson(missing)});
    }
    let failed: unknown = null;
    try {
      await buildNarrativeBeats({
        projectId: projectA,
        narrationPlanV2ArtifactId: buildA.artifact.id,
        requestId: 'L-3',
        provider,
      });
    } catch (err) {
      failed = err;
    }
    ok(failed instanceof LLMError && failed.code === 'VALIDATION_FAILED', '[L7] 两次 repair 仍失败 → VALIDATION_FAILED');
    ok(beatsRows(projectA).length === 2, '[L8] 失败 generation 不产生 artifact（仍仅 L-1/L-2 两个 candidate）');
    ok(usageCount(projectA) === 6, '[L9] 全部真实请求均记 usage（1+2+3）');

    // provider transport error → 无 usage、无 artifact
    provider.push({error: new LLMError('PROVIDER_HTTP_ERROR', 'boom', {status: 500})});
    let perr: unknown = null;
    const usageBeforeErr = usageCount(projectA);
    try {
      await buildNarrativeBeats({
        projectId: projectA,
        narrationPlanV2ArtifactId: buildA.artifact.id,
        requestId: 'L-4',
        provider,
      });
    } catch (err) {
      perr = err;
    }
    ok(perr instanceof LLMError && perr.code === 'PROVIDER_HTTP_ERROR', '[L10] provider error 原样上抛');
    ok(usageCount(projectA) === usageBeforeErr, '[L11] transport 失败不记 usage（不伪造成本）');
    ok(beatsRows(projectA).length === 2, '[L12] provider error 不产生 artifact');

    // 空响应 ×3 → EMPTY_RESPONSE（3 次 usage）
    provider.push({text: ''});
    provider.push({text: ''});
    provider.push({text: ''});
    let eerr: unknown = null;
    try {
      await buildNarrativeBeats({
        projectId: projectA,
        narrationPlanV2ArtifactId: buildA.artifact.id,
        requestId: 'L-5',
        provider,
      });
    } catch (err) {
      eerr = err;
    }
    ok(eerr instanceof LLMError && eerr.code === 'EMPTY_RESPONSE', '[L13] 空响应 ×3 → EMPTY_RESPONSE');

    // 截断 → OUTPUT_TRUNCATED（不做普通 repair）
    provider.push({text: '{"beats":[', finishReason: 'length'});
    let terr: unknown = null;
    try {
      await buildNarrativeBeats({
        projectId: projectA,
        narrationPlanV2ArtifactId: buildA.artifact.id,
        requestId: 'L-6',
        provider,
      });
    } catch (err) {
      terr = err;
    }
    ok(terr instanceof LLMError && terr.code === 'OUTPUT_TRUNCATED', '[L14] finishReason=length → OUTPUT_TRUNCATED');

    // 非法 JSON → repair 成功
    provider.push({text: 'not json at all'});
    provider.push({text: proposalJson(validBeats)});
    const repaired2 = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'L-7',
      provider,
    });
    ok(repaired2.beats.generation.attemptCount === 2, '[L15] invalid JSON → repair 成功');

    // 非法 role → repair 成功
    const badRole = validBeats.map((b) => ({...b}));
    badRole[0] = {...badRole[0]!, role: 'filler' as never};
    provider.push({text: JSON.stringify({beats: badRole})});
    provider.push({text: proposalJson(validBeats)});
    const repaired3 = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'L-8',
      provider,
    });
    ok(repaired3.beats.generation.attemptCount === 2, '[L16] 非法 role → zod 失败 → repair 成功');

    // usage 行审计字段
    const usageRow = getDb()
      .prepare(
        `SELECT stage, job_id, prompt_version, provider FROM llm_usage
         WHERE project_id = ? AND stage = 'm7_narrative_beats' LIMIT 1`,
      )
      .get(projectA) as {stage: string; job_id: string; prompt_version: string; provider: string};
    ok(
      usageRow.job_id === 'L-1' && usageRow.prompt_version === 'narrative-beats@1.0' && usageRow.provider === 'scriptable-mock',
      '[L17] usage 行含 requestId(job_id)/promptVersion/provider（可审计）',
      usageRow,
    );
  }

  // ============ ID：idempotency ============
  {
    const rowsBefore = beatsRows(projectA).length;
    const usageBefore = usageCount(projectA);
    const again = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'L-1',
      provider,
    });
    ok(again.reused && again.artifact.id === beatsArtifactId, '[ID1] 同 requestId → 复用同 artifact');
    ok(beatsRows(projectA).length === rowsBefore, '[ID2] 同 requestId 不产生新行');
    ok(usageCount(projectA) === usageBefore, '[ID3] 同 requestId 零新增 usage（不重复收费）');

    provider.push({text: proposalJson(validBeats)});
    const regen = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'ID-new',
      provider,
    });
    ok(!regen.reused && regen.artifact.id !== beatsArtifactId, '[ID4] 新 requestId → 新 candidate（regenerate 可用）');
    const versions = beatsRows(projectA).map((r) => r.version);
    ok(versions.length === new Set(versions).size, '[ID5] candidate append-only（旧 version 保留）');

    // 同 requestId 不同 source：projectY 内先建 beats，再演进 script 产生第二个 plan
    const projectY = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const buildY = buildNarrationPlanV2(projectY);
    provider.push({text: proposalJson(makeValidBeats(buildY.plan))});
    await buildNarrativeBeats({
      projectId: projectY,
      narrationPlanV2ArtifactId: buildY.artifact.id,
      requestId: 'Y-1',
      provider,
    });
    editVersion(
      {
        projectId: projectY,
        stage: 'script_v2',
        content: `${STRICT_MD}\n第七句。`,
        contentType: 'markdown',
        source: 'manual_edit',
        promptVersion: 'script-v2@2.0',
      },
      {confirmStale: true},
    );
    lockStage(projectY, 'script_v2');
    const buildY2 = buildNarrationPlanV2(projectY);
    ok(buildY2.artifact.id !== buildY.artifact.id, '[ID6a] projectY 产生第二个 plan candidate');
    await expectBeatsError(
      'REQUEST_ID_CONFLICT',
      () =>
        buildNarrativeBeats({
          projectId: projectY,
          narrationPlanV2ArtifactId: buildY2.artifact.id,
          requestId: 'Y-1',
          provider,
        }),
      '[ID6b] 同 requestId 不同 source → REQUEST_ID_CONFLICT',
    );

    // 失败 request 不 poison：L-3 失败后可成功
    provider.push({text: proposalJson(validBeats)});
    const retry = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'L-3',
      provider,
    });
    ok(!retry.reused && retry.beats.generation.attemptCount === 1, '[ID7] 失败 requestId 可重试成功');

    // 并发同 requestId → 只有一个 artifact
    provider.push({text: proposalJson(validBeats)});
    provider.push({text: proposalJson(validBeats)});
    const [c1, c2] = await Promise.all([
      buildNarrativeBeats({projectId: projectA, narrationPlanV2ArtifactId: buildA.artifact.id, requestId: 'ID-conc', provider}),
      buildNarrativeBeats({projectId: projectA, narrationPlanV2ArtifactId: buildA.artifact.id, requestId: 'ID-conc', provider}),
    ]);
    ok(c1.artifact.id === c2.artifact.id, '[ID8] 并发同 requestId → 同一 artifact');
    const concByRequest = beatsRows(projectA).filter((r) => {
      const content = getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(r.id) as {content_json: string};
      return (JSON.parse(content.content_json) as {generation: {requestId: string}}).generation.requestId === 'ID-conc';
    });
    ok(concByRequest.length === 1, '[ID9] 并发不生成重复 artifact');
  }

  // ============ CL：candidate 生命周期 ============
  {
    const candidates = listNarrativeBeatsCandidates(projectA);
    const first = candidates.find((c) => c.artifact.id === beatsArtifactId)!;
    ok(first.status === 'eligible_candidate', '[CL1] 合法 beats → eligible_candidate（仍只是 candidate）');
    ok(
      getCurrentNarrationPlanV2(projectA) === null,
      '[CL2] beats 存在不影响 narration active 语义（m6 getter 恒 null）',
    );
    ok(getPipelineVersion(projectA) === 'm6' && getM7PipelineSnapshotId(projectA) === null, '[CL3] 项目仍 m6 + 指针 NULL');
    const snapCount = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = 'm7_pipeline_snapshot'`)
      .get(projectA) as {c: number};
    ok(snapCount.c === 0, '[CL4] 未创建任何 m7 snapshot');

    // invalid JSON candidate
    const badId = crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
         VALUES (?, ?, ?, 99, '{broken', NULL, ?)`,
      )
      .run(badId, projectA, NARRATIVE_BEATS_KIND, new Date().toISOString());
    const badRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(badId) as never;
    ok(
      classifyNarrativeBeatsCandidate(projectA, badRow).status === 'invalid',
      '[CL5] 契约非法 artifact → invalid',
    );
    getDb().prepare('DELETE FROM artifacts WHERE id = ?').run(badId);

    // 覆盖损坏（beats 缺 unit）→ invalid
    const ref = getNarrativeBeatsArtifact(projectA, beatsArtifactId)!;
    const tampered = {...ref.beats, beats: ref.beats.beats.slice(0, 5)};
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run(JSON.stringify(tampered), beatsArtifactId);
    const tamperedRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(beatsArtifactId) as never;
    ok(
      classifyNarrativeBeatsCandidate(projectA, tamperedRow).status === 'invalid',
      '[CL6] beats 覆盖损坏 → invalid',
    );
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run(JSON.stringify(ref.beats), beatsArtifactId);
    const restoredRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(beatsArtifactId) as never;
    ok(
      classifyNarrativeBeatsCandidate(projectA, restoredRow).status === 'eligible_candidate',
      '[CL7] 恢复后 eligible_candidate',
    );

    // source stale → beats stale
    const projectZ = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const buildZ = buildNarrationPlanV2(projectZ);
    provider.push({text: proposalJson(makeValidBeats(buildZ.plan))});
    const beatsZ = await buildNarrativeBeats({
      projectId: projectZ,
      narrationPlanV2ArtifactId: buildZ.artifact.id,
      requestId: 'CL-z',
      provider,
    });
    editVersion(
      {
        projectId: projectZ,
        stage: 'script_v2',
        content: `${STRICT_MD}\n第七句。`,
        contentType: 'markdown',
        source: 'manual_edit',
        promptVersion: 'script-v2@2.0',
      },
      {confirmStale: true},
    );
    lockStage(projectZ, 'script_v2');
    const zRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(beatsZ.artifact.id) as never;
    ok(
      classifyNarrativeBeatsCandidate(projectZ, zRow).status === 'stale',
      '[CL8] source narration stale → beats candidate stale',
    );

    // source 内容 hash 漂移（模拟 append-only 被破坏）→ stale
    const srcRow = getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(buildZ.artifact.id) as {content_json: string};
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run(`${srcRow.content_json} `, buildZ.artifact.id);
    ok(
      classifyNarrativeBeatsCandidate(projectZ, zRow).status === 'stale',
      '[CL9] source hash 漂移 → stale',
    );

    // exact getter
    ok(getNarrativeBeatsArtifact(projectA, beatsArtifactId) !== null, '[CL10] exact getter 可读');
    ok(getNarrativeBeatsArtifact(projectZ, beatsArtifactId) === null, '[CL11] 跨项目 → null');
    ok(getNarrativeBeatsArtifact(projectA, buildA.artifact.id) === null, '[CL12] kind 不符 → null');
  }

  // ============ R：M7.1.1 active getter frozen-ruleset regression ============
  {
    // m6 + eligible candidate → null
    ok(getCurrentNarrationPlanV2(projectA) === null, '[R1] m6 + eligible candidate → getter null');

    // 完整链激活 → getter 精确返回 snapshot 引用的 plan
    const projectM = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const buildM = buildNarrationPlanV2(projectM);
    const chain = buildFullChain(projectM, buildM.artifact.id);
    activateM7Pipeline(projectM, chain.snapshotArtifactId);
    const current = getCurrentNarrationPlanV2(projectM);
    ok(
      current !== null && current.artifact.id === buildM.artifact.id,
      '[R2] m7 + 完整合法 snapshot → getter 返回精确 narration artifact',
    );

    // 链损坏（删引用 artifact）→ getter null（M7.2 补强前会错误返回 plan）
    getDb().prepare('DELETE FROM artifacts WHERE id = ?').run(chain.artifacts.animaticRenderArtifactId);
    ok(
      getCurrentNarrationPlanV2(projectM) === null,
      '[R3] m7 + 链损坏 → getter null（frozen ruleset fail-closed）',
    );

    // gate 内容损坏 → getter null
    const projectN = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const buildN = buildNarrationPlanV2(projectN);
    const chainN = buildFullChain(projectN, buildN.artifact.id);
    activateM7Pipeline(projectN, chainN.snapshotArtifactId);
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run('corrupted', chainN.artifacts.editorialGateResultArtifactId);
    ok(getCurrentNarrationPlanV2(projectN) === null, '[R4] m7 + gate 损坏 → getter null');

    // unsupported ruleset（直接 UPDATE 指针模拟）→ getter null
    const projectO = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const buildO = buildNarrationPlanV2(projectO);
    const fakeSnapshot = insertArtifact(projectO, M7_PIPELINE_SNAPSHOT_KIND, {
      schemaVersion: M7_PIPELINE_SNAPSHOT_SCHEMA_VERSION,
      rulesetVersion: 'm7-activation@9.9',
      projectId: projectO,
      generation: 1,
      artifacts: {},
      provenanceHash: `sha256:${'0'.repeat(64)}`,
      createdAt: new Date().toISOString(),
    });
    getDb()
      .prepare(`UPDATE projects SET pipeline_version = 'm7', m7_pipeline_snapshot_id = ? WHERE id = ?`)
      .run(fakeSnapshot, projectO);
    ok(getCurrentNarrationPlanV2(projectO) === null, '[R5] m7 + unsupported ruleset → getter null');

    // 不得返回其他 eligible candidate：projectM 里另有 beats/plan candidates，getter 只认 snapshot
    // （R2 已验证精确性；这里验证 m7 项目新建 eligible plan candidate 不影响 getter）
    try {
      switchPipelineToM7(projectA);
      ok(false, '[R6] 废弃 switchPipelineToM7 仍恒定拒绝');
    } catch (err) {
      ok(
        err instanceof PipelineVersionError && err.code === 'M7_ACTIVATION_SNAPSHOT_REQUIRED',
        '[R6] 废弃 switchPipelineToM7 仍恒定拒绝',
      );
    }
  }

  // ============ API：routes ============
  {
    const listRes = await beatsGET(new Request('http://test'), {params: Promise.resolve({id: projectA})});
    ok(listRes.status === 200, '[API1] GET list → 200');
    const listJson = (await listRes.json()) as {
      candidateOnly: boolean;
      pipelineVersion: string;
      candidates: Array<{artifactId: string}>;
      narrationCandidates: Array<{artifactId: string}>;
      latestEligibleSuggestionArtifactId: string | null;
    };
    ok(
      listJson.candidateOnly === true && listJson.pipelineVersion === 'm6',
      '[API2] list 响应 candidateOnly + m6',
    );
    ok(
      listJson.candidates.some((c) => c.artifactId === beatsArtifactId),
      '[API3] list 含已建 candidate',
    );
    ok(
      listJson.latestEligibleSuggestionArtifactId === buildA.artifact.id,
      '[API4] latestEligible 建议仅为建议字段',
    );

    const badBuild = await beatsPOST(
      new Request('http://test', {method: 'POST', body: JSON.stringify({requestId: 'x'})}),
      {params: Promise.resolve({id: projectA})},
    );
    ok(badBuild.status === 422 || badBuild.status === 400, '[API5] 缺 artifact ID → 4xx（不允许空 artifact ID）');

    // 注：route 使用进程级 provider 单例（测试环境=MockLLMProvider，无 beats fixture），
    // 201 真实生成路径已在 library 层全覆盖；此处验证 route plumbing + 幂等（reused 不触达 LLM）。
    const rebuildRes = await beatsPOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({narrationPlanV2ArtifactId: buildA.artifact.id, requestId: 'L-1'}),
      }),
      {params: Promise.resolve({id: projectA})},
    );
    ok(rebuildRes.status === 200, '[API6] 同 requestId POST → 200 reused');
    const rebuildJson = (await rebuildRes.json()) as {
      reused: boolean;
      candidateOnly: boolean;
      pipelineVersion: string;
      artifactId: string;
    };
    ok(
      rebuildJson.reused === true &&
        rebuildJson.candidateOnly === true &&
        rebuildJson.pipelineVersion === 'm6' &&
        rebuildJson.artifactId === beatsArtifactId,
      '[API7] reused 响应：candidateOnly + m6 + 同 artifact',
    );

    const detailRes = await beatsDetailGET(new Request('http://test'), {
      params: Promise.resolve({id: projectA, artifactId: beatsArtifactId}),
    });
    ok(detailRes.status === 200, '[API8] GET detail → 200');
    const detailJson = (await detailRes.json()) as {
      beatCount: number;
      coverage: {unitTotal: number; speechTotal: number; silenceTotal: number};
      beats: Array<{beatId: string; role: string}>;
    };
    ok(
      detailJson.beatCount === 6 &&
        detailJson.coverage.unitTotal === 6 &&
        detailJson.coverage.speechTotal === 4 &&
        detailJson.coverage.silenceTotal === 2,
      '[API9] detail 覆盖统计正确',
    );
    const missingDetail = await beatsDetailGET(new Request('http://test'), {
      params: Promise.resolve({id: projectA, artifactId: crypto.randomUUID()}),
    });
    ok(missingDetail.status === 404, '[API10] 不存在 detail → 404');
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m72-beats'), {recursive: true, force: true});

  // async expectBeatsError 的断言是微任务——等待全部落定再汇总
  await new Promise((resolve) => setImmediate(resolve));

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M7.2 Narrative Beats 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M7.2 Narrative Beats 测试全部通过 ✅');
}

void main();
