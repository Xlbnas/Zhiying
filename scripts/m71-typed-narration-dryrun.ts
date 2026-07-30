/**
 * M7.1 Typed Narration — production dry-run CLI（默认完全只读）。
 *
 * 用法：
 *   npx tsx scripts/m71-typed-narration-dryrun.ts --project <projectId>
 *   npx tsx scripts/m71-typed-narration-dryrun.ts --project <projectId> --write-candidate
 *
 * 只读语义（默认）：
 * - 只读取 locked script_v2 / 旧 narration_plan / 旧 tts_jobs
 * - 不调用 TTS、不写任何 artifact、不改变 current/locked pointers、不改 pipelineVersion
 *
 * --write-candidate（仅当 dry-run 完全通过：needsReview=0 且 leakage=0）：
 * - append-only INSERT narration_plan_v2 candidate artifact
 * - candidate 不 current、不 lock、不触发 TTS/字幕/beats/render
 *
 * 退出码：0=通过；1=泄漏或异常；2=needsReview 非零（列出并停止，不静默修补）。
 */

import {getDb, closeDb} from '../src/lib/db';
import {getStage} from '../src/lib/workflow/stages';
import {getVersion} from '../src/lib/workflow/versions';
import {compileNarrationPlanV2} from '../src/lib/narration/compiler-v2';
import {inputModeOf, buildNarrationPlanV2} from '../src/lib/narration/plan-v2';
import {findDirectiveLeakage} from '../src/lib/narration/leakage';
import {normalizeSpokenText} from '../src/lib/tts/fingerprint';
import {planTtsReuseDecisions, type TtsProviderSnapshot} from '../src/lib/narration/audio-v2';
import {getPipelineVersion} from '../src/lib/pipeline-version';
import {ttsJobResultSchema} from '../src/lib/tts-jobs';
import {narrationPlanSchema, type NarrationPlan} from '../src/lib/narration/schema';
import {NARRATION_PLAN_V2_ARTIFACT_KIND} from '../src/lib/narration/schema-v2';

interface Args {
  projectId: string;
  writeCandidate: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let projectId = '';
  let writeCandidate = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') projectId = argv[++i] ?? '';
    if (argv[i] === '--write-candidate') writeCandidate = true;
  }
  if (!projectId) {
    console.error('用法: npx tsx scripts/m71-typed-narration-dryrun.ts --project <projectId> [--write-candidate]');
    process.exit(1);
  }
  return {projectId, writeCandidate};
}

function readOldPlan(projectId: string): NarrationPlan | null {
  const rows = getDb()
    .prepare(
      `SELECT content_json FROM artifacts
       WHERE project_id = ? AND kind = 'narration_plan' ORDER BY version DESC`,
    )
    .all(projectId) as Array<{content_json: string}>;
  for (const row of rows) {
    try {
      const parsed = narrationPlanSchema.safeParse(JSON.parse(row.content_json));
      if (parsed.success) return parsed.data;
    } catch {
      // skip
    }
  }
  return null;
}

/** 旧→新 unit 映射：按归一化文本对齐（旧文本含指令前缀/括号时做包含匹配）。 */
function mapOldToNew(
  oldPlan: NarrationPlan | null,
  newUnits: Array<{id: string; kind: string; spokenText?: string}>,
): {matched: Array<[string, string]>; unmatchedOld: string[]; unmatchedNew: string[]} {
  if (!oldPlan) return {matched: [], unmatchedOld: [], unmatchedNew: newUnits.filter((u) => u.kind === 'speech').map((u) => u.id)};
  const oldSpeeches = oldPlan.units.filter((u) => u.kind === 'speech');
  const newSpeeches = newUnits.filter((u) => u.kind === 'speech');
  const matched: Array<[string, string]> = [];
  const usedNew = new Set<string>();
  for (const oldUnit of oldSpeeches) {
    const oldText = normalizeSpokenText(oldUnit.text ?? '');
    const hit = newSpeeches.find((nu) => {
      if (usedNew.has(nu.id)) return false;
      const newText = normalizeSpokenText(nu.spokenText ?? '');
      return newText === oldText || oldText.includes(newText) || newText.includes(oldText);
    });
    if (hit) {
      matched.push([oldUnit.id, hit.id]);
      usedNew.add(hit.id);
    }
  }
  return {
    matched,
    unmatchedOld: oldSpeeches.filter((u) => !matched.some(([o]) => o === u.id)).map((u) => u.id),
    unmatchedNew: newSpeeches.filter((u) => !usedNew.has(u.id)).map((u) => u.id),
  };
}

