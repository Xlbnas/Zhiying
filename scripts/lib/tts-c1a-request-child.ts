/**
 * TTS-C.1A.R1 并发测试 child 进程（真实独立进程 + 独立 SQLite 连接）。
 * 用法: node --import tsx scripts/lib/tts-c1a-request-child.ts <dataDir> <projectId> <requestId> <assignmentArtifactId>
 * stdout 输出单行 JSON：{ok, outcome?, code?, message?, requestStatus?, jobStatus?, jobId?}
 */
import {createMaterializationRequest, MaterializationError} from '../../src/lib/tts-c/materialization';

async function main(): Promise<void> {
  const [dataDir, projectId, requestId, assignmentArtifactId] = process.argv.slice(2);
  if (!dataDir || !projectId || !requestId || !assignmentArtifactId) {
    console.log(JSON.stringify({ok: false, code: 'BAD_ARGS', message: 'usage: <dataDir> <projectId> <requestId> <assignmentArtifactId>'}));
    process.exit(1);
  }
  process.env.ZHIYING_DATA_DIR = dataDir;
  // 独立进程 → 独立连接（getDb 全局单例在本进程内首次打开）
  const {getDb} = await import('../../src/lib/db');
  getDb();
  try {
    const r = await createMaterializationRequest(projectId, requestId, assignmentArtifactId);
    console.log(JSON.stringify({ok: true, outcome: r.outcome, requestStatus: r.request.status, jobStatus: r.job.status, jobId: r.job.id}));
    process.exit(0);
  } catch (e) {
    if (e instanceof MaterializationError) {
      console.log(JSON.stringify({ok: false, code: e.code, message: e.message}));
    } else {
      console.log(JSON.stringify({ok: false, code: 'UNEXPECTED', message: e instanceof Error ? e.message : String(e)}));
    }
    process.exit(0);
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ok: false, code: 'CHILD_FATAL', message: e instanceof Error ? e.message : String(e)}));
  process.exit(1);
});
