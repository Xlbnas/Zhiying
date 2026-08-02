/**
 * M7.3B Shots 测试（临时 DB + Mock provider，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m73b-shots.ts
 * 覆盖：
 * - schema（11.1 对 shots）：正常 parse / unknown 字段拒绝 / intent 副本拒绝 /
 *   timing・asset・render 字段拒绝 / voice・performance 字段拒绝 / malformed ID 拒绝 /
 *   版本字符串精确；
 * - 语义校验（11.3 全矩阵）：all units exact coverage / speech+silence 均覆盖 /
 *   gap / overlap / duplicate / non-contiguous / shot cross sequence / wrong chapter /
 *   missing sequence / intent outside sequence / shot crosses intent boundary /
 *   first transition 非 cut / state_morph cross sequence / hold invalid /
 *   unresolved → needs_review（非阻断） / 无 final timing 字段；
 * - classify：exact source → current_candidate / sequences hash 漂移 → stale_source /
 *   source 与 sequences 自身 source 不一致 → stale_source（SHOT_SOURCE_MISMATCH）/
 *   语义损坏 → invalid_source / unresolved → needs_review / malformed fail-closed。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m73b-shots');
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
import {buildNarrativeBeats} from '../src/lib/narrative-beats/plan';
import type {NarrativeBeatV1} from '../src/lib/narrative-beats/schema';
import {buildVisualIntentPlan} from '../src/lib/visual-intent/plan';
import type {VisualIntentV1} from '../src/lib/visual-intent/schema';
import {buildVisualSequences} from '../src/lib/visual-sequences/plan';
import type {VisualSequenceV1} from '../src/lib/visual-sequences/schema';
import {
  SHOTS_KIND,
  SHOTS_SCHEMA_VERSION,
  SHOTS_COMPILER_VERSION,
  SHOTS_PROMPT_VERSION,
  shotsArtifactV1Schema,
  shotsProposalSchema,
  shotV1Schema,
  type ShotV1,
} from '../src/lib/shots/schema';
import {
  scanForbiddenShotKeys,
  validateShots,
  type ShotValidationIssue,
} from '../src/lib/shots/validate';
import {
  classifyShotsCandidate,
  getShotsArtifact,
} from '../src/lib/shots/classify';
import {buildShots, precheckShotsSource, ShotsError} from '../src/lib/shots/plan';

function sha256(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m73b-shots'), {recursive: true, force: true});

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

function makeValidIntents(plan: NarrationPlanV2): VisualIntentV1[] {
  const n4 = plan.units[3]!;
  if (n4.kind !== 'speech') throw new Error('fixture: N004 必须是 speech');
  return [
    {visualIntentId: 'V001', chapter: 1, beatIds: ['B001'], intent: 'SHOW_PERSON', strategy: 'portrait', authenticity: 'authentic_required', objective: 'o', subject: {kind: 'person', label: '讲述者', evidenceIds: []}, continuationOfVisualIntentId: null, displayText: null},
    {visualIntentId: 'V002', chapter: 1, beatIds: ['B002'], intent: 'CONTINUE_PREVIOUS_VISUAL', strategy: 'continue_previous', authenticity: 'inherited', objective: 'o', subject: {kind: 'none', label: null, evidenceIds: []}, continuationOfVisualIntentId: 'V001', displayText: null},
    {visualIntentId: 'V003', chapter: 1, beatIds: ['B003'], intent: 'SHOW_PLACE', strategy: 'archive_photo', authenticity: 'authentic_required', objective: 'o', subject: {kind: 'place', label: '旧城区', evidenceIds: []}, continuationOfVisualIntentId: null, displayText: null},
    {visualIntentId: 'V004', chapter: 2, beatIds: ['B004'], intent: 'EMPHASIZE_TEXT', strategy: 'title_card', authenticity: 'not_applicable', objective: 'o', subject: {kind: 'text', label: null, evidenceIds: []}, continuationOfVisualIntentId: null, displayText: {sourceKind: 'spoken_exact', sourceUnitId: n4.id, sourceChapter: null, text: n4.spokenText}},
    {visualIntentId: 'V005', chapter: 2, beatIds: ['B005'], intent: 'SHOW_DATA', strategy: 'mg_data', authenticity: 'synthetic_allowed', objective: 'o', subject: {kind: 'data', label: '规模', evidenceIds: []}, continuationOfVisualIntentId: null, displayText: null},
    {visualIntentId: 'V006', chapter: 2, beatIds: ['B006'], intent: 'NO_VISUAL_CHANGE', strategy: 'hold', authenticity: 'inherited', objective: 'o', subject: {kind: 'none', label: null, evidenceIds: []}, continuationOfVisualIntentId: 'V005', displayText: null},
  ];
}

function makeValidSequences(): VisualSequenceV1[] {
  return [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002', 'B003'], visualIntentIds: ['V001', 'V002', 'V003']},
    {sequenceId: 'Q002', chapter: 2, beatIds: ['B004', 'B005', 'B006'], visualIntentIds: ['V004', 'V005', 'V006']},
  ];
}

/** 合法 shots 基线：每 unit 一个 shot；H002 hold（V002 是 V001 的合法 continuation）。 */
function makeValidShots(): ShotV1[] {
  return [
    {shotId: 'H001', sequenceId: 'Q001', chapter: 1, unitIds: ['N001'], visualIntentId: 'V001', transitionFromPrevious: 'cut'},
    {shotId: 'H002', sequenceId: 'Q001', chapter: 1, unitIds: ['N002'], visualIntentId: 'V002', transitionFromPrevious: 'hold'},
    {shotId: 'H003', sequenceId: 'Q001', chapter: 1, unitIds: ['N003'], visualIntentId: 'V003', transitionFromPrevious: 'state_morph'},
    {shotId: 'H004', sequenceId: 'Q002', chapter: 2, unitIds: ['N004'], visualIntentId: 'V004', transitionFromPrevious: 'cut'},
    {shotId: 'H005', sequenceId: 'Q002', chapter: 2, unitIds: ['N005'], visualIntentId: 'V005', transitionFromPrevious: 'state_morph'},
    {shotId: 'H006', sequenceId: 'Q002', chapter: 2, unitIds: ['N006'], visualIntentId: 'V006', transitionFromPrevious: 'hold'},
  ];
}

