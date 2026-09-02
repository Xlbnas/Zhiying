/**
 * INITIAL_PRODUCTION_BASELINE_V1 接入回归：只读 manifest、默认项目路由、实验隔离、
 * clean-master 默认和 conformance fixture 登记；不执行 TTS 或 Render。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dataDir = path.join(root, 'data', 'test-production-baseline');
process.env.ZHIYING_DATA_DIR = dataDir;

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {getProjectInput} from '../src/lib/project-inputs';
import {
  assertProductionBaselineReference,
  INITIAL_PRODUCTION_BASELINE_RULES,
  INITIAL_PRODUCTION_BASELINE_V1,
  PRODUCTION_BASELINE_MANIFEST_PATH,
  ProductionBaselineError,
  resolveProductionRenderJobKind,
  resolveProductionSubtitleMode,
  resolveWorkflowBaseline,
} from '../src/lib/workflow/production-baseline';

let pass = 0;
let fail = 0;

function ok(condition: boolean, label: string, detail?: unknown): void {
  if (condition) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail));
  }
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main(): void {
  fs.rmSync(dataDir, {recursive: true, force: true});
  const manifestFile = path.join(root, PRODUCTION_BASELINE_MANIFEST_PATH);
  const manifestBefore = fs.readFileSync(manifestFile);
  const manifest = assertProductionBaselineReference();

  ok(manifest.id === INITIAL_PRODUCTION_BASELINE_V1, 'reference manifest baseline identity');
  ok(manifest.status === 'FROZEN_INITIAL_PRODUCTION', 'reference manifest frozen status');
  ok(manifest.freezeCommit === 'ffee9e9330de0d88c8b6318f855b24dcd677338a', 'reference manifest freeze commit');
  ok(manifest.renderer.commit === '511b8b26772fb87488b40943511504437e7f7865', 'reference manifest renderer commit');
  ok(manifest.tag === 'long-video-initial-production-v1', 'reference manifest tag');
  ok(manifest.formalRenderAttempt2.sha256 === '3f79bf4215964f2dbb35d64da61ebdee5a6a58e0aafaed61f53c47df2f865239', 'reference master SHA pinned');
  ok(manifest.conformanceFixture.role === 'CONFORMANCE_FIXTURE', 'conformance fixture registered');
  ok(manifest.review.p0 === 0 && manifest.review.p1 === 0, 'reference final review P0/P1 gate');

  const production = resolveWorkflowBaseline();
  ok(production.productionBaseline === INITIAL_PRODUCTION_BASELINE_V1 && production.channel === 'production', 'default production baseline resolution');
  ok(resolveProductionSubtitleMode() === 'none' && resolveProductionRenderJobKind() === 'no-subtitles' && INITIAL_PRODUCTION_BASELINE_RULES.cleanMaster.showSubtitles === false, 'clean master defaults to subtitleMode=none/no-subtitles');

  const project = createProjectWithWorkflow({topic: 'baseline route test', coreQuestion: 'which workflow is default?'});
  const projectInput = getProjectInput(project.project.id);
  ok(projectInput?.productionBaseline === INITIAL_PRODUCTION_BASELINE_V1, 'new project stores baseline identity');
  ok(projectInput?.workflowChannel === 'production' && projectInput.experimentalOverride === null, 'new project defaults to production channel');
  ok((getDb().prepare('SELECT COUNT(*) AS c FROM render_jobs WHERE project_id = ?').get(project.project.id) as {c: number}).c === 0, 'routing validation creates no render job');

  const experiment = resolveWorkflowBaseline({channel: 'experimental', experimentalOverride: 'dark-editorial-v1@3'});
  ok(experiment.basedOn === INITIAL_PRODUCTION_BASELINE_V1 && experiment.experimentalOverride === 'dark-editorial-v1@3', 'experimental route is explicit and based on baseline');
  try {
    resolveWorkflowBaseline({channel: 'production', experimentalOverride: 'unapproved'});
    ok(false, 'production rejects experimental override');
  } catch (err) {
    ok(err instanceof ProductionBaselineError && err.code === 'PRODUCTION_OVERRIDE_FORBIDDEN', 'production rejects experimental override');
  }

  ok(fs.readFileSync(manifestFile).equals(manifestBefore), 'reference manifest unchanged by routing');
  const masterFile = path.join(root, manifest.formalRenderAttempt2.localMasterPath);
  ok(!fs.existsSync(masterFile) || sha256(masterFile) === manifest.formalRenderAttempt2.sha256, 'frozen reference video SHA unchanged', {present: fs.existsSync(masterFile)});
  ok((getDb().prepare('SELECT COUNT(*) AS c FROM render_jobs').get() as {c: number}).c === 0, 'no full render created');

  closeDb();
  fs.rmSync(dataDir, {recursive: true, force: true});
  console.log(JSON.stringify({status: fail === 0 ? 'PASS' : 'FAIL', pass, fail}));
  if (fail > 0) process.exitCode = 1;
}

main();
