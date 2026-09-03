import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiying-production-admission-'));
process.env.ZHIYING_DATA_DIR = dataDir;
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

let pass = 0;
let fail = 0;
function ok(condition: boolean, label: string): void {
  if (condition) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
  }
}
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

async function main(): Promise<void> {
  const {getDb, closeDb} = await import('../src/lib/db');
  const {createProjectWithWorkflow} = await import('../src/lib/projects');
  const {getCurrentApprovedNarrationScript, getCurrentNarrationPlan} = await import('../src/lib/narration/plan');
  const {registerApprovedNarrationProject, ProductionAdmissionError} = await import('../src/lib/production-admission');

  const generated = createProjectWithWorkflow({topic: 'existing-create', coreQuestion: 'q'}).project.id;
  ok(generated.length === 36, 'existing create path still generates UUID');
  const explicit = crypto.randomUUID();
  ok(createProjectWithWorkflow({topic: 'explicit-create', coreQuestion: 'q'}, {projectId: explicit}).project.id === explicit,
    'project service accepts explicit UUID');
  let collision = false;
  try {
    createProjectWithWorkflow({topic: 'collision', coreQuestion: 'q'}, {projectId: explicit});
  } catch {
    collision = true;
  }
  ok(collision, 'explicit project ID collision fails closed');

  const projectId = crypto.randomUUID();
  const scriptId = crypto.randomUUID();
  const approvalId = crypto.randomUUID();
  const definitionId = crypto.randomUUID();
  const researchId = crypto.randomUUID();
  const contentPlanId = crypto.randomUUID();
  const markdown = '# NARRATION_SCRIPT_V2\n\n## 第一章 测试\n\n第一句。第二句。\n\n第三句？\n';
  const plaintext = '第一句。第二句。\n\n第三句？\n';
  const plaintextSha256 = sha256(plaintext);
  const markdownSha256 = sha256(markdown);
  const base = {
    projectId,
    publicTitle: '测试公开标题',
    projectInput: {
      topic: '已审批项目', coreQuestion: '如何安全接入？', targetDuration: '10 分钟', language: 'zh-CN',
      platform: '通用 16:9', audience: '普通观众', videoStyle: '中文视频论文', visualStyle: '',
      scientificRigor: '高' as const, productionBaseline: 'INITIAL_PRODUCTION_BASELINE_V1' as const,
      workflowChannel: 'production' as const, experimentalOverride: null,
    },
    projectDefinition: {id: definitionId, version: 1, content: '# PROJECT_DEFINITION'},
    research: {id: researchId, version: 1, content: '# SOURCE_GROUNDED_RESEARCH'},
    contentNarrationPlan: {id: contentPlanId, version: 1, content: {
      projectId, status: 'PLANNING_ONLY', notTtsEligible: true,
    }},
    narrationScript: {id: scriptId, revision: 2, markdown, plaintext, plaintextSha256, markdownSha256, supersedes: null},
    approval: {id: approvalId, version: 1, content: {
      projectId, artifactId: scriptId, revision: 2, status: 'LOCKED', userApproved: true,
      ttsEligible: true, currentAuthority: true, plaintextSha256, markdownSha256,
      productionBaseline: 'INITIAL_PRODUCTION_BASELINE_V1', channel: 'production',
    }},
  };

  const first = registerApprovedNarrationProject(base);
  ok(first.projectId === projectId && first.reused === false, 'first explicit admission persists requested ID');
  const source = getCurrentApprovedNarrationScript(projectId);
  ok(source?.artifact.id === scriptId && source.plaintextSha256 === plaintextSha256,
    'append-only approval resolves exact script authority');
  const plan = getCurrentNarrationPlan(projectId);
  ok(plan?.plan.source.artifactId === scriptId && plan.plan.source.plaintextSha256 === plaintextSha256,
    'derived TTS plan points to approved V2 identity');
  const jobsBefore = (getDb().prepare('SELECT COUNT(*) count FROM tts_jobs WHERE project_id=?').get(projectId) as {count: number}).count;
  ok(plan !== null && jobsBefore === 0, 'standard TTS source resolves READY without enqueue');

  const countsBefore = {
    projects: (getDb().prepare('SELECT COUNT(*) count FROM projects WHERE id=?').get(projectId) as {count: number}).count,
    artifacts: (getDb().prepare('SELECT COUNT(*) count FROM artifacts WHERE project_id=?').get(projectId) as {count: number}).count,
  };
  const second = registerApprovedNarrationProject(base);
  const countsAfter = {
    projects: (getDb().prepare('SELECT COUNT(*) count FROM projects WHERE id=?').get(projectId) as {count: number}).count,
    artifacts: (getDb().prepare('SELECT COUNT(*) count FROM artifacts WHERE project_id=?').get(projectId) as {count: number}).count,
  };
  ok(second.reused === true && JSON.stringify(countsBefore) === JSON.stringify(countsAfter),
    'identical second admission is idempotent noop');

  let scriptConflict = false;
  const otherPlaintext = '不同正文。\n';
  const otherMarkdown = '# NARRATION_SCRIPT_V2\n\n## 第一章 测试\n\n不同正文。\n';
  try {
    registerApprovedNarrationProject({
      ...base,
      narrationScript: {...base.narrationScript, plaintext: otherPlaintext, markdown: otherMarkdown,
        plaintextSha256: sha256(otherPlaintext), markdownSha256: sha256(otherMarkdown)},
      approval: {...base.approval, content: {...base.approval.content,
        plaintextSha256: sha256(otherPlaintext), markdownSha256: sha256(otherMarkdown)}},
    });
  } catch (error) {
    scriptConflict = error instanceof ProductionAdmissionError && error.code === 'PROJECT_REGISTRATION_CONFLICT';
  }
  ok(scriptConflict, 'same ID with different script fails closed');

  let channelConflict = false;
  try {
    registerApprovedNarrationProject({
      ...base,
      projectInput: {...base.projectInput, workflowChannel: 'experimental', experimentalOverride: 'x'},
      approval: {...base.approval, content: {...base.approval.content, channel: 'experimental'}},
    });
  } catch {
    channelConflict = true;
  }
  ok(channelConflict, 'same ID with different channel fails closed');

  let baselineConflict = false;
  try {
    registerApprovedNarrationProject({
      ...base,
      projectInput: {...base.projectInput, productionBaseline: 'DIFFERENT_BASELINE'},
      approval: {...base.approval, content: {...base.approval.content, productionBaseline: 'DIFFERENT_BASELINE'}},
    } as never);
  } catch {
    baselineConflict = true;
  }
  ok(baselineConflict, 'same ID with different baseline fails closed');

  const atomicId = crypto.randomUUID();
  let invalidRejected = false;
  try {
    registerApprovedNarrationProject({...base, projectId: atomicId,
      contentNarrationPlan: {...base.contentNarrationPlan, content: {...base.contentNarrationPlan.content, projectId: atomicId}},
      narrationScript: {...base.narrationScript, markdown: markdown + '漂移', markdownSha256},
      approval: {...base.approval, content: {...base.approval.content, projectId: atomicId}},
    });
  } catch {
    invalidRejected = true;
  }
  const atomicRows = (getDb().prepare('SELECT COUNT(*) count FROM projects WHERE id=?').get(atomicId) as {count: number}).count;
  ok(invalidRejected && atomicRows === 0, 'invalid admission leaves no partial project');

  const rollbackId = crypto.randomUUID();
  const rollbackPlaintext = '没有章节的正文。\n';
  const rollbackMarkdown = '# NARRATION_SCRIPT_V2\n\n没有章节的正文。\n';
  const rollbackScriptId = crypto.randomUUID();
  const rollbackApprovalId = crypto.randomUUID();
  let compilerRejected = false;
  try {
    registerApprovedNarrationProject({
      ...base,
      projectId: rollbackId,
      projectDefinition: {...base.projectDefinition, id: crypto.randomUUID()},
      research: {...base.research, id: crypto.randomUUID()},
      contentNarrationPlan: {id: crypto.randomUUID(), version: 1, content: {
        projectId: rollbackId, status: 'PLANNING_ONLY', notTtsEligible: true,
      }},
      narrationScript: {
        ...base.narrationScript,
        id: rollbackScriptId,
        markdown: rollbackMarkdown,
        plaintext: rollbackPlaintext,
        plaintextSha256: sha256(rollbackPlaintext),
        markdownSha256: sha256(rollbackMarkdown),
      },
      approval: {id: rollbackApprovalId, version: 1, content: {
        ...base.approval.content,
        projectId: rollbackId,
        artifactId: rollbackScriptId,
        plaintextSha256: sha256(rollbackPlaintext),
        markdownSha256: sha256(rollbackMarkdown),
      }},
    });
  } catch {
    compilerRejected = true;
  }
  const rollbackCounts = {
    projects: (getDb().prepare('SELECT COUNT(*) count FROM projects WHERE id=?').get(rollbackId) as {count: number}).count,
    versions: (getDb().prepare('SELECT COUNT(*) count FROM project_versions WHERE project_id=?').get(rollbackId) as {count: number}).count,
    artifacts: (getDb().prepare('SELECT COUNT(*) count FROM artifacts WHERE project_id=?').get(rollbackId) as {count: number}).count,
  };
  ok(compilerRejected && Object.values(rollbackCounts).every((count) => count === 0),
    'compiler failure after inserts rolls back project, versions, and artifacts');

  closeDb();
  fs.rmSync(dataDir, {recursive: true, force: true});
  console.log(JSON.stringify({status: fail === 0 ? 'PASS' : 'FAIL', pass, fail}));
  if (fail > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
