/**
 * 真实 DeepSeek 上游注入 smoke（M2-D/E 依赖链验证，低成本两级）。
 *
 * 用法：npx tsx scripts/smoke-deepseek-upstream.ts
 * - 只从环境 / API-KEY.env 读取 key，永不打印。
 * - project_definition → lock → research 全部真实 API（Flash）；
 *   验证 dependency snapshot、上游内容注入、usage 落库、版本元信息。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'smoke-upstream');

import {getDb, closeDb} from '../src/lib/db';
import {DeepSeekProvider} from '../src/lib/llm/deepseek';
import {llmJobPayloadV2Schema} from '../src/lib/llm-jobs';
import {enqueueWorkflowStageJob, getLlmJob} from '../src/lib/llm-jobs';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runLlmJob} from '../src/worker/llm-executor';
import {lockStage, getStage} from '../src/lib/workflow/stages';
import {getVersion} from '../src/lib/workflow/versions';

function loadKey(): string | null {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv) return fromEnv;
  const alt = path.resolve(process.cwd(), 'API-KEY.env');
  if (!fs.existsSync(alt)) return null;
  const text = fs.readFileSync(alt, 'utf8');
  const named = /Deepseekapi\s*=\s*(.+?)\s*$/m.exec(text);
  if (named?.[1]) return named[1];
  const token = /sk-[A-Za-z0-9]+/.exec(text);
  return token ? token[0] : null;
}

async function main(): Promise<void> {
  const apiKey = loadKey();
  if (!apiKey) {
    console.log('REAL_UPSTREAM_SMOKE=NOT_RUN（未配置 DEEPSEEK_API_KEY）');
    return;
  }
  fs.rmSync(path.resolve(process.cwd(), 'data', 'smoke-upstream'), {recursive: true, force: true});
  const db = getDb();
  const provider = new DeepSeekProvider({apiKey});
  const ctx = {isShuttingDown: () => false, log: () => {}};
  const deps = {provider};

  const pid = createProjectWithWorkflow({
    topic: '我们为什么会拖延',
    coreQuestion: '拖延只是时间管理问题吗？',
  }).project.id;

  // Stage 1: project_definition（真实）
  const pdJob = enqueueWorkflowStageJob(pid, 'project_definition');
  let claimed = claimNextAnyJob('smoke');
  if (!claimed || claimed.type !== 'llm') throw new Error('claim pd 失败');
  await runLlmJob(claimed.job, ctx, deps);
  lockStage(pid, 'project_definition');
  console.log(`[smoke] pd: ${getLlmJob(pdJob.id)!.status}`);

  // Stage 2: research（真实，验证快照 + 上游注入）
  const rJob = enqueueWorkflowStageJob(pid, 'research');
  const payload = llmJobPayloadV2Schema.parse(JSON.parse(rJob.payload_json));
  console.log(
    `[smoke] research 快照: ${JSON.stringify(payload.upstreamVersions)}`,
  );
  claimed = claimNextAnyJob('smoke');
  if (!claimed || claimed.type !== 'llm') throw new Error('claim research 失败');
  await runLlmJob(claimed.job, ctx, deps);
  lockStage(pid, 'research');

  const rJobAfter = getLlmJob(rJob.id)!;
  const rVersion = getVersion(pid, 'research', getStage(pid, 'research')!.active_version!)!;
  const usages = db
    .prepare('SELECT stage, input_tokens, cached_tokens, output_tokens, cost_cny FROM llm_usage WHERE project_id = ? ORDER BY created_at')
    .all(pid) as Array<{stage: string; input_tokens: number; cached_tokens: number; output_tokens: number; cost_cny: number}>;
  const totalCost = usages.reduce((sum, u) => sum + u.cost_cny, 0);

  console.log(`[smoke] research: ${rJobAfter.status} v${rVersion.version} (${rVersion.prompt_version}, ${rVersion.model})`);
  console.log(`[smoke] research 内容长度: ${rVersion.content.length}`);
  for (const u of usages) {
    console.log(`[smoke] usage ${u.stage}: in=${u.input_tokens} cached=${u.cached_tokens} out=${u.output_tokens} cost=¥${u.cost_cny.toFixed(6)}`);
  }
  console.log(`[smoke] 总成本: ¥${totalCost.toFixed(6)}`);
  const ok =
    rJobAfter.status === 'succeeded' &&
    payload.upstreamVersions.project_definition === 1 &&
    usages.length >= 2;
  console.log(ok ? 'REAL_UPSTREAM_SMOKE=PASS' : 'REAL_UPSTREAM_SMOKE=FAIL');
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'smoke-upstream'), {recursive: true, force: true});
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error('[smoke] 异常：', err instanceof Error ? err.message : String(err));
  console.log('REAL_UPSTREAM_SMOKE=FAIL');
  process.exit(1);
});
