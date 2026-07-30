/**
 * M6.3.11 Final Render Artifact Integrity 测试（零真实渲染）。
 *
 * 用法：npx tsx scripts/test-m6311-artifact.ts
 * 使用临时数据目录（data/test-m6311-artifact），结束后清理。
 *
 * 覆盖（对应验收 Phase 18-20 / 26）：
 *   A. bundle 缓存键：源码变化 → 新键；稳定树 → 键稳定；TEMPLATE_VERSION 参与
 *   B. 输出校验：缺失 / 空文件 / ffprobe 失败 / 正常视频流（注入伪 ffprobe）
 *   C. SHA256：已知向量 + 文件流式哈希一致
 *   D. manifest：persist/get 往返（encoder/payload_sha/bundle_key/duration）
 *   E. 下载解析：exact job、两 job 隔离、missing file 不 fallback、
 *      size mismatch 拒绝、path mismatch 拒绝、未完成 409、惰性回填
 *   F. 绊线：schema 保留 showPilotIntro（worker 拒绝 demo defaultProps 的前提）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m6311-artifact');

import {closeDb, getDataDir, getDb} from '../src/lib/db';
import {
  backfillRenderArtifact,
  getRenderArtifact,
  persistRenderArtifact,
  probeRenderOutput,
  resolveJobArtifact,
  sha256File,
  sha256Text,
  validateRenderOutput,
  type ProbedOutput,
} from '../src/lib/render/artifact';
import {zhiyingFullCutPropsSchema} from '../src/lib/scene-schema';
import {bundleCacheKey, computeRendererSourceHash} from '../src/worker/bundle-key';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail));
  }
}

// ---------- fixture ----------

const P1 = 'test-m6311-p1';

function seedProject(projectId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(projectId, `测试项目 ${projectId}`, now, now);
}

function seedRenderJob(
  jobId: string,
  projectId: string,
  status: string,
  outputPath: string | null,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO render_jobs
       (id, project_id, kind, status, progress, payload_json, output_path, queued_at, attempt, max_attempts)
       VALUES (?, ?, 'fullcut', ?, 100, '{}', ?, ?, 1, 2)`,
    )
    .run(jobId, projectId, status, outputPath, now);
}

function writeFixture(relPath: string, content: string): string {
  const abs = path.join(getDataDir(), relPath);
  fs.mkdirSync(path.dirname(abs), {recursive: true});
  fs.writeFileSync(abs, content);
  return abs;
}

const GOOD_PROBE: ProbedOutput = {durationSec: 5, width: 1920, height: 1080, codec: 'h264'};
const goodProbe = async (): Promise<ProbedOutput> => GOOD_PROBE;
const badProbe = async (): Promise<ProbedOutput> => {
  throw new Error('ffprobe 校验失败：无有效视频流');
};

// ---------- A. bundle 缓存键 ----------

function makeSourceTree(root: string): void {
  fs.mkdirSync(path.join(root, 'src/remotion/compositions'), {recursive: true});
  fs.mkdirSync(path.join(root, 'src/lib'), {recursive: true});
  fs.mkdirSync(path.join(root, 'node_modules/remotion'), {recursive: true});
  fs.mkdirSync(path.join(root, 'node_modules/@remotion/bundler'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src/remotion/index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'src/remotion/compositions/FullCutV1.tsx'), '// v1\n');
  fs.writeFileSync(path.join(root, 'src/lib/scene-schema.ts'), '// schema v1\n');
  fs.writeFileSync(path.join(root, 'node_modules/remotion/package.json'), '{"version":"4.0.492"}');
  fs.writeFileSync(path.join(root, 'node_modules/@remotion/bundler/package.json'), '{"version":"4.0.492"}');
}

function testBundleKey(): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'm6311-bundle-'));
  const treeA = path.join(base, 'a');
  const treeB = path.join(base, 'b');
  makeSourceTree(treeA);
  makeSourceTree(treeB);

  const keyA1 = bundleCacheKey('freud-mg-v1.0', treeA);
  const keyA2 = bundleCacheKey('freud-mg-v1.0', treeA);
  ok(keyA1 === keyA2, '[A01] 同一源码树缓存键稳定');
  ok(keyA1.startsWith('freud-mg-v1.0-'), '[A02] 键含 TEMPLATE_VERSION 前缀');

  const keyB = bundleCacheKey('freud-mg-v1.0', treeB);
  ok(keyA1 === keyB, '[A03] 相同内容不同目录 → 键相同');

  // renderer 源码变化（M6.3.11 P0 场景：ProductionSceneRenderer 落地）
  fs.writeFileSync(path.join(treeB, 'src/remotion/compositions/ProductionSceneRenderer.tsx'), '// new renderer\n');
  const keyB2 = bundleCacheKey('freud-mg-v1.0', treeB);
  ok(keyB2 !== keyA1, '[A04] renderer 源码新增/变化 → 新缓存键（触发重建）');

  // 已有文件内容修改
  fs.writeFileSync(path.join(treeB, 'src/remotion/compositions/ProductionSceneRenderer.tsx'), '// new renderer\n');
  fs.writeFileSync(path.join(treeB, 'src/remotion/compositions/FullCutV1.tsx'), '// v2\n');
  const keyB3 = bundleCacheKey('freud-mg-v1.0', treeB);
  ok(keyB3 !== keyB2 && keyB3 !== keyA1, '[A05] 已有 renderer 文件修改 → 新缓存键');

  // schema 变化
  const treeC = path.join(base, 'c');
  makeSourceTree(treeC);
  fs.writeFileSync(path.join(treeC, 'src/lib/scene-schema.ts'), '// schema v2\n');
  ok(bundleCacheKey('freud-mg-v1.0', treeC) !== keyA1, '[A06] scene-schema 变化 → 新缓存键');

  // TEMPLATE_VERSION 变化
  ok(
    bundleCacheKey('freud-mg-v1.1', treeA) !== keyA1,
    '[A07] TEMPLATE_VERSION 变化 → 新缓存键',
  );

  // 渲染依赖版本变化
  const treeD = path.join(base, 'd');
  makeSourceTree(treeD);
  fs.writeFileSync(path.join(treeD, 'node_modules/remotion/package.json'), '{"version":"4.0.500"}');
  ok(bundleCacheKey('freud-mg-v1.0', treeD) !== keyA1, '[A08] remotion 版本变化 → 新缓存键');

  ok(
    computeRendererSourceHash(treeA) !== computeRendererSourceHash(treeD),
    '[A09] 内容 hash 本身区分依赖版本',
  );

  fs.rmSync(base, {recursive: true, force: true});
}

// ---------- B/C. 输出校验 + SHA ----------

async function testValidation(): Promise<void> {
  const dir = path.join(getDataDir(), 'validation');
  fs.mkdirSync(dir, {recursive: true});

  const missing = await validateRenderOutput(path.join(dir, 'missing.mp4'));
  ok(!missing.ok && !('info' in missing), '[B01] 输出文件不存在 → 校验失败');

  const emptyPath = path.join(dir, 'empty.mp4');
  fs.writeFileSync(emptyPath, '');
  const empty = await validateRenderOutput(emptyPath);
  ok(!empty.ok, '[B02] 0 字节输出 → 校验失败');

  const fakePath = path.join(dir, 'fake.mp4');
  fs.writeFileSync(fakePath, 'not-a-real-mp4');
  const bad = await validateRenderOutput(fakePath, badProbe);
  ok(!bad.ok, '[B03] ffprobe 失败（无有效视频流）→ 校验失败');

  const good = await validateRenderOutput(fakePath, goodProbe);
  ok(good.ok && 'info' in good && good.info.codec === 'h264' && good.info.durationSec === 5,
    '[B04] 有效视频流 → 校验通过并带回 duration/codec');

  // probeRenderOutput 解析：无视频流 → throw
  const noVideoExec = async (): Promise<string> =>
    JSON.stringify({streams: [{codec_type: 'audio', codec_name: 'aac'}], format: {duration: '5.0'}});
  let threw = false;
  try {
    await probeRenderOutput(fakePath, noVideoExec);
  } catch {
    threw = true;
  }
  ok(threw, '[B05] 纯音频文件（无视频流）→ probe 拒绝');

  const noDurationExec = async (): Promise<string> =>
    JSON.stringify({streams: [{codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080}], format: {duration: '0'}});
  let threw2 = false;
  try {
    await probeRenderOutput(fakePath, noDurationExec);
  } catch {
    threw2 = true;
  }
  ok(threw2, '[B06] duration=0 → probe 拒绝');

  // SHA 已知向量：sha256("abc") = ba7816bf...
  ok(
    sha256Text('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    '[C01] sha256Text 已知向量',
  );
  const shaPath = path.join(dir, 'sha.bin');
  fs.writeFileSync(shaPath, 'abc');
  ok(
    (await sha256File(shaPath)) === sha256Text('abc'),
    '[C02] 文件流式 SHA 与文本 SHA 一致',
  );
}

// ---------- D/E. manifest + 下载解析 ----------

async function testResolve(): Promise<void> {
  seedProject(P1);

  // Job A / Job B：两个独立产物（two-job isolation）
  const relA = `projects/${P1}/renders/job-a.mp4`;
  const relB = `projects/${P1}/renders/job-b.mp4`;
  writeFixture(relA, 'VIDEO-A-CONTENT');
  writeFixture(relB, 'VIDEO-B-CONTENT-ELSE');
  seedRenderJob('job-a', P1, 'succeeded', relA);
  seedRenderJob('job-b', P1, 'succeeded', relB);
  // Job C：未完成
  seedRenderJob('job-c', P1, 'running', null);

  // manifest persist/get 往返（新渲染路径字段完整性）
  persistRenderArtifact({
    job_id: 'job-a', project_id: P1, output_path: relA,
    output_sha256: sha256Text('VIDEO-A-CONTENT'), output_size: 'VIDEO-A-CONTENT'.length,
    duration_sec: 5.5, frame_count: 165, encoder: 'h264_nvenc',
    payload_sha256: sha256Text('payload-a'), bundle_key: 'freud-mg-v1.0-deadbeef1234',
  });
  const manifestA = getRenderArtifact('job-a');
  ok(
    !!manifestA && manifestA.encoder === 'h264_nvenc'
      && manifestA.payload_sha256 === sha256Text('payload-a')
      && manifestA.bundle_key === 'freud-mg-v1.0-deadbeef1234'
      && manifestA.duration_sec === 5.5 && manifestA.frame_count === 165
      && manifestA.backfilled === 0,
    '[D01] manifest 落库字段完整（encoder/payload_sha/bundle_key/duration/frames）',
  );

  // exact job 下载解析
  const resA = await resolveJobArtifact({id: 'job-a', project_id: P1, status: 'succeeded', progress: 100, output_path: relA}, goodProbe);
  ok(resA.ok && resA.absPath.endsWith('job-a.mp4') && resA.artifact.output_sha256 === sha256Text('VIDEO-A-CONTENT'),
    '[E01] exact job 解析返回自己的产物');

  // 两 job 隔离：B 只返回 B
  const resB = await resolveJobArtifact({id: 'job-b', project_id: P1, status: 'succeeded', progress: 100, output_path: relB}, goodProbe);
  ok(resB.ok && resB.absPath.endsWith('job-b.mp4'), '[E02] 两 job 隔离：B 不返回 A 的文件');
  ok(resB.ok && resB.artifact.output_sha256 === sha256Text('VIDEO-B-CONTENT-ELSE')
      && resB.artifact.output_sha256 !== sha256Text('VIDEO-A-CONTENT'),
    '[E03] B 的 SHA 独立（惰性回填自 B 自己的文件）');
  ok(resB.ok && resB.artifact.backfilled === 1, '[E04] 无 manifest 的历史 job → 惰性回填标记');
  const manifestB2 = getRenderArtifact('job-b');
  ok(!!manifestB2, '[E05] 回填后 manifest 持久化');

  // 未完成 job → 409
  const resC = await resolveJobArtifact({id: 'job-c', project_id: P1, status: 'running', progress: 40, output_path: null});
  ok(!resC.ok && resC.status === 409 && resC.code === 'job_not_finished',
    '[E06] 未完成 job → 409 job_not_finished');

  // missing file：manifest 存在但文件被删 → 404，绝不 fallback 其他 job
  fs.rmSync(path.join(getDataDir(), relB));
  const resB2 = await resolveJobArtifact({id: 'job-b', project_id: P1, status: 'succeeded', progress: 100, output_path: relB}, goodProbe);
  ok(!resB2.ok && resB2.status === 404 && resB2.code === 'output_missing',
    '[E07] 当前 job 文件缺失 → 404 output_missing（不 fallback 旧产物）');

  // size mismatch：manifest 落库后文件被替换 → 409
  writeFixture(relA, 'VIDEO-A-CONTENT-TAMPERED!!');
  const resA2 = await resolveJobArtifact({id: 'job-a', project_id: P1, status: 'succeeded', progress: 100, output_path: relA}, goodProbe);
  ok(!resA2.ok && resA2.status === 409 && resA2.code === 'artifact_mismatch',
    '[E08] 文件被替换（size 与 manifest 不一致）→ 409 artifact_mismatch');

  // path mismatch：manifest 被污染指向别的路径 → 409
  writeFixture(relA, 'VIDEO-A-CONTENT'); // 还原
  getDb().prepare(`UPDATE render_artifacts SET output_path = ? WHERE job_id = 'job-a'`)
    .run(`projects/${P1}/renders/job-x.mp4`);
  const resA3 = await resolveJobArtifact({id: 'job-a', project_id: P1, status: 'succeeded', progress: 100, output_path: relA}, goodProbe);
  ok(!resA3.ok && resA3.code === 'artifact_path_mismatch',
    '[E09] manifest 路径与 job 记录不一致 → 拒绝');
  getDb().prepare(`UPDATE render_artifacts SET output_path = ? WHERE job_id = 'job-a'`).run(relA);

  // 无 manifest 且文件缺失 → 不可回填 → 409 artifact_unvalidated
  const relD = `projects/${P1}/renders/job-d.mp4`;
  seedRenderJob('job-d', P1, 'succeeded', relD);
  const resD = await resolveJobArtifact({id: 'job-d', project_id: P1, status: 'succeeded', progress: 100, output_path: relD}, goodProbe);
  ok(!resD.ok && resD.status === 409 && resD.code === 'artifact_unvalidated',
    '[E10] DB 称 succeeded 但文件缺失且无 manifest → 409（不下发旧文件）');

  // 旧文件仍存在于磁盘但属于旧 job：新失败 job 不得返回旧文件（stale overwrite 场景）
  const relOld = `projects/${P1}/renders/job-old.mp4`;
  writeFixture(relOld, 'OLD-VIDEO');
  seedRenderJob('job-old', P1, 'succeeded', relOld);
  seedRenderJob('job-new-failed', P1, 'failed', null);
  const resNF = await resolveJobArtifact({id: 'job-new-failed', project_id: P1, status: 'failed', progress: 100, output_path: null});
  ok(!resNF.ok, '[E11] 新 job 失败 → 报错，绝不返回磁盘上的旧 job 文件');
  const resOld = await resolveJobArtifact({id: 'job-old', project_id: P1, status: 'succeeded', progress: 100, output_path: relOld}, goodProbe);
  ok(resOld.ok && resOld.absPath.endsWith('job-old.mp4'),
    '[E12] 显式请求旧 job → 仍可下载旧产物（各自 identity 独立）');

  // backfillRenderArtifact 直接调用：无 output_path → null
  ok(
    (await backfillRenderArtifact({id: 'job-c', project_id: P1, output_path: null})) === null,
    '[E13] 无 output_path 的 job 不可回填',
  );
}

// ---------- F. 绊线前提：schema 保留 showPilotIntro ----------

function testTripwire(): void {
  const baseProps = {
    data: {
      schemaVersion: '1.0',
      templateVersion: 'freud-mg-v1.0',
      project: {
        title: 't', composition: 'ZhiyingFullCut', fps: 30, width: 1920, height: 1080,
        durationSec: 10, durationInFrames: 300, timingBasis: 'narration_scene_reconciliation',
        showPilotIntro: true,
      },
      chapterTiming: [],
      scenes: [],
    },
    subtitles: [],
    audio: {narration: null, bgm: null, sfx: null},
    showSubtitles: true,
  };
  const parsed = zhiyingFullCutPropsSchema.safeParse(baseProps);
  ok(
    parsed.success && parsed.data.data.project.showPilotIntro === true,
    '[F01] schema 保留 showPilotIntro（worker 绊线可检测 demo defaultProps）',
  );
}

async function main(): Promise<void> {
  fs.rmSync(getDataDir(), {recursive: true, force: true});
  testBundleKey();
  await testValidation();
  await testResolve();
  testTripwire();
  closeDb();
  fs.rmSync(getDataDir(), {recursive: true, force: true});
  console.log(`\n${pass} PASS, ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
