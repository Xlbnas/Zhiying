/**
 * TTS-C.1A.R1 recovery child 进程（真实独立进程 + 独立连接，验证多 Worker 竞争）。
 * 用法: node --import tsx scripts/lib/tts-c1a-recovery-child.ts <dataDir> <limit>
 * stdout: {count, error?}
 */
import {recoverExpiredMaterializationJobs} from '../../src/lib/tts-c/materialization';

async function main(): Promise<void> {
  const [dataDir, limit] = process.argv.slice(2);
  process.env.ZHIYING_DATA_DIR = dataDir;
  const {getDb} = await import('../../src/lib/db');
  getDb();
  try {
    const count = await recoverExpiredMaterializationJobs(Number(limit ?? 10));
    console.log(JSON.stringify({count}));
    process.exit(0);
  } catch (e) {
    console.log(JSON.stringify({count: 0, error: e instanceof Error ? e.message : String(e)}));
    process.exit(0);
  }
}

main();
