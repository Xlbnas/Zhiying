import fs from 'node:fs';
import path from 'node:path';
import {getDb} from '../src/lib/db';
import {getCurrentApprovedNarrationScript, getCurrentNarrationPlan} from '../src/lib/narration/plan';
import {registerApprovedNarrationProject} from '../src/lib/production-admission';
import {getTtsProvider} from '../src/lib/tts';
import {resolveRequestedVoice} from '../src/lib/tts/voice-registry';

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

function field(markdown: string, name: string): string {
  const match = markdown.match(new RegExp('^- ' + name + ': `([^`]+)`$', 'm'));
  if (!match) throw new Error(`project-definition 缺少 ${name}`);
  return match[1]!;
}

async function main(): Promise<void> {
  const reportDir = path.resolve(arg('report-dir'));
  const read = (name: string) => fs.readFileSync(path.join(reportDir, name), 'utf8');
  const definition = read('project-definition.md');
  const research = read('source-grounded-research.md');
  const contentPlan = JSON.parse(read('narration-plan.json')) as Record<string, unknown>;
  const markdown = read('narration-script-v2.md');
  const plaintext = read('narration-script-v2.txt');
  const lock = JSON.parse(read('narration-script-v2-lock.json')) as Record<string, unknown>;
  if (lock.productionBaseline !== 'INITIAL_PRODUCTION_BASELINE_V1' || lock.channel !== 'production') {
    throw new Error('lock manifest baseline/channel 不受 production admission 支持');
  }
  const db = getDb();
  const beforeJobs = (db.prepare('SELECT COUNT(*) AS count FROM tts_jobs WHERE project_id=?')
    .get(lock.projectId) as {count: number}).count;

  const registration = registerApprovedNarrationProject({
    projectId: String(lock.projectId),
    publicTitle: field(definition, 'public_title'),
    projectInput: {
      topic: field(definition, 'working_title'),
      coreQuestion: field(definition, 'core_question'),
      targetDuration: '10 分钟',
      language: field(definition, 'language'),
      platform: field(definition, 'platform'),
      audience: field(definition, 'audience'),
      videoStyle: '中文视频论文',
      visualStyle: '',
      scientificRigor: '高',
      productionBaseline: 'INITIAL_PRODUCTION_BASELINE_V1',
      workflowChannel: 'production',
      experimentalOverride: null,
    },
    projectDefinition: {
      id: String(lock.upstreamProjectDefinition).split('@')[0]!,
      version: Number(String(lock.upstreamProjectDefinition).split('@')[1]),
      content: definition,
    },
    research: {
      id: String(lock.upstreamResearch).split('@')[0]!,
      version: Number(String(lock.upstreamResearch).split('@')[1]),
      content: research,
    },
    contentNarrationPlan: {
      id: String(lock.upstreamNarrationPlan).split('@')[0]!,
      version: Number(String(lock.upstreamNarrationPlan).split('@')[1]),
      content: contentPlan,
    },
    narrationScript: {
      id: String(lock.artifactId),
      revision: Number(lock.revision),
      markdown,
      plaintext,
      plaintextSha256: String(lock.plaintextSha256),
      markdownSha256: String(lock.markdownSha256),
      supersedes: typeof lock.supersedes === 'string' ? lock.supersedes : null,
    },
    approval: {id: String(lock.lockRecordId), version: 1, content: lock},
  });

  const source = getCurrentApprovedNarrationScript(String(lock.projectId));
  const plan = getCurrentNarrationPlan(String(lock.projectId));
  const voice = resolveRequestedVoice('xlbnas@1');
  const provider = getTtsProvider();
  const health = provider.health ? await provider.health() : null;
  const afterJobs = (db.prepare('SELECT COUNT(*) AS count FROM tts_jobs WHERE project_id=?')
    .get(lock.projectId) as {count: number}).count;
  if (!source || !plan || plan.artifact.id !== registration.narrationPlanArtifactId ||
      beforeJobs !== afterJobs) throw new Error('PRODUCTION_ADMISSION_POSTCONDITION_FAILED');

  console.log(JSON.stringify({
    ok: true,
    registration,
    source: {
      artifact: `${source.artifact.id}@${source.revision}`,
      approval: `${source.approval.id}@${source.approval.version}`,
      plaintextSha256: source.plaintextSha256,
    },
    narrationPlan: {
      artifact: `${plan.artifact.id}@${plan.artifact.version}`,
      role: 'TTS_EXECUTION_PLAN',
      source: plan.plan.source,
      units: plan.plan.units.length,
      speechUnits: plan.plan.units.filter((unit) => unit.kind === 'speech').length,
    },
    ttsDryResolution: {
      provider: provider.name,
      providerHealth: health,
      voice: `${voice.id}@${voice.revision}`,
      referenceSha256: voice.referenceSha256,
      jobsBefore: beforeJobs,
      jobsAfter: afterJobs,
      requestSent: false,
      sourceReady: true,
    },
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
