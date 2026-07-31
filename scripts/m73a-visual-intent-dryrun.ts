/**
 * M7.3A Visual Intent Plan dry-run / candidate 生成（production 安全）。
 *
 * 用法：
 *   只读 dry-run：
 *     npx tsx scripts/m73a-visual-intent-dryrun.ts --project <id> --beats <artifactId>
 *   创建 candidate（显式 requestId，真实 LLM）：
 *     npx tsx scripts/m73a-visual-intent-dryrun.ts --project <id> --beats <artifactId> \
 *       --write-candidate --requestId <id>
 *
 * 安全边界（与 m72-narrative-beats-dryrun.ts 相同）：
 * - 只接受 exact narrativeBeatsArtifactId；绝不 current/latest 解析。
 * - dry-run 默认只读：不调用 LLM、不写 artifact、不改任何指针。
 * - --write-candidate 只写 append-only candidate：不 current/lock、
 *   不改 pipelineVersion、不创建 snapshot、不触发 TTS/字幕/下游。
 * - 不打印 secret 或内部配置（provider 只显示名字）。
 * - production 中 LLM_PROVIDER/DEEPSEEK_API_KEY 只存在于 worker 容器
 *   （compose 冻结边界：绝不注入 web/adapter）——请在 worker 容器内运行。
 */

import {getDb, closeDb} from '../src/lib/db';
import {getM7PipelineSnapshotId, getPipelineVersion} from '../src/lib/pipeline-version';
import {
  classifyNarrativeBeatsCandidate,
  getNarrativeBeatsArtifact,
} from '../src/lib/narrative-beats/plan';
import {getNarrationPlanV2Artifact} from '../src/lib/narration/plan-v2';
import {buildVisualIntentPlan, classifyVisualIntentCandidate} from '../src/lib/visual-intent/plan';
import {VISUAL_INTENT_SYSTEM_PROMPT, buildVisualIntentUserPrompt} from '../src/lib/visual-intent/prompt';
import {buildVisualIntentPlannerInput, hashPrompt} from '../src/lib/visual-intent/projection';
import {VISUAL_INTENT_KIND} from '../src/lib/visual-intent/schema';
import {validateVisualIntentPlan} from '../src/lib/visual-intent/validate';

interface Args {
  project: string;
  beats: string;
  writeCandidate: boolean;
  requestId: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {project: '', beats: '', writeCandidate: false, requestId: null};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--project') args.project = argv[++i] ?? '';
    else if (a === '--beats') args.beats = argv[++i] ?? '';
    else if (a === '--write-candidate') args.writeCandidate = true;
    else if (a === '--requestId') args.requestId = argv[++i] ?? '';
  }
  if (!args.project || !args.beats) {
    console.error('用法：--project <id> --beats <artifactId> [--write-candidate --requestId <id>]');
    process.exit(2);
  }
  if (args.writeCandidate && !args.requestId) {
    console.error('--write-candidate 必须显式提供 --requestId');
    process.exit(2);
  }
  return args;
}

