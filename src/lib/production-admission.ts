import crypto from 'node:crypto';
import {z} from 'zod';
import {getDb} from './db';
import {getProjectInput, projectInputSchema} from './project-inputs';
import {createProjectWithWorkflow, getProjectRow} from './projects';
import {
  buildApprovedNarrationPlan,
  getCurrentApprovedNarrationScript,
  getCurrentNarrationPlan,
} from './narration/plan';

export const PRODUCTION_ADMISSION_ARTIFACT_KIND = 'production_project_admission';

const authoritySchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  content: z.string().min(1),
});

const registrationSchema = z.object({
  projectId: z.string().uuid(),
  publicTitle: z.string().trim().min(1),
  projectInput: projectInputSchema,
  projectDefinition: authoritySchema,
  research: authoritySchema,
  contentNarrationPlan: z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    content: z.unknown(),
  }),
  narrationScript: z.object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    markdown: z.string().min(1),
    plaintext: z.string().min(1),
    plaintextSha256: z.string().regex(/^[0-9a-f]{64}$/),
    markdownSha256: z.string().regex(/^[0-9a-f]{64}$/),
    supersedes: z.string().min(1).nullable(),
  }),
  approval: z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    content: z.record(z.string(), z.unknown()),
  }),
});

export type ApprovedProductionRegistration = z.input<typeof registrationSchema>;

