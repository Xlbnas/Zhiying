/**
 * M7.3A Visual Intent Plan 测试（临时 DB + Scriptable/Blockable Mock Provider，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m73a-visual-intent.ts
 * 覆盖：schema、beat coverage validator、intent↔strategy↔authenticity↔subject 矩阵、
 * displayText 精确引用、continuation 链、input isolation、durable single-flight
 * （generation_runs/attempts 复用 stage='m7_visual_intent'）、candidate 生命周期、
 * API routes、M7.2 narrative beats 回归。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m73a-visual-intent');
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion, editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import {LLMError, type LLMProvider, type LLMRequest, type LLMResponse} from '../src/lib/llm/types';
import {buildNarrationPlanV2} from '../src/lib/narration/plan-v2';
import type {NarrationPlanV2} from '../src/lib/narration/schema-v2';
import {
  buildNarrativeBeats,
  classifyNarrativeBeatsCandidate,
  getNarrativeBeatsArtifact,
} from '../src/lib/narrative-beats/plan';
import type {NarrativeBeatV1} from '../src/lib/narrative-beats/schema';
import {
  buildVisualIntentPlan,
  classifyVisualIntentCandidate,
  getVisualIntentArtifact,
  listVisualIntentCandidates,
  setVisualIntentProviderForTest,
  VisualIntentError,
  type BuildVisualIntentResult,
} from '../src/lib/visual-intent/plan';
import {
  VISUAL_INTENT_KIND,
  visualIntentPlanArtifactV1Schema,
  visualIntentProposalSchema,
  type VisualIntentV1,
} from '../src/lib/visual-intent/schema';
import {validateVisualIntentPlan} from '../src/lib/visual-intent/validate';
import {getM7PipelineSnapshotId, getPipelineVersion} from '../src/lib/pipeline-version';
import {GET as visualGET, POST as visualPOST} from '../src/app/api/projects/[id]/visual-intents/route';
import {GET as visualDetailGET} from '../src/app/api/projects/[id]/visual-intents/[artifactId]/route';

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

async function expectVisualError(code: string, fn: () => unknown, label: string): Promise<void> {
  try {
    await fn();
    ok(false, label, '意外成功（应抛错）');
  } catch (err) {
    ok(
      err instanceof VisualIntentError && err.code === code,
      label,
      err instanceof Error ? `${err.name}: ${(err as {code?: string}).code ?? err.message}` : err,
    );
  }
}

type SucceededResult = Extract<BuildVisualIntentResult, {kind: 'succeeded'}>;

function asSucceeded(result: BuildVisualIntentResult, label: string): SucceededResult {
  ok(result.kind === 'succeeded', label, result.kind === 'succeeded' ? undefined : result);
  return result as SucceededResult;
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

/** 可阻塞 Mock Provider：generate 停在 Promise barrier 上，release() 后放行。 */
class BlockableProvider implements LLMProvider {
  readonly name = 'blockable-mock';
  readonly requests: LLMRequest[] = [];
  private gate: Promise<void> | null = null;
  private releaseFn: (() => void) | null = null;

  constructor(private readonly text: string) {}

  arm(): void {
    this.gate = new Promise((resolve) => {
      this.releaseFn = resolve;
    });
  }

