/**
 * M5 Pilot 开场残留修复测试：
 * - Legacy M1 链路 buildFullCutProps → showPilotIntro=true（M1 输出不变）
 * - defaultProps（Studio 预览）→ showPilotIntro=true
 * - projectMetaSchema 接受缺省（workflow 项目无该字段也能解析）
 *
 * 用法：npx tsx scripts/test-m5-pilot-intro-gate.ts
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m5-pilot-gate');
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {buildFullCutProps} from '../src/app/api/_lib/shared';
import {projectMetaSchema} from '../src/lib/scene-schema';
import {zhiyingFullCutDefaultProps} from '../src/remotion/compositions/FullCutV1';

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

function main(): void {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m5-pilot-gate'), {recursive: true, force: true});
  const db = getDb();

  // 造一个 legacy 形态项目 + scenes artifact（buildFullCutProps 只依赖 artifact）
  const pid = 'pilot-gate-test';
  db.prepare(
    "INSERT INTO projects (id, title, mode, schema_version, template_version, composition_id, current_stage, created_at, updated_at) VALUES (?, ?, 'rigorous', '1.0', 'freud-mg-v1.0', 'ZhiyingFullCut', 'scenes', datetime('now'), datetime('now'))",
  ).run(pid, '残留测试');
  const scenesDoc = {
    schemaVersion: '1.0',
    templateVersion: 'freud-mg-v1.0',
    project: {title: '残留测试', durationSec: 6.5, durationInFrames: 195},
    chapterTiming: [{chapter: 1, title: '一', start: 0, end: 6.5}],
    scenes: [{
      id: 'S001', chapter: 1, chapterTitle: '一', start: 0, end: 6.5, duration: 6.5,
      startFrame: 0, durationInFrames: 195, category: 'Minimal', visualType: 'Minimal',
      template: null, sourceTemplate: null, narrationSummary: '摘要', description: '描述',
      notes: '', assetIds: [], licenseStatus: 'not-applicable',
      subtitlePosition: 'bottom', transitionIn: 'none', transitionOut: 'cut',
    }],
  };
  db.prepare(
    "INSERT INTO artifacts (id, project_id, kind, version, content_json, created_at) VALUES (?, ?, 'scenes', 1, ?, datetime('now'))",
  ).run('a1', pid, JSON.stringify(scenesDoc));

  const props = buildFullCutProps(pid, {showSubtitles: true});
  ok(props !== null, '[G01] legacy buildFullCutProps 返回 props');
  ok(
    props?.data.project.showPilotIntro === true,
    '[G02] Legacy M1 链路保留 Pilot 开场（showPilotIntro=true，M1 输出不变）',
    props?.data.project.showPilotIntro,
  );

  ok(
    zhiyingFullCutDefaultProps.data.project.showPilotIntro === true,
    '[G03] Studio defaultProps 保留 Pilot 开场（demo 预览不变）',
  );

  const parsed = projectMetaSchema.safeParse({
    title: 'x', durationSec: 1, durationInFrames: 30,
  });
  ok(
    parsed.success && parsed.data.showPilotIntro === undefined,
    '[G04] projectMetaSchema 缺省可解析（workflow 项目无该字段 = 无残留）',
  );

  closeDb();
  console.log(`\nM5 pilot-intro-gate: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main();
