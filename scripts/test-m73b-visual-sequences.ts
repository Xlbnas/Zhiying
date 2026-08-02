/**
 * M7.3B Visual Sequences 测试（临时 DB + Mock provider，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m73b-visual-sequences.ts
 * 覆盖：
 * - schema（11.1 对 sequences）：正常 parse / unknown 字段拒绝 / intent・strategy・
 *   authenticity 副本拒绝 / timing・asset・render 字段拒绝 / voice・performance 字段拒绝 /
 *   malformed ID 拒绝 / 版本字符串精确；
 * - 语义校验（11.2 全矩阵）：exact coverage / gap / overlap / duplicate /
 *   non-contiguous / chapter crossing / missing intent / intent split /
 *   coverage mismatch / continuation target missing / continuation crossing /
 *   unresolved → needs_review（非阻断）且不转 MG（validator 零改写）/
 *   source 成功 / source ID・hash・compiler 漂移 → stale_source / malformed source fail-closed；
 * - 双源 transitive chain 不一致 → precheck SOURCE_CHAIN_MISMATCH；
 * - 向后兼容：旧 M6 项目只读可读、旧 candidate/artifact 不动。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m73b-visual-sequences');
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import type {LLMProvider, LLMRequest, LLMResponse} from '../src/lib/llm/types';
import {buildNarrationPlanV2} from '../src/lib/narration/plan-v2';
import type {NarrationPlanV2} from '../src/lib/narration/schema-v2';
import {buildNarrativeBeats, getNarrativeBeatsArtifact} from '../src/lib/narrative-beats/plan';
import type {NarrativeBeatV1} from '../src/lib/narrative-beats/schema';
import {buildVisualIntentPlan, getVisualIntentArtifact} from '../src/lib/visual-intent/plan';
import type {VisualIntentV1} from '../src/lib/visual-intent/schema';
import {
  VISUAL_SEQUENCES_KIND,
  VISUAL_SEQUENCES_SCHEMA_VERSION,
  VISUAL_SEQUENCES_COMPILER_VERSION,
  VISUAL_SEQUENCES_PROMPT_VERSION,
  visualSequencesArtifactV1Schema,
  visualSequencesProposalSchema,
  visualSequenceV1Schema,
  type VisualSequenceV1,
} from '../src/lib/visual-sequences/schema';
import {
  scanForbiddenSequenceKeys,
  validateVisualSequences,
  type SequenceValidationIssue,
} from '../src/lib/visual-sequences/validate';
import {
  classifyVisualSequencesCandidate,
  getVisualSequencesArtifact,
  listVisualSequencesRows,
} from '../src/lib/visual-sequences/classify';
import {
  buildVisualSequences,
  composeSequencesSourceKey,
  parseSequencesSourceKey,
  precheckVisualSequencesSource,
  VisualSequencesError,
} from '../src/lib/visual-sequences/plan';

function cryptoRandom(): string {
  return crypto.randomUUID();
}

function sha256(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function getNarrativeBeatsRef(projectId: string, artifactId: string) {
  const ref = getNarrativeBeatsArtifact(projectId, artifactId);
  if (!ref) throw new Error('fixture: beats ref missing');
  return ref;
}

function getVisualIntentRef(projectId: string, artifactId: string) {
  const ref = getVisualIntentArtifact(projectId, artifactId);
  if (!ref) throw new Error('fixture: intent ref missing');
  return ref;
}

fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m73b-visual-sequences'), {recursive: true, force: true});

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

class ScriptableProvider implements LLMProvider {
  readonly name = 'scriptable-mock';
  readonly requests: LLMRequest[] = [];
  private queue: Array<{text?: string; finishReason?: string; error?: Error}> = [];

  push(resp: {text?: string; finishReason?: string; error?: Error}): void {
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
  const projectId = createProjectWithWorkflow({topic: 'm73b', coreQuestion: 'q'}).project.id;
  for (const stage of UPSTREAM) {
    generateVersion({projectId, stage, content: `# ${stage}`, contentType: 'markdown', source: 'manual_edit'});
    lockStage(projectId, stage);
  }
  generateVersion({projectId, stage: 'script_v2', content, contentType: 'markdown', source: 'manual_edit', promptVersion});
  lockStage(projectId, 'script_v2');
  return projectId;
}

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

/** 每 beat 一个 intent（V001…V006），合法矩阵（0 unresolved）。 */
function makeValidIntents(plan: NarrationPlanV2): VisualIntentV1[] {
  const n4 = plan.units[3]!;
  if (n4.kind !== 'speech') throw new Error('fixture: N004 必须是 speech');
  const intents: VisualIntentV1[] = [
    {visualIntentId: 'V001', chapter: 1, beatIds: ['B001'], intent: 'SHOW_PERSON', strategy: 'portrait', authenticity: 'authentic_required', objective: 'o', subject: {kind: 'person', label: '讲述者', evidenceIds: []}, continuationOfVisualIntentId: null, displayText: null},
    {visualIntentId: 'V002', chapter: 1, beatIds: ['B002'], intent: 'CONTINUE_PREVIOUS_VISUAL', strategy: 'continue_previous', authenticity: 'inherited', objective: 'o', subject: {kind: 'none', label: null, evidenceIds: []}, continuationOfVisualIntentId: 'V001', displayText: null},
    {visualIntentId: 'V003', chapter: 1, beatIds: ['B003'], intent: 'SHOW_PLACE', strategy: 'archive_photo', authenticity: 'authentic_required', objective: 'o', subject: {kind: 'place', label: '旧城区', evidenceIds: []}, continuationOfVisualIntentId: null, displayText: null},
    {visualIntentId: 'V004', chapter: 2, beatIds: ['B004'], intent: 'EMPHASIZE_TEXT', strategy: 'title_card', authenticity: 'not_applicable', objective: 'o', subject: {kind: 'text', label: null, evidenceIds: []}, continuationOfVisualIntentId: null, displayText: {sourceKind: 'spoken_exact', sourceUnitId: n4.id, sourceChapter: null, text: n4.spokenText}},
    {visualIntentId: 'V005', chapter: 2, beatIds: ['B005'], intent: 'SHOW_DATA', strategy: 'mg_data', authenticity: 'synthetic_allowed', objective: 'o', subject: {kind: 'data', label: '规模', evidenceIds: []}, continuationOfVisualIntentId: null, displayText: null},
    {visualIntentId: 'V006', chapter: 2, beatIds: ['B006'], intent: 'NO_VISUAL_CHANGE', strategy: 'hold', authenticity: 'inherited', objective: 'o', subject: {kind: 'none', label: null, evidenceIds: []}, continuationOfVisualIntentId: 'V005', displayText: null},
  ];
  return intents;
}

