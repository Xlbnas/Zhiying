/**
 * M7.2 Narrative Beats 测试（临时 DB + Scriptable Mock Provider，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m72-narrative-beats.ts
 * 覆盖：schema、coverage validator、input isolation、LLM/repair、idempotency、
 * candidate 生命周期、M7.1.1 active getter frozen-ruleset regression、API routes。
 * M7.2.1 适配：build 返回 union（succeeded/in_progress/terminal）——LLM/validation
 * 失败不再 throw，而是 run 转 failed 终态；requestId 需 8–128 安全字符；
 * durable single-flight（generation_runs/generation_attempts）。
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
  type BuildNarrativeBeatsResult,
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
import {getDispatchJob} from '../src/lib/llm-generation/dispatch';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runDispatchJob} from '../src/worker/dispatch-executor';

// 上次中断运行可能留下临时 DB（claimNextAnyJob 全局 FIFO 会捡到旧 dispatch）——
// 启动即清空（getDb 为惰性单例，此处尚未打开）。
fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m72-beats'), {recursive: true, force: true});

/** Worker-side dispatch：claim 下一个 dispatch 并以注入 provider 执行（模拟 worker 主循环一步）。 */
async function runNextDispatch(provider: LLMProvider): Promise<void> {
  const claimed = claimNextAnyJob('worker-test-m72');
  if (!claimed || claimed.type !== 'dispatch') {
    throw new Error(`expected queued dispatch job, got ${claimed?.type ?? 'null'}`);
  }
  await runDispatchJob(
    claimed.job,
    {isShuttingDown: () => false, log: () => {}},
    {provider, heartbeatMs: 60_000},
  );
}

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

type SucceededResult = Extract<BuildNarrativeBeatsResult, {kind: 'succeeded'}>;

/** M7.2.1：build 返回 union——断言 kind=succeeded 后继续（失败会计数并级联）。 */
function asSucceeded(result: BuildNarrativeBeatsResult, label: string): SucceededResult {
  ok(result.kind === 'succeeded', label, result.kind === 'succeeded' ? undefined : result);
  return result as SucceededResult;
}

interface RunRowProbe {
  id: string;
  status: string;
  error_code: string | null;
  result_artifact_id: string | null;
}

function runRow(projectId: string, requestId: string): RunRowProbe | undefined {
  return getDb()
    .prepare(
      `SELECT id, status, error_code, result_artifact_id FROM generation_runs
       WHERE project_id = ? AND stage = 'm7_narrative_beats' AND request_id = ?`,
    )
    .get(projectId, requestId) as RunRowProbe | undefined;
}

