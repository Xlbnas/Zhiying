/**
 * M7.1 Compiler V2 测试（零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m71-compiler.ts
 * 覆盖：strict DSL、legacy production 真实指令语料、正常语义不误杀、
 * hard fail 路径、needsReview 分类、deterministic。任一断言失败即非零退出。
 */

import {compileNarrationPlanV2, NarrationV2CompileError} from '../src/lib/narration/compiler-v2';
import type {NarrationPlanV2} from '../src/lib/narration/schema-v2';
import {findDirectiveLeakage, isDirectiveBracketContent} from '../src/lib/narration/leakage';

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

function compile(md: string, mode: 'strict' | 'legacy'): NarrationPlanV2 {
  return compileNarrationPlanV2({
    scriptV2Markdown: md,
    scriptV2VersionId: 'test-version-id',
    scriptV2Version: 1,
    scriptV2PromptVersion: mode === 'strict' ? 'script-v2@2.0' : 'script-v2@1.0',
    inputMode: mode,
  });
}

function expectHardFail(md: string, mode: 'strict' | 'legacy', label: string): void {
  try {
    compile(md, mode);
    ok(false, label, '编译意外成功（应 hard fail）');
  } catch (err) {
    ok(err instanceof NarrationV2CompileError, label, err instanceof Error ? err.message : err);
  }
}

function speechTexts(plan: NarrationPlanV2): string[] {
  return plan.units.filter((u) => u.kind === 'speech').map((u) => u.spokenText);
}

function totalLeakage(plan: NarrationPlanV2): number {
  let n = 0;
  for (const u of plan.units) {
    if (u.kind === 'speech') {
      n += findDirectiveLeakage(u.spokenText).length;
      if (u.subtitleText !== null) n += findDirectiveLeakage(u.subtitleText).length;
    }
  }
  return n;
}