function codes(issues: ShotValidationIssue[]): string[] {
  return issues.map((i) => i.code);
}

function hasCode(issues: ShotValidationIssue[], code: string): boolean {
  return issues.some((i) => i.code === code);
}

/** 手工构造 shots artifact content（wrapper 形状与 build 一致）。 */
function makeShotsContent(
  sequencesArtifactId: string,
  seqSource: Record<string, string>,
  shots: ShotV1[],
  extra?: Record<string, unknown>,
): Record<string, unknown> & {source: Record<string, string>} {
  return {
    schemaVersion: SHOTS_SCHEMA_VERSION,
    compilerVersion: SHOTS_COMPILER_VERSION,
    promptVersion: SHOTS_PROMPT_VERSION,
    source: {
      visualSequencesArtifactId: sequencesArtifactId,
      visualSequencesContentHash: '',
      visualSequencesSchemaVersion: 'visual-sequences@1.0',
      visualSequencesCompilerVersion: '1.0',
      narrativeBeatsArtifactId: seqSource.narrativeBeatsArtifactId,
      narrativeBeatsContentHash: seqSource.narrativeBeatsContentHash,
      visualIntentPlanArtifactId: seqSource.visualIntentPlanArtifactId,
      visualIntentPlanContentHash: seqSource.visualIntentPlanContentHash,
      narrationPlanV2ArtifactId: seqSource.narrationPlanV2ArtifactId,
      narrationPlanV2ContentHash: seqSource.narrationPlanV2ContentHash,
      scriptV2VersionId: seqSource.scriptV2VersionId,
      scriptV2ContentHash: seqSource.scriptV2ContentHash,
      ...extra,
    } as Record<string, string>,
    generation: {requestId: 'req-shots-m73b-0001', provider: 'scriptable-mock', model: 'deepseek-v4-flash', attemptCount: 1},
    shots,
  } as Record<string, unknown> & {source: Record<string, string>};
}

function insertShotsArtifact(projectId: string, content: Record<string, unknown>): string {
  const id = `shot-art-${crypto.randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?), ?, NULL, ?)`,
    )
    .run(id, projectId, SHOTS_KIND, projectId, SHOTS_KIND, JSON.stringify(content), new Date().toISOString());
  return id;
}

function sourceHash(kind: string, artifactId: string): string {
  const row = getDb().prepare('SELECT content_json FROM artifacts WHERE id = ? AND kind = ?').get(artifactId, kind) as {content_json: string} | undefined;
  return sha256(row?.content_json ?? '');
}