function downstreamJobCounts(projectId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of ['tts_jobs', 'render_jobs']) {
    try {
      const row = getDb()
        .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ? AND status IN ('queued','running')`)
        .get(projectId) as {c: number};
      out[table] = row.c;
    } catch {
      out[table] = -1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const {project, beats: beatsArtifactId} = args;

  console.log('=== M7.3A Visual Intent dry-run ===');
  console.log(`projectId=${project}`);
  console.log(`narrativeBeatsArtifactId=${beatsArtifactId}`);

  // ── 前置检查（只读） ──
  const beatsRef = getNarrativeBeatsArtifact(project, beatsArtifactId);
  if (!beatsRef) {
    console.log('PRECHECK FAIL: narrative beats artifact 不存在/跨项目/契约非法');
    process.exit(1);
  }
  const beatsStatus = classifyNarrativeBeatsCandidate(project, beatsRef.artifact);
  console.log(`beats status=${beatsStatus.status}${beatsStatus.statusReason ? ` (${beatsStatus.statusReason})` : ''}`);
  if (beatsStatus.status !== 'eligible_candidate') {
    console.log('PRECHECK FAIL: beats 不是 eligible_candidate，禁止构建 visual intent');
    process.exit(1);
  }
  const narrationRef = getNarrationPlanV2Artifact(project, beatsRef.beats.source.narrationPlanV2ArtifactId);
  if (!narrationRef) {
    console.log('PRECHECK FAIL: beats provenance 指向的 narration plan 不可读');
    process.exit(1);
  }

  const beats = beatsRef.beats;
  const plan = narrationRef.plan;
  const speech = plan.units.filter((u) => u.kind === 'speech').length;
  const silence = plan.units.filter((u) => u.kind === 'silence').length;
  console.log(`beats=${beats.beats.length} narration units=${plan.units.length} speech=${speech} silence=${silence} chapters=${plan.chapters.length}`);
  console.log(`source narrationPlanV2ArtifactId=${beats.source.narrationPlanV2ArtifactId}`);
  console.log(`source narrationPlanV2ContentHash=${beats.source.narrationPlanV2ContentHash}`);

  // sanitized projection + prompt hash（不调用 LLM）
  const projection = buildVisualIntentPlannerInput(beats, plan);
  const userPrompt = buildVisualIntentUserPrompt(projection);
  const promptHash = hashPrompt(VISUAL_INTENT_SYSTEM_PROMPT, userPrompt);
  const projectionText = JSON.stringify(projection);
  console.log(`projection beats=${projection.beats.length} units=${projection.units.length}（无 sourceText：${!projectionText.includes('sourceText')}）`);
  console.log(`promptHash=${promptHash}`);
  console.log(`promptChars system=${VISUAL_INTENT_SYSTEM_PROMPT.length} user=${userPrompt.length}`);
  console.log(`llmProviderEnv=${process.env.LLM_PROVIDER ?? '(unset)'}`);

  console.log(`pipelineVersion=${getPipelineVersion(project)} snapshotPointer=${getM7PipelineSnapshotId(project) ?? 'NULL'}`);
  const jobs = downstreamJobCounts(project);
  console.log(`running jobs: tts=${jobs.tts_jobs} render=${jobs.render_jobs}`);

  if (!args.writeCandidate) {
    console.log('\nDRY-RUN ONLY：未调用 LLM、未写 artifact、未改任何指针。');
    return;
  }

  // ── 创建 candidate（真实 LLM，显式 requestId） ──
  console.log(`\n=== write-candidate requestId=${args.requestId} ===`);
  const usageBefore = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM llm_usage WHERE project_id = ? AND stage = 'm7_visual_intent'`)
    .get(project) as {c: number};

  const result = await buildVisualIntentPlan({
    projectId: project,
    narrativeBeatsArtifactId: beatsArtifactId,
    requestId: args.requestId!,
  });

  if (result.kind === 'in_progress') {
    console.error(`FAIL: 同 requestId 的 generation 正在运行 runId=${result.runId} retryAfterMs=${result.retryAfterMs}`);
    process.exit(2);
  }
  if (result.kind === 'terminal') {
    console.error(
      `FAIL: requestId 已终态 runId=${result.runId} status=${result.status} error=${result.errorCode}: ${result.errorMessage}`,
    );
    process.exit(3);
  }

  const usageRows = getDb()
    .prepare(
      `SELECT request_id, model, input_tokens, output_tokens, cost_cny
       FROM llm_usage WHERE project_id = ? AND job_id = ? ORDER BY created_at ASC`,
    )
    .all(project, args.requestId!) as Array<{
    request_id: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_cny: number;
  }>;

  console.log(`reused=${result.reused} legacy=${result.legacy} runId=${result.runId ?? '(none)'}`);
  console.log(`visual intent artifactId=${result.artifact.id} version=${result.artifact.version}`);
  console.log(`generation provider=${result.visualIntent.generation.provider} model=${result.visualIntent.generation.model} attemptCount=${result.visualIntent.generation.attemptCount}`);
  console.log(`intents=${result.visualIntent.intents.length}`);
  console.log(`usage rows for requestId: ${usageRows.length}（before=${usageBefore.c}）`);
  for (const row of usageRows) {
    console.log(`  usage ${row.request_id} model=${row.model} in=${row.input_tokens} out=${row.output_tokens} cost=¥${row.cost_cny.toFixed(4)}`);
  }

  // 终验：coverage + matrix + candidate 状态 + 项目状态不变
  const finalIssues = validateVisualIntentPlan(beats.beats, plan, result.visualIntent.intents);
  console.log(`validation issues=${finalIssues.length}`);
  const classified = classifyVisualIntentCandidate(project, result.artifact);
  console.log(`candidate status=${classified.status}${classified.statusReason ? ` (${classified.statusReason})` : ''}`);

  const coveredIds = new Set(result.visualIntent.intents.flatMap((i) => i.beatIds));
  console.log(`coverage: beats=${coveredIds.size}/${beats.beats.length}`);
  const intents = new Map<string, number>();
  const strategies = new Map<string, number>();
  for (const i of result.visualIntent.intents) {
    intents.set(i.intent, (intents.get(i.intent) ?? 0) + 1);
    strategies.set(i.strategy, (strategies.get(i.strategy) ?? 0) + 1);
  }
  console.log(`intent distribution: ${[...intents.entries()].map(([k, n]) => `${k}=${n}`).join(' ')}`);
  console.log(`strategy distribution: ${[...strategies.entries()].map(([k, n]) => `${k}=${n}`).join(' ')}`);
  const unresolved = result.visualIntent.intents.filter((i) => i.intent === 'VISUAL_UNRESOLVED');
  console.log(`unresolved=${unresolved.length}${unresolved.length > 0 ? ` ids=${unresolved.map((i) => i.visualIntentId).join(',')}` : ''}`);
  console.log(`titleCards=${result.visualIntent.intents.filter((i) => i.intent === 'EMPHASIZE_TEXT').length}`);
  console.log(`continuations=${result.visualIntent.intents.filter((i) => i.intent === 'CONTINUE_PREVIOUS_VISUAL' || i.intent === 'NO_VISUAL_CHANGE').length}`);

  console.log(`pipelineVersion=${getPipelineVersion(project)} snapshotPointer=${getM7PipelineSnapshotId(project) ?? 'NULL'}`);
  const snapshotCount = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = 'm7_pipeline_snapshot'`)
    .get(project) as {c: number};
  console.log(`m7 snapshot artifacts=${snapshotCount.c}`);
  const viCount = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = ?`)
    .get(project, VISUAL_INTENT_KIND) as {c: number};
  console.log(`visual_intent_plan artifacts=${viCount.c}`);
  const jobsAfter = downstreamJobCounts(project);
  console.log(`running jobs after: tts=${jobsAfter.tts_jobs} render=${jobsAfter.render_jobs}`);

  if (finalIssues.length > 0) {
    console.error('FAIL: candidate 未通过终验');
    process.exit(1);
  }
  if (classified.status !== 'eligible_candidate' && classified.status !== 'needs_review') {
    console.error(`FAIL: candidate 状态异常=${classified.status}`);
    process.exit(1);
  }
  console.log(`\nOK: candidate 创建/复用完成（status=${classified.status}，candidate only，项目仍 m6）。`);
}

main()
  .catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    process.exit(1);
  })
  .finally(() => {
    closeDb();
  });
