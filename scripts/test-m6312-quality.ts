/**
 * M6.3.12 Final Video Visual Completeness + Quality Gate 测试（零真实渲染）。
 *
 * 用法：npx tsx scripts/test-m6312-quality.ts
 * 使用临时数据目录（data/test-m6312-quality），结束后清理。
 *
 * 覆盖（对应验收 Phase 3/4/5/7/8/9/12/14/17/20）：
 *   A. render-input gate：MG 缺 templateProps / 未知模板 / 缺 template；
 *      Archive 缺 assetMap / 首素材非 image / 物理文件缺失；全过；Minimal 免素材
 *   B. placeholder kill switch：final 模式 throw MissingVisualAssetError；
 *      preview 模式渲染占位文案
 *   C. Ken Burns：确定性（同 sceneId 同帧同 transform）、四种模式覆盖、
 *      进度端点插值正确、pan 基础放大不露底
 *   D. loudnorm：pass1/pass2 参数构造、stderr JSON 解析、两通 exec 流程（伪 ffmpeg）
 *   E. 质量门扩展：requireAudio 无音轨失败、时长偏差 >1s 失败、正常通过
 *   F. 视觉审计：分类时长分布、title/MG 占比、静态 >8s/>12s、素材复用标记
 *   G. manifest 扩展列：audit_json / loudness_json 持久化往返
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m6312-quality');

import {closeDb, getDataDir, getDb} from '../src/lib/db';
import {
  getRenderArtifact,
  persistRenderArtifact,
  validateRenderOutput,
  type ProbedOutput,
} from '../src/lib/render/artifact';
import {
  buildLoudnormPass1Args,
  buildLoudnormPass2Args,
  parseLoudnormMeasured,
  runTwoPassLoudnorm,
  type LoudnormMeasured,
} from '../src/lib/render/loudness';
import {
  auditFinalVisuals,
  validateFinalVisualProps,
} from '../src/lib/render/visual-gate';
import type {Scene, ZhiyingFullCutProps} from '../src/lib/scene-schema';
import {RenderModeContext, MissingVisualAssetError} from '../src/remotion/render-mode';
import {ProductionPlaceholder} from '../src/remotion/compositions/ProductionPlaceholder';
import {kenBurnsTransform} from '../src/remotion/compositions/ProductionSceneRenderer';

// tsx 按 tsconfig jsx:'preserve' 以 classic runtime 转译被测组件（无自动 React 注入），
// 组件内 JSX 在运行期引用自由变量 React —— 测试进程显式提供（仅测试环境需要）。
(globalThis as {React?: typeof React}).React = React;

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

function makeScene(partial: Partial<Scene> & {id: string}): Scene {
  return {
    chapter: 1,
    chapterTitle: 'C1',
    start: 0,
    end: 10,
    duration: 10,
    startFrame: 0,
    durationInFrames: 300,
    category: 'Minimal',
    visualType: 'UI',
    template: null,
    sourceTemplate: null,
    assetRequirements: [],
    narrationSummary: '测试旁白',
    description: '',
    notes: '',
    assetIds: [],
    licenseStatus: 'not-applicable',
    subtitlePosition: 'bottom',
    transitionIn: 'none',
    transitionOut: 'none',
    ...partial,
  };
}

function makeProps(scenes: Scene[], assetMap?: ZhiyingFullCutProps['data']['assetMap']): ZhiyingFullCutProps {
  return {
    data: {
      schemaVersion: '1.0',
      templateVersion: 'freud-mg-v1.0',
      project: {
        title: 'T',
        fps: 30,
        width: 1920,
        height: 1080,
        durationSec: 10,
        durationInFrames: 300,
        composition: 'ZhiyingFullCut',
      },
      chapterTiming: [{chapter: 1, title: 'C1', start: 0, end: 10}],
      scenes,
      assetMap,
    },
    subtitles: [],
    audio: {narration: null, bgm: null, sfx: null},
    showSubtitles: true,
  };
}

const assetExists = () => true;
const assetMissing = () => false;

const MG_PROPS = {message: '核心论断', context: '上下文'};

function testVisualGate(): void {
  console.log('\n-- A. render-input gate --');
  // 1. MG templateProps 完整 → pass
  const mgOk = validateFinalVisualProps(
    makeProps([makeScene({id: 'S1', category: 'MG', template: 'MG_MessageFocus', templateProps: MG_PROPS})]),
    {assetFileExists: assetExists},
  );
  ok(mgOk.ok === true, 'A1 MG templateProps 完整 → 通过');

  // 2. MG templateProps 缺失 → fail（历史 P0：TimedScene 丢弃 templateProps 场景）
  const mgMissing = validateFinalVisualProps(
    makeProps([makeScene({id: 'S1', category: 'MG', template: 'MG_MessageFocus'})]),
    {assetFileExists: assetExists},
  );
  ok(mgMissing.ok === false && mgMissing.issues[0]?.sceneId === 'S1', 'A2 MG 缺 templateProps → 拦截', mgMissing.ok === false ? mgMissing.issues : undefined);

  // 3. 未知 MG 模板 → fail
  const mgUnknown = validateFinalVisualProps(
    makeProps([makeScene({id: 'S2', category: 'MG', template: 'MG_NotExist', templateProps: MG_PROPS})]),
    {assetFileExists: assetExists},
  );
  ok(mgUnknown.ok === false && mgUnknown.issues[0]?.reason.includes('未知 MG 模板'), 'A3 未知 MG 模板 → 拦截');

  // 4. MG 缺 template → fail
  const mgNoTpl = validateFinalVisualProps(
    makeProps([makeScene({id: 'S3', category: 'MG'})]),
    {assetFileExists: assetExists},
  );
  ok(mgNoTpl.ok === false && mgNoTpl.issues[0]?.reason.includes('缺少 template'), 'A4 MG 缺 template → 拦截');

  // 5. Archive 有 assetMap 且文件存在 → pass
  const archiveOk = validateFinalVisualProps(
    makeProps(
      [makeScene({id: 'S4', category: 'Archive'})],
      {S4: [{assetId: 'a1', publicPath: 'assets/p/x.jpg', mediaType: 'image', width: 800, height: 600, description: '', attribution: '', sourceUrl: 'https://x'}]},
    ),
    {assetFileExists: assetExists},
  );
  ok(archiveOk.ok === true, 'A5 Archive assetMap + 文件存在 → 通过');

  // 6. Archive 缺 assetMap → fail
  const archiveMissing = validateFinalVisualProps(
    makeProps([makeScene({id: 'S5', category: 'Archive'})]),
    {assetFileExists: assetExists},
  );
  ok(archiveMissing.ok === false && archiveMissing.issues[0]?.reason.includes('assetMap'), 'A6 Archive 缺 assetMap → 拦截');

  // 7. B-roll 首素材 video → fail（renderer 只支持 image）
  const brollVideo = validateFinalVisualProps(
    makeProps(
      [makeScene({id: 'S6', category: 'B-roll'})],
      {S6: [{assetId: 'a2', publicPath: 'assets/p/x.mp4', mediaType: 'video', width: null, height: null, description: '', attribution: '', sourceUrl: ''}]},
    ),
    {assetFileExists: assetExists},
  );
  ok(brollVideo.ok === false && brollVideo.issues[0]?.reason.includes('视频素材'), 'A7 B-roll 视频素材 → 拦截');

  // 8. assetMap 存在但物理文件缺失 → fail（binding ≠ 文件可读）
  const fileMissing = validateFinalVisualProps(
    makeProps(
      [makeScene({id: 'S7', category: 'Archive'})],
      {S7: [{assetId: 'a3', publicPath: 'assets/p/gone.jpg', mediaType: 'image', width: 1, height: 1, description: '', attribution: '', sourceUrl: ''}]},
    ),
    {assetFileExists: assetMissing},
  );
  ok(fileMissing.ok === false && fileMissing.issues[0]?.reason.includes('素材文件缺失'), 'A8 binding 存在但文件缺失 → 拦截');

  // 9. Minimal typography → 免素材通过
  const minimal = validateFinalVisualProps(
    makeProps([makeScene({id: 'S8', category: 'Minimal'})]),
    {assetFileExists: assetMissing},
  );
  ok(minimal.ok === true, 'A9 Minimal 无外部素材 → 通过');

  // 10. 混合：一个失败 → 整体失败且 issues 计数正确
  const mixed = validateFinalVisualProps(
    makeProps([
      makeScene({id: 'S9', category: 'MG', template: 'MG_MessageFocus', templateProps: MG_PROPS}),
      makeScene({id: 'S10', category: 'Archive'}),
      makeScene({id: 'S11', category: 'B-roll'}),
    ]),
    {assetFileExists: assetExists},
  );
  ok(mixed.ok === false && mixed.issues.length === 2, 'A10 混合场景 issues 计数正确', mixed.ok === false ? mixed.issues.length : undefined);
}

function testKillSwitch(): void {
  console.log('\n-- B. placeholder kill switch --');
  const scene = makeScene({id: 'SX', category: 'Archive'});
  // final 模式 → throw MissingVisualAssetError
  let thrown: unknown = null;
  try {
    renderToStaticMarkup(
      React.createElement(
        RenderModeContext.Provider,
        {value: 'final'},
        React.createElement(ProductionPlaceholder, {scene, reason: '视觉素材待准备'}),
      ),
    );
  } catch (err) {
    thrown = err;
  }
  ok(
    thrown instanceof MissingVisualAssetError && (thrown as MissingVisualAssetError).sceneId === 'SX',
    'B1 final 模式 placeholder → throw MissingVisualAssetError',
    thrown instanceof Error ? thrown.message : thrown,
  );
  // preview 模式 → 正常渲染占位文案
  const html = renderToStaticMarkup(
    React.createElement(
      RenderModeContext.Provider,
      {value: 'preview'},
      React.createElement(ProductionPlaceholder, {scene, reason: '视觉素材待准备'}),
    ),
  );
  ok(html.includes('视觉素材待准备'), 'B2 preview 模式 placeholder → 正常渲染');
}

function testKenBurns(): void {
  console.log('\n-- C. Ken Burns --');
  const t1 = kenBurnsTransform('S001', 0, 300);
  const t2 = kenBurnsTransform('S001', 0, 300);
  ok(t1 === t2, 'C1 同 sceneId 同帧 → transform 确定');
  const start = kenBurnsTransform('S001', 0, 300);
  const end = kenBurnsTransform('S001', 299, 300);
  ok(start !== end, 'C2 首末帧 transform 不同（有运动）', {start, end});
  // 四种模式覆盖
  const modes = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const t = kenBurnsTransform(`SCENE-${i}`, 150, 300);
    if (t.startsWith('scale(1.05) translateX(-')) modes.add('pan-left');
    else if (t.startsWith('scale(1.05) translateX(')) modes.add('pan-right-or-zero');
    else modes.add('zoom');
  }
  ok(modes.has('pan-left') && modes.size >= 2, 'C3 多 sceneId 覆盖多种运动模式', [...modes]);
  // 端点：progress=0 / 1 精确
  const zStart = kenBurnsTransform('S002', 0, 300);
  ok(zStart.includes('1.00000') || zStart.includes('1.04000') || zStart.includes('0.0000') || zStart.includes('-1.5000'), 'C4 起点为插值端点', zStart);
  // durationInFrames=1 不除零
  const single = kenBurnsTransform('S003', 0, 1);
  ok(typeof single === 'string' && single.length > 0, 'C5 单帧 scene 不崩溃', single);
}

async function testLoudness(): Promise<void> {
  console.log('\n-- D. loudnorm --');
  const p1 = buildLoudnormPass1Args('/in.mp4');
  ok(p1.includes('loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json') && p1[p1.length - 1] === '-' && p1.includes('null'), 'D1 pass1 参数构造正确', p1.join(' '));
  const measured: LoudnormMeasured = {inputI: -22.04, inputTp: -5.86, inputLra: 3.3, inputThresh: -32.54, targetOffset: 0.04};
  const p2 = buildLoudnormPass2Args('/in.mp4', '/out.mp4', measured);
  const af = p2.find((a) => a.startsWith('loudnorm=')) ?? '';
  ok(
    af.includes('measured_I=-22.04') && af.includes('measured_TP=-5.86') && af.includes('offset=0.04') && af.includes('linear=true'),
    'D2 pass2 携带 measured_* + linear',
    af,
  );
  ok(p2.includes('-c:v') && p2[p2.indexOf('-c:v') + 1] === 'copy', 'D3 pass2 视频流 copy（不重编码）');
  ok(p2.includes('-c:a') && p2[p2.indexOf('-c:a') + 1] === 'aac', 'D4 pass2 音频重编码 AAC');

  const fakeStderr = `
[Parsed_loudnorm_0 @ 0x0] something
{
	"input_i" : "-22.04",
	"input_tp" : "-5.86",
	"input_lra" : "3.30",
	"input_thresh" : "-32.54",
	"output_i" : "-16.01",
	"output_tp" : "-1.60",
	"output_lra" : "3.10",
	"output_thresh" : "-26.51",
	"normalization_type" : "dynamic",
	"target_offset" : "0.04"
}
`;
  const parsed = parseLoudnormMeasured(fakeStderr);
  ok(parsed.inputI === -22.04 && parsed.inputTp === -5.86 && parsed.targetOffset === 0.04, 'D5 stderr 测量 JSON 解析', parsed);
  let parseFailed = false;
  try {
    parseLoudnormMeasured('no json here');
  } catch {
    parseFailed = true;
  }
  ok(parseFailed, 'D6 无测量 JSON → 明确抛错');

  // 两通流程（伪 ffmpeg：pass1 回 stderr，pass2 复制输入到输出）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6312-loud-'));
  const input = path.join(dir, 'in.bin');
  fs.writeFileSync(input, 'fake-video');
  const output = path.join(dir, 'out.bin');
  const calls: string[][] = [];
  const fakeExec = async (args: string[]): Promise<{stdout: string; stderr: string}> => {
    calls.push(args);
    if (args.includes('null')) return {stdout: '', stderr: fakeStderr};
    const out = args[args.length - 1]!;
    const inp = args[args.indexOf('-i') + 1]!;
    fs.copyFileSync(inp, out);
    return {stdout: '', stderr: ''};
  };
  const result = await runTwoPassLoudnorm(input, output, fakeExec);
  ok(calls.length === 2 && fs.existsSync(output), 'D7 两通 loudnorm 执行（pass1 测量 + pass2 归一化）');
  ok(result.measured.inputI === -22.04, 'D8 返回输入测量值');
  fs.rmSync(dir, {recursive: true, force: true});
}

async function testQualityGate(): Promise<void> {
  console.log('\n-- E. 质量门扩展 --');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6312-gate-'));
  const f = path.join(dir, 'v.mp4');
  fs.writeFileSync(f, 'x');
  const noAudio: ProbedOutput = {durationSec: 10, width: 1920, height: 1080, codec: 'h264', audioCodec: null};
  const withAudio: ProbedOutput = {...noAudio, audioCodec: 'aac'};
  const r1 = await validateRenderOutput(f, async () => noAudio, {requireAudio: true});
  ok(r1.ok === false && r1.reason.includes('音轨'), 'E1 requireAudio + 无音轨 → 失败');
  const r2 = await validateRenderOutput(f, async () => withAudio, {requireAudio: true});
  ok(r2.ok === true, 'E2 requireAudio + 有音轨 → 通过');
  const r3 = await validateRenderOutput(f, async () => withAudio, {expectDurationSec: 12.5});
  ok(r3.ok === false && r3.reason.includes('时长偏差'), 'E3 时长偏差 >1s → 失败');
  const r4 = await validateRenderOutput(f, async () => withAudio, {expectDurationSec: 10.5});
  ok(r4.ok === true, 'E4 时长偏差 ≤1s → 通过');
  const r5 = await validateRenderOutput(f, async () => withAudio);
  ok(r5.ok === true, 'E5 无 opts 旧行为不变');
  fs.rmSync(dir, {recursive: true, force: true});
}

function testAudit(): void {
  console.log('\n-- F. 视觉审计 --');
  const props = makeProps(
    [
      makeScene({id: 'S1', category: 'Archive', start: 0, end: 15, duration: 15}), // generated, >8s, >12s
      makeScene({id: 'S2', category: 'B-roll', start: 15, end: 24, duration: 9}), // real, >8s
      makeScene({id: 'S3', category: 'MG', template: 'MG_MessageFocus', templateProps: MG_PROPS, start: 24, end: 30, duration: 6}),
      makeScene({id: 'S4', category: 'Minimal', start: 30, end: 40, duration: 10}),
      makeScene({id: 'S5', category: 'Archive', start: 40, end: 45, duration: 5}), // 复用 a1
    ],
    {
      S1: [{assetId: 'a1', publicPath: 'assets/p/a.jpg', mediaType: 'image', width: 1, height: 1, description: '', attribution: 'AI 生成', sourceUrl: ''}],
      S2: [{assetId: 'a2', publicPath: 'assets/p/b.jpg', mediaType: 'image', width: 1, height: 1, description: '', attribution: 'Wikimedia', sourceUrl: 'https://commons'}],
      S5: [{assetId: 'a1', publicPath: 'assets/p/a.jpg', mediaType: 'image', width: 1, height: 1, description: '', attribution: 'AI 生成', sourceUrl: ''}],
    },
  );
  const audit = auditFinalVisuals(props);
  ok(audit.byClass.generated_image.scenes === 2 && audit.byClass.generated_image.durationSec === 20, 'F1 generated_image 分类（attribution/sourceUrl 判定）', audit.byClass);
  ok(audit.byClass.real_image.scenes === 1 && audit.byClass.real_image.durationSec === 9, 'F2 real_image 分类');
  ok(audit.byClass.mg.scenes === 1 && audit.byClass.title_card.scenes === 1, 'F3 mg / title_card 分类');
  ok(audit.placeholder.scenes === 0 && audit.placeholder.durationSec === 0, 'F4 placeholder 恒 0');
  ok(Math.abs(audit.titleMgOnly.ratio - 16 / 45) < 1e-9, 'F5 title/MG-only 占比', audit.titleMgOnly);
  ok(audit.staticShotsOver8s.length === 2 && audit.staticShotsOver12s.length === 1, 'F6 静态长镜头分档', {o8: audit.staticShotsOver8s, o12: audit.staticShotsOver12s});
  const reuse = audit.assetReuse.find((r) => r.assetId === 'a1');
  ok(
    reuse !== undefined && reuse.sceneCount === 2 && reuse.suspicious === true && reuse.totalDurationSec === 20 && reuse.usages.length === 2,
    'F7 素材复用标记（sceneCount/时长/时间点）',
    reuse,
  );
  const single = audit.assetReuse.find((r) => r.assetId === 'a2');
  ok(single !== undefined && single.suspicious === false, 'F8 单次使用不标记 suspicious');
}

function testManifestColumns(): void {
  console.log('\n-- G. manifest 扩展列 --');
  const projectId = 'test-m6312-p1';
  const now = new Date().toISOString();
  getDb().prepare('INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(projectId, 'T', now, now);
  const jobId = 'job-m6312-1';
  getDb()
    .prepare(
      `INSERT INTO render_jobs (id, project_id, kind, status, progress, payload_json, output_path, queued_at, attempt, max_attempts)
       VALUES (?, ?, 'fullcut', 'succeeded', 100, '{}', 'projects/x/renders/j.mp4', ?, 1, 2)`,
    )
    .run(jobId, projectId, now);
  persistRenderArtifact({
    job_id: jobId,
    project_id: projectId,
    output_path: 'projects/x/renders/j.mp4',
    output_sha256: 'a'.repeat(64),
    output_size: 123,
    duration_sec: 307.6,
    frame_count: 9228,
    encoder: 'h264_nvenc',
    payload_sha256: 'b'.repeat(64),
    bundle_key: 'k',
    audit_json: '{"compilerVersion":"m6312-visual-audit-v1"}',
    loudness_json: '{"output":{"inputI":-16.01}}',
  });
  const row = getRenderArtifact(jobId);
  ok(row?.audit_json?.includes('m6312-visual-audit-v1') === true, 'G1 audit_json 持久化往返');
  ok(row?.loudness_json?.includes('-16.01') === true, 'G2 loudness_json 持久化往返');
  // 旧调用方不传新列 → null（历史兼容）
  persistRenderArtifact({
    job_id: jobId,
    project_id: projectId,
    output_path: 'projects/x/renders/j.mp4',
    output_sha256: 'a'.repeat(64),
    output_size: 123,
    duration_sec: 1,
    frame_count: 30,
    encoder: 'libx264',
    payload_sha256: null,
    bundle_key: null,
    backfilled: 1,
  });
  const row2 = getRenderArtifact(jobId);
  ok(row2?.audit_json === null && row2?.loudness_json === null && row2?.backfilled === 1, 'G3 缺省 → 新列 null（回填路径兼容）');
}

// ---------- main ----------

async function main(): Promise<void> {
  testVisualGate();
  testKillSwitch();
  testKenBurns();
  await testLoudness();
  await testQualityGate();
  testAudit();
  testManifestColumns();
  console.log(`\n${pass} PASS, ${fail} FAIL`);
  closeDb();
  fs.rmSync(getDataDir(), {recursive: true, force: true});
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