async function main(): Promise<void> {
  const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
  const buildA = buildNarrationPlanV2(projectId);
  const plan = buildA.plan;
  const beats = makeValidBeats(plan);
  const intents = makeValidIntents(plan);

  // 造 exact source 链：beats → intent → sequences（全部走 build 路径）
  const beatsProvider = new ScriptableProvider();
  beatsProvider.push({text: JSON.stringify({beats})});
  const beatsBuild = await buildNarrativeBeats({projectId, narrationPlanV2ArtifactId: buildA.artifact.id, requestId: 'req-beats-m73b-0001', provider: beatsProvider});
  if (beatsBuild.kind !== 'succeeded') throw new Error('fixture: beats build failed');
  const beatsArtifactId = beatsBuild.artifact.id;

  const intentProvider = new ScriptableProvider();
  intentProvider.push({text: JSON.stringify({intents})});
  const intentBuild = await buildVisualIntentPlan({projectId, narrativeBeatsArtifactId: beatsArtifactId, requestId: 'req-intent-m73b-0001', provider: intentProvider});
  if (intentBuild.kind !== 'succeeded') throw new Error('fixture: intent build failed');
  const intentArtifactId = intentBuild.artifact.id;

  const sequencesProvider = new ScriptableProvider();
  sequencesProvider.push({text: JSON.stringify({sequences: makeValidSequences()})});
  const sequencesBuild = await buildVisualSequences({
    projectId,
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-sequences-m73b-0001',
    provider: sequencesProvider,
  });
  if (sequencesBuild.kind !== 'succeeded') throw new Error('fixture: sequences build failed');
  const sequencesArtifactId = sequencesBuild.artifact.id;
  const seqContent = sequencesBuild.visualSequences;
  const seqSource = seqContent.source;
  const sequencesRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(sequencesArtifactId) as {content_json: string};
  const sequencesHash = sha256(sequencesRow.content_json);

  // ═══════ A. schema（11.1 对 shots） ═══════
  console.log('── A. schema');
  const validShot = makeValidShots()[0]!;
  ok(shotV1Schema.safeParse(validShot).success, 'A1 正常 shot parse 通过');
  ok(!shotV1Schema.safeParse({...validShot, shotId: 'H01'}).success, 'A2 malformed shotId (H01) 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, shotId: 'H001x'}).success, 'A3 malformed shotId (H001x) 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, unitIds: []}).success, 'A4 空 unitIds 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, sequenceId: 'Q01'}).success, 'A5 malformed sequenceId 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, transitionFromPrevious: 'zoom'}).success, 'A6 未知 transition 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, chapter: 0}).success, 'A7 chapter=0 拒绝');
  // intent 副本拒绝
  ok(!shotV1Schema.safeParse({...validShot, intent: 'SHOW_PERSON'}).success, 'A8 intent 副本字段拒绝');
  ok(!shotV1Schema.safeParse({...validShot, strategy: 'portrait'}).success, 'A9 strategy 副本字段拒绝');
  ok(!shotV1Schema.safeParse({...validShot, authenticity: 'authentic_required'}).success, 'A10 authenticity 副本字段拒绝');
  ok(!shotV1Schema.safeParse({...validShot, subject: {kind: 'person'}}).success, 'A11 subject 副本字段拒绝');
  ok(!shotV1Schema.safeParse({...validShot, displayText: 'x'}).success, 'A12 displayText 拒绝');
  // timing / render 字段拒绝
  ok(!shotV1Schema.safeParse({...validShot, startMs: 0}).success, 'A13 startMs 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, endMs: 0}).success, 'A14 endMs 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, durationMs: 0}).success, 'A15 durationMs 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, frames: 24}).success, 'A16 frames 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, renderSegment: 'r1'}).success, 'A17 renderSegment 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, assetId: 'a1'}).success, 'A18 assetId 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, templateId: 't1'}).success, 'A19 templateId 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, fitPolicy: 'cover'}).success, 'A20 fitPolicy 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, focalPoint: {x: 0}}).success, 'A21 focalPoint 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, cropSafe: true}).success, 'A22 cropSafe 拒绝');
  // voice/performance 字段拒绝
  ok(!shotV1Schema.safeParse({...validShot, voiceProfile: 'vp1'}).success, 'A23 voiceProfile 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, delivery: 'normal'}).success, 'A24 delivery 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, pace: 1}).success, 'A25 pace 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, energy: 1}).success, 'A26 energy 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, emotion: 'calm'}).success, 'A27 emotion 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, spokenText: 'x'}).success, 'A28 spokenText 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, subtitleText: 'x'}).success, 'A29 subtitleText 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, beatSummary: 'x'}).success, 'A30 beatSummary 拒绝');
  // proposal 契约
  ok(shotsProposalSchema.safeParse({shots: makeValidShots()}).success, 'A31 proposal 正常');
  ok(!shotsProposalSchema.safeParse({shots: makeValidShots(), source: {}}).success, 'A32 proposal 不允许 source');
  ok(!shotsProposalSchema.safeParse({shots: makeValidShots(), generation: {}}).success, 'A33 proposal 不允许 generation');
  ok(!shotsProposalSchema.safeParse({}).success, 'A34 proposal 缺少 shots 拒绝');
  // 版本字符串
  ok(SHOTS_KIND === 'shot_plan', 'A35 kind=shot_plan（与冻结 snapshot ruleset 一致）');
  ok(SHOTS_SCHEMA_VERSION === 'shots@1.0', 'A36 schemaVersion=shots@1.0');
  ok(SHOTS_COMPILER_VERSION === '1.0', 'A37 compilerVersion=1.0');
  ok(SHOTS_PROMPT_VERSION === 'shots@1.0', 'A38 promptVersion=shots@1.0');
  // forbidden scan
  ok(scanForbiddenShotKeys(makeValidShots()).length === 0, 'A39 合法 shots forbidden scan 通过');
  ok(scanForbiddenShotKeys([{...validShot, startMs: 1, assetId: 'a'}]).includes('startMs'), 'A40 forbidden scan 命中 startMs');
  ok(scanForbiddenShotKeys([{...validShot, emotion: 'calm'}]).includes('emotion'), 'A41 forbidden scan 命中 emotion');
  // reference ID schema（M7.3B.R1 P1）：malformed reference 在 schema 层拒绝
  ok(!shotV1Schema.safeParse({...validShot, unitIds: ['N01']}).success, 'A42 unitIds N01 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, unitIds: ['N0001']}).success, 'A43 unitIds N0001 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, unitIds: ['n001']}).success, 'A44 unitIds n001（小写）拒绝');
  ok(!shotV1Schema.safeParse({...validShot, unitIds: ['x']}).success, 'A45 unitIds x 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, visualIntentId: 'V01'}).success, 'A46 visualIntentId V01 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, visualIntentId: 'V0001'}).success, 'A47 visualIntentId V0001 拒绝');
  ok(!shotV1Schema.safeParse({...validShot, visualIntentId: 'x'}).success, 'A48 visualIntentId x 拒绝');
  ok(shotV1Schema.safeParse(validShot).success, 'A49 合法 N001/V001 通过');
  ok(!shotV1Schema.safeParse({...validShot, unitIds: []}).success, 'A50 空 unitIds 继续拒绝');

  // ═══════ B. validate 矩阵（11.3） ═══════
  console.log('── B. validate 矩阵');
  const valid = makeValidShots();
  const beatsArtifact = (beatsBuild as Extract<typeof beatsBuild, {kind: 'succeeded'}>).beats;
  const validIssues = validateShots(seqContent, beatsArtifact, intents, plan, valid);
  ok(validIssues.length === 0, 'B1 all units exact coverage 成功（speech+silence 全覆盖，0 issues）', validIssues);

  // gap：H006 去掉 N006
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, valid.slice(0, 5)), 'SHOT_UNIT_COVERAGE_GAP'), 'B2 gap → SHOT_UNIT_COVERAGE_GAP');
  // overlap：N002 被 H001 和 H002 覆盖
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    {...valid[0]!, unitIds: ['N001', 'N002']},
    ...valid.slice(1),
  ]), 'SHOT_UNIT_OVERLAP'), 'B3 overlap → SHOT_UNIT_OVERLAP');
  // duplicate：shot 内重复 unit
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    {...valid[0]!, unitIds: ['N001', 'N001']},
    ...valid.slice(1),
  ]), 'SHOT_UNIT_DUPLICATE'), 'B4 同 shot 重复 unit → SHOT_UNIT_DUPLICATE');
  // non-contiguous：H001 [N001, N003]
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    {...valid[0]!, unitIds: ['N001', 'N003']},
    ...valid.slice(1),
  ]), 'SHOT_UNIT_NON_CONTIGUOUS'), 'B5 non-contiguous → SHOT_UNIT_NON_CONTIGUOUS');
  // 跨 sequence：H002 引入 N004（属 Q002）
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    {...valid[0]!},
    {...valid[1]!, unitIds: ['N002', 'N004']},
    ...valid.slice(2),
  ]), 'SHOT_SEQUENCE_CROSSING'), 'B6 shot 跨 sequence → SHOT_SEQUENCE_CROSSING');
  // wrong chapter：H001 chapter=2
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    {...valid[0]!, chapter: 2},
    ...valid.slice(1),
  ]), 'SHOT_CHAPTER_MISMATCH'), 'B7 wrong chapter → SHOT_CHAPTER_MISMATCH');
  // missing sequence：H001 sequenceId=Q999
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    {...valid[0]!, sequenceId: 'Q999'},
    ...valid.slice(1),
  ]), 'SHOT_SEQUENCE_NOT_FOUND'), 'B8 missing sequence → SHOT_SEQUENCE_NOT_FOUND');
  // intent outside sequence：H001 用 V004（属 Q002）
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    {...valid[0]!, visualIntentId: 'V004'},
    ...valid.slice(1),
  ]), 'SHOT_INTENT_OUTSIDE_SEQUENCE'), 'B9 intent outside sequence → SHOT_INTENT_OUTSIDE_SEQUENCE');
  // shot crosses intent boundary：H003 [N003] V002（V002 只覆盖 N002）
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    valid[0]!, valid[1]!,
    {...valid[2]!, visualIntentId: 'V002'},
    ...valid.slice(3),
  ]), 'SHOT_INTENT_BOUNDARY_CROSSING'), 'B10 shot 跨 intent 边界 → SHOT_INTENT_BOUNDARY_CROSSING');
  // first transition 非 cut
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    {...valid[0]!, transitionFromPrevious: 'crossfade'},
    ...valid.slice(1),
  ]), 'SHOT_TRANSITION_INVALID'), 'B11 首 shot transition 非 cut → SHOT_TRANSITION_INVALID');
  // state_morph cross sequence（新 sequence 首 shot）
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    ...valid.slice(0, 3),
    {...valid[3]!, transitionFromPrevious: 'state_morph'},
    ...valid.slice(4),
  ]), 'SHOT_TRANSITION_INVALID'), 'B12 新 sequence 首 shot state_morph → SHOT_TRANSITION_INVALID');
  // 新 sequence 首 shot hold
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    ...valid.slice(0, 3),
    {...valid[3]!, transitionFromPrevious: 'hold'},
    ...valid.slice(4),
  ]), 'SHOT_TRANSITION_INVALID'), 'B13 新 sequence 首 shot hold → SHOT_TRANSITION_INVALID');
  // hold invalid：H002 用 V003（非同一 intent、非 continuation）
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    valid[0]!,
    {...valid[1]!, visualIntentId: 'V003'},
    ...valid.slice(2),
  ]), 'SHOT_TRANSITION_INVALID'), 'B14 hold 不保持 intent 也无 continuation → SHOT_TRANSITION_INVALID');
  // id 连续 / 重复
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    {...valid[0]!},
    {...valid[2]!},
    ...valid.slice(2),
  ]), 'SHOT_ID_SEQUENCE_BROKEN'), 'B15 id 跳号 → SHOT_ID_SEQUENCE_BROKEN');
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    valid[0]!, valid[0]!, ...valid.slice(2),
  ]), 'SHOT_ID_DUPLICATE'), 'B16 id 重复 → SHOT_ID_DUPLICATE');
  // sequence 无 shot
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, valid.slice(0, 3)), 'SHOT_SEQUENCE_UNCOVERED'), 'B17 sequence 无 shot → SHOT_SEQUENCE_UNCOVERED');
  // 引用不存在 unit
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    {...valid[0]!, unitIds: ['N999']},
    ...valid.slice(1),
  ]), 'SHOT_UNIT_NOT_FOUND'), 'B18 引用不存在 unit → SHOT_UNIT_NOT_FOUND');
  // 引用不存在 intent
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    {...valid[0]!, visualIntentId: 'V999'},
    ...valid.slice(1),
  ]), 'SHOT_INTENT_NOT_FOUND'), 'B19 引用不存在 intent → SHOT_INTENT_NOT_FOUND');
  // exact-but-missing 合法格式 unit → semantic NOT_FOUND（schema 层放行）
  ok(hasCode(validateShots(seqContent, beatsArtifact, intents, plan, [
    {...valid[0]!, unitIds: ['N999']},
    ...valid.slice(1),
  ]), 'SHOT_UNIT_NOT_FOUND'), 'B20 exact-but-missing unit（N999 合法格式）→ semantic NOT_FOUND');

  // ── 全局 canonical 顺序（M7.3B.R1 P0）──
  // Q002 shot block 完整放在 Q001 前面：shotId 重新 H001…Hnnn、每 sequence 内
  // unit 仍连续、chapter/intent/transition 都合法——旧实现（只查交错与
  // within-sequence 连续）会放过。
  const seqSwapped: ShotV1[] = [
    {shotId: 'H001', sequenceId: 'Q002', chapter: 2, unitIds: ['N004'], visualIntentId: 'V004', transitionFromPrevious: 'cut'},
    {shotId: 'H002', sequenceId: 'Q002', chapter: 2, unitIds: ['N005'], visualIntentId: 'V005', transitionFromPrevious: 'state_morph'},
    {shotId: 'H003', sequenceId: 'Q002', chapter: 2, unitIds: ['N006'], visualIntentId: 'V006', transitionFromPrevious: 'hold'},
    {shotId: 'H004', sequenceId: 'Q001', chapter: 1, unitIds: ['N001'], visualIntentId: 'V001', transitionFromPrevious: 'cut'},
    {shotId: 'H005', sequenceId: 'Q001', chapter: 1, unitIds: ['N002'], visualIntentId: 'V002', transitionFromPrevious: 'hold'},
    {shotId: 'H006', sequenceId: 'Q001', chapter: 1, unitIds: ['N003'], visualIntentId: 'V003', transitionFromPrevious: 'state_morph'},
  ];
  const seqSwapIssues = validateShots(seqContent, beatsArtifact, intents, plan, seqSwapped);
  ok(hasCode(seqSwapIssues, 'SHOT_SEQUENCE_ORDER_MISMATCH'), 'B21 Q002 block 前置 → SHOT_SEQUENCE_ORDER_MISMATCH', seqSwapIssues);
  ok(hasCode(seqSwapIssues, 'SHOT_UNIT_ORDER_MISMATCH'), 'B22 同时命中 SHOT_UNIT_ORDER_MISMATCH（全局 unit 时间线错）');
  ok(!hasCode(seqSwapIssues, 'SHOT_SEQUENCE_CROSSING'), 'B23 无交错（block 完整）→ 不误报 CROSSING');
  ok(!hasCode(seqSwapIssues, 'SHOT_UNIT_COVERAGE_GAP') && !hasCode(seqSwapIssues, 'SHOT_UNIT_COVERAGE_MISMATCH'), 'B24 覆盖完整（仅顺序错）');
  ok(!hasCode(seqSwapIssues, 'SHOT_CHAPTER_MISMATCH') && !hasCode(seqSwapIssues, 'SHOT_TRANSITION_INVALID'), 'B25 chapter/transition 合法（不误报）');

  // 同一 sequence 内两个合法 shot block 交换（Q001 内 H2=[N002] 与 H3=[N003] 互换；
  // transition 统一改 cut 保持合法；intent 随 unit 匹配）
  const unitSwapped: ShotV1[] = [
    valid[0]!,
    {...valid[2]!, shotId: 'H002', transitionFromPrevious: 'cut'},
    {...valid[1]!, shotId: 'H003', transitionFromPrevious: 'cut'},
    ...valid.slice(3),
  ];
  const unitSwapIssues = validateShots(seqContent, beatsArtifact, intents, plan, unitSwapped);
  ok(hasCode(unitSwapIssues, 'SHOT_UNIT_ORDER_MISMATCH'), 'B26 sequence 内 shot block 交换 → SHOT_UNIT_ORDER_MISMATCH', unitSwapIssues);
  ok(!hasCode(unitSwapIssues, 'SHOT_SEQUENCE_ORDER_MISMATCH'), 'B27 sequence block 顺序未变 → 不误报 SEQUENCE_ORDER');
  ok(!hasCode(unitSwapIssues, 'SHOT_INTENT_BOUNDARY_CROSSING'), 'B28 intent 边界合法（不误报）');
  ok(!hasCode(unitSwapIssues, 'SHOT_TRANSITION_INVALID'), 'B29 transition 合法（不误报）');

  // ═══════ C. classify ═══════
  console.log('── C. classify');
  const goodContent = makeShotsContent(sequencesArtifactId, seqSource, valid);
  goodContent.source.visualSequencesContentHash = sequencesHash;
  const goodId = insertShotsArtifact(projectId, goodContent);
  const goodClass = classifyShotsCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(goodId) as never);
  ok(goodClass.status === 'current_candidate', 'C1 exact source 成功 → current_candidate', goodClass);
  ok(getShotsArtifact(projectId, goodId) !== null, 'C2 exact get 可读');

  // sequences hash 漂移 → stale_source
  const driftContent = makeShotsContent(sequencesArtifactId, seqSource, valid);
  driftContent.source.visualSequencesContentHash = sha256('drifted');
  const driftId = insertShotsArtifact(projectId, driftContent);
  const driftClass = classifyShotsCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(driftId) as never);
  ok(driftClass.status === 'stale_source', 'C3 sequences hash 漂移 → stale_source', driftClass);

  // shots source 与 sequences 自身 source 不一致（scriptV2VersionId 不同）→ stale_source
  const mismatchContent = makeShotsContent(sequencesArtifactId, seqSource, valid);
  mismatchContent.source.visualSequencesContentHash = sequencesHash;
  mismatchContent.source.scriptV2VersionId = 'other-version';
  const mismatchId = insertShotsArtifact(projectId, mismatchContent);
  const mismatchClass = classifyShotsCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(mismatchId) as never);
  ok(mismatchClass.status === 'stale_source', 'C4 source 与 sequences 自身 source 不一致 → stale_source', mismatchClass);

  // 语义损坏（gap）→ invalid_source
  const brokenContent = makeShotsContent(sequencesArtifactId, seqSource, valid.slice(0, 5));
  brokenContent.source.visualSequencesContentHash = sequencesHash;
  const brokenId = insertShotsArtifact(projectId, brokenContent);
  const brokenClass = classifyShotsCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(brokenId) as never);
  ok(brokenClass.status === 'invalid_source', 'C5 语义损坏（gap）→ invalid_source', brokenClass);

  // malformed JSON → invalid_source
  const malformedId = `shot-art-${crypto.randomUUID()}`;
  getDb().prepare(`INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at) VALUES (?, ?, ?, (SELECT COALESCE(MAX(version),0)+1 FROM artifacts WHERE project_id = ? AND kind = ?), 'not-json', NULL, ?)`)
    .run(malformedId, projectId, SHOTS_KIND, projectId, SHOTS_KIND, new Date().toISOString());
  const malformedClass = classifyShotsCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(malformedId) as never);
  ok(malformedClass.status === 'invalid_source', 'C6 malformed source fail-closed → invalid_source', malformedClass);

  // 未知版本 → schema fail-closed（invalid_source）
  const compContent = {...makeShotsContent(sequencesArtifactId, seqSource, valid), promptVersion: 'shots@9.9'};
  compContent.source.visualSequencesContentHash = sequencesHash;
  const compId = insertShotsArtifact(projectId, compContent);
  const compClass = classifyShotsCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(compId) as never);
  ok(compClass.status === 'invalid_source', 'C7 未知 prompt version → schema fail-closed（invalid_source）', compClass);

  // ═══════ D. precheck ═══════
  console.log('── D. precheck');
  const pre = precheckShotsSource({projectId, visualSequencesArtifactId: sequencesArtifactId, requestId: 'req-shots-pre-0001'});
  ok(pre.requestId === 'req-shots-pre-0001' && pre.seqRef.artifact.id === sequencesArtifactId, 'D1 shots precheck 通过');
  const noSeq = await (async () => {
    try {
      precheckShotsSource({projectId, visualSequencesArtifactId: 'no-such-seq', requestId: 'req-shots-pre-0002'});
      return null;
    } catch (err) {
      return err instanceof ShotsError ? err.code : 'WRONG';
    }
  })();
  ok(noSeq === 'SEQUENCES_NOT_FOUND', 'D2 不存在 sequences → SEQUENCES_NOT_FOUND', noSeq);
  const badReq = await (async () => {
    try {
      precheckShotsSource({projectId, visualSequencesArtifactId: sequencesArtifactId, requestId: 'short'});
      return null;
    } catch (err) {
      return err instanceof ShotsError ? err.code : 'WRONG';
    }
  })();
  ok(badReq === 'REQUEST_ID_INVALID', 'D3 非法 requestId → REQUEST_ID_INVALID', badReq);

  // ═══════ E. 向后兼容 ═══════
  console.log('── E. backward compat');
  ok(getShotsArtifact(projectId, 'no-such') === null, 'E1 跨项目/不存在 exact 读取 → null');
  ok(shotsArtifactV1Schema.safeParse(goodContent).success, 'E2 wrapper 契约可解析');
  const projectRow = getDb().prepare('SELECT pipeline_version, m7_pipeline_snapshot_id FROM projects WHERE id = ?').get(projectId) as {pipeline_version: string; m7_pipeline_snapshot_id: string | null};
  ok(projectRow.pipeline_version === 'm6' && projectRow.m7_pipeline_snapshot_id === null, 'E3 项目仍 m6 / snapshot NULL（无激活）');

  // ═══════ F. canonical order：classify + generation repair（M7.3B.R1 P0） ═══════
  console.log('── F. canonical order');
  // F1：乱序 shots artifact（Q002 block 前置）→ classify invalid_source
  const seqSwappedContent = makeShotsContent(sequencesArtifactId, seqSource, [
    {shotId: 'H001', sequenceId: 'Q002', chapter: 2, unitIds: ['N004'], visualIntentId: 'V004', transitionFromPrevious: 'cut' as const},
    {shotId: 'H002', sequenceId: 'Q002', chapter: 2, unitIds: ['N005'], visualIntentId: 'V005', transitionFromPrevious: 'cut' as const},
    {shotId: 'H003', sequenceId: 'Q002', chapter: 2, unitIds: ['N006'], visualIntentId: 'V006', transitionFromPrevious: 'cut' as const},
    {shotId: 'H004', sequenceId: 'Q001', chapter: 1, unitIds: ['N001'], visualIntentId: 'V001', transitionFromPrevious: 'cut' as const},
    {shotId: 'H005', sequenceId: 'Q001', chapter: 1, unitIds: ['N002'], visualIntentId: 'V002', transitionFromPrevious: 'cut' as const},
    {shotId: 'H006', sequenceId: 'Q001', chapter: 1, unitIds: ['N003'], visualIntentId: 'V003', transitionFromPrevious: 'cut' as const},
  ]);
  seqSwappedContent.source.visualSequencesContentHash = sequencesHash;
  const seqSwappedId = insertShotsArtifact(projectId, seqSwappedContent);
  const seqSwappedClass = classifyShotsCandidate(projectId, getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(seqSwappedId) as never);
  ok(seqSwappedClass.status === 'invalid_source', 'F1 乱序 shots classify → invalid_source', seqSwappedClass);

  // F2：generation repair（首次乱序 → validator 拒绝 → repair 返回 canonical）
  const genShotsProvider = new ScriptableProvider();
  const disorderShots: ShotV1[] = [
    {shotId: 'H001', sequenceId: 'Q002', chapter: 2, unitIds: ['N004'], visualIntentId: 'V004', transitionFromPrevious: 'cut'},
    {shotId: 'H002', sequenceId: 'Q002', chapter: 2, unitIds: ['N005'], visualIntentId: 'V005', transitionFromPrevious: 'cut'},
    {shotId: 'H003', sequenceId: 'Q002', chapter: 2, unitIds: ['N006'], visualIntentId: 'V006', transitionFromPrevious: 'cut'},
    {shotId: 'H004', sequenceId: 'Q001', chapter: 1, unitIds: ['N001'], visualIntentId: 'V001', transitionFromPrevious: 'cut'},
    {shotId: 'H005', sequenceId: 'Q001', chapter: 1, unitIds: ['N002'], visualIntentId: 'V002', transitionFromPrevious: 'cut'},
    {shotId: 'H006', sequenceId: 'Q001', chapter: 1, unitIds: ['N003'], visualIntentId: 'V003', transitionFromPrevious: 'cut'},
  ];
  genShotsProvider.push({text: JSON.stringify({shots: disorderShots})});
  genShotsProvider.push({text: JSON.stringify({shots: makeValidShots()})});
  const genShotsBuild = await buildShots({
    projectId,
    visualSequencesArtifactId: sequencesArtifactId,
    requestId: 'req-shots-order-repair-0001',
    provider: genShotsProvider,
  });
  ok(genShotsBuild.kind === 'succeeded', 'F2a repair 后 build succeeded', genShotsBuild);
  if (genShotsBuild.kind === 'succeeded') {
    ok(genShotsBuild.generation?.attemptCount === 2, 'F2b repair attemptCount=2（首次乱序拒绝 + repair canonical）', genShotsBuild.generation);
    const artifactShots = genShotsBuild.shots.shots;
    ok(
      artifactShots.length === 6 &&
        artifactShots[0]!.sequenceId === 'Q001' &&
        artifactShots[3]!.sequenceId === 'Q002' &&
        artifactShots.every((s, i) => s.shotId === `H${String(i + 1).padStart(3, '0')}`),
      'F2c 落库 artifact 为 canonical 顺序（服务端未自动排序，内容来自 repair 输出）',
      artifactShots.map((s) => `${s.shotId}:${s.sequenceId}`),
    );
  }

  console.log(`\n==== test-m73b-shots: ${pass} PASS / ${fail} FAIL ====`);
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m73b-shots'), {recursive: true, force: true});
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