export class ProductionAdmissionError extends Error {
  constructor(
    public readonly code: 'PROJECT_REGISTRATION_CONFLICT' | 'AUTHORITY_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'ProductionAdmissionError';
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function markdownBody(markdown: string): string {
  return markdown.split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n');
}

function failAuthority(message: string): never {
  throw new ProductionAdmissionError('AUTHORITY_INVALID', message);
}

function conflict(message: string): never {
  throw new ProductionAdmissionError('PROJECT_REGISTRATION_CONFLICT', message);
}

export function registerApprovedNarrationProject(raw: ApprovedProductionRegistration): {
  projectId: string;
  registrationArtifactId: string;
  narrationPlanArtifactId: string;
  narrationPlanArtifactVersion: number;
  reused: boolean;
} {
  const input = registrationSchema.parse(raw);
  if (input.projectInput.workflowChannel !== 'production' ||
      input.projectInput.productionBaseline !== 'INITIAL_PRODUCTION_BASELINE_V1' ||
      input.projectInput.experimentalOverride !== null) {
    failAuthority('production admission 只接受 frozen baseline、production channel、无 experimental override');
  }
  if (sha256(input.narrationScript.plaintext) !== input.narrationScript.plaintextSha256) {
    failAuthority('narration plaintext SHA256 不匹配');
  }
  if (sha256(input.narrationScript.markdown) !== input.narrationScript.markdownSha256) {
    failAuthority('narration Markdown SHA256 不匹配');
  }
  if (markdownBody(input.narrationScript.markdown) !== input.narrationScript.plaintext) {
    failAuthority('narration Markdown 正文与 plaintext 不一致');
  }
  const contentPlan = input.contentNarrationPlan.content as Record<string, unknown>;
  if (contentPlan.projectId !== input.projectId || contentPlan.status !== 'PLANNING_ONLY' ||
      contentPlan.notTtsEligible !== true) {
    failAuthority('content narration plan 必须保持 PLANNING_ONLY/notTtsEligible');
  }
  const lock = input.approval.content;
  if (lock.projectId !== input.projectId || lock.artifactId !== input.narrationScript.id ||
      lock.revision !== input.narrationScript.revision || lock.status !== 'LOCKED' ||
      lock.userApproved !== true || lock.ttsEligible !== true || lock.currentAuthority !== true ||
      lock.plaintextSha256 !== input.narrationScript.plaintextSha256 ||
      lock.markdownSha256 !== input.narrationScript.markdownSha256 ||
      lock.productionBaseline !== input.projectInput.productionBaseline ||
      lock.channel !== input.projectInput.workflowChannel) {
    failAuthority('approval record 与 narration/project identity 不一致');
  }

  const registrationIdentity = {
    projectId: input.projectId,
    title: input.projectInput.topic,
    publicTitle: input.publicTitle,
    baseline: input.projectInput.productionBaseline,
    channel: input.projectInput.workflowChannel,
    projectDefinition: `${input.projectDefinition.id}@${input.projectDefinition.version}`,
    research: `${input.research.id}@${input.research.version}`,
    contentNarrationPlan: `${input.contentNarrationPlan.id}@${input.contentNarrationPlan.version}`,
    narrationScript: `${input.narrationScript.id}@${input.narrationScript.revision}`,
    approval: `${input.approval.id}@${input.approval.version}`,
    plaintextSha256: input.narrationScript.plaintextSha256,
  };
  const fingerprint = sha256(JSON.stringify(registrationIdentity));
  const db = getDb();
  const tx = db.transaction(() => {
    const existingProject = getProjectRow(input.projectId);
    if (existingProject) {
      const existing = db.prepare(
        `SELECT id, content_json FROM artifacts
         WHERE project_id = ? AND kind = ? ORDER BY version DESC LIMIT 1`,
      ).get(input.projectId, PRODUCTION_ADMISSION_ARTIFACT_KIND) as
        | {id: string; content_json: string}
        | undefined;
      const existingContent = existing ? JSON.parse(existing.content_json) as Record<string, unknown> : null;
      const storedInput = getProjectInput(input.projectId);
      if (!existing || existingContent?.fingerprint !== fingerprint ||
          existingProject.title !== input.projectInput.topic ||
          JSON.stringify(storedInput) !== JSON.stringify(input.projectInput)) {
        conflict(`project ID 已存在但 admission identity 不一致: ${input.projectId}`);
      }
      const source = getCurrentApprovedNarrationScript(input.projectId);
      const plan = getCurrentNarrationPlan(input.projectId);
      if (!source || !plan || source.artifact.id !== input.narrationScript.id ||
          plan.plan.source.admission !== 'approved_external_artifact' ||
          plan.plan.source.artifactId !== input.narrationScript.id ||
          plan.plan.source.plaintextSha256 !== input.narrationScript.plaintextSha256 ||
          plan.plan.source.approvalRecordId !== input.approval.id) {
        conflict(`project ID 已存在但 production source chain 不完整: ${input.projectId}`);
      }
      return {
        projectId: input.projectId,
        registrationArtifactId: existing.id,
        narrationPlanArtifactId: plan.artifact.id,
        narrationPlanArtifactVersion: plan.artifact.version,
        reused: true,
      };
    }

    createProjectWithWorkflow(input.projectInput, {projectId: input.projectId});
    const at = new Date().toISOString();
    const insertVersion = db.prepare(
      `INSERT INTO project_versions
       (id, project_id, stage, version, content, content_type, source, prompt_version, model, job_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, 'markdown', 'manual_edit', NULL, NULL, NULL, ?, ?)`,
    );
    insertVersion.run(input.projectDefinition.id, input.projectId, 'project_definition',
      input.projectDefinition.version, input.projectDefinition.content, 'production admission: existing approved authority', at);
    insertVersion.run(input.research.id, input.projectId, 'research',
      input.research.version, input.research.content, 'production admission: existing approved authority', at);
    const lockStage = db.prepare(
      `UPDATE project_stages SET status='locked', active_version=?, locked_version=?, updated_at=?
       WHERE project_id=? AND stage=?`,
    );
    lockStage.run(input.projectDefinition.version, input.projectDefinition.version, at, input.projectId, 'project_definition');
    lockStage.run(input.research.version, input.research.version, at, input.projectId, 'research');

    const insertArtifact = db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    );
    insertArtifact.run(input.contentNarrationPlan.id, input.projectId, 'canary_narration_plan_outline',
      input.contentNarrationPlan.version, JSON.stringify(input.contentNarrationPlan.content), at);
    insertArtifact.run(input.narrationScript.id, input.projectId, 'narration_script',
      input.narrationScript.revision, JSON.stringify({
        schemaVersion: 'narration-script@1.0',
        artifactType: 'narration_script',
        projectId: input.projectId,
        revision: input.narrationScript.revision,
        supersedes: input.narrationScript.supersedes,
        status: 'DRAFT_REVIEW_REQUIRED',
        ttsEligible: false,
        scriptLanguage: 'zh-CN',
        scriptText: input.narrationScript.plaintext,
        scriptTextSha256: input.narrationScript.plaintextSha256,
        markdownSha256: input.narrationScript.markdownSha256,
      }), at);
    insertArtifact.run(input.approval.id, input.projectId, 'narration_script_approval',
      input.approval.version, JSON.stringify({
        ...input.approval.content,
        approvedArtifact: `${input.narrationScript.id}@${input.narrationScript.revision}`,
        inputNarrationArtifact: `${input.narrationScript.id}@${input.narrationScript.revision}`,
        inputPlaintextSha256: input.narrationScript.plaintextSha256,
        artifactStateMechanism: 'append_only_approval_record',
      }), at);
    const registrationId = crypto.randomUUID();
    insertArtifact.run(registrationId, input.projectId, PRODUCTION_ADMISSION_ARTIFACT_KIND, 1,
      JSON.stringify({schemaVersion: 'production-project-admission@1.0', status: 'REGISTERED',
        ...registrationIdentity, fingerprint}), at);

    const plan = buildApprovedNarrationPlan(input.projectId, input.narrationScript.markdown);
    return {
      projectId: input.projectId,
      registrationArtifactId: registrationId,
      narrationPlanArtifactId: plan.artifact.id,
      narrationPlanArtifactVersion: plan.artifact.version,
      reused: false,
    };
  });
  return tx.immediate();
}