/** 从最新 succeeded tts job 的 result_json 推导真实 provider 快照（生产条件实录，非推断）。 */
function inferProviderSnapshot(projectId: string): TtsProviderSnapshot | null {
  const row = getDb()
    .prepare(
      `SELECT provider, result_json FROM tts_jobs
       WHERE project_id = ? AND status = 'succeeded' AND result_json IS NOT NULL
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(projectId) as {provider: string; result_json: string} | undefined;
  if (!row) return null;
  try {
    const parsed = ttsJobResultSchema.safeParse(JSON.parse(row.result_json));
    if (!parsed.success) return null;
    return {
      name: row.provider,
      model: parsed.data.model,
      providerVersion: parsed.data.providerVersion,
      providerCommit: parsed.data.providerCommit,
    };
  } catch {
    return null;
  }
}

function main(): void {
  const {projectId, writeCandidate} = parseArgs();
  const db = getDb();
  const project = db
    .prepare('SELECT id, title, pipeline_version FROM projects WHERE id = ?')
    .get(projectId) as {id: string; title: string; pipeline_version: string} | undefined;
  if (!project) {
    console.error(`项目不存在: ${projectId}`);
    process.exit(1);
  }

  const stage = getStage(projectId, 'script_v2');
  if (!stage || stage.status !== 'locked' || stage.locked_version === null) {
    console.error(`script_v2 未锁定（当前 ${stage?.status ?? 'missing'}）`);
    process.exit(1);
  }
  const versionRow = getVersion(projectId, 'script_v2', stage.locked_version) as
    | {id: string; version: number; content: string; prompt_version: string | null}
    | undefined;
  if (!versionRow) {
    console.error(`script_v2 locked_version=${stage.locked_version} 版本行不存在`);
    process.exit(1);
  }

  const inputMode = inputModeOf(versionRow.prompt_version);
  console.log('=== M7.1 Typed Narration Dry-run（只读）===');
  console.log(`project:            ${project.id}（${project.title}）`);
  console.log(`pipelineVersion:    ${getPipelineVersion(projectId)}（dry-run 不改变）`);
  console.log(`script_v2 locked:   v${stage.locked_version}（versionId=${versionRow.id}）`);
  console.log(`promptVersion:      ${versionRow.prompt_version ?? 'null'} → inputMode=${inputMode}`);

  const plan = compileNarrationPlanV2({
    scriptV2Markdown: versionRow.content,
    scriptV2VersionId: versionRow.id,
    scriptV2Version: stage.locked_version,
    scriptV2PromptVersion: versionRow.prompt_version,
    inputMode,
  });

  const speechUnits = plan.units.filter((u) => u.kind === 'speech');
  const silenceUnits = plan.units.filter((u) => u.kind === 'silence');
  console.log('\n--- 编译结果 ---');
  console.log(`units total:        ${plan.units.length}`);
  console.log(`speech units:       ${speechUnits.length}`);
  console.log(`silence units:      ${silenceUnits.length}`);
  console.log(`needsReview:        ${plan.needsReview.length}`);

  // leakage 断言：输出文本必须零泄漏
  let leakageCount = 0;
  for (const unit of speechUnits) {
    leakageCount += findDirectiveLeakage(unit.spokenText).length;
    if (unit.subtitleText !== null) leakageCount += findDirectiveLeakage(unit.subtitleText).length;
  }
  console.log(`leakage（输出文本）: ${leakageCount}`);

  const oldPlan = readOldPlan(projectId);
  if (oldPlan) {
    const oldSpeech = oldPlan.units.filter((u) => u.kind === 'speech').length;
    const oldPause = oldPlan.units.filter((u) => u.kind === 'pause').length;
    const oldProsody = oldPlan.units.filter((u) => u.kind === 'prosody').length;
    const oldBreath = oldPlan.units.filter((u) => u.kind === 'visual_breath').length;
    console.log('\n--- 旧 plan（v1，参考） ---');
    console.log(`old units:          ${oldPlan.units.length}（speech=${oldSpeech} pause=${oldPause} prosody=${oldProsody} visual_breath=${oldBreath}）compilerVersion=${oldPlan.compilerVersion}`);
    const mapping = mapOldToNew(oldPlan, plan.units);
    console.log(`old→new 映射:       matched=${mapping.matched.length} unmatchedOld=[${mapping.unmatchedOld.join(',')}] unmatchedNew=[${mapping.unmatchedNew.join(',')}]`);
  } else {
    console.log('\n--- 旧 plan（v1）不存在，跳过映射 ---');
  }

  // TTS fingerprint reuse estimate（只读，基于真实 succeeded jobs）
  const provider = inferProviderSnapshot(projectId);
  if (provider) {
    const reusePlan = planTtsReuseDecisions({projectId, plan, provider});
    console.log('\n--- TTS 增量复用估计（fingerprint 机制，dry-run 不执行 TTS） ---');
    console.log(`provider snapshot:  ${provider.name}/${provider.model}@${provider.providerCommit ?? 'n/a'}`);
    console.log(`reuse:              ${reusePlan.reuseCount}`);
    console.log(`rebuild:            ${reusePlan.rebuildCount}`);
    const byReason = new Map<string, number>();
    for (const d of reusePlan.decisions) {
      byReason.set(d.reasonCode, (byReason.get(d.reasonCode) ?? 0) + 1);
    }
    for (const [reason, count] of [...byReason.entries()].sort()) {
      console.log(`  ${reason}: ${count}`);
    }
  } else {
    console.log('\n--- 无 succeeded TTS job，跳过复用估计 ---');
  }

  if (plan.needsReview.length > 0) {
    console.log('\n--- needsReview（fail-closed：列出并停止，不静默修补） ---');
    for (const item of plan.needsReview) {
      console.log(`  ${item.id} [${item.kind}] 第${item.chapter}章 ${item.reason}`);
      console.log(`      raw: ${item.raw.slice(0, 120)}`);
    }
    console.log(`\n[dry-run] needsReview=${plan.needsReview.length} > 0 → 停止，不写入 candidate`);
    process.exit(2);
  }

  if (leakageCount > 0) {
    console.error('\n[dry-run] 输出文本存在指令泄漏 → 失败');
    process.exit(1);
  }

  if (writeCandidate) {
    // 防重复：已存在同 source 的 candidate 时 buildNarrationPlanV2 幂等复用
    const existing = db
      .prepare(
        `SELECT id FROM artifacts WHERE project_id = ? AND kind = ?`,
      )
      .all(projectId, NARRATION_PLAN_V2_ARTIFACT_KIND) as Array<{id: string}>;
    const result = buildNarrationPlanV2(projectId);
    console.log('\n--- candidate artifact（append-only，不 current / 不 lock） ---');
    console.log(`artifact id:        ${result.artifact.id}`);
    console.log(`artifact version:   ${result.artifact.version}`);
    console.log(`reused:             ${result.reused}（此前已有 ${existing.length} 个 v2 artifact）`);
    console.log('确认：未触发 TTS/字幕/beats/render；未改变 current/locked/pipelineVersion');
  } else {
    console.log('\n[dry-run] 通过（needsReview=0, leakage=0）。如需写入 candidate 加 --write-candidate');
  }
  process.exit(0);
}

try {
  main();
} finally {
  closeDb();
}
