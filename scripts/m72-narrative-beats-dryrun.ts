/**
 * M7.2 Narrative Beats dry-run / candidate 生成（production 安全）。
 *
 * 用法：
 *   只读 dry-run：
 *     npx tsx scripts/m72-narrative-beats-dryrun.ts --project <id> --plan <artifactId>
 *   创建 candidate（显式 requestId，真实 LLM）：
 *     npx tsx scripts/m72-narrative-beats-dryrun.ts --project <id> --plan <artifactId> \
 *       --write-candidate --requestId <uuid>
 *
 * 安全边界：
 * - 只接受 exact narrationPlanV2ArtifactId；绝不 current/latest 解析。
 * - dry-run 默认只读：不调用 LLM、不写 artifact、不改任何指针。
 * - --write-candidate 只写 append-only candidate：不 current/lock、
 *   不改 pipelineVersion、不创建 snapshot、不触发 TTS/字幕/下游。
 * - 不打印 secret 或内部配置（provider 只显示名字）。
 */

import {getDb, closeDb} from '../src/lib/db';
import {buildNarrativeBeats, classifyNarrativeBeatsCandidate} from '../src/lib/narrative-beats/plan';
import {BEATS_SYSTEM_PROMPT, buildBeatsUserPrompt} from '../src/lib/narrative-beats/prompt';
import {buildBeatPlannerInput, hashPrompt} from '../src/lib/narrative-beats/projection';
import {NARRATIVE_BEATS_KIND} from '../src/lib/narrative-beats/schema';
import {validateNarrativeBeatsCoverage} from '../src/lib/narrative-beats/validate';
import {classifyNarrationPlanV2Candidate, getNarrationPlanV2Artifact} from '../src/lib/narration/plan-v2';
import {getM7PipelineSnapshotId, getPipelineVersion} from '../src/lib/pipeline-version';

