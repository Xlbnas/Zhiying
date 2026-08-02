/**
 * GET /api/projects/[id]/visual-sequences/[artifactId] — exact candidate 详情（M7.3B）
 * 只读；跨项目/kind/非法 → 404。candidate only，不暗示任何 active 语义。
 */
import {
  classifyVisualSequencesCandidate,
  getVisualSequencesArtifact,
} from '@/lib/visual-sequences/classify';
import {getNarrativeBeatsArtifact} from '@/lib/narrative-beats/plan';
import {getVisualIntentArtifact} from '@/lib/visual-intent/plan';
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
  const ref = getVisualSequencesArtifact(id, artifactId);
  if (!ref) {
    return jsonError(404, 'visual_sequences_not_found', {message: 'visual sequences artifact 不存在/跨项目/契约非法'});
  }
  const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as never;
  const classified = classifyVisualSequencesCandidate(id, row);

  const beatsRef = getNarrativeBeatsArtifact(id, ref.visualSequences.source.narrativeBeatsArtifactId);
  const intentRef = getVisualIntentArtifact(id, ref.visualSequences.source.visualIntentPlanArtifactId);
  const beatById = new Map(beatsRef?.beats.beats.map((b) => [b.beatId, b] as const) ?? []);
  const intentById = new Map(intentRef?.visualIntent.intents.map((i) => [i.visualIntentId, i] as const) ?? []);
  const sequences = ref.visualSequences.sequences.map((seq) => ({
    ...seq,
    beatRange: {first: seq.beatIds[0], last: seq.beatIds[seq.beatIds.length - 1]},
    beatRoles: seq.beatIds.map((beatId) => beatById.get(beatId)?.role ?? null),
    intentKinds: seq.visualIntentIds.map((intentId) => intentById.get(intentId)?.intent ?? null),
  }));
  const unresolvedCount = sequences.filter((seq) =>
    seq.visualIntentIds.some((intentId) => intentById.get(intentId)?.intent === 'VISUAL_UNRESOLVED'),
  ).length;

  return Response.json({
    artifactId: ref.artifact.id,
    version: ref.artifact.version,
    createdAt: ref.artifact.created_at,
    candidateOnly: true,
    pipelineVersion: getPipelineVersion(id),
    m7PipelineSnapshotId: getM7PipelineSnapshotId(id),
    status: classified.status,
    statusReason: classified.statusReason,
    schemaVersion: ref.visualSequences.schemaVersion,
    compilerVersion: ref.visualSequences.compilerVersion,
    promptVersion: ref.visualSequences.promptVersion,
    source: ref.visualSequences.source,
    generation: ref.visualSequences.generation,
    sequenceCount: sequences.length,
    coverage: {
      beatTotal: beatsRef?.beats.beats.length ?? null,
      coveredBeatIds: beatsRef ? sequences.flatMap((s) => s.beatIds) : [],
    },
    unresolvedCount,
    sequences,
  });
}
