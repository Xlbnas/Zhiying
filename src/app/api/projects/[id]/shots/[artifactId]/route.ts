/**
 * GET /api/projects/[id]/shots/[artifactId] — exact candidate 详情（M7.3B）
 * 只读；跨项目/kind/非法 → 404。candidate only，不暗示任何 active 语义。
 */
import {classifyShotsCandidate, getShotsArtifact} from '@/lib/shots/classify';
import {getVisualSequencesArtifact} from '@/lib/visual-sequences/classify';
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
  const ref = getShotsArtifact(id, artifactId);
  if (!ref) {
    return jsonError(404, 'shots_not_found', {message: 'shots artifact 不存在/跨项目/契约非法'});
  }
  const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as never;
  const classified = classifyShotsCandidate(id, row);

  const seqRef = getVisualSequencesArtifact(id, ref.shots.source.visualSequencesArtifactId);
  const narrationRef = getNarrationPlanV2Artifact(id, ref.shots.source.narrationPlanV2ArtifactId);
  const unitById = new Map(narrationRef?.plan.units.map((u) => [u.id, u] as const) ?? []);
  const unitKinds = new Map<string, 'speech' | 'silence'>();
  for (const unit of narrationRef?.plan.units ?? []) {
    unitKinds.set(unit.id, unit.kind);
  }
  const shots = ref.shots.shots.map((shot) => ({
    ...shot,
    unitRange: {first: shot.unitIds[0], last: shot.unitIds[shot.unitIds.length - 1]},
    unitKinds: shot.unitIds.map((unitId) => unitKinds.get(unitId) ?? null),
    unitChapters: shot.unitIds.map((unitId) => unitById.get(unitId)?.chapter ?? null),
  }));
  const transitionDistribution: Record<string, number> = {};
  for (const shot of shots) {
    transitionDistribution[shot.transitionFromPrevious] =
      (transitionDistribution[shot.transitionFromPrevious] ?? 0) + 1;
  }

  return Response.json({
    artifactId: ref.artifact.id,
    version: ref.artifact.version,
    createdAt: ref.artifact.created_at,
    candidateOnly: true,
    pipelineVersion: getPipelineVersion(id),
    m7PipelineSnapshotId: getM7PipelineSnapshotId(id),
    status: classified.status,
    statusReason: classified.statusReason,
    schemaVersion: ref.shots.schemaVersion,
    compilerVersion: ref.shots.compilerVersion,
    promptVersion: ref.shots.promptVersion,
    source: ref.shots.source,
    generation: ref.shots.generation,
    shotCount: shots.length,
    coverage: {
      sequenceTotal: seqRef?.visualSequences.sequences.length ?? null,
      unitTotal: narrationRef?.plan.units.length ?? null,
      coveredUnitIds: narrationRef ? shots.flatMap((s) => s.unitIds) : [],
    },
    transitionDistribution,
    shots,
  });
}