  release(): void {
    this.releaseFn?.();
    this.gate = null;
    this.releaseFn = null;
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const respond = (): LLMResponse => ({
      text: this.text,
      requestId: `blk-${this.requests.length}`,
      model: request.model,
      finishReason: 'stop',
      usage: {promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, completionTokens: 50},
    });
    if (this.gate) return this.gate.then(respond);
    return Promise.resolve(respond());
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

function newProjectWithScript(content: string, promptVersion: string): string {
  const projectId = createProjectWithWorkflow({topic: 'm73a', coreQuestion: 'q'}).project.id;
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

function beatsProposalJson(beats: NarrativeBeatV1[]): string {
  return JSON.stringify({beats});
}

/**
 * 每个 beat 独立成 intent 的合法基线（0 个 unresolved → eligible）：
 * V001 SHOW_PERSON / V002 CONTINUE_PREVIOUS_VISUAL(→V001) / V003 SHOW_PLACE /
 * V004 EMPHASIZE_TEXT(spoken_exact=N004) / V005 SHOW_DATA / V006 NO_VISUAL_CHANGE(→V005)。
 */
function makeValidIntents(plan: NarrationPlanV2): VisualIntentV1[] {
  const n4 = plan.units[3]!;
  if (n4.kind !== 'speech') throw new Error('fixture: N004 必须是 speech');
  return [
    {
      visualIntentId: 'V001',
      chapter: 1,
      beatIds: ['B001'],
      intent: 'SHOW_PERSON',
      strategy: 'portrait',
      authenticity: 'authentic_required',
      objective: '展示讲述者形象。',
      subject: {kind: 'person', label: '讲述者', evidenceIds: []},
      continuationOfVisualIntentId: null,
      displayText: null,
    },
    {
      visualIntentId: 'V002',
      chapter: 1,
      beatIds: ['B002'],
      intent: 'CONTINUE_PREVIOUS_VISUAL',
      strategy: 'continue_previous',
      authenticity: 'inherited',
      objective: '停顿期间保持人物画面。',
      subject: {kind: 'none', label: null, evidenceIds: []},
      continuationOfVisualIntentId: 'V001',
      displayText: null,
    },
    {
      visualIntentId: 'V003',
      chapter: 1,
      beatIds: ['B003'],
      intent: 'SHOW_PLACE',
      strategy: 'archive_photo',
      authenticity: 'authentic_required',
      objective: '展示事发地点旧照。',
      subject: {kind: 'place', label: '旧城区', evidenceIds: []},
      continuationOfVisualIntentId: null,
      displayText: null,
    },
    {
      visualIntentId: 'V004',
      chapter: 2,
      beatIds: ['B004'],
      intent: 'EMPHASIZE_TEXT',
      strategy: 'title_card',
      authenticity: 'not_applicable',
      objective: '关键句上屏强调。',
      subject: {kind: 'text', label: null, evidenceIds: []},
      continuationOfVisualIntentId: null,
      displayText: {sourceKind: 'spoken_exact', sourceUnitId: n4.id, sourceChapter: null, text: n4.spokenText},
    },
    {
      visualIntentId: 'V005',
      chapter: 2,
      beatIds: ['B005'],
      intent: 'SHOW_DATA',
      strategy: 'mg_data',
      authenticity: 'not_applicable',
      objective: '用数据图说明规模。',
      subject: {kind: 'data', label: '规模对比', evidenceIds: []},
      continuationOfVisualIntentId: null,
      displayText: null,
    },
    {
      visualIntentId: 'V006',
      chapter: 2,
      beatIds: ['B006'],
      intent: 'NO_VISUAL_CHANGE',
      strategy: 'hold',
      authenticity: 'inherited',
      objective: '收束时保持数据图。',
      subject: {kind: 'none', label: null, evidenceIds: []},
      continuationOfVisualIntentId: 'V005',
      displayText: null,
    },
  ];
}

function proposalJson(intents: VisualIntentV1[]): string {
  return JSON.stringify({intents});
}

function cloneIntents(intents: VisualIntentV1[]): VisualIntentV1[] {
  return intents.map((i) => ({
    ...i,
    beatIds: [...i.beatIds],
    subject: {...i.subject, evidenceIds: [...i.subject.evidenceIds]},
    displayText: i.displayText === null ? null : {...i.displayText},
  }));
}

function usageCount(projectId: string, stage = 'm7_visual_intent'): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM llm_usage WHERE project_id = ? AND stage = ?`)
    .get(projectId, stage) as {c: number};
  return row.c;
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
       WHERE project_id = ? AND stage = 'm7_visual_intent' AND request_id = ?`,
    )
    .get(projectId, requestId) as RunRowProbe | undefined;
}

function visualRows(projectId: string): Array<{id: string; version: number}> {
  return getDb()
    .prepare(`SELECT id, version FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version ASC`)
    .all(projectId, VISUAL_INTENT_KIND) as Array<{id: string; version: number}>;
}

async function main(): Promise<void> {
  // ============ 公共 fixture：projectA + narration plan + beats candidate ============
  const projectA = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
  const buildA = buildNarrationPlanV2(projectA);
  const planA = buildA.plan;
  const beatsProvider = new ScriptableProvider();
  const validBeats = makeValidBeats(planA);
  beatsProvider.push({text: beatsProposalJson(validBeats)});
  const beatsBuildA = await buildNarrativeBeats({
    projectId: projectA,
    narrationPlanV2ArtifactId: buildA.artifact.id,
    requestId: 'req-m73a-beatsA',
    provider: beatsProvider,
  });
  ok(beatsBuildA.kind === 'succeeded', '[setup] beats candidate 构建成功', beatsBuildA);
  const beatsArtifactA = beatsBuildA.kind === 'succeeded' ? beatsBuildA.artifact.id : '';
  const validIntents = makeValidIntents(planA);
  const chapterTitles = new Map(planA.chapters.map((c) => [c.chapter, c.title] as const));
  const n4 = planA.units[3]!;
  const n4Speech = n4.kind === 'speech' ? n4 : null;

  const provider = new ScriptableProvider();

  // ============ A：schema ============
  {
    const artifact = {
      schemaVersion: 'visual-intent-plan@1.0',
      compilerVersion: '1.0',
      promptVersion: 'visual-intent-plan@1.0',
      source: {
        narrativeBeatsArtifactId: beatsArtifactA,
        narrativeBeatsContentHash: `sha256:${'a'.repeat(64)}`,
        narrativeBeatsSchemaVersion: 'narrative-beats@1.0',
        narrativeBeatsCompilerVersion: '1.0',
        narrationPlanV2ArtifactId: buildA.artifact.id,
        narrationPlanV2ContentHash: `sha256:${'b'.repeat(64)}`,
        scriptV2VersionId: planA.source.scriptV2VersionId,
        scriptV2ContentHash: planA.source.scriptV2ContentHash,
      },
      generation: {requestId: 'r1', provider: 'mock', model: 'm', attemptCount: 1},
      intents: validIntents,
    };
    ok(visualIntentPlanArtifactV1Schema.safeParse(artifact).success, '[A1] 完整合法 artifact 通过');
    ok(
      !visualIntentPlanArtifactV1Schema.safeParse({...artifact, extra: 1}).success,
      '[A2] 顶层未知字段 → strict 拒绝',
    );
    for (const field of ['sequenceId', 'shotId', 'sceneId', 'assetId', 'startMs', 'durationMs', 'transition', 'resolvedAsset']) {
      ok(
        !visualIntentPlanArtifactV1Schema.safeParse({
          ...artifact,
          intents: [{...validIntents[0]!, [field]: 'x'}],
        }).success,
        `[A3] intent 含禁止字段 ${field} → 拒绝`,
      );
    }
    ok(
      !visualIntentPlanArtifactV1Schema.safeParse({
        ...artifact,
        intents: [{...validIntents[0]!, intent: 'SHOW_THING'}],
      }).success,
      '[A4] intent 枚举越界 → 拒绝',
    );
    ok(
      !visualIntentPlanArtifactV1Schema.safeParse({
        ...artifact,
        intents: [{...validIntents[0]!, strategy: 'mg_magic'}],
      }).success,
      '[A5] strategy 枚举越界 → 拒绝',
    );
    ok(
      !visualIntentPlanArtifactV1Schema.safeParse({
        ...artifact,
        intents: [{...validIntents[0]!, authenticity: 'whatever'}],
      }).success,
      '[A6] authenticity 枚举越界 → 拒绝',
    );
    ok(
      !visualIntentPlanArtifactV1Schema.safeParse({
        ...artifact,
        intents: [{...validIntents[0]!, visualIntentId: 'V1'}],
      }).success,
      '[A7] visualIntentId 格式非法 → 拒绝',
    );
    ok(
      !visualIntentPlanArtifactV1Schema.safeParse({
        ...artifact,
        source: {...artifact.source, narrativeBeatsContentHash: 'md5:abc'},
      }).success,
      '[A8] source hash 格式非法 → 拒绝',
    );
    const {source: _s, ...noSource} = artifact;
    ok(!visualIntentPlanArtifactV1Schema.safeParse(noSource).success, '[A9] 缺 source → 拒绝');
    ok(
      !visualIntentPlanArtifactV1Schema.safeParse({
        ...artifact,
        intents: [
          {
            ...validIntents[3]!,
            displayText: {...validIntents[3]!.displayText!, extraField: 1},
          },
        ],
      }).success,
      '[A10] displayText 含未知字段 → strict 拒绝',
    );
    ok(
      !visualIntentPlanArtifactV1Schema.safeParse({
        ...artifact,
        intents: [{...validIntents[3]!, displayText: {sourceKind: 'paraphrase', sourceUnitId: null, sourceChapter: null, text: 'x'}}],
      }).success,
      '[A11] displayText.sourceKind 越界 → 拒绝',
    );
    ok(
      !visualIntentPlanArtifactV1Schema.safeParse({
        ...artifact,
        intents: [{...validIntents[0]!, objective: 'x'.repeat(241)}],
      }).success,
      '[A12] objective 超长 → 拒绝',
    );
    ok(
      !visualIntentPlanArtifactV1Schema.safeParse({
        ...artifact,
        intents: [{...validIntents[0]!, subject: {kind: 'person', label: 'x'.repeat(121), evidenceIds: []}}],
      }).success,
      '[A13] subject.label 超长 → 拒绝',
    );
    ok(
      !visualIntentPlanArtifactV1Schema.safeParse({
        ...artifact,
        intents: [{...validIntents[0]!, beatIds: []}],
      }).success,
      '[A14] beatIds 为空 → 拒绝',
    );
    ok(
      !visualIntentProposalSchema.safeParse({intents: validIntents, note: 'x'}).success,
      '[A15] LLM proposal 含额外字段 → 拒绝',
    );
  }

  // ============ B：beat coverage ============
  {
    ok(validateVisualIntentPlan(validBeats, planA, validIntents).length === 0, '[B1] 合法基线 → 0 issues');

    const dup = cloneIntents(validIntents);
    dup[2] = {...dup[2]!, beatIds: ['B002', 'B003']};
    ok(
      validateVisualIntentPlan(validBeats, planA, dup).some((i) => i.code === 'DUPLICATE_BEAT'),
      '[B2] 重复 beat → DUPLICATE_BEAT',
    );

    const missing = cloneIntents(validIntents).filter((_, i) => i !== 5).map((v, i) => ({
      ...v,
      visualIntentId: `V${String(i + 1).padStart(3, '0')}`,
    }));
    ok(
      validateVisualIntentPlan(validBeats, planA, missing).some((i) => i.code === 'MISSING_BEAT'),
      '[B3] 遗漏 beat → MISSING_BEAT',
    );

    const unknown = cloneIntents(validIntents);
    unknown[0] = {...unknown[0]!, beatIds: ['B001', 'B999']};
    ok(
      validateVisualIntentPlan(validBeats, planA, unknown).some((i) => i.code === 'UNKNOWN_BEAT_ID'),
      '[B4] 不存在 beat → UNKNOWN_BEAT_ID',
    );

    const nonContig = cloneIntents(validIntents);
    nonContig[0] = {...nonContig[0]!, beatIds: ['B001', 'B003']};
    ok(
      validateVisualIntentPlan(validBeats, planA, nonContig).some((i) => i.code === 'NON_CONTIGUOUS_RANGE'),
      '[B5] 非连续 beat range → NON_CONTIGUOUS_RANGE',
    );

    // 两个顺序颠倒的普通 intent：V001=[B003]、V002=[B001] → 全局倒序
    const simpleReorder = [
      {...validIntents[2]!, visualIntentId: 'V001', beatIds: ['B003']},
      {...validIntents[0]!, visualIntentId: 'V002', beatIds: ['B001']},
      ...cloneIntents(validIntents).slice(1, 2).map((v) => ({...v, visualIntentId: 'V003'})),
      ...cloneIntents(validIntents).slice(3).map((v, i) => ({...v, visualIntentId: `V${String(i + 4).padStart(3, '0')}`})),
    ];
    ok(
      validateVisualIntentPlan(validBeats, planA, simpleReorder).some((i) => i.code === 'INTENT_ORDER'),
      '[B6] intents 全局顺序错 → INTENT_ORDER',
    );

    const crossChapter = cloneIntents(validIntents);
    crossChapter[2] = {...crossChapter[2]!, beatIds: ['B003', 'B004']};
    const crossIssues = validateVisualIntentPlan(validBeats, planA, crossChapter);
    ok(crossIssues.some((i) => i.code === 'CROSS_CHAPTER'), '[B7] 跨 chapter intent → CROSS_CHAPTER');

    const wrongChapter = cloneIntents(validIntents);
    wrongChapter[0] = {...wrongChapter[0]!, chapter: 2};
    ok(
      validateVisualIntentPlan(validBeats, planA, wrongChapter).some((i) => i.code === 'CHAPTER_MISMATCH'),
      '[B8] chapter 字段错误 → CHAPTER_MISMATCH',
    );

    const badSeq = cloneIntents(validIntents);
    badSeq[1] = {...badSeq[1]!, visualIntentId: 'V003'};
    ok(
      validateVisualIntentPlan(validBeats, planA, badSeq).some((i) => i.code === 'INTENT_ID_SEQUENCE'),
      '[B9] visualIntentId 不连续 → INTENT_ID_SEQUENCE',
    );

    const emptyBeats = cloneIntents(validIntents);
    emptyBeats[0] = {...emptyBeats[0]!, beatIds: []};
    ok(
      validateVisualIntentPlan(validBeats, planA, emptyBeats).some((i) => i.code === 'EMPTY_BEAT_IDS'),
      '[B10] beatIds 为空 → EMPTY_BEAT_IDS',
    );
  }

  // ============ C：矩阵 + displayText + continuation ============
  {
    const swapV001 = (patch: Partial<VisualIntentV1>): VisualIntentV1[] => {
      const intents = cloneIntents(validIntents);
      intents[0] = {...intents[0]!, ...patch};
      return intents;
    };
    const codes = (intents: VisualIntentV1[]): string[] =>
      validateVisualIntentPlan(validBeats, planA, intents).map((i) => i.code);

    // C1-C2 SHOW_PERSON 合法 strategy
    ok(codes(validIntents).length === 0, '[C1] SHOW_PERSON+portrait 正例');
    ok(
      codes(swapV001({strategy: 'archive_photo'})).length === 0,
      '[C2] SHOW_PERSON+archive_photo 正例',
    );
    ok(
      codes(swapV001({strategy: 'mg_process'})).includes('STRATEGY_MISMATCH'),
      '[C3] SHOW_PERSON+mg_process → STRATEGY_MISMATCH',
    );
    ok(
      codes(swapV001({authenticity: 'synthetic_allowed'})).includes('AUTHENTICITY_MISMATCH'),
      '[C4] SHOW_PERSON+synthetic_allowed → AUTHENTICITY_MISMATCH',
    );
    ok(
      codes(swapV001({subject: {kind: 'place', label: null, evidenceIds: []}})).includes('SUBJECT_KIND_MISMATCH'),
      '[C5] SHOW_PERSON subject.kind≠person → SUBJECT_KIND_MISMATCH',
    );

    // C6-C11 其余 SHOW_* 正例（换 V003）
    const swapV003 = (patch: Partial<VisualIntentV1>): VisualIntentV1[] => {
      const intents = cloneIntents(validIntents);
      intents[2] = {...intents[2]!, ...patch};
      return intents;
    };
    ok(
      codes(swapV003({strategy: 'archive_video'})).length === 0,
      '[C6] SHOW_PLACE+archive_video 正例',
    );
    ok(
      codes(swapV003({intent: 'SHOW_ARCHIVE', strategy: 'archive_video'})).length === 0,
      '[C7] SHOW_ARCHIVE+archive_video 正例',
    );
    ok(
      codes(swapV003({intent: 'SHOW_DOCUMENT', strategy: 'document_frame', subject: {kind: 'document', label: '档案', evidenceIds: []}})).length === 0,
      '[C8] SHOW_DOCUMENT+document_frame 正例',
    );
    ok(
      codes(swapV003({intent: 'SHOW_EVIDENCE', strategy: 'evidence_frame', subject: {kind: 'evidence', label: null, evidenceIds: ['E1']}})).length === 0,
      '[C9] SHOW_EVIDENCE+evidence_frame 正例',
    );
    ok(
      codes(swapV003({intent: 'SHOW_EXAMPLE', strategy: 'real_world_example', authenticity: 'authentic_preferred', subject: {kind: 'example', label: null, evidenceIds: []}})).length === 0,
      '[C10] SHOW_EXAMPLE+real_world_example 正例',
    );
    ok(
      codes(swapV003({intent: 'SHOW_PROCESS', strategy: 'mg_process', authenticity: 'not_applicable', subject: {kind: 'process', label: null, evidenceIds: []}})).length === 0 &&
        codes(swapV003({intent: 'SHOW_RELATIONSHIP', strategy: 'mg_relationship', authenticity: 'not_applicable', subject: {kind: 'relationship', label: null, evidenceIds: []}})).length === 0 &&
        codes(swapV003({intent: 'SHOW_COMPARISON', strategy: 'mg_comparison', authenticity: 'not_applicable', subject: {kind: 'comparison', label: null, evidenceIds: []}})).length === 0,
      '[C11] SHOW_PROCESS/RELATIONSHIP/COMPARISON MG 正例',
    );
    ok(
      codes(swapV003({authenticity: 'authentic_preferred'})).includes('AUTHENTICITY_MISMATCH'),
      '[C12] SHOW_PLACE authenticity≠authentic_required → AUTHENTICITY_MISMATCH',
    );
    ok(
      codes(swapV003({intent: 'SHOW_DOCUMENT', strategy: 'archive_photo'})).includes('STRATEGY_MISMATCH'),
      '[C13] SHOW_DOCUMENT+archive_photo → STRATEGY_MISMATCH',
    );

    // C14-C21 EMPHASIZE_TEXT / displayText
    ok(codes(validIntents).length === 0, '[C14] EMPHASIZE_TEXT spoken_exact 正例（基线 V004）');
    const swapV004 = (patch: Partial<VisualIntentV1>): VisualIntentV1[] => {
      const intents = cloneIntents(validIntents);
      intents[3] = {...intents[3]!, ...patch};
      return intents;
    };
    ok(
      n4Speech !== null &&
        codes(
          swapV004({
            displayText: {
              sourceKind: 'subtitle_exact',
              sourceUnitId: n4.id,
              sourceChapter: null,
              text: n4Speech.subtitleText ?? '__none__',
            },
          }),
        ).length === 0,
      '[C15] EMPHASIZE_TEXT subtitle_exact 正例',
    );
    ok(
      codes(
        swapV004({
          displayText: {
            sourceKind: 'chapter_title',
            sourceUnitId: null,
            sourceChapter: 2,
            text: chapterTitles.get(2) ?? '__none__',
          },
        }),
      ).length === 0,
      '[C16] EMPHASIZE_TEXT chapter_title 正例',
    );
    ok(
      codes(
        swapV004({
          displayText: {sourceKind: 'spoken_exact', sourceUnitId: n4.id, sourceChapter: null, text: '改写的文本'},
        }),
      ).includes('DISPLAY_TEXT_MISMATCH'),
      '[C17] displayText 与引用源不一致 → DISPLAY_TEXT_MISMATCH',
    );
    ok(
      codes(
        swapV004({
          displayText: {sourceKind: 'spoken_exact', sourceUnitId: n4.id, sourceChapter: null, text: validBeats[3]!.summary},
        }),
      ).includes('DISPLAY_TEXT_BEAT_COPY'),
      '[C18] displayText=beat.summary → DISPLAY_TEXT_BEAT_COPY',
    );
    ok(
      codes(
        swapV001({
          displayText: {sourceKind: 'spoken_exact', sourceUnitId: planA.units[0]!.id, sourceChapter: null, text: '第一句。第二句。'},
        }),
      ).includes('DISPLAY_TEXT_FORBIDDEN'),
      '[C19] 非 EMPHASIZE_TEXT 带 displayText → DISPLAY_TEXT_FORBIDDEN',
    );
    ok(
      codes(swapV004({displayText: null})).includes('DISPLAY_TEXT_REQUIRED'),
      '[C20] EMPHASIZE_TEXT displayText=null → DISPLAY_TEXT_REQUIRED',
    );
    ok(
      codes(swapV004({strategy: 'mg_data'})).includes('STRATEGY_MISMATCH') &&
        codes(swapV004({authenticity: 'authentic_required'})).includes('AUTHENTICITY_MISMATCH'),
      '[C21] EMPHASIZE_TEXT strategy/authenticity 越界 → 拒绝',
    );

    // C22-C27 continuation 链
    ok(
      codes(
        swapV001({
          intent: 'CONTINUE_PREVIOUS_VISUAL',
          strategy: 'continue_previous',
          authenticity: 'inherited',
          subject: {kind: 'none', label: null, evidenceIds: []},
          continuationOfVisualIntentId: 'V001',
        }),
      ).includes('CONTINUATION_FIRST'),
      '[C22] V001 为 CONTINUE_PREVIOUS_VISUAL → CONTINUATION_FIRST',
    );
    const withUnresolvedV005 = (): VisualIntentV1[] => {
      const intents = cloneIntents(validIntents);
      intents[4] = {
        ...intents[4]!,
        intent: 'VISUAL_UNRESOLVED',
        strategy: 'unresolved',
        authenticity: 'not_applicable',
        subject: {kind: 'none', label: null, evidenceIds: []},
        continuationOfVisualIntentId: null,
      };
      return intents;
    };
    ok(
      codes(withUnresolvedV005()).includes('CONTINUATION_TARGET'),
      '[C23] continuation 指向 unresolved（V006→V005）→ CONTINUATION_TARGET',
    );
    const skipMiddle = cloneIntents(validIntents);
    skipMiddle[5] = {...skipMiddle[5]!, continuationOfVisualIntentId: 'V001'};
    ok(
      codes(skipMiddle).includes('CONTINUATION_TARGET'),
      '[C24] continuation 跳过中间普通 intent 引用更早 → CONTINUATION_TARGET',
    );
    const contSubject = cloneIntents(validIntents);
    contSubject[1] = {...contSubject[1]!, subject: {kind: 'person', label: 'x', evidenceIds: []}};
    ok(
      codes(contSubject).includes('SUBJECT_KIND_MISMATCH'),
      '[C25] continuation subject.kind≠none → SUBJECT_KIND_MISMATCH',
    );
    const contNull = cloneIntents(validIntents);
    contNull[1] = {...contNull[1]!, continuationOfVisualIntentId: null};
    ok(
      codes(contNull).includes('CONTINUATION_REQUIRED'),
      '[C26] continuation 缺 continuationOfVisualIntentId → CONTINUATION_REQUIRED',
    );
    const badUnresolved = withUnresolvedV005();
    // unresolved intent 自身携带 displayText + continuationOfVisualIntentId
    badUnresolved[4] = {
      ...badUnresolved[4]!,
      continuationOfVisualIntentId: 'V003',
      displayText: {sourceKind: 'spoken_exact', sourceUnitId: n4.id, sourceChapter: null, text: 'x'},
    };
    // V006 指向最近合法目标 V004（隔离 unresolved 自身的问题）
    badUnresolved[5] = {...badUnresolved[5]!, continuationOfVisualIntentId: 'V004'};
    const badUnresolvedCodes = codes(badUnresolved);
    ok(
      badUnresolvedCodes.includes('DISPLAY_TEXT_FORBIDDEN') && badUnresolvedCodes.includes('CONTINUATION_FORBIDDEN'),
      '[C27] unresolved 带 displayText/continuation → 拒绝',
      badUnresolvedCodes,
    );
    const unresolvedBadStrategy = withUnresolvedV005();
    unresolvedBadStrategy[4] = {...unresolvedBadStrategy[4]!, strategy: 'mg_data'};
    unresolvedBadStrategy[5] = {...unresolvedBadStrategy[5]!, continuationOfVisualIntentId: 'V004'};
    ok(
      codes(unresolvedBadStrategy).includes('STRATEGY_MISMATCH'),
      '[C28] unresolved strategy≠unresolved → STRATEGY_MISMATCH',
    );

    // C29-C31 泄漏 + 误杀防护 + forbidden 字段
    const leakyObjective = cloneIntents(validIntents);
    leakyObjective[0] = {...leakyObjective[0]!, objective: '（停顿0.5秒）这里要放慢'};
    ok(
      codes(leakyObjective).includes('OBJECTIVE_LEAKAGE'),
      '[C29] objective 指令泄漏 → OBJECTIVE_LEAKAGE',
    );
    const leakyLabel = cloneIntents(validIntents);
    leakyLabel[0] = {...leakyLabel[0]!, subject: {kind: 'person', label: '旁白：此处收束', evidenceIds: []}};
    ok(
      codes(leakyLabel).includes('SUBJECT_LABEL_LEAKAGE'),
      '[C30] subject.label 指令泄漏 → SUBJECT_LABEL_LEAKAGE',
    );
    const normal = cloneIntents(validIntents);
    normal[0] = {...normal[0]!, objective: '谈话中出现了短暂停顿，随后给出结论。'};
    ok(codes(normal).length === 0, '[C31] 正常语义「停顿」不误杀');
    const forbidden = cloneIntents(validIntents) as Array<VisualIntentV1 & {shotId?: string}>;
    forbidden[0]!.shotId = 'SH1';
    ok(
      validateVisualIntentPlan(validBeats, planA, forbidden).some((i) => i.code === 'FORBIDDEN_FIELD'),
      '[C32] intent 含禁止字段 shotId → FORBIDDEN_FIELD',
    );
  }

  // ============ D：input isolation ============
  {
    await expectVisualError(
      'BEATS_NOT_FOUND',
      () => buildVisualIntentPlan({projectId: projectA, narrativeBeatsArtifactId: crypto.randomUUID(), requestId: 'req-m73a-d001'}),
      '[D1] 不存在的 beats artifact → BEATS_NOT_FOUND',
    );
    // 跨项目 beats artifact
    const projectX = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const buildX = buildNarrationPlanV2(projectX);
    beatsProvider.push({text: beatsProposalJson(makeValidBeats(buildX.plan))});
    const beatsX = await buildNarrativeBeats({
      projectId: projectX,
      narrationPlanV2ArtifactId: buildX.artifact.id,
      requestId: 'req-m73a-beatsX',
      provider: beatsProvider,
    });
    const beatsXId = beatsX.kind === 'succeeded' ? beatsX.artifact.id : '';
    await expectVisualError(
      'BEATS_NOT_FOUND',
      () => buildVisualIntentPlan({projectId: projectA, narrativeBeatsArtifactId: beatsXId, requestId: 'req-m73a-d002'}),
      '[D2] 跨项目 beats artifact → BEATS_NOT_FOUND',
    );
    await expectVisualError(
      'BEATS_NOT_FOUND',
      () => buildVisualIntentPlan({projectId: projectA, narrativeBeatsArtifactId: buildA.artifact.id, requestId: 'req-m73a-d003'}),
      '[D3] kind 不符（narration artifact ID）→ BEATS_NOT_FOUND',
    );
    // stale beats：projectX 演进 script → narration stale → beats stale → 拒绝
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
    const beatsXRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(beatsXId) as never;
    ok(
      classifyNarrativeBeatsCandidate(projectX, beatsXRow).status === 'stale',
      '[D4a] fixture：projectX beats 已 stale',
    );
    await expectVisualError(
      'BEATS_NOT_ELIGIBLE',
      () => buildVisualIntentPlan({projectId: projectX, narrativeBeatsArtifactId: beatsXId, requestId: 'req-m73a-d004'}),
      '[D4b] stale beats → BEATS_NOT_ELIGIBLE（不 fallback latest）',
    );
    // invalid beats：破坏覆盖 → 拒绝
    const projectW = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const buildW = buildNarrationPlanV2(projectW);
    beatsProvider.push({text: beatsProposalJson(makeValidBeats(buildW.plan))});
    const beatsW = await buildNarrativeBeats({
      projectId: projectW,
      narrationPlanV2ArtifactId: buildW.artifact.id,
      requestId: 'req-m73a-beatsW',
      provider: beatsProvider,
    });
    const beatsWId = beatsW.kind === 'succeeded' ? beatsW.artifact.id : '';
    const beatsWRef = getNarrativeBeatsArtifact(projectW, beatsWId)!;
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run(JSON.stringify({...beatsWRef.beats, beats: beatsWRef.beats.beats.slice(0, 5)}), beatsWId);
    const beatsWRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(beatsWId) as never;
    ok(
      classifyNarrativeBeatsCandidate(projectW, beatsWRow).status === 'invalid',
      '[D5a] fixture：projectW beats 覆盖损坏 → invalid',
    );
    await expectVisualError(
      'BEATS_NOT_ELIGIBLE',
      () => buildVisualIntentPlan({projectId: projectW, narrativeBeatsArtifactId: beatsWId, requestId: 'req-m73a-d005'}),
      '[D5b] invalid beats → BEATS_NOT_ELIGIBLE',
    );
    await expectVisualError(
      'REQUEST_ID_REQUIRED',
      () => buildVisualIntentPlan({projectId: projectA, narrativeBeatsArtifactId: beatsArtifactA, requestId: '  '}),
      '[D6] 空 requestId → REQUEST_ID_REQUIRED',
    );
  }

  // ============ E：durable generation ============
  let visualArtifactId = '';
  {
    provider.push({text: proposalJson(validIntents)});
    const r1 = asSucceeded(
      await buildVisualIntentPlan({
        projectId: projectA,
        narrativeBeatsArtifactId: beatsArtifactA,
        requestId: 'req-m73a-e001',
        provider,
      }),
      '[E1a] build 返回 kind=succeeded',
    );
    ok(!r1.reused && r1.visualIntent.intents.length === 6, '[E1] 合法 proposal 一次通过');
    ok(r1.visualIntent.generation.attemptCount === 1, '[E2] attemptCount=1');
    ok(usageCount(projectA) === 1, '[E3] usage 记录恰好 1 行（真实 attempts）');
    const runE1 = runRow(projectA, 'req-m73a-e001');
    ok(
      runE1 !== undefined && runE1.status === 'succeeded' && runE1.id === r1.runId,
      '[E4] generation_runs 行转 succeeded（stage=m7_visual_intent）',
      runE1,
    );
    visualArtifactId = r1.artifact.id;
    // provenance 完整性
    ok(
      r1.visualIntent.source.narrativeBeatsArtifactId === beatsArtifactA &&
        r1.visualIntent.source.narrationPlanV2ArtifactId === buildA.artifact.id &&
        r1.visualIntent.source.scriptV2VersionId === planA.source.scriptV2VersionId,
      '[E5] artifact provenance 携带 beats+narration+script 精确引用',
    );

    // prompt 内容隔离
    const reqText = provider.requests.map((r) => `${r.system}\n${r.user}`).join('\n');
    ok(!reqText.includes('sourceText'), '[E6a] prompt 不含 sourceText 字段');
    ok(!reqText.includes('@silence'), '[E6b] prompt 不含 raw DSL directive');
    ok(!reqText.includes('visual_breakdown') && !reqText.includes('shot_list'), '[E6c] prompt 不含下游 stage 内容');
    ok(reqText.includes('B001') && reqText.includes('节拍 1'), '[E6d] prompt 含 beats 投影');
    ok(reqText.includes('第一句'), '[E6e] prompt 含 sanitized spokenText（displayText 引用源）');

    // 真实并发 single-flight（可阻塞 barrier）
    const blockable = new BlockableProvider(proposalJson(validIntents));
    blockable.arm();
    const p1 = buildVisualIntentPlan({
      projectId: projectA,
      narrativeBeatsArtifactId: beatsArtifactA,
      requestId: 'req-m73a-e002',
      provider: blockable,
    });
    // 等 p1 完成 claim 并停在 provider barrier 上
    await new Promise((resolve) => setTimeout(resolve, 50));
    const callsBeforeC2 = blockable.requests.length;
    const p2 = await buildVisualIntentPlan({
      projectId: projectA,
      narrativeBeatsArtifactId: beatsArtifactA,
      requestId: 'req-m73a-e002',
      provider: blockable,
    });
    ok(p2.kind === 'in_progress', '[E7a] 并发同 requestId → 后到者 in_progress', p2);
    blockable.release();
    const r2 = asSucceeded(await p1, '[E7b] 先到者 succeeded');
    ok(!r2.reused, '[E7c] 先到者真实生成');
    ok(blockable.requests.length === callsBeforeC2, '[E8] 并发全程 provider 恰好 1 次调用（single-flight）');
    ok(usageCount(projectA) === 2, '[E9] 并发恰好 1 行新 usage（无双计费）');

    // 同 requestId 复用零成本
    const usageBefore = usageCount(projectA);
    const callsBefore = provider.requests.length;
    const again = asSucceeded(
      await buildVisualIntentPlan({
        projectId: projectA,
        narrativeBeatsArtifactId: beatsArtifactA,
        requestId: 'req-m73a-e001',
        provider,
      }),
      '[E10a] 同 requestId build 返回 kind=succeeded',
    );
    ok(again.reused && again.artifact.id === visualArtifactId, '[E10] 同 requestId → 复用同 artifact');
    ok(usageCount(projectA) === usageBefore && provider.requests.length === callsBefore, '[E11] 复用零 provider 调用零 usage');

    // repair：第一次输出重复 beat → repair 成功
    const dupIntents = cloneIntents(validIntents);
    dupIntents[2] = {...dupIntents[2]!, beatIds: ['B002', 'B003']};
    provider.push({text: proposalJson(dupIntents)});
    provider.push({text: proposalJson(validIntents)});
    const repaired = asSucceeded(
      await buildVisualIntentPlan({
        projectId: projectA,
        narrativeBeatsArtifactId: beatsArtifactA,
        requestId: 'req-m73a-e003',
        provider,
      }),
      '[E12a] repair build 返回 kind=succeeded',
    );
    ok(repaired.visualIntent.generation.attemptCount === 2, '[E12] 重复 beat → repair 第 2 次成功');
    const repairReq = provider.requests[provider.requests.length - 1]!;
    ok(repairReq.user.includes('DUPLICATE_BEAT'), '[E13] repair prompt 携带精确 validation errors');
    ok(usageCount(projectA) === usageBefore + 2, '[E14] repair usage=真实 attempts（2）');

    // 三次仍失败 → terminal VALIDATION_FAILED；同 requestId 重试同终态零调用
    for (let i = 0; i < 3; i++) {
      provider.push({text: proposalJson(cloneIntents(validIntents).slice(0, 5))});
    }
    const failed = await buildVisualIntentPlan({
      projectId: projectA,
      narrativeBeatsArtifactId: beatsArtifactA,
      requestId: 'req-m73a-e004',
      provider,
    });
    ok(
      failed.kind === 'terminal' && failed.status === 'failed' && failed.errorCode === 'VALIDATION_FAILED',
      '[E15] 两次 repair 仍失败 → terminal VALIDATION_FAILED',
      failed,
    );
    ok(visualRows(projectA).length === 3, '[E16] 失败 generation 不产生 artifact');
    const callsBeforeRetry = provider.requests.length;
    const usageBeforeRetry = usageCount(projectA);
    const retrySame = await buildVisualIntentPlan({
      projectId: projectA,
      narrativeBeatsArtifactId: beatsArtifactA,
      requestId: 'req-m73a-e004',
      provider,
    });
    ok(
      retrySame.kind === 'terminal' && retrySame.errorCode === 'VALIDATION_FAILED',
      '[E17] 失败 requestId 再调 → 同一 terminal（不自动重试）',
    );
    ok(
      provider.requests.length === callsBeforeRetry && usageCount(projectA) === usageBeforeRetry,
      '[E18] 终态复用零 provider 调用零 usage',
    );
    provider.push({text: proposalJson(validIntents)});
    const retry = asSucceeded(
      await buildVisualIntentPlan({
        projectId: projectA,
        narrativeBeatsArtifactId: beatsArtifactA,
        requestId: 'req-m73a-e005',
        provider,
      }),
      '[E19a] 新 requestId regenerate build 返回 kind=succeeded',
    );
    ok(!retry.reused && retry.visualIntent.generation.attemptCount === 1, '[E19] 新 requestId regenerate → 成功');

    // transport 失败 → terminal，无 usage 无 artifact
    provider.push({error: new LLMError('PROVIDER_HTTP_ERROR', 'boom', {status: 500})});
    const usageBeforeErr = usageCount(projectA);
    const perr = await buildVisualIntentPlan({
      projectId: projectA,
      narrativeBeatsArtifactId: beatsArtifactA,
      requestId: 'req-m73a-e006',
      provider,
    });
    ok(
      perr.kind === 'terminal' && perr.errorCode === 'PROVIDER_HTTP_ERROR',
      '[E20] provider error → terminal PROVIDER_HTTP_ERROR',
      perr,
    );
    ok(usageCount(projectA) === usageBeforeErr, '[E21] transport 失败不记 usage（不伪造成本）');

    // 空响应 ×3 → EMPTY_RESPONSE；截断 → OUTPUT_TRUNCATED
    provider.push({text: ''});
    provider.push({text: ''});
    provider.push({text: ''});
    const eerr = await buildVisualIntentPlan({
      projectId: projectA,
      narrativeBeatsArtifactId: beatsArtifactA,
      requestId: 'req-m73a-e007',
      provider,
    });
    ok(eerr.kind === 'terminal' && eerr.errorCode === 'EMPTY_RESPONSE', '[E22] 空响应 ×3 → terminal EMPTY_RESPONSE');
    provider.push({text: '{"intents":[', finishReason: 'length'});
    const terr = await buildVisualIntentPlan({
      projectId: projectA,
      narrativeBeatsArtifactId: beatsArtifactA,
      requestId: 'req-m73a-e008',
      provider,
    });
    ok(terr.kind === 'terminal' && terr.errorCode === 'OUTPUT_TRUNCATED', '[E23] finishReason=length → terminal OUTPUT_TRUNCATED');

    // 同 requestId 不同 source → REQUEST_ID_CONFLICT（projectA 第二个 beats candidate）
    beatsProvider.push({text: beatsProposalJson(validBeats)});
    const beatsA2 = await buildNarrativeBeats({
      projectId: projectA,
      narrationPlanV2ArtifactId: buildA.artifact.id,
      requestId: 'req-m73a-beatsA2',
      provider: beatsProvider,
    });
    const beatsA2Id = beatsA2.kind === 'succeeded' ? beatsA2.artifact.id : '';
    await expectVisualError(
      'REQUEST_ID_CONFLICT',
      () =>
        buildVisualIntentPlan({
          projectId: projectA,
          narrativeBeatsArtifactId: beatsA2Id,
          requestId: 'req-m73a-e001',
          provider,
        }),
      '[E24] 同 requestId 不同 source → REQUEST_ID_CONFLICT',
    );
  }

  // ============ API：routes ============
  {
    const listRes = await visualGET(new Request('http://test'), {params: Promise.resolve({id: projectA})});
    ok(listRes.status === 200, '[API1] GET list → 200');
    const listJson = (await listRes.json()) as {
      candidateOnly: boolean;
      pipelineVersion: string;
      beatsCandidates: Array<{artifactId: string; status: string}>;
      latestEligibleBeatsSuggestionArtifactId: string | null;
      candidates: Array<{artifactId: string; status: string; legacyRunMetadataUnavailable: boolean}>;
      runs: Array<{runId: string; requestId: string; status: string; stage: string}>;
    };
    ok(
      listJson.candidateOnly === true && listJson.pipelineVersion === 'm6',
      '[API2] list 响应 candidateOnly + m6',
    );
    ok(
      listJson.candidates.some((c) => c.artifactId === visualArtifactId),
      '[API3] list 含已建 candidate',
    );
    ok(
      listJson.latestEligibleBeatsSuggestionArtifactId !== null &&
        listJson.beatsCandidates.some((b) => b.artifactId === listJson.latestEligibleBeatsSuggestionArtifactId),
      '[API4] latestEligibleBeats 建议仅为建议字段',
    );
    ok(
      Array.isArray(listJson.runs) &&
        listJson.runs.some((r) => r.requestId === 'req-m73a-e001' && r.status === 'succeeded') &&
        listJson.runs.some((r) => r.requestId === 'req-m73a-e004' && r.status === 'failed'),
      '[API5] list 响应含 generation runs（succeeded + failed 均可见）',
    );
    const candidateE1 = listJson.candidates.find((c) => c.artifactId === visualArtifactId);
    ok(
      candidateE1 !== undefined && candidateE1.legacyRunMetadataUnavailable === false,
      '[API6] 有 run 的 candidate legacyRunMetadataUnavailable=false',
    );

    // route 真实新建路径：setVisualIntentProviderForTest 注入 Mock
    const routeProvider = new ScriptableProvider();
    routeProvider.push({text: proposalJson(validIntents)});
    setVisualIntentProviderForTest(routeProvider);
    let createdArtifactId = '';
    try {
      const createRes = await visualPOST(
        new Request('http://test', {
          method: 'POST',
          body: JSON.stringify({narrativeBeatsArtifactId: beatsArtifactA, requestId: 'req-m73a-api01'}),
        }),
        {params: Promise.resolve({id: projectA})},
      );
      ok(createRes.status === 201, '[API7] 新 requestId POST → 201 新建');
      const createJson = (await createRes.json()) as {
        reused: boolean;
        legacy: boolean;
        runId: string | null;
        artifactId: string;
        intentCount: number;
      };
      createdArtifactId = createJson.artifactId;
      ok(
        createJson.reused === false && createJson.legacy === false && createJson.runId !== null && createJson.intentCount === 6,
        '[API8] 201 响应含非空 runId + intentCount（durable run 追溯）',
        createJson,
      );
      ok(routeProvider.requests.length === 1, '[API9] route 新建路径真实调用注入的 provider');

      // route 级 202：可阻塞 provider + 同 requestId 第二次 POST
      const routeBlock = new BlockableProvider(proposalJson(validIntents));
      routeBlock.arm();
      setVisualIntentProviderForTest(routeBlock);
      const pending = visualPOST(
        new Request('http://test', {
          method: 'POST',
          body: JSON.stringify({narrativeBeatsArtifactId: beatsArtifactA, requestId: 'req-m73a-api02'}),
        }),
        {params: Promise.resolve({id: projectA})},
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const dup = await visualPOST(
        new Request('http://test', {
          method: 'POST',
          body: JSON.stringify({narrativeBeatsArtifactId: beatsArtifactA, requestId: 'req-m73a-api02'}),
        }),
        {params: Promise.resolve({id: projectA})},
      );
      ok(dup.status === 202, '[API10] 同 requestId 进行中 POST → 202 in_progress');
      routeBlock.release();
      const done = await pending;
      ok(done.status === 201, '[API11] barrier 放行后首个 POST → 201');
      ok(routeBlock.requests.length === 1, '[API12] route 并发全程 provider 恰好 1 次调用');
    } finally {
      setVisualIntentProviderForTest(null);
    }

    // 同 requestId POST → 200 reused（无 provider 注入也不触达 LLM）
    const rebuildRes = await visualPOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({narrativeBeatsArtifactId: beatsArtifactA, requestId: 'req-m73a-e001'}),
      }),
      {params: Promise.resolve({id: projectA})},
    );
    ok(rebuildRes.status === 200, '[API13] 同 requestId POST → 200 reused');
    const rebuildJson = (await rebuildRes.json()) as {reused: boolean; artifactId: string; candidateOnly: boolean};
    ok(
      rebuildJson.reused === true && rebuildJson.artifactId === visualArtifactId && rebuildJson.candidateOnly === true,
      '[API14] reused 响应：candidateOnly + 同 artifact',
    );

