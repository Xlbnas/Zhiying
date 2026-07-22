#!/usr/bin/env node
/**
 * verify-roundtrip.mjs —— round-trip 无损校验（CONTRACT §8）
 *
 * 用法：
 *   node scripts/verify-roundtrip.mjs <projectId>
 *
 * 环境变量：
 *   BASE_URL  服务地址，默认 http://localhost:3000
 *
 * 行为：
 *   GET {BASE_URL}/api/projects/{projectId}/scenes（返回 ZhiyingFullCutProps），
 *   与 samples/FullCutScenes.json 逐字段对比：
 *     - scene 总数必须等于 85
 *     - 每个 scene 的 id / 顺序 / start / end / duration /
 *       startFrame / durationInFrames / template / category 全部一致
 *   输出逐项 PASS/FAIL 汇总；任何不一致打印 diff 并以非零码退出。
 *
 * 仅使用 Node 18+ 原生 fetch，无第三方依赖。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.resolve(__dirname, '..', 'samples', 'FullCutScenes.json');
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const EXPECTED_SCENE_COUNT = 85;

// 契约要求的逐字段对比项（顺序即数组下标，单独校验）
const COMPARE_FIELDS = [
  'id',
  'start',
  'end',
  'duration',
  'startFrame',
  'durationInFrames',
  'template',
  'category',
];

function fmt(v) {
  return v === undefined ? '(missing)' : JSON.stringify(v);
}

async function main() {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error('用法: node scripts/verify-roundtrip.mjs <projectId>');
    console.error('（projectId 由 scripts/import-sample.mjs 输出）');
    process.exit(1);
  }

  // 1. 读取源样例
  let source;
  try {
    source = JSON.parse(await readFile(SAMPLE_PATH, 'utf8'));
  } catch (err) {
    console.error(`[verify] 无法读取样例文件: ${SAMPLE_PATH}: ${err.message}`);
    process.exit(1);
  }
  const sourceScenes = source.scenes;

  // 2. 拉取服务端 scenes（ZhiyingFullCutProps: { data, subtitles, audio, showSubtitles }）
  const url = `${BASE_URL}/api/projects/${encodeURIComponent(projectId)}/scenes`;
  console.log(`[verify] GET ${url}`);
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(`[verify] 请求失败（服务是否已启动？先运行 npm run dev）: ${err.message}`);
    process.exit(1);
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`[verify] 获取失败 HTTP ${res.status}`);
    console.error('[verify] 响应体:');
    console.error(text);
    process.exit(1);
  }
  let props;
  try {
    props = JSON.parse(text);
  } catch {
    console.error('[verify] 响应不是合法 JSON:');
    console.error(text);
    process.exit(1);
  }
  const remoteScenes = props?.data?.scenes;
  if (!Array.isArray(remoteScenes)) {
    console.error('[verify] 响应缺少 data.scenes 数组，不符合 ZhiyingFullCutProps 契约');
    process.exit(1);
  }

  // 3. 逐项对比
  let pass = 0;
  let fail = 0;
  const report = (ok, label, detail) => {
    if (ok) {
      pass++;
      console.log(`PASS  ${label}`);
    } else {
      fail++;
      console.log(`FAIL  ${label}`);
      if (detail) console.log(detail);
    }
  };

  // 3.1 scene 总数
  report(
    remoteScenes.length === EXPECTED_SCENE_COUNT,
    `scene 总数 = ${EXPECTED_SCENE_COUNT}`,
    `  expected: ${EXPECTED_SCENE_COUNT}\n  actual:   ${remoteScenes.length}`
  );
  report(
    sourceScenes.length === EXPECTED_SCENE_COUNT,
    `源样例 scene 总数 = ${EXPECTED_SCENE_COUNT}`,
    `  expected: ${EXPECTED_SCENE_COUNT}\n  actual:   ${sourceScenes.length}`
  );

  // 3.2 逐 scene、逐字段对比（按数组顺序对齐，顺序错误会导致 id 不一致并报出）
  const n = Math.min(sourceScenes.length, remoteScenes.length);
  for (let i = 0; i < n; i++) {
    const s = sourceScenes[i];
    const r = remoteScenes[i];

    // 顺序：通过 id 是否对位体现
    report(
      s.id === r.id,
      `scene[${i}] 顺序/id 一致 (${s.id})`,
      `  expected: ${fmt(s.id)}\n  actual:   ${fmt(r.id)}\n  （顺序错位或 id 不一致）`
    );

    for (const field of COMPARE_FIELDS) {
      if (field === 'id') continue; // 上面已校验
      const ok = Object.is(s[field], r[field]);
      report(
        ok,
        `scene[${i}] ${s.id} .${field}`,
        `  expected: ${fmt(s[field])}\n  actual:   ${fmt(r[field])}`
      );
    }
  }

  // 3.3 汇总
  console.log('');
  console.log(`[verify] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[verify] round-trip 校验未通过：存在不一致字段（见上方 diff）');
    process.exit(1);
  }
  console.log('[verify] round-trip 校验通过：85 个 scene 全部字段一致 ✅');
}

main();
