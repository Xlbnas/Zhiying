/**
 * M7.3A-1 Visual Intent candidate 只读 revalidation（契约 1.1）。
 *
 * 用法：
 *   npx tsx scripts/m73a1-visual-intent-revalidate.ts --project <id> --artifact <visualIntentArtifactId>
 *
 * 用途：对既有 visual_intent_plan candidate（典型：契约 1.0 时代的 candidate，
 * 如 Freud 项目）用 1.1 补强后的 deterministic validator 做纯校验，
 * 列出 candidate classify 状态与全部 issues。
 *
 * 安全边界（硬保证）：
 * - 只读：不修改 artifact、不写任何行、不改任何指针、不触发下游；
 * - 不调用 LLM：脚本不 import provider、不读取 LLM key，
 *   可在 production worker 等效环境（无 DEEPSEEK_API_KEY）运行；
 * - 只接受 exact artifact ID；绝不 current/latest 解析；
 * - 不打印 secret 或内部配置。
 */

import {closeDb, getDb} from '../src/lib/db';
import {getM7PipelineSnapshotId, getPipelineVersion} from '../src/lib/pipeline-version';
import {getNarrativeBeatsArtifact} from '../src/lib/narrative-beats/plan';
import {getNarrationPlanV2Artifact} from '../src/lib/narration/plan-v2';
import {classifyVisualIntentCandidate, getVisualIntentArtifact} from '../src/lib/visual-intent/plan';
import {
  VISUAL_INTENT_COMPILER_VERSION,
  VISUAL_INTENT_PROMPT_VERSION,
  VISUAL_INTENT_SCHEMA_VERSION,
} from '../src/lib/visual-intent/schema';
import {validateVisualIntentPlan} from '../src/lib/visual-intent/validate';

interface Args {
  project: string;
  artifact: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {project: '', artifact: ''};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--project') args.project = argv[++i] ?? '';
    else if (a === '--artifact') args.artifact = argv[++i] ?? '';
  }
  if (!args.project || !args.artifact) {
    console.error('用法：--project <id> --artifact <visualIntentArtifactId>');
    process.exit(2);
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const {project, artifact: artifactId} = args;

  console.log('=== M7.3A-1 Visual Intent 只读 revalidation（契约 1.1） ===');
  console.log(`projectId=${project}`);
  console.log(`visualIntentArtifactId=${artifactId}`);
  console.log(
    `validator 要求：schemaVersion=${VISUAL_INTENT_SCHEMA_VERSION} compilerVersion=${VISUAL_INTENT_COMPILER_VERSION} promptVersion=${VISUAL_INTENT_PROMPT_VERSION}`,
  );

  // ── 读取 exact candidate（fail-closed，不 latest/current 解析） ──
  const ref = getVisualIntentArtifact(project, artifactId);
  if (!ref) {
    console.log('PRECHECK FAIL: visual intent artifact 不存在/跨项目/kind 不符/契约非法');
    process.exit(1);
  }
  const {visualIntent, artifact} = ref;
  const contentJsonBefore = artifact.content_json;

  console.log(`artifact version=${artifact.version} created_at=${artifact.created_at}`);
  console.log(
    `artifact 声明：schemaVersion=${visualIntent.schemaVersion} compilerVersion=${visualIntent.compilerVersion} promptVersion=${visualIntent.promptVersion}`,
  );
  console.log(`generation requestId=${visualIntent.generation.requestId} provider=${visualIntent.generation.provider} model=${visualIntent.generation.model} attemptCount=${visualIntent.generation.attemptCount}`);
  console.log(`intents=${visualIntent.intents.length}`);

  // ── candidate classify（deterministic，纯读；1.0 candidate 应 stale：version mismatch） ──
  const classified = classifyVisualIntentCandidate(project, artifact);
  console.log(`\ncandidate classify: status=${classified.status}${classified.statusReason ? ` reason=${classified.statusReason}` : ''}`);
  if (classified.status === 'stale' && (classified.statusReason ?? '').includes('version')) {
    console.log('（符合预期：旧 compiler/prompt version candidate 自然 stale，不原地修 artifact）');
  }

  // ── 1.1 语义校验（纯函数，对内容做全量 issues 列表） ──
  const beatsRef = getNarrativeBeatsArtifact(project, visualIntent.source.narrativeBeatsArtifactId);
  if (!beatsRef) {
    console.log('\nREVALIDATE SKIP: source narrative beats artifact 不可读，无法做内容级校验');
  } else {
    const narrationRef = getNarrationPlanV2Artifact(project, visualIntent.source.narrationPlanV2ArtifactId);
    if (!narrationRef) {
      console.log('\nREVALIDATE SKIP: source narration plan artifact 不可读，无法做内容级校验');
    } else {
      const issues = validateVisualIntentPlan(beatsRef.beats.beats, narrationRef.plan, visualIntent.intents);
      console.log(`\n1.1 validator issues=${issues.length}`);
      for (const issue of issues) {
        console.log(`  [${issue.code}] ${issue.message}`);
      }
      if (issues.length === 0) {
        console.log('内容级校验：通过 1.1 全部规则（subject/authenticity 矩阵、displayText 范围、evidenceIds provenance）。');
      } else {
        const byCode = new Map<string, number>();
        for (const issue of issues) byCode.set(issue.code, (byCode.get(issue.code) ?? 0) + 1);
        console.log(`issue 分布：${[...byCode.entries()].map(([k, n]) => `${k}=${n}`).join(' ')}`);
      }
    }
  }

  // ── 只读自证：artifact 内容未被修改 ──
  const after = getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(artifactId) as
    | {content_json: string}
    | undefined;
  const unchanged = after !== undefined && after.content_json === contentJsonBefore;
  console.log(`\nread-only 自证：artifact content_json 未变=${unchanged}`);
  console.log(`pipelineVersion=${getPipelineVersion(project)} snapshotPointer=${getM7PipelineSnapshotId(project) ?? 'NULL'}`);
  console.log('本脚本不修改 artifact、不调用 LLM、可在无 LLM key 的 worker 等效环境运行。');
  if (!unchanged) {
    console.error('FAIL: artifact 内容在 revalidation 期间发生变化（只读边界被破坏）');
    process.exit(1);
  }
  console.log('\nOK: revalidation 完成（只读）。');
}

try {
  main();
} catch (err) {
  console.error(`ERROR: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  process.exit(1);
} finally {
  closeDb();
}