function main(): void {
  // ============ strict DSL：基本编译 ============
  const DSL = `# Script V2

> 差异说明：压缩书面语。

## 第 1 章 冰山（00:00–01:00）

@delivery slow
真正庞大的部分，沉在黑暗海底的，是潜意识。它决定了我们的选择。
@pause 500ms
水面上的，只是冰山一角。意识，前意识，潜意识。
@silence 1200ms reason=visual_breath
@delivery normal
我们回到问题本身。为什么今天还谈弗洛伊德？
`;
  const dsl = compile(DSL, 'strict');
  const dslSpeech = dsl.units.filter((u) => u.kind === 'speech');
  const dslSilence = dsl.units.filter((u) => u.kind === 'silence');
  ok(dsl.units.length === 5, '[D1] strict DSL unit 总数=5（3 speech + 2 silence）', dsl.units.map((u) => [u.id, u.kind]));
  ok(dslSilence.length === 2 && dslSilence[0]!.durationMs === 500 && dslSilence[0]!.reason === 'pause', '[D2] @pause 500ms → silence/pause/500ms');
  ok(dslSilence[1]!.durationMs === 1200 && dslSilence[1]!.reason === 'visual_breath', '[D3] @silence 1200ms reason=visual_breath');
  ok(dslSpeech[0]!.delivery === 'slow', '[D4] @delivery slow 作用于后续 speech');
  ok(dslSpeech[dslSpeech.length - 1]!.delivery === 'normal', '[D5] @delivery normal 重置');
  ok(dsl.needsReview.length === 0, '[D6] 合法 DSL needsReview=0');
  ok(totalLeakage(dsl) === 0, '[D7] 合法 DSL 输出 leakage=0');
  ok(JSON.stringify(compile(DSL, 'strict')) === JSON.stringify(dsl), '[D8] strict 编译 deterministic');
  ok(dsl.units.every((u, i) => u.id === `N${String(i + 1).padStart(3, '0')}`), '[D9] unit ID 连续 N001…');
  ok(dsl.chapters[0]!.firstUnitId === 'N001' && dsl.chapters[0]!.lastUnitId === 'N005', '[D10] chapter first/last 引用一致（含 silence）');
  ok(dsl.source.scriptV2ContentHash.startsWith('sha256:'), '[D11] provenance 含 contentHash');

  // @pause 1s / 0.5秒 变体
  const dslVariants = compile(
    `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n第一句。\n@pause 1s\n第二句。\n@pause 0.5秒\n第三句。\n@silence 2s\n第四句。\n`,
    'strict',
  );
  const vSilence = dslVariants.units.filter((u) => u.kind === 'silence');
  ok(
    vSilence.length === 3 && vSilence[0]!.durationMs === 1000 && vSilence[1]!.durationMs === 500 && vSilence[2]!.durationMs === 2000,
    '[D12] @pause 1s/0.5秒/@silence 2s 时长解析',
    vSilence.map((u) => u.durationMs),
  );

  // strict hard fail：未知 @directive
  expectHardFail(
    `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n第一句。\n@fade 300ms\n第二句。\n`,
    'strict',
    '[D13] 未知 @directive → hard fail',
  );
  // strict hard fail：正文混入旧括号指令
  expectHardFail(
    `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n（停顿 0.5s，放缓）第一句。\n`,
    'strict',
    '[D14] strict 正文混入（停顿 0.5s，放缓）→ hard fail',
  );
  // strict hard fail：旁白：前缀
  expectHardFail(
    `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n旁白：第一句。\n`,
    'strict',
    '[D15] strict 正文「旁白：」→ hard fail',
  );
  // strict hard fail：horizontal rule
  expectHardFail(
    `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n第一句。\n\n---\n\n第二句。\n`,
    'strict',
    '[D16] strict 正文 --- → hard fail',
  );
  // strict hard fail：非法时长
  expectHardFail(
    `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n第一句。\n@pause -3s\n第二句。\n`,
    'strict',
    '[D17] @pause 负数 → hard fail',
  );
  expectHardFail(
    `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n第一句。\n@pause 999s\n第二句。\n`,
    'strict',
    '[D18] @pause 超上限 → hard fail',
  );

  // ============ legacy：production 真实指令语料 ============
  // 语料来源：production DB 两项目 script_v2 locked 内容实测提取
  const corpus: Array<{md: string; expectSilenceMs?: number; expectDelivery?: string; expectReview?: string; label: string}> = [
    {md: '（停顿 0.5s）第一句。', expectSilenceMs: 500, label: '（停顿 0.5s）'},
    {md: '（停顿 1s）第一句。', expectSilenceMs: 1000, label: '（停顿 1s）'},
    {md: '（停顿 0.8s）第一句。', expectSilenceMs: 800, label: '（停顿 0.8s）'},
    {md: '（停顿 1.5s）第一句。', expectSilenceMs: 1500, label: '（停顿 1.5s）'},
    {md: '（停顿 0.5s，放缓）第一句。', expectSilenceMs: 500, expectDelivery: 'slow', label: '复合（停顿 0.5s，放缓）'},
    {md: '（停顿 1s，放缓）第一句。', expectSilenceMs: 1000, expectDelivery: 'slow', label: '复合（停顿 1s，放缓）'},
    {md: '（停顿 0.8s，放缓）第一句。', expectSilenceMs: 800, expectDelivery: 'slow', label: '复合（停顿 0.8s，放缓）'},
    {md: '（放缓）第一句。', expectDelivery: 'slow', label: '（放缓）'},
    {md: '（放慢）第一句。', expectDelivery: 'slow', label: '（放慢）'},
    {md: '（稍快）第一句。', expectDelivery: 'fast', label: '（稍快）'},
    {md: '（加重）第一句。', expectDelivery: 'emphasis', label: '（加重）'},
    {md: '（停顿）第一句。', expectReview: 'pause_without_duration', label: '（停顿）无时长 → needsReview'},
    {md: '[画面留白]\n第一句。', expectReview: 'visual_breath_without_duration', label: '[画面留白] → needsReview'},
    {md: '旁白无\n第一句。', expectReview: 'no_narration_without_duration', label: '旁白无 → needsReview'},
    {md: '停顿后旁白：第一句。', expectReview: 'pause_without_duration', label: '停顿后旁白：→ review + 正文保留'},
    {md: '画面：一张旧照片。\n第一句。', expectReview: 'visual_directive', label: '画面：→ needsReview'},
    {md: '（停顿1s，等待答案的悬念）第一句。', expectSilenceMs: 1000, expectReview: 'unknown_directive', label: '（停顿1s，等待答案的悬念）→ silence + unknown review'},
  ];
  corpus.forEach((c, i) => {
    const plan = compile(`# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n${c.md}\n`, 'legacy');
    const silences = plan.units.filter((u) => u.kind === 'silence');
    const speeches = plan.units.filter((u) => u.kind === 'speech');
    if (c.expectSilenceMs !== undefined) {
      ok(
        silences.length === 1 && silences[0]!.durationMs === c.expectSilenceMs,
        `[L${i + 1}a] ${c.label}：silence=${c.expectSilenceMs}ms`,
        silences.map((u) => u.durationMs),
      );
    }
    if (c.expectDelivery !== undefined) {
      ok(
        speeches.length > 0 && speeches[0]!.delivery === c.expectDelivery,
        `[L${i + 1}b] ${c.label}：delivery=${c.expectDelivery}`,
        speeches.map((u) => u.delivery),
      );
    }
    if (c.expectReview !== undefined) {
      ok(
        plan.needsReview.some((r) => r.kind === c.expectReview),
        `[L${i + 1}c] ${c.label}：needsReview 含 ${c.expectReview}`,
        plan.needsReview.map((r) => r.kind),
      );
    }
    ok(totalLeakage(plan) === 0, `[L${i + 1}d] ${c.label}：输出 leakage=0`);
  });

  // --- 与 【脚本结束】：明确 metadata，剔除且不产生 review
  const mdSeparators = `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n第一句。\n\n---\n\n第二句。\n\n--- *【脚本结束】*\n`;
  const sep = compile(mdSeparators, 'legacy');
  ok(sep.units.every((u) => u.kind === 'speech'), '[M1] --- / 【脚本结束】不产生 unit', sep.units.map((u) => [u.id, u.kind]));
  ok(sep.needsReview.length === 0, '[M2] --- / 【脚本结束】不产生 needsReview');
  ok(totalLeakage(sep) === 0, '[M3] --- / 【脚本结束】输出 leakage=0');

  // 正常语义不误杀
  const mdSemantic = `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n谈话中出现了短暂停顿。这不是指令。他制造了悬念，观众等待答案。\n`;
  const sem = compile(mdSemantic, 'legacy');
  ok(sem.needsReview.length === 0, '[M4] 正常语义「停顿/悬念/等待答案」零误杀', sem.needsReview);
  ok(
    sem.units.filter((u) => u.kind === 'speech').length === 2 &&
      sem.units.filter((u) => u.kind === 'speech').map((u) => u.spokenText).join('').includes('谈话中出现了短暂停顿。'),
    '[M5] 正常语义全部保留为 speech（3 句 → 2 units，无丢失）',
    sem.units.map((u) => [u.id, u.kind]),
  );
  ok(totalLeakage(sem) === 0, '[M6] 正常语义输出 leakage=0');

  // 普通括号（非指令）保留为文本
  const mdParen = `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n潜意识（即冰山之下的部分）决定行为。\n`;
  const paren = compile(mdParen, 'legacy');
  ok(
    paren.units.filter((u) => u.kind === 'speech')[0]?.spokenText.includes('（即冰山之下的部分）') === true,
    '[M7] 普通括号（即…）保留为 speech 文本',
    speechTexts(paren),
  );
  ok(paren.needsReview.length === 0, '[M8] 普通括号不产生 needsReview');

  // 未知括号指令 → needsReview，绝不进 speech
  const mdUnknown = `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n（渐强读出来）第一句。\n`;
  const unk = compile(mdUnknown, 'legacy');
  ok(unk.needsReview.some((r) => r.kind === 'unknown_directive'), '[M9] 未知括号指令 → needsReview', unk.needsReview);
  ok(!speechTexts(unk).some((t) => t.includes('渐强')), '[M10] 未知括号指令不进 speech', speechTexts(unk));

  // 非法时长 → needsReview（legacy 不 hard fail）
  const mdBadDur = `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n（停顿 99秒）第一句。\n`;
  const badDur = compile(mdBadDur, 'legacy');
  ok(badDur.needsReview.some((r) => r.kind === 'invalid_directive'), '[M11] 超上限时长 → invalid_directive review', badDur.needsReview);
  ok(badDur.units.filter((u) => u.kind === 'silence').length === 0, '[M12] 非法时长不产生 silence unit');

  // directive 与正文混排：指令剥离、正文保留
  const mdMixed = `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n他曾经以为记忆可以捞起来。（停顿 0.5s，放缓）真正庞大的部分，沉在黑暗海底。\n`;
  const mixed = compile(mdMixed, 'legacy');
  const mixedSpeech = speechTexts(mixed);
  ok(
    mixedSpeech.some((t) => t.includes('他曾经以为记忆可以捞起来。')) &&
      mixedSpeech.some((t) => t.includes('真正庞大的部分，沉在黑暗海底。')),
    '[M13] 混排：指令两侧正文都保留为 speech',
    mixedSpeech,
  );
  ok(mixed.units.some((u) => u.kind === 'silence' && u.durationMs === 500), '[M14] 混排：复合指令 → silence 500ms');
  ok(totalLeakage(mixed) === 0, '[M15] 混排：输出 leakage=0');

  // evidence 注释
  const mdEvidence = `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n第一句。<!-- E01, E03 -->\n第二句。\n`;
  const ev = compile(mdEvidence, 'legacy');
  const evSpeech = ev.units.filter((u) => u.kind === 'speech');
  ok(evSpeech[0]!.evidenceIds.join(',') === 'E01,E03', '[M16] evidence 注释归属 speech', evSpeech.map((u) => u.evidenceIds));
  ok(!speechTexts(ev).some((t) => t.includes('<!--')), '[M17] evidence 注释不进 speech 文本');

  // 空 speech 不产生（纯指令段落）
  const mdOnlyDirective = `# Script V2\n\n## 第 1 章 T（00:00–01:00）\n\n（停顿 1s）\n\n## 第 2 章 T2（01:00–02:00）\n\n第二句。\n`;
  const onlyDir = compile(mdOnlyDirective, 'legacy');
  ok(!onlyDir.units.some((u) => u.kind === 'speech' && u.spokenText.trim().length === 0), '[M18] 不产生空 speech unit');

  // legacy deterministic
  ok(
    JSON.stringify(compile(mdMixed, 'legacy')) === JSON.stringify(mixed),
    '[M19] legacy 编译 deterministic',
  );

  // isDirectiveBracketContent 单元断言
  ok(isDirectiveBracketContent('停顿 0.5s，放缓'), '[N1] bracket grammar：复合指令');
  ok(isDirectiveBracketContent('停顿1s，等待答案的悬念'), '[N2] bracket：含指令词的未知项');
  ok(!isDirectiveBracketContent('即冰山之下的部分'), '[N3] 普通括号非指令');
  ok(!isDirectiveBracketContent('2026 年 7 月'), '[N4] 数字括号非指令');

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M7.1 compiler 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M7.1 Compiler V2 测试全部通过 ✅');
}

main();