    // terminal run 同 requestId → 409
    const terminalRes = await visualPOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({narrativeBeatsArtifactId: beatsArtifactA, requestId: 'req-m73a-e004'}),
      }),
      {params: Promise.resolve({id: projectA})},
    );
    ok(terminalRes.status === 409, '[API15] 失败 run 同 requestId POST → 409');
    const terminalJson = (await terminalRes.json()) as {status: string; errorCode: string; runId: string};
    ok(
      terminalJson.status === 'failed' && terminalJson.errorCode === 'VALIDATION_FAILED' && terminalJson.runId.length > 0,
      '[API16] 409 响应含 status/errorCode/runId',
    );

    // 非法 body
    const missingField = await visualPOST(
      new Request('http://test', {method: 'POST', body: JSON.stringify({requestId: 'req-m73a-api03'})}),
      {params: Promise.resolve({id: projectA})},
    );
    ok(missingField.status === 422 || missingField.status === 400, '[API17] 缺 artifact ID → 4xx');
    const shortId = await visualPOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({narrativeBeatsArtifactId: beatsArtifactA, requestId: 'abc'}),
      }),
      {params: Promise.resolve({id: projectA})},
    );
    ok(shortId.status === 422, '[API18] 过短 requestId → 422 REQUEST_ID_INVALID');

    // detail route
    const detailRes = await visualDetailGET(new Request('http://test'), {
      params: Promise.resolve({id: projectA, artifactId: createdArtifactId}),
    });
    ok(detailRes.status === 200, '[API19] GET detail → 200');
    const detailJson = (await detailRes.json()) as {
      status: string;
      intentCount: number;
      coverage: {beatTotal: number; coveredBeatIds: string[]};
      unresolvedCount: number;
      titleCardCount: number;
      continuationCount: number;
      distributions: {intent: Record<string, number>; strategy: Record<string, number>};
      intents: Array<{visualIntentId: string; beatRange: {first: string; last: string}; displayText: unknown}>;
    };
    ok(
      detailJson.status === 'eligible_candidate' &&
        detailJson.intentCount === 6 &&
        detailJson.coverage.beatTotal === 6 &&
        detailJson.coverage.coveredBeatIds.length === 6 &&
        detailJson.unresolvedCount === 0 &&
        detailJson.titleCardCount === 1 &&
        detailJson.continuationCount === 2,
      '[API20] detail 覆盖/统计正确',
      detailJson.coverage,
    );
    ok(
      detailJson.distributions.intent['SHOW_PERSON'] === 1 &&
        detailJson.distributions.intent['EMPHASIZE_TEXT'] === 1 &&
        detailJson.distributions.strategy['title_card'] === 1,
      '[API21] detail intent/strategy 分布正确',
    );
    ok(
      detailJson.intents[0]?.beatRange.first === 'B001' && detailJson.intents[3]?.displayText !== null,
      '[API22] detail intent 含 beatRange + displayText 来源',
    );
    const missingDetail = await visualDetailGET(new Request('http://test'), {
      params: Promise.resolve({id: projectA, artifactId: crypto.randomUUID()}),
    });
    ok(missingDetail.status === 404, '[API23] 不存在 detail → 404');
  }

  // ============ F：candidate 生命周期 ============
  {
    const candidates = listVisualIntentCandidates(projectA);
    const first = candidates.find((c) => c.artifact.id === visualArtifactId)!;
    ok(first.status === 'eligible_candidate', '[F1] 合法且无 unresolved → eligible_candidate（仍只是 candidate）');
    ok(
      getPipelineVersion(projectA) === 'm6' && getM7PipelineSnapshotId(projectA) === null,
      '[F2] 项目仍 m6 + snapshot 指针 NULL',
    );
    const downstreamCount = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind IN ('visual_sequence_plan', 'shot_plan', 'm7_pipeline_snapshot')`,
      )
      .get(projectA) as {c: number};
    ok(downstreamCount.c === 0, '[F3] 未创建任何 sequence/shot/snapshot artifact');

    // needs_review：含 1 个 unresolved（V006 continuation 改指 V004）
    const unresolvedIntents = cloneIntents(validIntents);
    unresolvedIntents[4] = {
      ...unresolvedIntents[4]!,
      intent: 'VISUAL_UNRESOLVED',
      strategy: 'unresolved',
      authenticity: 'not_applicable',
      subject: {kind: 'none', label: null, evidenceIds: []},
      continuationOfVisualIntentId: null,
    };
    unresolvedIntents[5] = {...unresolvedIntents[5]!, continuationOfVisualIntentId: 'V004'};
    ok(
      validateVisualIntentPlan(validBeats, planA, unresolvedIntents).length === 0,
      '[F4a] fixture：含 unresolved 的合法 intents',
    );
    provider.push({text: proposalJson(unresolvedIntents)});
    const nr = asSucceeded(
      await buildVisualIntentPlan({
        projectId: projectA,
        narrativeBeatsArtifactId: beatsArtifactA,
        requestId: 'req-m73a-f001',
        provider,
      }),
      '[F4b] 含 unresolved build 返回 kind=succeeded',
    );
    const nrRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(nr.artifact.id) as never;
    const nrClassified = classifyVisualIntentCandidate(projectA, nrRow);
    ok(
      nrClassified.status === 'needs_review' && (nrClassified.statusReason ?? '').includes('VISUAL_UNRESOLVED=1'),
      '[F4] 含 unresolved → needs_review',
      nrClassified.statusReason,
    );

    // invalid JSON artifact → invalid
    const badId = crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
         VALUES (?, ?, ?, 99, '{broken', NULL, ?)`,
      )
      .run(badId, projectA, VISUAL_INTENT_KIND, new Date().toISOString());
    const badRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(badId) as never;
    ok(
      classifyVisualIntentCandidate(projectA, badRow).status === 'invalid',
      '[F5] 契约非法 artifact → invalid',
    );
    getDb().prepare('DELETE FROM artifacts WHERE id = ?').run(badId);

    // 语义损坏（缺 beat 覆盖）→ invalid
    const ref = getVisualIntentArtifact(projectA, visualArtifactId)!;
    const tampered = {...ref.visualIntent, intents: ref.visualIntent.intents.slice(0, 5)};
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run(JSON.stringify(tampered), visualArtifactId);
    const tamperedRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(visualArtifactId) as never;
    ok(
      classifyVisualIntentCandidate(projectA, tamperedRow).status === 'invalid',
      '[F6] 覆盖损坏 → invalid',
    );
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run(JSON.stringify(ref.visualIntent), visualArtifactId);
    const restoredRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(visualArtifactId) as never;
    ok(
      classifyVisualIntentCandidate(projectA, restoredRow).status === 'eligible_candidate',
      '[F7] 恢复后 eligible_candidate',
    );

    // source beats stale → visual stale（projectZ：完整链路后演进 script）
    const projectZ = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const buildZ = buildNarrationPlanV2(projectZ);
    beatsProvider.push({text: beatsProposalJson(makeValidBeats(buildZ.plan))});
    const beatsZ = await buildNarrativeBeats({
      projectId: projectZ,
      narrationPlanV2ArtifactId: buildZ.artifact.id,
      requestId: 'req-m73a-beatsZ',
      provider: beatsProvider,
    });
    const beatsZId = beatsZ.kind === 'succeeded' ? beatsZ.artifact.id : '';
    provider.push({text: proposalJson(makeValidIntents(buildZ.plan))});
    const visualZ = asSucceeded(
      await buildVisualIntentPlan({
        projectId: projectZ,
        narrativeBeatsArtifactId: beatsZId,
        requestId: 'req-m73a-f002',
        provider,
      }),
      '[F8a] projectZ visual intent build 返回 kind=succeeded',
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
    const zRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(visualZ.artifact.id) as never;
    ok(
      classifyVisualIntentCandidate(projectZ, zRow).status === 'stale',
      '[F8] source beats stale（经 narration 传导）→ visual candidate stale',
    );

    // source beats 内容 hash 漂移（模拟 append-only 被破坏）→ stale
    const beatsZRow = getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(beatsZId) as {content_json: string};
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run(`${beatsZRow.content_json} `, beatsZId);
    ok(
      classifyVisualIntentCandidate(projectZ, zRow).status === 'stale',
      '[F9] source beats hash 漂移 → stale',
    );

    // exact getter
    ok(getVisualIntentArtifact(projectA, visualArtifactId) !== null, '[F10] exact getter 可读');
    ok(getVisualIntentArtifact(projectZ, visualArtifactId) === null, '[F11] 跨项目 → null');
    ok(getVisualIntentArtifact(projectA, beatsArtifactA) === null, '[F12] kind 不符 → null');
  }

  // ============ G：回归——runs 通用化后 m7_narrative_beats 路径不受影响 ============
  {
    const projectG = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const buildG = buildNarrationPlanV2(projectG);
    beatsProvider.push({text: beatsProposalJson(makeValidBeats(buildG.plan))});
    const beatsG = await buildNarrativeBeats({
      projectId: projectG,
      narrationPlanV2ArtifactId: buildG.artifact.id,
      requestId: 'req-m73a-beatsG',
      provider: beatsProvider,
    });
    ok(beatsG.kind === 'succeeded', '[G1] narrative beats build 仍工作（runs 通用化回归）');
    const beatsRun = getDb()
      .prepare(
        `SELECT status FROM generation_runs WHERE project_id = ? AND stage = 'm7_narrative_beats' AND request_id = ?`,
      )
      .get(projectG, 'req-m73a-beatsG') as {status: string} | undefined;
    ok(beatsRun?.status === 'succeeded', '[G2] m7_narrative_beats run 终态正常');
    ok(
      usageCount(projectG, 'm7_narrative_beats') === 1 && usageCount(projectG, 'm7_visual_intent') === 0,
      '[G3] beats usage 仍记 m7_narrative_beats（stage 不串扰）',
    );
    // 复用也正常
    const beatsG2 = await buildNarrativeBeats({
      projectId: projectG,
      narrationPlanV2ArtifactId: buildG.artifact.id,
      requestId: 'req-m73a-beatsG',
      provider: beatsProvider,
    });
    ok(
      beatsG2.kind === 'succeeded' && beatsG2.reused,
      '[G4] narrative beats 同 requestId 复用仍工作',
    );
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m73a-visual-intent'), {recursive: true, force: true});

  // async expectVisualError 的断言是微任务——等待全部落定再汇总
  await new Promise((resolve) => setImmediate(resolve));

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M7.3A Visual Intent Plan 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M7.3A Visual Intent Plan 测试全部通过 ✅');
}

void main();