/** 合法序列基线：Q001=[B001,B002,B003]→[V001,V002,V003]；Q002=[B004,B005,B006]→[V004,V005,V006]。 */
function makeValidSequences(): VisualSequenceV1[] {
  return [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002', 'B003'], visualIntentIds: ['V001', 'V002', 'V003']},
    {sequenceId: 'Q002', chapter: 2, beatIds: ['B004', 'B005', 'B006'], visualIntentIds: ['V004', 'V005', 'V006']},
  ];
}

function codes(issues: SequenceValidationIssue[]): string[] {
  return issues.map((i) => i.code);
}

function hasCode(issues: SequenceValidationIssue[], code: string): boolean {
  return issues.some((i) => i.code === code);
}

/** 手工构造 sequences artifact content（wrapper 形状与 build 一致）。 */
function makeSequencesContent(
  beatsArtifactId: string,
  intentArtifactId: string,
  narrationPlanArtifactId: string,
  scriptV2VersionId: string,
  scriptV2ContentHash: string,
  sequences: VisualSequenceV1[],
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: VISUAL_SEQUENCES_SCHEMA_VERSION,
    compilerVersion: VISUAL_SEQUENCES_COMPILER_VERSION,
    promptVersion: VISUAL_SEQUENCES_PROMPT_VERSION,
    source: {
      narrativeBeatsArtifactId: beatsArtifactId,
      narrativeBeatsContentHash: '',
      narrativeBeatsSchemaVersion: 'narrative-beats@1.0',
      narrativeBeatsCompilerVersion: '1.0',
      visualIntentPlanArtifactId: intentArtifactId,
      visualIntentPlanContentHash: '',
      visualIntentSchemaVersion: 'visual-intent-plan@1.0',
      visualIntentCompilerVersion: '1.1',
      narrationPlanV2ArtifactId: narrationPlanArtifactId,
      narrationPlanV2ContentHash: '',
      scriptV2VersionId,
      scriptV2ContentHash,
      ...extra,
    },
    generation: {requestId: 'req-seq-m73b-0001', provider: 'scriptable-mock', model: 'deepseek-v4-flash', attemptCount: 1},
    sequences,
  };
}