interface Args {
  project: string;
  plan: string;
  writeCandidate: boolean;
  requestId: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {project: '', plan: '', writeCandidate: false, requestId: null};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--project') args.project = argv[++i] ?? '';
    else if (a === '--plan') args.plan = argv[++i] ?? '';
    else if (a === '--write-candidate') args.writeCandidate = true;
    else if (a === '--requestId') args.requestId = argv[++i] ?? '';
  }
  if (!args.project || !args.plan) {
    console.error('用法：--project <id> --plan <artifactId> [--write-candidate --requestId <uuid>]');
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
  const {project, plan: planArtifactId} = args;

  console.log('=== M7.2 Narrative Beats dry-run ===');
  console.log(`projectId=${project}`);
  console.log(`narrationPlanV2ArtifactId=${planArtifactId}`);

  // ── 前置检查（只读） ──
  const sourceRef = getNarrationPlanV2Artifact(project, planArtifactId);
  if (!sourceRef) {
    console.log('PRECHECK FAIL: narration plan artifact 不存在/跨项目/契约非法');
    process.exit(1);
  }
  const sourceStatus = classifyNarrationPlanV2Candidate(project, sourceRef.artifact);
  console.log(`source status=${sourceStatus.status}${sourceStatus.statusReason ? ` (${sourceStatus.statusReason})` : ''}`);
  if (sourceStatus.status !== 'eligible_candidate') {
    console.log('PRECHECK FAIL: source 不是 eligible_candidate，禁止构建 beats');
    process.exit(1);
  }

  const plan = sourceRef.plan;
  const speech = plan.units.filter((u) => u.kind === 'speech').length;
  const silence = plan.units.filter((u) => u.kind === 'silence').length;
  console.log(`units=${plan.units.length} speech=${speech} silence=${silence} chapters=${plan.chapters.length}`);
  console.log(`needsReview=${plan.needsReview.length}`);
  console.log(`source scriptV2VersionId=${plan.source.scriptV2VersionId}`);
  console.log(`source scriptV2ContentHash=${plan.source.scriptV2ContentHash}`);

  // sanitized projection + prompt hash（不调用 LLM）
  const projection = buildBeatPlannerInput(plan);
  const userPrompt = buildBeatsUserPrompt(projection);
  const promptHash = hashPrompt(BEATS_SYSTEM_PROMPT, userPrompt);
  const projectionText = JSON.stringify(projection);
  console.log(`projection units=${projection.units.length}（无 sourceText：${!projectionText.includes('sourceText')}）`);
  console.log(`promptHash=${promptHash}`);
  console.log(`promptChars system=${BEATS_SYSTEM_PROMPT.length} user=${userPrompt.length}`);
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
    .prepare(`SELECT COUNT(*) AS c FROM llm_usage WHERE project_id = ? AND stage = 'm7_narrative_beats'`)
    .get(project) as {c: number};

  const result = await buildNarrativeBeats({
    projectId: project,
    narrationPlanV2ArtifactId: planArtifactId,
    requestId: args.requestId!,
  });

  // M7.2.1：build 返回 union——in_progress/terminal 不是成功路径，打印并非零退出。
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

  const usageAfter = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM llm_usage WHERE project_id = ? AND stage = 'm7_narrative_beats'`)
    .get(project) as {c: number};
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
  console.log(`beats artifactId=${result.artifact.id} version=${result.artifact.version}`);
  console.log(`generation provider=${result.beats.generation.provider} model=${result.beats.generation.model} attemptCount=${result.beats.generation.attemptCount}`);
  console.log(`beats=${result.beats.beats.length}`);
  console.log(`usage rows for requestId: ${usageRows.length}（before=${usageBefore.c} after=${usageAfter.c}）`);
  for (const row of usageRows) {
    console.log(`  usage ${row.request_id} model=${row.model} in=${row.input_tokens} out=${row.output_tokens} cost=¥${row.cost_cny.toFixed(4)}`);
  }

  // 终验：覆盖 + candidate 状态 + 项目状态不变
  const finalIssues = validateNarrativeBeatsCoverage(plan, result.beats.beats);
  console.log(`coverage validation issues=${finalIssues.length}`);
  const classified = classifyNarrativeBeatsCandidate(project, result.artifact);
  console.log(`candidate status=${classified.status}`);

  const coveredIds = new Set(result.beats.beats.flatMap((b) => b.unitIds));
  const coveredSpeech = plan.units.filter((u) => u.kind === 'speech' && coveredIds.has(u.id)).length;
  const coveredSilence = plan.units.filter((u) => u.kind === 'silence' && coveredIds.has(u.id)).length;
  console.log(`coverage: units=${coveredIds.size}/${plan.units.length} speech=${coveredSpeech}/${speech} silence=${coveredSilence}/${silence}`);
  const roles = new Map<string, number>();
  for (const b of result.beats.beats) roles.set(b.role, (roles.get(b.role) ?? 0) + 1);
  console.log(`role distribution: ${[...roles.entries()].map(([r, n]) => `${r}=${n}`).join(' ')}`);
  const chapters = new Map<number, number>();
  for (const b of result.beats.beats) chapters.set(b.chapter, (chapters.get(b.chapter) ?? 0) + 1);
  console.log(`chapter distribution: ${[...chapters.entries()].map(([c, n]) => `ch${c}=${n}`).join(' ')}`);

  console.log(`pipelineVersion=${getPipelineVersion(project)} snapshotPointer=${getM7PipelineSnapshotId(project) ?? 'NULL'}`);
  const snapshotCount = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = 'm7_pipeline_snapshot'`)
    .get(project) as {c: number};
  console.log(`m7 snapshot artifacts=${snapshotCount.c}`);
  const beatsCount = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = ?`)
    .get(project, NARRATIVE_BEATS_KIND) as {c: number};
  console.log(`narrative_beats artifacts=${beatsCount.c}`);
  const jobsAfter = downstreamJobCounts(project);
  console.log(`running jobs after: tts=${jobsAfter.tts_jobs} render=${jobsAfter.render_jobs}`);

  if (finalIssues.length > 0 || classified.status !== 'eligible_candidate') {
    console.error('FAIL: candidate 未通过终验');
    process.exit(1);
  }
  console.log('\nOK: candidate 创建/复用完成（candidate only，项目仍 m6）。');
}

main()
  .catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    process.exit(1);
  })
  .finally(() => {
    closeDb();
  });
