/**
 * GET /api/projects/[id]/visual-intents/[artifactId] — exact candidate 详情（M7.3A）
 * 只读；跨项目/kind/非法 → 404。candidate only，不暗示任何 active 语义。
 */
import {
  classifyVisualIntentCandidate,
  getVisualIntentArtifact,
} from '@/lib/visual-intent/plan';
import {getNarrativeBeatsArtifact} from '@/lib/narrative-beats/plan';
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
  const ref = getVisualIntentArtifact(id, artifactId);
  if (!ref) {
    return jsonError(404, 'visual_intent_not_found', {message: 'visual intent artifact 不存在/跨项目/契约非法'});
  }
  const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as never;
  const classified = classifyVisualIntentCandidate(id, row);

  const sourceRef = getNarrativeBeatsArtifact(id, ref.visualIntent.source.narrativeBeatsArtifactId);
  const beatById = new Map(sourceRef?.beats.beats.map((b) => [b.beatId, b] as const) ?? []);
  const intents = ref.visualIntent.intents.map((intent) => ({
    ...intent,
    beatRange: {first: intent.beatIds[0], last: intent.beatIds[intent.beatIds.length - 1]},
    beatRoles: intent.beatIds.map((beatId) => beatById.get(beatId)?.role ?? null),
  }));

  const countBy = <K extends string>(key: (i: (typeof intents)[number]) => K): Record<K, number> => {
    const acc = {} as Record<K, number>;
    for (const intent of intents) {
      const k = key(intent);
      acc[k] = (acc[k] ?? 0) + 1;
    }
    return acc;
  };

  return Response.json({
    artifactId: ref.artifact.id,
    version: ref.artifact.version,
    createdAt: ref.artifact.created_at,
    candidateOnly: true,
    pipelineVersion: getPipelineVersion(id),
    m7PipelineSnapshotId: getM7PipelineSnapshotId(id),
    status: classified.status,
    statusReason: classified.statusReason,
    schemaVersion: ref.visualIntent.schemaVersion,
    compilerVersion: ref.visualIntent.compilerVersion,
    promptVersion: ref.visualIntent.promptVersion,
    source: ref.visualIntent.source,
    generation: ref.visualIntent.generation,
    intentCount: intents.length,
    coverage: {
      beatTotal: sourceRef?.beats.beats.length ?? null,
      coveredBeatIds: sourceRef ? intents.flatMap((i) => i.beatIds) : [],
    },
    unresolvedCount: intents.filter((i) => i.intent === 'VISUAL_UNRESOLVED').length,
    titleCardCount: intents.filter((i) => i.intent === 'EMPHASIZE_TEXT').length,
    continuationCount: intents.filter(
      (i) => i.intent === 'CONTINUE_PREVIOUS_VISUAL' || i.intent === 'NO_VISUAL_CHANGE',
    ).length,
    distributions: {
      intent: countBy((i) => i.intent),
      strategy: countBy((i) => i.strategy),
      authenticity: countBy((i) => i.authenticity),
    },
    intents,
  });
}