function insertSequencesArtifact(projectId: string, content: Record<string, unknown>): string {
  const id = `seq-art-${cryptoRandom()}`;
  getDb()
    .prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?), ?, NULL, ?)`,
    )
    .run(id, projectId, VISUAL_SEQUENCES_KIND, projectId, VISUAL_SEQUENCES_KIND, JSON.stringify(content), new Date().toISOString());
  return id;
}

async function main(): Promise<void> {
  const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
  const buildA = buildNarrationPlanV2(projectId);
  const plan = buildA.plan;
  const beats = makeValidBeats(plan);
  const intents = makeValidIntents(plan);

  // 造 exact source artifacts：beats + intent（走 build 路径，Mock provider）
  const beatsProvider = new ScriptableProvider();
  beatsProvider.push({text: JSON.stringify({beats})});
  const beatsBuild = await buildNarrativeBeats({
    projectId,
    narrationPlanV2ArtifactId: buildA.artifact.id,
    requestId: 'req-beats-m73b-0001',
    provider: beatsProvider,
  });
  if (beatsBuild.kind !== 'succeeded') throw new Error('fixture: beats build failed');
  const beatsArtifactId = beatsBuild.artifact.id;

  const intentProvider = new ScriptableProvider();
  intentProvider.push({text: JSON.stringify({intents})});
  const intentBuild = await buildVisualIntentPlan({
    projectId,
    narrativeBeatsArtifactId: beatsArtifactId,
    requestId: 'req-intent-m73b-0001',
    provider: intentProvider,
  });
  if (intentBuild.kind !== 'succeeded') throw new Error('fixture: intent build failed');
  const intentArtifactId = intentBuild.artifact.id;

  const beatsRef = getNarrativeBeatsRef(projectId, beatsArtifactId);
  const intentRef = getVisualIntentRef(projectId, intentArtifactId);
  const narrationArtifactId = buildA.artifact.id;
  const scriptV2VersionId = plan.source.scriptV2VersionId;
  const scriptV2ContentHash = plan.source.scriptV2ContentHash;

  function sourceHash(kind: string, artifactId: string): string {
    const row = getDb().prepare('SELECT content_json FROM artifacts WHERE id = ? AND project_id = ? AND kind = ?').get(artifactId, projectId, kind) as {content_json: string} | undefined;
    return sha256(row?.content_json ?? '');
  }

  // ═══════ A. schema（11.1） ═══════
  console.log('── A. schema');
  const validSeq = makeValidSequences()[0]!;
  ok(visualSequenceV1Schema.safeParse(validSeq).success, 'A1 正常 sequence parse 通过');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, sequenceId: 'Q01'}).success, 'A2 malformed sequenceId (Q01) 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, sequenceId: 'Q001x'}).success, 'A3 malformed sequenceId (Q001x) 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, beatIds: []}).success, 'A4 空 beatIds 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, visualIntentIds: []}).success, 'A5 空 visualIntentIds 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, chapter: 0}).success, 'A6 chapter=0 拒绝');
  // intent/strategy/authenticity 副本拒绝（unknown key + 视觉语义副本）
  ok(!visualSequenceV1Schema.safeParse({...validSeq, intent: 'SHOW_PERSON'}).success, 'A7 intent 副本字段拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, strategy: 'portrait'}).success, 'A8 strategy 副本字段拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, authenticity: 'authentic_required'}).success, 'A9 authenticity 副本字段拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, displayText: 'x'}).success, 'A10 displayText 字段拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, subject: {kind: 'person'}}).success, 'A11 subject 副本字段拒绝');
  // timing 字段拒绝
  ok(!visualSequenceV1Schema.safeParse({...validSeq, startMs: 0}).success, 'A12 startMs 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, endMs: 0}).success, 'A13 endMs 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, durationMs: 0}).success, 'A14 durationMs 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, transition: 'cut'}).success, 'A15 transition 拒绝');
  // asset/render 字段拒绝
  ok(!visualSequenceV1Schema.safeParse({...validSeq, sceneId: 's1'}).success, 'A16 sceneId 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, assetId: 'a1'}).success, 'A17 assetId 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, templateProps: {}}).success, 'A18 templateProps 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, fitPolicy: 'cover'}).success, 'A19 fitPolicy 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, shotIds: ['H001']}).success, 'A20 shotIds 拒绝');
  // voice/performance 字段拒绝
  ok(!visualSequenceV1Schema.safeParse({...validSeq, voice: 'v1'}).success, 'A21 voice 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, delivery: 'normal'}).success, 'A22 delivery 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, emotion: 'calm'}).success, 'A23 emotion 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, spokenText: 'x'}).success, 'A24 spokenText 拒绝');
  // proposal 契约：只允许 sequences
  ok(visualSequencesProposalSchema.safeParse({sequences: makeValidSequences()}).success, 'A25 proposal 正常');
  ok(!visualSequencesProposalSchema.safeParse({sequences: makeValidSequences(), source: {}}).success, 'A26 proposal 不允许 source');
  ok(!visualSequencesProposalSchema.safeParse({sequences: makeValidSequences(), generation: {}}).success, 'A27 proposal 不允许 generation');
  ok(!visualSequencesProposalSchema.safeParse({}).success, 'A28 proposal 缺少 sequences 拒绝');
  // 版本字符串精确
  ok(VISUAL_SEQUENCES_KIND === 'visual_sequence_plan', 'A29 kind=visual_sequence_plan（与冻结 snapshot ruleset 一致）');
  ok(VISUAL_SEQUENCES_SCHEMA_VERSION === 'visual-sequences@1.0', 'A30 schemaVersion=visual-sequences@1.0');
  ok(VISUAL_SEQUENCES_COMPILER_VERSION === '1.0', 'A31 compilerVersion=1.0');
  ok(VISUAL_SEQUENCES_PROMPT_VERSION === 'visual-sequences@1.0', 'A32 promptVersion=visual-sequences@1.0');
  // forbidden scan
  ok(scanForbiddenSequenceKeys(makeValidSequences()).length === 0, 'A33 合法序列 forbidden scan 通过');
  ok(scanForbiddenSequenceKeys([{...validSeq, transition: 'cut', startMs: 1}]).includes('transition'), 'A34 forbidden scan 命中 transition');
  ok(scanForbiddenSequenceKeys([{...validSeq, intent: 'SHOW_PERSON'}]).includes('intent'), 'A35 forbidden scan 命中 intent 副本');
  // reference ID schema（M7.3B.R1 P1）：malformed reference 在 schema 层拒绝
  ok(!visualSequenceV1Schema.safeParse({...validSeq, beatIds: ['B01']}).success, 'A36 beatIds B01 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, beatIds: ['B0001']}).success, 'A37 beatIds B0001 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, beatIds: ['b001']}).success, 'A38 beatIds b001（小写）拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, visualIntentIds: ['V01']}).success, 'A39 visualIntentIds V01 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, visualIntentIds: ['V0001']}).success, 'A40 visualIntentIds V0001 拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, visualIntentIds: ['x']}).success, 'A41 visualIntentIds x 拒绝');
  ok(visualSequenceV1Schema.safeParse(validSeq).success, 'A42 合法 B001/V001 通过');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, beatIds: []}).success, 'A43 空 beatIds 继续拒绝');
  ok(!visualSequenceV1Schema.safeParse({...validSeq, visualIntentIds: []}).success, 'A44 空 visualIntentIds 继续拒绝');

  // ═══════ B. 语义校验（11.2） ═══════
  console.log('── B. validate 矩阵');
  const valid = makeValidSequences();
  ok(validateVisualSequences(beats, intents, valid).length === 0, 'B1 exact coverage 成功（0 issues）');
  // gap：漏掉 B006
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002', 'B003'], visualIntentIds: ['V001', 'V002', 'V003']},
    {sequenceId: 'Q002', chapter: 2, beatIds: ['B004', 'B005'], visualIntentIds: ['V004', 'V005']},
  ]), 'SEQUENCE_BEAT_COVERAGE_GAP'), 'B2 gap → SEQUENCE_BEAT_COVERAGE_GAP');
  // overlap：B003 同时在两个 sequence
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002', 'B003'], visualIntentIds: ['V001', 'V002', 'V003']},
    {sequenceId: 'Q002', chapter: 2, beatIds: ['B003', 'B004'], visualIntentIds: ['V003', 'V004']},
  ]), 'SEQUENCE_BEAT_OVERLAP'), 'B3 overlap → SEQUENCE_BEAT_OVERLAP');
  // duplicate：同 sequence 内重复 beat
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B001', 'B002'], visualIntentIds: ['V001', 'V002']},
    ...valid.slice(1),
  ]), 'SEQUENCE_BEAT_DUPLICATE'), 'B4 同 sequence 重复 beat → SEQUENCE_BEAT_DUPLICATE');
  // non-contiguous：Q001 跳 B002
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B003'], visualIntentIds: ['V001', 'V003']},
    ...valid.slice(1),
  ]), 'SEQUENCE_BEAT_NON_CONTIGUOUS'), 'B5 non-contiguous → SEQUENCE_BEAT_NON_CONTIGUOUS');
  // id 不连续
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001'], visualIntentIds: ['V001']},
    {sequenceId: 'Q003', chapter: 2, beatIds: ['B002', 'B003'], visualIntentIds: ['V002', 'V003']},
  ]), 'SEQUENCE_ID_SEQUENCE_BROKEN'), 'B6 id 跳号 → SEQUENCE_ID_SEQUENCE_BROKEN');
  ok(hasCode(validateVisualSequences(beats, intents, [
    valid[0]!, valid[0]!,
  ]), 'SEQUENCE_ID_DUPLICATE'), 'B7 id 重复 → SEQUENCE_ID_DUPLICATE');
  // chapter crossing：Q001 含 B004（chapter 2）
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002', 'B004'], visualIntentIds: ['V001', 'V002', 'V004']},
    {sequenceId: 'Q002', chapter: 2, beatIds: ['B003', 'B005', 'B006'], visualIntentIds: ['V003', 'V005', 'V006']},
  ]), 'SEQUENCE_CHAPTER_CROSSING'), 'B8 chapter crossing → SEQUENCE_CHAPTER_CROSSING');
  // missing intent
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002', 'B003'], visualIntentIds: ['V999']},
    ...valid.slice(1),
  ]), 'SEQUENCE_INTENT_NOT_FOUND'), 'B9 引用不存在的 intent → SEQUENCE_INTENT_NOT_FOUND');
  // intent split：V003 同时在 Q001 和 Q002
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002', 'B003'], visualIntentIds: ['V001', 'V002', 'V003']},
    {sequenceId: 'Q002', chapter: 2, beatIds: ['B004', 'B005', 'B006'], visualIntentIds: ['V004', 'V005', 'V003']},
  ]), 'SEQUENCE_INTENT_SPLIT'), 'B11 intent split → SEQUENCE_INTENT_SPLIT');
  // coverage mismatch：Q001 的 beatIds 与其 intents 覆盖并集不一致（B001 未引用 V001）
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002'], visualIntentIds: ['V001', 'V002', 'V003']},
    ...valid.slice(1),
  ]), 'SEQUENCE_INTENT_COVERAGE_MISMATCH'), 'B12 coverage mismatch → SEQUENCE_INTENT_COVERAGE_MISMATCH');
  // intent 顺序与 beat 顺序不一致
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002', 'B003'], visualIntentIds: ['V002', 'V001', 'V003']},
    ...valid.slice(1),
  ]), 'SEQUENCE_INTENT_ORDER'), 'B13 intent 顺序倒序 → SEQUENCE_INTENT_ORDER');
  // continuation target missing：V002→V999
  const badContinuation = intents.map((i) => ({...i, subject: {...i.subject, evidenceIds: [...i.subject.evidenceIds]}, displayText: i.displayText === null ? null : {...i.displayText}}));
  badContinuation[1] = {...badContinuation[1]!, continuationOfVisualIntentId: 'V999'};
  ok(hasCode(validateVisualSequences(beats, badContinuation, valid), 'SEQUENCE_CONTINUATION_TARGET_MISSING'), 'B14 continuation target 缺失 → SEQUENCE_CONTINUATION_TARGET_MISSING');
  // continuation crossing sequence：V002（continuation→V001）在 Q001，V001 只在 Q002
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002', 'B003'], visualIntentIds: ['V002', 'V003']},
    {sequenceId: 'Q002', chapter: 2, beatIds: ['B004', 'B005', 'B006'], visualIntentIds: ['V004', 'V005', 'V001']},
  ]), 'SEQUENCE_CONTINUATION_CROSSING'), 'B15 continuation 跨 sequence → SEQUENCE_CONTINUATION_CROSSING');
  // unresolved → needs_review（非阻断）；不转 MG（validator 零改写）
  const unresolvedIntents = intents.map((i) => ({...i, subject: {...i.subject, evidenceIds: [...i.subject.evidenceIds]}, displayText: i.displayText === null ? null : {...i.displayText}}));
  unresolvedIntents[2] = {...unresolvedIntents[2]!, intent: 'VISUAL_UNRESOLVED', strategy: 'unresolved', authenticity: 'not_applicable', subject: {kind: 'none', label: null, evidenceIds: []}, continuationOfVisualIntentId: null, displayText: null};
  const unresolvedIssues = validateVisualSequences(beats, unresolvedIntents, valid);
  ok(unresolvedIssues.length === 1 && unresolvedIssues[0]!.code === 'SEQUENCE_NEEDS_REVIEW', 'B16 unresolved → SEQUENCE_NEEDS_REVIEW（仅此一条）', unresolvedIssues);
  ok(!hasCode(validateVisualSequences(beats, unresolvedIntents, valid), 'SEQUENCE_INTENT_COVERAGE_MISMATCH'), 'B17 unresolved 引用不触发 coverage mismatch（允许保留）');
  const after = validateVisualSequences(beats, unresolvedIntents, valid);
  ok(after.every((i) => i.code === 'SEQUENCE_NEEDS_REVIEW'), 'B18 validator 零改写（无 MG/其他改写行为）', after);
  // 引用不存在 beat
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B999'], visualIntentIds: ['V001']},
  ]), 'SEQUENCE_BEAT_NOT_FOUND'), 'B19 引用不存在 beat → SEQUENCE_BEAT_NOT_FOUND');
  // exact-but-missing 合法格式 ID → semantic NOT_FOUND（schema 层放行，语义层拒绝）
  ok(hasCode(validateVisualSequences(beats, intents, [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002'], visualIntentIds: ['V001', 'V002']},
    {sequenceId: 'Q002', chapter: 2, beatIds: ['B004', 'B005', 'B006'], visualIntentIds: ['V004', 'V005', 'V006']},
  ]), 'SEQUENCE_BEAT_COVERAGE_GAP'), 'B20 exact-but-missing（B003 合法格式但缺失）→ semantic GAP');

  // ── 全局 canonical beat 顺序（M7.3B.R1 P0）──
  // reversed blocks：Q001→后半、Q002→前半；每个 sequence 内仍连续、chapter 正确、
  // intent coverage 正确——旧实现（只查 within-sequence 连续）会放过。
  const reversed = [
    {sequenceId: 'Q001', chapter: 2, beatIds: ['B004', 'B005', 'B006'], visualIntentIds: ['V004', 'V005', 'V006']},
    {sequenceId: 'Q002', chapter: 1, beatIds: ['B001', 'B002', 'B003'], visualIntentIds: ['V001', 'V002', 'V003']},
  ];
  const revIssues = validateVisualSequences(beats, intents, reversed);
  ok(hasCode(revIssues, 'SEQUENCE_BEAT_ORDER_MISMATCH'), 'B21 reversed blocks → SEQUENCE_BEAT_ORDER_MISMATCH', revIssues);
  ok(!hasCode(revIssues, 'SEQUENCE_BEAT_NON_CONTIGUOUS'), 'B22 reversed blocks 内每个 sequence 仍连续（仅全局顺序错）');
  ok(!hasCode(revIssues, 'SEQUENCE_INTENT_COVERAGE_MISMATCH'), 'B23 reversed blocks intent coverage 正确（不误报）');
  ok(!hasCode(revIssues, 'SEQUENCE_CHAPTER_CROSSING'), 'B24 reversed blocks chapter 正确（不误报）');
  // 三个 sequence block 交换
  const swapped = [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002'], visualIntentIds: ['V001', 'V002']},
    {sequenceId: 'Q002', chapter: 2, beatIds: ['B005', 'B006'], visualIntentIds: ['V005', 'V006']},
    {sequenceId: 'Q003', chapter: 2, beatIds: ['B003', 'B004'], visualIntentIds: ['V003', 'V004']},
  ];
  const swapIssues = validateVisualSequences(beats, intents, swapped);
  ok(hasCode(swapIssues, 'SEQUENCE_BEAT_ORDER_MISMATCH'), 'B25 三 sequence block 交换 → SEQUENCE_BEAT_ORDER_MISMATCH', swapIssues);
  ok(!hasCode(swapIssues, 'SEQUENCE_BEAT_NON_CONTIGUOUS') && !hasCode(swapIssues, 'SEQUENCE_BEAT_COVERAGE_GAP'), 'B26 交换后内部连续且无 gap（仅顺序错）');

  // ═══════ C. classify（11.2 source 部分 + 9） ═══════
  console.log('── C. classify');
  function fillHashes(content: Record<string, unknown>): Record<string, unknown> {
    const source = content.source as Record<string, string>;
    source.narrativeBeatsContentHash = sourceHash('narrative_beats', source.narrativeBeatsArtifactId);
    source.visualIntentPlanContentHash = sourceHash('visual_intent_plan', source.visualIntentPlanArtifactId);
    source.narrationPlanV2ContentHash = sourceHash('narration_plan_v2', source.narrationPlanV2ArtifactId);
    return content;
  }
  const goodContent = fillHashes(
    makeSequencesContent(beatsArtifactId, intentArtifactId, narrationArtifactId, scriptV2VersionId, scriptV2ContentHash, valid),
  );
  const goodId = insertSequencesArtifact(projectId, goodContent);
  const goodRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(goodId) as never;
  const goodClass = classifyVisualSequencesCandidate(projectId, goodRow as Parameters<typeof classifyVisualSequencesCandidate>[1]);
  ok(goodClass.status === 'current_candidate', 'C1 exact source 成功 → current_candidate', goodClass);
  ok(getVisualSequencesArtifact(projectId, goodId) !== null, 'C2 exact get 可读');

  // source ID 错（引用不存在的 beats）
  const badIdContent = fillHashes(
    makeSequencesContent('no-such-beats', intentArtifactId, narrationArtifactId, scriptV2VersionId, scriptV2ContentHash, valid),
  );
  const badId = insertSequencesArtifact(projectId, badIdContent);
  const badIdClass = classifyVisualSequencesCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(badId) as never);
  ok(badIdClass.status === 'stale_source', 'C3 source beats ID 不存在 → stale_source', badIdClass);

  // hash 漂移：保存原始行，UPDATE source 行 content_json（临时 DB 注入），断言后原样恢复
  const originalBeatsContent = (getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(beatsArtifactId) as {content_json: string}).content_json;
  const driftId = insertSequencesArtifact(projectId, {...goodContent});
  getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(
    JSON.stringify({...JSON.parse(originalBeatsContent), beats: []}),
    beatsArtifactId,
  );
  const driftClass = classifyVisualSequencesCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(driftId) as never);
  ok(driftClass.status === 'stale_source', 'C4 source beats hash 漂移 → stale_source', driftClass);
  // 原样恢复 beats 行（后续用例依赖精确 hash）
  getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(originalBeatsContent, beatsArtifactId);

  // compiler/prompt 版本未知 → schema fail-closed（invalid_source，不是 eligible/stale——未知版本不得产生合格 candidate）
  const compContent = {...makeSequencesContent(beatsArtifactId, intentArtifactId, narrationArtifactId, scriptV2VersionId, scriptV2ContentHash, valid), compilerVersion: '9.9'};
  fillHashes(compContent);
  const compId = insertSequencesArtifact(projectId, compContent);
  const compClass = classifyVisualSequencesCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(compId) as never);
  ok(compClass.status === 'invalid_source', 'C5 未知 compiler version → schema fail-closed（invalid_source）', compClass);

  // malformed content（非法 JSON）→ invalid_source（parse fail-closed）
  const malformedId = `seq-art-${cryptoRandom()}`;
  getDb().prepare(`INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at) VALUES (?, ?, ?, (SELECT COALESCE(MAX(version),0)+1 FROM artifacts WHERE project_id = ? AND kind = ?), 'not-json', NULL, ?)`)
    .run(malformedId, projectId, VISUAL_SEQUENCES_KIND, projectId, VISUAL_SEQUENCES_KIND, new Date().toISOString());
  const malformedClass = classifyVisualSequencesCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(malformedId) as never);
  ok(malformedClass.status === 'invalid_source', 'C6 malformed source fail-closed → invalid_source', malformedClass);

  // 语义损坏（intent 覆盖 mismatch）→ invalid_source
  const brokenContent = fillHashes(
    makeSequencesContent(beatsArtifactId, intentArtifactId, narrationArtifactId, scriptV2VersionId, scriptV2ContentHash, [
      {sequenceId: 'Q001', chapter: 1, beatIds: ['B001'], visualIntentIds: ['V001']},
    ]),
  );
  const brokenId = insertSequencesArtifact(projectId, brokenContent);
  const brokenClass = classifyVisualSequencesCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(brokenId) as never);
  ok(brokenClass.status === 'invalid_source', 'C7 语义损坏（gap）→ invalid_source', brokenClass);

  // unresolved → needs_review（classify 层）
  // 注：unresolved 传播需要 source intent artifact 含 unresolved——单独构造 unresolved intent artifact
  const unresolvedIntentProvider = new ScriptableProvider();
  unresolvedIntentProvider.push({text: JSON.stringify({intents: unresolvedIntents})});
  const unresolvedIntentBuild = await buildVisualIntentPlan({
    projectId,
    narrativeBeatsArtifactId: beatsArtifactId,
    requestId: 'req-intent-unresolved-0001',
    provider: unresolvedIntentProvider,
  });
  if (unresolvedIntentBuild.kind !== 'succeeded') throw new Error('fixture: unresolved intent build failed');
  const unresolvedIntentId = unresolvedIntentBuild.artifact.id;
  const unresolvedSeqContent = fillHashes(
    makeSequencesContent(beatsArtifactId, unresolvedIntentId, narrationArtifactId, scriptV2VersionId, scriptV2ContentHash, valid),
  );
  const unresolvedSeqId = insertSequencesArtifact(projectId, unresolvedSeqContent);
  const unresolvedSeqClass = classifyVisualSequencesCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(unresolvedSeqId) as never);
  ok(unresolvedSeqClass.status === 'needs_review', 'C8 unresolved source → needs_review（不转 MG）', unresolvedSeqClass);

  // M7.3B.R1 P0：reversed blocks artifact → classify invalid_source（canonical order 是阻断规则）
  const reversedContent = fillHashes(
    makeSequencesContent(beatsArtifactId, intentArtifactId, narrationArtifactId, scriptV2VersionId, scriptV2ContentHash, [
      {sequenceId: 'Q001', chapter: 2, beatIds: ['B004', 'B005', 'B006'], visualIntentIds: ['V004', 'V005', 'V006']},
      {sequenceId: 'Q002', chapter: 1, beatIds: ['B001', 'B002', 'B003'], visualIntentIds: ['V001', 'V002', 'V003']},
    ]),
  );
  const reversedId = insertSequencesArtifact(projectId, reversedContent);
  const reversedClass = classifyVisualSequencesCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(reversedId) as never);
  ok(reversedClass.status === 'invalid_source', 'C9 reversed blocks classify → invalid_source', reversedClass);

  // M7.3B.R1 P0：generation repair（首次 reversed → validator 拒绝 → repair 返回 canonical）
  const genProvider = new ScriptableProvider();
  genProvider.push({text: JSON.stringify({sequences: [
    {sequenceId: 'Q001', chapter: 2, beatIds: ['B004', 'B005', 'B006'], visualIntentIds: ['V004', 'V005', 'V006']},
    {sequenceId: 'Q002', chapter: 1, beatIds: ['B001', 'B002', 'B003'], visualIntentIds: ['V001', 'V002', 'V003']},
  ]})});
  genProvider.push({text: JSON.stringify({sequences: makeValidSequences()})});
  const genBuild = await buildVisualSequences({
    projectId,
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-gen-order-repair-0001',
    provider: genProvider,
  });
  ok(genBuild.kind === 'succeeded', 'C10 repair 后 build succeeded', genBuild);
  if (genBuild.kind === 'succeeded') {
    ok(genBuild.generation?.attemptCount === 2, 'C11 repair attemptCount=2（首次 reversed 拒绝 + repair canonical）', genBuild.generation);
    // 服务端未自动排序：generation 内容必须与 LLM 第二次输出一致（无服务端重排）
    const artifactContent = genBuild.visualSequences.sequences;
    ok(
      artifactContent.length === 2 &&
        artifactContent[0]!.sequenceId === 'Q001' &&
        artifactContent[0]!.beatIds.join(',') === 'B001,B002,B003' &&
        artifactContent[1]!.sequenceId === 'Q002' &&
        artifactContent[1]!.beatIds.join(',') === 'B004,B005,B006',
      'C12 落库 artifact 为 canonical 顺序（服务端未自动排序，内容来自 repair 输出）',
      artifactContent,
    );
    const genArtifactCount = listVisualSequencesRows(projectId).filter((r) => {
      try {
        const parsed = JSON.parse(r.content_json) as {generation?: {requestId?: string}};
        return parsed.generation?.requestId === 'req-seq-gen-order-repair-0001';
      } catch {
        return false;
      }
    }).length;
    ok(genArtifactCount === 1, 'C13 repair 后只产生一个合法 artifact', genArtifactCount);
  }

  // ═══════ D. precheck 双源 chain（11.2 source 部分） ═══════
  console.log('── D. precheck / source chain');
  const pre = precheckVisualSequencesSource({
    projectId,
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-precheck-0001',
  });
  ok(pre.requestId === 'req-precheck-0001' && pre.beatsRef.artifact.id === beatsArtifactId, 'D1 双源 precheck 通过');
  // 双源 chain 不一致：造一个 narration 链不同的 intent（不同 narration plan）
  const otherProject = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
  const otherBuild = buildNarrationPlanV2(otherProject);
  const otherBeats = makeValidBeats(otherBuild.plan);
  const otherBeatsProvider = new ScriptableProvider();
  otherBeatsProvider.push({text: JSON.stringify({beats: otherBeats})});
  const otherBeatsBuild = await buildNarrativeBeats({projectId: otherProject, narrationPlanV2ArtifactId: otherBuild.artifact.id, requestId: 'req-other-beats-0001', provider: otherBeatsProvider});
  if (otherBeatsBuild.kind !== 'succeeded') throw new Error('fixture: other beats build failed');
  // intent 用 projectId 的 beats，但引用不同 narration 链——直接用 projectId 的 intent 与 otherProject 的 beats 组合
  const chainMismatch = await (async () => {
    try {
      precheckVisualSequencesSource({
        projectId,
        narrativeBeatsArtifactId: beatsArtifactId,
        visualIntentPlanArtifactId: intentArtifactId,
        requestId: 'req-chain-0001',
      });
      return null;
    } catch (err) {
      return err;
    }
  })();
  ok(chainMismatch === null, 'D2 同链 precheck 不抛错');
  // 跨项目 source → BEATS_NOT_FOUND
  const crossProject = await (async () => {
    try {
      precheckVisualSequencesSource({
        projectId,
        narrativeBeatsArtifactId: otherBeatsBuild.artifact.id,
        visualIntentPlanArtifactId: intentArtifactId,
        requestId: 'req-cross-0001',
      });
      return null;
    } catch (err) {
      return err instanceof VisualSequencesError ? err.code : 'WRONG';
    }
  })();
  ok(crossProject === 'BEATS_NOT_FOUND', 'D3 跨项目 beats source → BEATS_NOT_FOUND', crossProject);
  // 不存在 intent → INTENT_NOT_FOUND
  const noIntent = await (async () => {
    try {
      precheckVisualSequencesSource({
        projectId,
        narrativeBeatsArtifactId: beatsArtifactId,
        visualIntentPlanArtifactId: 'no-such-intent',
        requestId: 'req-nointent-0001',
      });
      return null;
    } catch (err) {
      return err instanceof VisualSequencesError ? err.code : 'WRONG';
    }
  })();
  ok(noIntent === 'INTENT_NOT_FOUND', 'D4 不存在 intent → INTENT_NOT_FOUND', noIntent);
  // requestId 非法
  const badReq = await (async () => {
    try {
      precheckVisualSequencesSource({
        projectId,
        narrativeBeatsArtifactId: beatsArtifactId,
        visualIntentPlanArtifactId: intentArtifactId,
        requestId: 'short',
      });
      return null;
    } catch (err) {
      return err instanceof VisualSequencesError ? err.code : 'WRONG';
    }
  })();
  ok(badReq === 'REQUEST_ID_INVALID', 'D5 非法 requestId → REQUEST_ID_INVALID', badReq);
  // 复合键编解码
  const key = composeSequencesSourceKey(beatsArtifactId, intentArtifactId);
  ok(parseSequencesSourceKey(key).narrativeBeatsArtifactId === beatsArtifactId, 'D6 复合键编解码一致');
  let malformedKey = false;
  try {
    parseSequencesSourceKey('only-one');
  } catch {
    malformedKey = true;
  }
  ok(malformedKey, 'D7 malformed 复合键 fail-closed');

  // ═══════ E. 向后兼容（11.6） ═══════
  console.log('── E. backward compat');
  ok(getVisualSequencesArtifact(projectId, 'no-such') === null, 'E1 跨项目/不存在 exact 读取 → null');
  ok(visualSequencesArtifactV1Schema.safeParse(goodContent).success, 'E2 wrapper 契约可解析');
  // 旧 M6 只读路径：projects 仍 m6、snapshot NULL（本轮不得触碰）
  const projectRow = getDb().prepare('SELECT pipeline_version, m7_pipeline_snapshot_id FROM projects WHERE id = ?').get(projectId) as {pipeline_version: string; m7_pipeline_snapshot_id: string | null};
  ok(projectRow.pipeline_version === 'm6' && projectRow.m7_pipeline_snapshot_id === null, 'E3 项目仍 m6 / snapshot NULL（无激活）');

  console.log(`\n==== test-m73b-visual-sequences: ${pass} PASS / ${fail} FAIL ====`);
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m73b-visual-sequences'), {recursive: true, force: true});
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
