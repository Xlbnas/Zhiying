/**
 * 真实 DeepSeek Smoke（M2-B §十七）。
 *
 * 用法：npx tsx scripts/smoke-deepseek.ts
 *
 * - 只检查 DEEPSEEK_API_KEY 是否存在（process.env → .env.local → .env），
 *   永不打印/记录其值；不存在则输出 REAL_DEEPSEEK_SMOKE=NOT_RUN 并以 0 退出（不阻塞）。
 * - 存在则执行一次极小 project_definition 真实 Flash 请求（thinking disabled），
 *   验证 requestId / model / finishReason / usage / 成本快照。
 * - 成本量级：maxTokens 4096 上限内的一段 Brief（实测通常 <¥0.01）。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'smoke-deepseek');

import {closeDb, getDb} from '../src/lib/db';
import {DeepSeekProvider} from '../src/lib/llm/deepseek';
import {executeStageGeneration} from '../src/lib/llm/executor';

/** 极简 dotenv：仅提取目标 key，不打印任何内容。 */
function loadKeyFromDotenv(): string | null {
  for (const name of ['.env.local', '.env']) {
    const file = path.resolve(process.cwd(), name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (match && match[1] && match[1].length > 0) {
        return match[1];
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? loadKeyFromDotenv();
  if (!apiKey) {
    console.log('REAL_DEEPSEEK_SMOKE=NOT_RUN（未配置 DEEPSEEK_API_KEY，不阻塞 M2-B）');
    return;
  }

  fs.rmSync(path.resolve(process.cwd(), 'data', 'smoke-deepseek'), {
    recursive: true,
    force: true,
  });
  const db = getDb();
  const provider = new DeepSeekProvider({apiKey});

  console.log('[smoke] 发起真实 project_definition 请求（deepseek-v4-flash, thinking disabled）…');
  const result = await executeStageGeneration({
    db,
    provider,
    stage: 'project_definition',
    input: {
      topic: '为什么我们总在最后一刻才开始',
      coreQuestion: '拖延只是时间管理问题吗？',
      targetDuration: '10 分钟',
    },
    projectId: 'smoke-deepseek',
    env: {},
  });

  const row = db
    .prepare('SELECT * FROM llm_usage WHERE request_id = ?')
    .get(result.requestIds[0]!) as Record<string, unknown> | undefined;

  console.log('[smoke] --- 结果 ---');
  console.log(`[smoke] requestId     : ${result.requestIds[0]}`);
  console.log(`[smoke] model         : ${result.model}`);
  console.log(`[smoke] promptVersion : ${result.promptVersion}`);
  console.log(`[smoke] repairCount   : ${result.repairCount}`);
  console.log(`[smoke] contentLength : ${result.content.length}`);
  if (row) {
    console.log(
      `[smoke] usage         : input=${row.input_tokens} cached=${row.cached_tokens} output=${row.output_tokens}`,
    );
    console.log(
      `[smoke] cost snapshot : ¥${Number(row.cost_cny).toFixed(6)}（hit ${row.price_cache_hit_per_m}/miss ${row.price_cache_miss_per_m}/out ${row.price_output_per_m} 元每百万）`,
    );
  }
  const ok = result.requestIds.length === 1 && result.content.length > 0 && row !== undefined;
  console.log(ok ? 'REAL_DEEPSEEK_SMOKE=PASS' : 'REAL_DEEPSEEK_SMOKE=FAIL');
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'smoke-deepseek'), {
    recursive: true,
    force: true,
  });
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error('[smoke] 异常：', err instanceof Error ? err.message : String(err));
  console.log('REAL_DEEPSEEK_SMOKE=FAIL');
  process.exit(1);
});
