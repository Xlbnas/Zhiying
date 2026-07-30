/**
 * M6.3.1.3 Narration Speech Text Sanitation 测试（零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m6313-narration.ts
 * 纯函数 + compiler 端到端断言，不触数据库、不需要临时数据目录。
 * 任一断言失败即非零退出。
 */

import {compileNarrationPlan} from '../src/lib/narration/compiler';
import type {NarrationPlan} from '../src/lib/narration/schema';
import {
  containsMeaningfulSpeechCharacters,
  isSpeakableText,
  sanitizeSpeechText,
} from '../src/lib/narration/speech-text';

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

function compile(md: string): NarrationPlan {
  return compileNarrationPlan({
    scriptV2Markdown: md,
    scriptV2Version: 1,
    promptVersion: 'script-v2@1.0',
  });
}

function speechTexts(plan: NarrationPlan): string[] {
  return plan.units.filter((u) => u.kind === 'speech').map((u) => u.text ?? '');
}

function main(): void {
  // ============ containsMeaningfulSpeechCharacters ============
  ok(containsMeaningfulSpeechCharacters('口播'), '[C1] CJK 表意文字 → true');
  ok(containsMeaningfulSpeechCharacters('abc'), '[C2] 英文字母 → true');
  ok(containsMeaningfulSpeechCharacters('123'), '[C3] 数字 → true');
  ok(!containsMeaningfulSpeechCharacters('---'), '[C4] 纯分隔符 → false');
  ok(!containsMeaningfulSpeechCharacters('。！？；…'), '[C5] 纯标点 → false');
  ok(!containsMeaningfulSpeechCharacters(''), '[C6] 空串 → false');

  // ============ sanitizeSpeechText ============
  const sanitizeCases: Array<[string, string, string]> = [
    ['---', '', '整行 ---'],
    [' *** ', '', '整行 ***'],
    ['___', '', '整行 ___'],
    ['- - -', '', '含空白变体 - - -'],
    ['* * *', '', '含空白变体 * * *'],
    ['<!-- none -->', '', 'HTML 注释'],
    ['第一句。\n---\n第二句。', '第一句。 第二句。', '段内独立行 --- 剥离'],
    ['--- 第二句。', '第二句。', '句首分隔符 run 剥离'],
    ['句子。 - - - 下一句。', '句子。 下一句。', '句中分隔符 run 剥离'],
    ['2026-07-30', '2026-07-30', '日期连字符原样保留'],
    ['AI-driven 工作流', 'AI-driven 工作流', 'AI-driven 连字符原样保留'],
    ['**加粗**保留', '**加粗**保留', '双星号强调不误伤'],
    ['<!-- a --><!-- b -->正文。', '正文。', '连续 HTML 注释'],
  ];
  sanitizeCases.forEach(([input, expected, label], i) => {
    ok(sanitizeSpeechText(input) === expected, `[S${i + 1}] sanitize：${label}`, {
      input,
      got: sanitizeSpeechText(input),
    });
  });

  // ============ isSpeakableText ============
  const unspeakable = ['---', ' *** ', '___', '<!-- none -->', '……', '。！？', '   ', ''];
  unspeakable.forEach((text, i) => {
    ok(!isSpeakableText(text), `[U${i + 1}] 不可朗读：${JSON.stringify(text)}`);
  });
  const speakable = ['这是正常口播。', '2026-07-30', 'AI-driven 工作流'];
  speakable.forEach((text, i) => {
    ok(isSpeakableText(text), `[K${i + 1}] 可朗读：${JSON.stringify(text)}`);
  });

  // ============ Compiler 端到端：章节间 + 段内混合 horizontal rule ============
  const MD = `# Script V2

> 与 V1 差异说明：压缩书面语，零新增事实。

## 第 1 章 开场（00:00–01:00）

开场第一句。开场第二句。

---

## 第 2 章 深入（01:00–02:00）

段内第一句。
---
段内第二句。段内第三句。
`;
  const plan = compile(MD);
  const speeches = speechTexts(plan);

  ok(
    !plan.units.some((u) => u.kind === 'speech' && (u.text ?? '').includes('---')),
    '[E1] 不产生 text 含 --- 的 speech unit',
    speeches,
  );
  ok(
    !plan.units.some((u) => u.kind === 'speech' && !isSpeakableText(u.text ?? '')),
    '[E2] 全部 speech unit 均可朗读',
    speeches,
  );
  ok(
    speeches.includes('开场第一句。开场第二句。'),
    '[E3] 章节间 --- 不影响第 1 章合法句',
    speeches,
  );
  ok(
    speeches.includes('段内第一句。段内第二句。'),
    '[E4] 段内 --- 只剔除分隔符，同段合法句保留（前两句聚组）',
    speeches,
  );
  ok(
    speeches.includes('段内第三句。'),
    '[E5] 段内第三句独立成组保留',
    speeches,
  );
  ok(
    plan.units.every((u, i) => u.id === `N${String(i + 1).padStart(3, '0')}`),
    '[E6] 过滤后 unit 编号仍连续 N001…N00N',
    plan.units.map((u) => u.id),
  );
  ok(
    plan.chapters.every((c) => c.firstUnitId !== null && c.lastUnitId !== null),
    '[E7] 每章 first/lastUnitId 均有效（无空章）',
    plan.chapters,
  );
  ok(
    JSON.stringify(compile(MD)) === JSON.stringify(plan),
    '[E8] 含 --- 的脚本编译仍 deterministic（字节级一致）',
  );

  // 只有分隔符的章节正文 → 不产生 speech unit，但 plan 仍合法（该章无 unit）
  const separatorOnly = compile(
    `# Script V2\n\n## 第 1 章 分隔（00:00–01:00）\n\n---\n\n## 第 2 章 正文（01:00–02:00）\n\n正常句子。\n`,
  );
  ok(
    separatorOnly.units.length === 1 &&
      separatorOnly.units[0]!.kind === 'speech' &&
      separatorOnly.units[0]!.text === '正常句子。',
    '[E9] 分隔符独占的章不产生任何 unit，后续章正常',
    separatorOnly.units,
  );

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M6.3.1.3 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M6.3.1.3 Narration Sanitation 测试全部通过 ✅');
}

main();
