#!/usr/bin/env node
/**
 * import-sample.mjs —— 将 samples/FullCutScenes.json 导入本地知影服务（CONTRACT §8）
 *
 * 用法：
 *   node scripts/import-sample.mjs
 *
 * 环境变量：
 *   BASE_URL  服务地址，默认 http://localhost:3000
 *
 * 行为：
 *   POST {BASE_URL}/api/projects/import，body 为 samples/FullCutScenes.json 原文。
 *   成功时打印 project id；失败时打印响应体并以非零码退出。
 *
 * 仅使用 Node 18+ 原生 fetch，无第三方依赖。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.resolve(__dirname, '..', 'samples', 'FullCutScenes.json');
// 弗洛伊德示例的官方配套字幕（复制自 src/remotion/data/fullCutSubtitles.json）。
// 存在时由本脚本「显式」合入 payload.subtitles —— 通用 Import API 只认请求体里的
// subtitles 字段，不做任何隐式固定字幕 fallback。
const SUBTITLES_PATH = path.resolve(
  __dirname,
  '..',
  'samples',
  'FullCutSubtitles.json',
);
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

async function main() {
  let raw;
  try {
    raw = await readFile(SAMPLE_PATH, 'utf8');
  } catch (err) {
    console.error(`[import] 无法读取样例文件: ${SAMPLE_PATH}`);
    console.error(`[import] ${err.message}`);
    process.exit(1);
  }

  // 基本完整性检查（zod 校验由服务端 fullCutDataSchema 负责）
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[import] 样例文件不是合法 JSON: ${err.message}`);
    process.exit(1);
  }
  if (!parsed || !Array.isArray(parsed.scenes)) {
    console.error('[import] 样例文件缺少 scenes 数组，结构不符合 FullCutData');
    process.exit(1);
  }
  console.log(`[import] 样例: ${parsed.project?.title ?? '(无标题)'}，scenes=${parsed.scenes.length}`);

  // 样例源文件本身不带 subtitles 字段；若配套字幕文件存在则显式合入 payload
  let payloadBody = raw;
  if (!('subtitles' in parsed)) {
    try {
      const subsRaw = await readFile(SUBTITLES_PATH, 'utf8');
      const subs = JSON.parse(subsRaw);
      if (Array.isArray(subs)) {
        payloadBody = JSON.stringify({ ...parsed, subtitles: subs });
        console.log(`[import] 已合入配套字幕: ${subs.length} 条（来自 samples/FullCutSubtitles.json）`);
      }
    } catch {
      console.log('[import] 未找到配套字幕文件，按无字幕导入');
    }
  }

  const url = `${BASE_URL}/api/projects/import`;
  console.log(`[import] POST ${url}`);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadBody,
    });
  } catch (err) {
    console.error(`[import] 请求失败（服务是否已启动？先运行 npm run dev）: ${err.message}`);
    process.exit(1);
  }

  const text = await res.text();
  if (!res.ok) {
    console.error(`[import] 导入失败 HTTP ${res.status}`);
    console.error('[import] 响应体:');
    console.error(text);
    process.exit(1);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    console.error('[import] 响应不是合法 JSON:');
    console.error(text);
    process.exit(1);
  }

  const projectId = body?.project?.id;
  if (!projectId) {
    console.error('[import] 响应中缺少 project.id:');
    console.error(text);
    process.exit(1);
  }

  console.log(`[import] 导入成功`);
  console.log(`project id: ${projectId}`);
  console.log(`[import] 下一步: node scripts/verify-roundtrip.mjs ${projectId}`);
}

main();
