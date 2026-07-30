/**
 * M6.3.13 Manual Upload 内容权威验证测试（零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m6313-upload.ts
 *
 * 背景：浏览器对部分文件自报 application/octet-stream 或错误 MIME，
 * 服务端旧逻辑 100% 信任 declared MIME → 合法 PNG 被 400 invalid_mime。
 * 新契约：magic bytes 为唯一权威（canonical 类型决定落盘扩展名与 DB mimeType），
 * 不可识别内容一律 400 invalid_content。
 *
 * 覆盖：
 *   A. 真实 PNG 字节 + declared image/png → 201，落盘 .png
 *   B. 真实 PNG 字节 + declared application/octet-stream（浏览器误报场景）→ 201
 *   C. JPEG 字节改名 .png（内容与扩展名不符，magic=jpeg）→ 按规则 a canonical 处理：
 *      接受并按 magic 落盘 .jpg（DB mimeType=image/jpeg）
 *   D. 随机字节伪装（magic 不可识别）→ 400 invalid_content
 *   E. JPEG / WebP 真实样本回归 → 201
 *   F. sniffImageType / hasAllowedExtension 单元断言
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m6313-upload');
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {hasAllowedExtension, sniffImageType} from '../src/lib/assets/image-sniff';
import {getAssetById} from '../src/lib/assets/model';
import {compileAssetPlans} from '../src/lib/assets/requirements';
import type {AssetRequirement, Scene} from '../src/lib/scene-schema';
import {POST as uploadPOST} from '../src/app/api/projects/[id]/assets/upload/route';

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

// ---------- 最小合法文件头样本（magic bytes 足够，无需可解码真图片） ----------

// PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR 起头
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
// JPEG: FF D8 FF E0 + JFIF
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
// WebP: RIFF....WEBP + VP8
const WEBP_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
// 随机字节：任何 magic 都不匹配
const GARBAGE_BYTES = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd]);

// ---------- fixture ----------

const P1 = 'test-p1-upload';

const REQ_S01_R01: AssetRequirement = {kind: 'image', subject: '弗洛伊德肖像', query: 'Freud portrait', usage: 'primary', policy: 'public_domain'};

function scenesArtifact(): string {
  return JSON.stringify({
    chapterTiming: [{chapter: 1, title: '第一章', start: 0, end: 10}],
    scenes: [{
      id: 'S01', chapter: 1, chapterTitle: '第一章', start: 0, end: 10, duration: 10,
      startFrame: 0, durationInFrames: 300, category: 'Archive', visualType: 'Archive',
      template: null, sourceTemplate: null, assetRequirements: [REQ_S01_R01],
      narrationSummary: '摘要', description: '画面描述', notes: '', assetIds: [],
      licenseStatus: 'not-applicable', subtitlePosition: 'bottom', transitionIn: 'none', transitionOut: 'cut',
    } as Scene],
  });
}

function seedProject(projectId: string): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(projectId, `测试项目 ${projectId}`, now, now);
  getDb().prepare(
    `INSERT INTO project_versions (id, project_id, stage, version, content, content_type, source, created_at)
     VALUES (?, ?, 'scenes', 1, ?, 'json', 'repair', ?)`,
  ).run(`${projectId}-scenes-v1`, projectId, scenesArtifact(), now);
}

async function upload(bytes: Buffer, name: string, declaredType: string): Promise<{status: number; body: Record<string, unknown>}> {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], name, {type: declaredType}));
  form.append('sceneId', 'S01');
  form.append('requirementId', 'S01-R01');
  const res = await uploadPOST(
    new Request('http://test/upload', {method: 'POST', body: form}),
    {params: Promise.resolve({id: P1})},
  );
  return {status: res.status, body: (await res.json()) as Record<string, unknown>};
}

// ---------- main ----------

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m6313-upload'), {recursive: true, force: true});
  getDb();
  seedProject(P1);
  // 确认 fixture 的 requirementId 推导与 compileAssetPlans 一致
  const reqId = compileAssetPlans(scenesArtifact())[0]!.requirements[0]!.requirementId;
  ok(reqId === 'S01-R01', '[F00] fixture requirementId = S01-R01', reqId);

  // ---------- F：sniff 单元断言 ----------
  ok(sniffImageType(PNG_BYTES)?.type === 'png', '[F01] sniff PNG magic');
  ok(sniffImageType(JPEG_BYTES)?.type === 'jpeg', '[F02] sniff JPEG magic');
  ok(sniffImageType(WEBP_BYTES)?.type === 'webp', '[F03] sniff WebP magic');
  ok(sniffImageType(GARBAGE_BYTES) === null, '[F04] sniff 随机字节 = null');
  ok(sniffImageType(Buffer.from([0x89, 0x50])) === null, '[F05] 截断 PNG 头 = null');
  ok(hasAllowedExtension('A.PNG') && hasAllowedExtension('b.jpeg') && !hasAllowedExtension('c.gif') && !hasAllowedExtension('noext'),
    '[F06] 扩展名白名单小写归一');

  // ---------- A：真实 PNG + 正确 declared MIME ----------
  {
    const {status, body} = await upload(PNG_BYTES, 'portrait.png', 'image/png');
    ok(status === 201, '[A01] PNG + image/png → 201', body);
    ok(typeof body.publicPath === 'string' && (body.publicPath as string).endsWith('.png'), '[A02] 落盘扩展名 .png', body.publicPath);
    const row = getAssetById(body.assetId as string);
    ok(row?.mime_type === 'image/png', '[A03] DB mimeType = image/png', row?.mime_type);
    ok(fs.existsSync(path.join(process.cwd(), 'public', row!.local_path)), '[A04] 物理文件已落盘');
  }

  // ---------- B：真实 PNG + 浏览器误报 octet-stream ----------
  {
    const {status, body} = await upload(PNG_BYTES, 'portrait.png', 'application/octet-stream');
    ok(status === 201, '[B01] PNG + octet-stream（浏览器误报）→ 201（旧逻辑 400 invalid_mime）', body);
    ok(typeof body.publicPath === 'string' && (body.publicPath as string).endsWith('.png'), '[B02] canonical=png → 落盘 .png', body.publicPath);
    const row = getAssetById(body.assetId as string);
    ok(row?.mime_type === 'image/png', '[B03] DB mimeType 被纠正为 image/png', row?.mime_type);
  }

  // ---------- C：JPEG 字节改名 .png（magic 与扩展名/declared 不符） ----------
  // 规则 a 语义选择：接受并以 magic 为 canonical → 落盘 .jpg、DB image/jpeg。
  // 理由：内容权威原则下，纸面信息（名字/declared MIME）一律不否决可识别内容。
  {
    const {status, body} = await upload(JPEG_BYTES, 'mislabeled.png', 'image/png');
    ok(status === 201, '[C01] JPEG 字节改名 .png → 201（规则 a：接受并按 canonical 处理）', body);
    ok(typeof body.publicPath === 'string' && (body.publicPath as string).endsWith('.jpg'), '[C02] canonical=jpeg → 落盘 .jpg（非纸面 .png）', body.publicPath);
    const row = getAssetById(body.assetId as string);
    ok(row?.mime_type === 'image/jpeg', '[C03] DB mimeType = image/jpeg', row?.mime_type);
  }

  // ---------- D：随机字节伪装 → 400 invalid_content ----------
  {
    const {status, body} = await upload(GARBAGE_BYTES, 'fake.png', 'image/png');
    ok(status === 400 && body.error === 'invalid_content', '[D01] 随机字节 + image/png declared → 400 invalid_content', body);
    const {status: s2, body: b2} = await upload(GARBAGE_BYTES, 'fake.jpg', 'image/jpeg');
    ok(s2 === 400 && b2.error === 'invalid_content', '[D02] 随机字节 + image/jpeg declared → 400 invalid_content', b2);
  }

  // ---------- E：JPEG / WebP 真实样本回归 ----------
  {
    const {status, body} = await upload(JPEG_BYTES, 'photo.jpg', 'image/jpeg');
    ok(status === 201 && typeof body.publicPath === 'string' && (body.publicPath as string).endsWith('.jpg'), '[E01] JPEG 回归 → 201 落盘 .jpg', body);
    const {status: s2, body: b2} = await upload(WEBP_BYTES, 'pic.webp', 'image/webp');
    ok(s2 === 201 && typeof b2.publicPath === 'string' && (b2.publicPath as string).endsWith('.webp'), '[E02] WebP 回归 → 201 落盘 .webp', b2);
    const row = getAssetById(b2.assetId as string);
    ok(row?.mime_type === 'image/webp', '[E03] WebP DB mimeType = image/webp', row?.mime_type);
  }

  // ---------- 收尾 ----------
  fs.rmSync(path.join(process.cwd(), 'public', 'assets', P1), {recursive: true, force: true});
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m6313-upload'), {recursive: true, force: true});

  console.log(`\n${pass} PASS / ${fail} FAIL / ${pass + fail} TOTAL`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