function runCount(projectId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM generation_runs WHERE project_id = ? AND stage = 'm7_narrative_beats'`,
    )
    .get(projectId) as {c: number};
  return row.c;
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
      () => buildNarrativeBeats({projectId: projectA, narrationPlanV2ArtifactId: crypto.randomUUID(), requestId: 'req-i-0001'}),
      '[I1] 不存在的 plan artifact → NARRATION_PLAN_NOT_FOUND',
    );
    const projectX = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const buildX = buildNarrationPlanV2(projectX);
    await expectBeatsError(
      'NARRATION_PLAN_NOT_FOUND',
      () => buildNarrativeBeats({projectId: projectA, narrationPlanV2ArtifactId: buildX.artifact.id, requestId: 'req-i-0002'}),
      '[I2] 跨项目 plan artifact → NARRATION_PLAN_NOT_FOUND',
    );
    const projectR = newProjectWithScript(REVIEW_MD, 'script-v2@1.0');
    const buildR = buildNarrationPlanV2(projectR);
    ok(buildR.plan.needsReview.length > 0, '[I3a] needsReview fixture 非空');
    await expectBeatsError(
      'NARRATION_PLAN_NOT_ELIGIBLE',
      () => buildNarrativeBeats({projectId: projectR, narrationPlanV2ArtifactId: buildR.artifact.id, requestId: 'req-i-0003'}),
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
      () => buildNarrativeBeats({projectId: projectX, narrationPlanV2ArtifactId: buildX.artifact.id, requestId: 'req-i-0005'}),
      '[I5] stale plan → NARRATION_PLAN_NOT_ELIGIBLE（不 fallback latest）',
    );
  }

  // ============ L：LLM / repair ============
  const provider = new ScriptableProvider();
  let beatsArtifactId = '';
  {
    provider.push({text: proposalJson(validBeats)});
    const r1 = asSucceeded(
      await buildNarrativeBeats({
        projectId: projectA,
        narrationPlanV2ArtifactId: buildA.artifact.id,
        requestId: 'req-L-0001',
        provider,
      }),
      '[L1a] build 返回 kind=succeeded',
    );
    ok(!r1.reused && r1.beats.beats.length === 6, '[L1] 合法 proposal 一次通过');
    ok(r1.beats.generation.attemptCount === 1, '[L2] attemptCount=1');
    ok(usageCount(projectA) === 1, '[L3] usage 记录恰好 1 行');
    const runL1 = runRow(projectA, 'req-L-0001');
    ok(
      runL1 !== undefined && runL1.status === 'succeeded' && runL1.id === r1.runId,
      '[L3b] generation_runs 行转 succeeded 且 runId 回传',
      runL1,
    );
    beatsArtifactId = r1.artifact.id;

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
    const repaired = asSucceeded(
      await buildNarrativeBeats({
        projectId: projectA,
        narrationPlanV2ArtifactId: buildA.artifact.id,
        requestId: 'req-L-0002',
        provider,
      }),
      '[L5a] repair build 返回 kind=succeeded',
    );
    ok(!repaired.reused && repaired.beats.generation.attemptCount === 2, '[L5] 重复 unit → repair 第 2 次成功');
    const repairReq = provider.requests[provider.requests.length - 1]!;
    ok(
      repairReq.user.includes('DUPLICATE_UNIT'),
      '[L6] repair prompt 携带精确 validation errors',
    );

    // 两次 repair 仍失败（遗漏 unit ×3）→ M7.2.1：不再 throw，run 转 failed 终态
    for (let i = 0; i < 3; i++) {
      const missing = validBeats.slice(0, 5);
      provider.push({text: proposalJson(missing)});
    }
    const failedResult = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'req-L-0003',
      provider,
    });
    ok(
      failedResult.kind === 'terminal' &&
        failedResult.status === 'failed' &&
        failedResult.errorCode === 'VALIDATION_FAILED',
      '[L7] 两次 repair 仍失败 → terminal VALIDATION_FAILED（不再 throw）',
      failedResult,
    );
    const runL3 = runRow(projectA, 'req-L-0003');
    ok(
      runL3 !== undefined && runL3.status === 'failed' && runL3.error_code === 'VALIDATION_FAILED',
      '[L7b] generation_runs 行转 failed 终态',
      runL3,
    );
    ok(beatsRows(projectA).length === 2, '[L8] 失败 generation 不产生 artifact（仍仅 req-L-0001/req-L-0002 两个 candidate）');
    ok(usageCount(projectA) === 6, '[L9] 全部真实请求均记 usage（1+2+3）');

    // provider transport error → terminal（无 usage、无 artifact）
    provider.push({error: new LLMError('PROVIDER_HTTP_ERROR', 'boom', {status: 500})});
    const usageBeforeErr = usageCount(projectA);
    const perr = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'req-L-0004',
      provider,
    });
    ok(
      perr.kind === 'terminal' && perr.status === 'failed' && perr.errorCode === 'PROVIDER_HTTP_ERROR',
      '[L10] provider error → terminal PROVIDER_HTTP_ERROR（不再上抛 LLMError）',
      perr,
    );
    const runL4 = runRow(projectA, 'req-L-0004');
    ok(runL4?.status === 'failed' && runL4.error_code === 'PROVIDER_HTTP_ERROR', '[L10b] transport 失败 run 转 failed');
    ok(usageCount(projectA) === usageBeforeErr, '[L11] transport 失败不记 usage（不伪造成本）');
    ok(beatsRows(projectA).length === 2, '[L12] provider error 不产生 artifact');

    // 空响应 ×3 → terminal EMPTY_RESPONSE（3 次 usage）
    provider.push({text: ''});
    provider.push({text: ''});
    provider.push({text: ''});
    const eerr = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'req-L-0005',
      provider,
    });
    ok(
      eerr.kind === 'terminal' && eerr.errorCode === 'EMPTY_RESPONSE',
      '[L13] 空响应 ×3 → terminal EMPTY_RESPONSE',
      eerr,
    );

    // 截断 → terminal OUTPUT_TRUNCATED（不做普通 repair）
    provider.push({text: '{"beats":[', finishReason: 'length'});
    const terr = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'req-L-0006',
      provider,
    });
    ok(
      terr.kind === 'terminal' && terr.errorCode === 'OUTPUT_TRUNCATED',
      '[L14] finishReason=length → terminal OUTPUT_TRUNCATED',
      terr,
    );

    // 非法 JSON → repair 成功
    provider.push({text: 'not json at all'});
    provider.push({text: proposalJson(validBeats)});
    const repaired2 = asSucceeded(
      await buildNarrativeBeats({
        projectId: projectA,
        narrationPlanV2ArtifactId: buildA.artifact.id,
        requestId: 'req-L-0007',
        provider,
      }),
      '[L15a] invalid JSON repair build 返回 kind=succeeded',
    );
    ok(repaired2.beats.generation.attemptCount === 2, '[L15] invalid JSON → repair 成功');

    // 非法 role → repair 成功
    const badRole = validBeats.map((b) => ({...b}));
    badRole[0] = {...badRole[0]!, role: 'filler' as never};
    provider.push({text: JSON.stringify({beats: badRole})});
    provider.push({text: proposalJson(validBeats)});
    const repaired3 = asSucceeded(
      await buildNarrativeBeats({
        projectId: projectA,
        narrationPlanV2ArtifactId: buildA.artifact.id,
        requestId: 'req-L-0008',
        provider,
      }),
      '[L16a] 非法 role repair build 返回 kind=succeeded',
    );
    ok(repaired3.beats.generation.attemptCount === 2, '[L16] 非法 role → zod 失败 → repair 成功');

    // usage 行审计字段
    const usageRow = getDb()
      .prepare(
        `SELECT stage, job_id, prompt_version, provider FROM llm_usage
         WHERE project_id = ? AND stage = 'm7_narrative_beats' LIMIT 1`,
      )
      .get(projectA) as {stage: string; job_id: string; prompt_version: string; provider: string};
    ok(
      usageRow.job_id === 'req-L-0001' && usageRow.prompt_version === 'narrative-beats@1.0' && usageRow.provider === 'scriptable-mock',
      '[L17] usage 行含 requestId(job_id)/promptVersion/provider（可审计）',
      usageRow,
    );
  }

  // ============ ID：idempotency ============
  {
    const rowsBefore = beatsRows(projectA).length;
    const usageBefore = usageCount(projectA);
    const again = asSucceeded(
      await buildNarrativeBeats({
        projectId: projectA,
        narrationPlanV2ArtifactId: buildA.artifact.id,
        requestId: 'req-L-0001',
        provider,
      }),
      '[ID1a] 同 requestId build 返回 kind=succeeded',
    );
    ok(again.reused && again.artifact.id === beatsArtifactId, '[ID1] 同 requestId → 复用同 artifact');
    ok(again.legacy === false && again.runId !== null, '[ID1b] M7.2.1 复用带 run 追溯（legacy=false）');
    ok(beatsRows(projectA).length === rowsBefore, '[ID2] 同 requestId 不产生新行');
    ok(usageCount(projectA) === usageBefore, '[ID3] 同 requestId 零新增 usage（不重复收费）');

    provider.push({text: proposalJson(validBeats)});
    const regen = asSucceeded(
      await buildNarrativeBeats({
        projectId: projectA,
        narrationPlanV2ArtifactId: buildA.artifact.id,
        requestId: 'req-ID-new1',
        provider,
      }),
      '[ID4a] regenerate build 返回 kind=succeeded',
    );
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
      requestId: 'req-Y-0001',
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
          requestId: 'req-Y-0001',
          provider,
        }),
      '[ID6b] 同 requestId 不同 source → REQUEST_ID_CONFLICT',
    );

    // M7.2.1 终态语义：失败 requestId 再调 → 同一 terminal（零 provider 调用、零新增
    // usage，不自动重试）；显式 regenerate 必须用新 requestId。
    const callsBeforeRetry = provider.requests.length;
    const usageBeforeRetry = usageCount(projectA);
    const retrySame = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'req-L-0003',
      provider,
    });
    ok(
      retrySame.kind === 'terminal' && retrySame.errorCode === 'VALIDATION_FAILED',
      '[ID7a] 失败 requestId 再调 → 同一 terminal（不自动重试）',
      retrySame,
    );
    ok(provider.requests.length === callsBeforeRetry, '[ID7b] 终态复用零 provider 调用');
    ok(usageCount(projectA) === usageBeforeRetry, '[ID7c] 终态复用零新增 usage（不重复收费）');
    provider.push({text: proposalJson(validBeats)});
    const retry = asSucceeded(
      await buildNarrativeBeats({
        projectId: projectA,
        narrationPlanV2ArtifactId: buildA.artifact.id,
        requestId: 'req-L-0003b',
        provider,
      }),
      '[ID7d] 新 requestId regenerate build 返回 kind=succeeded',
    );
    ok(!retry.reused && retry.beats.generation.attemptCount === 1, '[ID7] 新 requestId regenerate → 成功');

    // 并发同 requestId：durable claim 在 DB 层串行——先到者独占 run 并调用 provider，
    // 后到者得 in_progress（绝不二次调用 provider）。
    provider.push({text: proposalJson(validBeats)});
    const callsBeforeConc = provider.requests.length;
    const usageBeforeConc = usageCount(projectA);
    const [c1, c2] = await Promise.all([
      buildNarrativeBeats({projectId: projectA, narrationPlanV2ArtifactId: buildA.artifact.id, requestId: 'req-ID-conc', provider}),
      buildNarrativeBeats({projectId: projectA, narrationPlanV2ArtifactId: buildA.artifact.id, requestId: 'req-ID-conc', provider}),
    ]);
    ok(
      c1.kind === 'succeeded' && c2.kind === 'in_progress',
      '[ID8] 并发同 requestId → 先到者 succeeded + 后到者 in_progress',
      {c1: c1.kind, c2: c2.kind},
    );
    ok(
      provider.requests.length === callsBeforeConc + 1,
      '[ID8b] 并发全程 provider 恰好 1 次调用（single-flight）',
    );
    ok(
      usageCount(projectA) === usageBeforeConc + 1,
      '[ID8c] 并发恰好 1 行新 usage（无双计费）',
    );
    const concByRequest = beatsRows(projectA).filter((r) => {
      const content = getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(r.id) as {content_json: string};
      return (JSON.parse(content.content_json) as {generation: {requestId: string}}).generation.requestId === 'req-ID-conc';
    });
    ok(concByRequest.length === 1, '[ID9] 并发不生成重复 artifact');
    const concRun = runRow(projectA, 'req-ID-conc');
    ok(
      concRun !== undefined && concRun.status === 'succeeded',
      '[ID9b] 并发恰好一条 generation_runs 行且终态 succeeded',
      concRun,
    );
    // 租约释放后同 requestId 再调 → 复用同一 artifact（reused）
    const concAgain = asSucceeded(
      await buildNarrativeBeats({
        projectId: projectA,
        narrationPlanV2ArtifactId: buildA.artifact.id,
        requestId: 'req-ID-conc',
        provider,
      }),
      '[ID9c] 完成后同 requestId build 返回 kind=succeeded',
    );
    ok(
      concAgain.reused && c1.kind === 'succeeded' && concAgain.artifact.id === c1.artifact.id,
      '[ID9d] 完成后同 requestId → 复用同一 artifact',
    );
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
    const beatsZ = asSucceeded(
      await buildNarrativeBeats({
        projectId: projectZ,
        narrationPlanV2ArtifactId: buildZ.artifact.id,
        requestId: 'req-CL-z01',
        provider,
      }),
      '[CL8a] projectZ beats build 返回 kind=succeeded',
    );
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
      candidates: Array<{artifactId: string; legacyRunMetadataUnavailable: boolean}>;
      narrationCandidates: Array<{artifactId: string}>;
      latestEligibleSuggestionArtifactId: string | null;
      runs: Array<{runId: string; requestId: string; status: string}>;
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
    ok(
      Array.isArray(listJson.runs) &&
        listJson.runs.some((r) => r.requestId === 'req-L-0001' && r.status === 'succeeded') &&
        listJson.runs.some((r) => r.requestId === 'req-L-0003' && r.status === 'failed'),
      '[API4b] list 响应含 generation runs（succeeded + failed 均可见）',
    );
    const candidateL1 = listJson.candidates.find((c) => c.artifactId === beatsArtifactId);
    ok(
      candidateL1 !== undefined && candidateL1.legacyRunMetadataUnavailable === false,
      '[API4c] 有 run 的 candidate legacyRunMetadataUnavailable=false',
    );

    const badBuild = await beatsPOST(
      new Request('http://test', {method: 'POST', body: JSON.stringify({requestId: 'req-x-0001'})}),
      {params: Promise.resolve({id: projectA})},
    );
    ok(badBuild.status === 422 || badBuild.status === 400, '[API5] 缺 artifact ID → 4xx（不允许空 artifact ID）');

    // Worker-side LLM Dispatch：route 为 enqueue-only（Web 零 provider、零 secret），
    // worker executor 持有凭据执行 build（provider 经 deps 注入，不经 route）。
    const routeProvider = new ScriptableProvider();
    routeProvider.push({text: proposalJson(validBeats)});
    {
      const createRes = await beatsPOST(
        new Request('http://test', {
          method: 'POST',
          body: JSON.stringify({narrationPlanV2ArtifactId: buildA.artifact.id, requestId: 'req-API-new1'}),
        }),
        {params: Promise.resolve({id: projectA})},
      );
      ok(createRes.status === 202, '[API5b] 新 requestId POST → 202 queued（enqueue-only）');
      const createJson = (await createRes.json()) as {
        dispatchId: string;
        requestId: string;
        status: string;
        candidateOnly: boolean;
      };
      ok(
        createJson.status === 'queued' &&
          createJson.requestId === 'req-API-new1' &&
          createJson.dispatchId.length > 0 &&
          createJson.candidateOnly === true,
        '[API5c] 202 响应含 dispatchId + status=queued + candidateOnly',
        createJson,
      );
      ok(routeProvider.requests.length === 0, '[API5d] Web POST 零 provider 调用（route 无 secret）');

      // worker executor 执行 dispatch → build → artifact + dispatch 终态关联
      await runNextDispatch(routeProvider);
      ok(routeProvider.requests.length === 1, '[API5e] worker executor 真实调用 provider（1 次）');
      const newRun = runRow(projectA, 'req-API-new1');
      ok(
        newRun !== undefined && newRun.status === 'succeeded' && newRun.result_artifact_id !== null,
        '[API5f] worker 执行后 run succeeded + result artifact（durable 追溯）',
      );
      const newDispatch = getDispatchJob(getDb(), createJson.dispatchId);
      ok(
        newDispatch !== null &&
          newDispatch.status === 'succeeded' &&
          newDispatch.generation_run_id === newRun!.id &&
          newDispatch.result_artifact_id === newRun!.result_artifact_id,
        '[API5g] dispatch succeeded + generation_run/result_artifact 关联',
      );
    }

    const shortId = await beatsPOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({narrationPlanV2ArtifactId: buildA.artifact.id, requestId: 'abc'}),
      }),
      {params: Promise.resolve({id: projectA})},
    );
    ok(shortId.status === 422, '[API5h] 过短 requestId → 422 REQUEST_ID_INVALID');

    // 同 requestId POST → reused（不触达 LLM，无需注入 provider）。
    const rebuildRes = await beatsPOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({narrationPlanV2ArtifactId: buildA.artifact.id, requestId: 'req-L-0001'}),
      }),
      {params: Promise.resolve({id: projectA})},
    );
    ok(rebuildRes.status === 200, '[API6] 同 requestId POST → 200 reused');
    const rebuildJson = (await rebuildRes.json()) as {
      reused: boolean;
      candidateOnly: boolean;
      pipelineVersion: string;
      artifactId: string;
      legacy: boolean;
      runId: string | null;
    };
    ok(
      rebuildJson.reused === true &&
        rebuildJson.candidateOnly === true &&
        rebuildJson.pipelineVersion === 'm6' &&
        rebuildJson.artifactId === beatsArtifactId,
      '[API7] reused 响应：candidateOnly + m6 + 同 artifact',
    );
    ok(
      rebuildJson.legacy === false && rebuildJson.runId !== null,
      '[API7b] reused 响应带 run 追溯（legacy=false、runId 非空）',
    );

    // terminal run 同 requestId → 409（永远稳定返回同一终态）
    const terminalRes = await beatsPOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({narrationPlanV2ArtifactId: buildA.artifact.id, requestId: 'req-L-0003'}),
      }),
      {params: Promise.resolve({id: projectA})},
    );
    ok(terminalRes.status === 409, '[API7c] 失败 run 同 requestId POST → 409');
    const terminalJson = (await terminalRes.json()) as {
      status: string;
      errorCode: string;
      runId: string;
    };
    ok(
      terminalJson.status === 'failed' && terminalJson.errorCode === 'VALIDATION_FAILED' && terminalJson.runId.length > 0,
      '[API7d] 409 响应含 status/errorCode/runId',
      terminalJson,
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
