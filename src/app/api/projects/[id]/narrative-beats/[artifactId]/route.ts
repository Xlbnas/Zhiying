/**
 * GET /api/projects/[id]/narrative-beats/[artifactId] — exact candidate 详情（M7.2）
 * 只读；跨项目/kind/非法 → 404。candidate only，不暗示任何 active 语义。
 */
import {
  classifyNarrativeBeatsCandidate,
  getNarrativeBeatsArtifact,
} from '@/lib/narrative-beats/plan';
import {getNarrationPlanV2Artifact} from '@/lib/narration/plan-v2';
import {getDb} from '@/lib/db';
import {getM7PipelineSnapshotId, getPipelineVersion} from '@/lib/pipeline-version';
import {getProject, jsonError} from '../../../../_lib/shared';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{id: string; artifactId: string}>},
): Promise<Response> {
  const {id, artifactId} = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }
  const ref = getNarrativeBeatsArtifact(id, artifactId);
  if (!ref) {
    return jsonError(404, 'beats_not_found', {message: 'narrative beats artifact 不存在/跨项目/契约非法'});
  }
  const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as never;
  const classified = classifyNarrativeBeatsCandidate(id, row);

  const sourceRef = getNarrationPlanV2Artifact(id, ref.beats.source.narrationPlanV2ArtifactId);
  const unitById = new Map(sourceRef?.plan.units.map((u) => [u.id, u] as const) ?? []);
  const beats = ref.beats.beats.map((beat) => {
    const units = beat.unitIds.map((unitId) => unitById.get(unitId));
    const speechCount = units.filter((u) => u?.kind === 'speech').length;
    const silenceCount = units.filter((u) => u?.kind === 'silence').length;
    return {
      ...beat,
      unitRange: {first: beat.unitIds[0], last: beat.unitIds[beat.unitIds.length - 1]},
      speechCount,
      silenceCount,
    };
  });

  return Response.json({
    artifactId: ref.artifact.id,
    version: ref.artifact.version,
    createdAt: ref.artifact.created_at,
    candidateOnly: true,
    pipelineVersion: getPipelineVersion(id),
    m7PipelineSnapshotId: getM7PipelineSnapshotId(id),
    status: classified.status,
    statusReason: classified.statusReason,
    schemaVersion: ref.beats.schemaVersion,
    compilerVersion: ref.beats.compilerVersion,
    promptVersion: ref.beats.promptVersion,
    source: ref.beats.source,
    generation: ref.beats.generation,
    beatCount: beats.length,
    coverage: {
      unitTotal: sourceRef?.plan.units.length ?? null,
      speechTotal: sourceRef?.plan.units.filter((u) => u.kind === 'speech').length ?? null,
      silenceTotal: sourceRef?.plan.units.filter((u) => u.kind === 'silence').length ?? null,
    },
    beats,
  });
}
