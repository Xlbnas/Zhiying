/**
 * M2-D 双执行上下文竞态测试的子进程助手（仅为测试服务，非生产代码）。
 *
 * 用法（由 test-m2d.ts 以 child_process 驱动）：
 *   npx tsx scripts/test-m2d-dual-conn-child.ts hold <dbPath>
 *     —— 独立连接 BEGIN IMMEDIATE 持写锁，stdout 打印 READY（确定性 barrier），
 *        等待 stdin 一行 RELEASE 后 COMMIT 退出。用于「对方 writer 先持锁」方向。
 *   npx tsx scripts/test-m2d-dual-conn-child.ts enqueue <pid> <stage> <confirmStale> [busyMs]
 *     —— 本进程内调用真实高层 API enqueueWorkflowStageJob（独立连接），
 *        输出 OK <jobId> 或 ERR <code>。busyMs 默认 5000。
 *
 * 注意：hold 使用 exec('BEGIN IMMEDIATE') 手动事务（而非 transaction() 包裹），
 * 以便事件循环空转等待 stdin——写锁在等待期间持续持有。
 */

import Database from 'better-sqlite3';
import readline from 'node:readline';

const [command, ...rest] = process.argv.slice(2);

async function waitStdinLine(): Promise<void> {
  const rl = readline.createInterface({input: process.stdin});
  await new Promise<void>((resolve) => rl.once('line', () => resolve()));
  rl.close();
}

async function main(): Promise<void> {
  if (command === 'hold') {
    const dbPath = rest[0];
    if (!dbPath) throw new Error('hold: missing dbPath');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    // 无害写入，确保持有 writer lock
    db.prepare('UPDATE llm_jobs SET progress = progress WHERE 1 = 0').run();
    console.log('READY');
    await waitStdinLine();
    db.exec('COMMIT');
    db.close();
    console.log('DONE');
    return;
  }

  if (command === 'enqueue') {
    const [projectId, stage, confirmStaleRaw, busyMsRaw] = rest;
    if (!projectId || !stage) throw new Error('enqueue: missing args');
    const {enqueueWorkflowStageJob} = await import('../src/lib/llm-jobs');
    const {getDb} = await import('../src/lib/db');
    const busyMs = Number(busyMsRaw ?? '5000');
    getDb().pragma(`busy_timeout = ${busyMs}`);
    try {
      const job = enqueueWorkflowStageJob(
        projectId,
        stage as Parameters<typeof enqueueWorkflowStageJob>[1],
        {confirmStale: confirmStaleRaw === 'true'},
      );
      console.log(`OK ${job.id}`);
    } catch (err) {
      const code =
        err instanceof Error && 'code' in err && typeof err.code === 'string'
          ? err.code
          : String(err);
      console.log(`ERR ${code}`);
    }
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((err) => {
  console.log(`ERR ${err instanceof Error ? String(err) : String(err)}`);
  process.exit(1);
});
