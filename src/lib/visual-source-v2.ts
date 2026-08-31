import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {getDb} from './db';
import {
  getExactNarrationAudioV2Artifact,
  type NarrationAudioV2Artifact,
} from './narration/audio-v2';
import {getNarrationPlanV2Artifact} from './narration/plan-v2';
import {scenesAiOutputSchema, type ScenesAiOutput} from './prompts/scenes';
import {resolvedAssetSchema, type ResolvedAsset} from './scene-schema';
import {getActiveBinding, getAssetById, insertAsset, listAssetsForProject, type AssetRow} from './assets/model';
import {buildAssetMap, evaluateVisualReadiness} from './assets/readiness';
import {buildSceneAssetPlan} from './assets/requirements';
import {
  getExactSubtitleTimingV2Artifact,
  type SubtitleTimingV2Artifact,
} from './subtitles/timing-v2';
import {validateScenesSemantics} from './workflow/scenes-semantic-validation';
import v2VisualR2Choreography from '../data/v2-visual-r2-choreography-plan.json';
import r3aHistoricalAssets from '../data/r3a-historical-assets.json';

export const VISUAL_SOURCE_V2_ARTIFACT_KIND = 'visual_source_v2';
export const VISUAL_SOURCE_V2_SCHEMA_VERSION = 'visual-source@2.0';
export const VISUAL_SOURCE_V2_COMPILER_VERSION = '1.0';
export const V2_VISUAL_R2_CHOREOGRAPHY = {id: 'v2-visual-r2', version: 2} as const;
export const V2_VISUAL_R2_RENDERER_VERSION = 'v2-visual-r2@2';
export const DARK_EDITORIAL_V1_CHOREOGRAPHY = {id: 'dark-editorial-v1', version: 1} as const;
export const DARK_EDITORIAL_V1_RENDERER_VERSION = 'dark-editorial-v1@1';
export const DARK_EDITORIAL_V1_PACING_CHOREOGRAPHY = {id: 'dark-editorial-v1', version: 2} as const;
export const DARK_EDITORIAL_V1_PACING_RENDERER_VERSION = 'dark-editorial-v1@2';
export const DARK_EDITORIAL_V1_STATE_PERSISTENCE_CHOREOGRAPHY = {id: 'dark-editorial-v1', version: 3} as const;
export const DARK_EDITORIAL_V1_STATE_PERSISTENCE_RENDERER_VERSION = 'dark-editorial-v1@3';
export const MEMORY_LAB_EDITORIAL_CHOREOGRAPHY = {id: 'memory-lab-editorial', version: 1} as const;
export const MEMORY_LAB_EDITORIAL_RENDERER_VERSION = 'memory-lab-editorial@1';
const FPS = 30;

const identitySchema = z.object({id: z.string().min(1), version: z.number().int().positive()});

export const visualSourceV2Schema = z.object({
  schemaVersion: z.literal(VISUAL_SOURCE_V2_SCHEMA_VERSION),
  compilerVersion: z.literal(VISUAL_SOURCE_V2_COMPILER_VERSION),
  source: z.object({
    designScenes: identitySchema,
    narrationPlanV2: identitySchema,
    narrationAudioV2: identitySchema,
    subtitleTimingV2: identitySchema,
    scriptV2: identitySchema,
    masterSha256: z.string().regex(/^[0-9a-f]{64}$/),
    masterDurationMs: z.number().int().positive(),
  }),
  timingBasis: z.literal('narration_audio_v2_unit_timeline'),
  choreography: z.union([z.object({
    id: z.literal(V2_VISUAL_R2_CHOREOGRAPHY.id),
    version: z.literal(V2_VISUAL_R2_CHOREOGRAPHY.version),
    beatCount: z.number().int().positive(),
  }), z.object({
    id: z.literal(DARK_EDITORIAL_V1_CHOREOGRAPHY.id),
    version: z.literal(DARK_EDITORIAL_V1_CHOREOGRAPHY.version),
    beatCount: z.number().int().positive(),
  }), z.object({
    id: z.literal(DARK_EDITORIAL_V1_PACING_CHOREOGRAPHY.id),
    version: z.literal(DARK_EDITORIAL_V1_PACING_CHOREOGRAPHY.version),
    beatCount: z.number().int().positive(),
  }), z.object({
    id: z.literal(DARK_EDITORIAL_V1_STATE_PERSISTENCE_CHOREOGRAPHY.id),
    version: z.literal(DARK_EDITORIAL_V1_STATE_PERSISTENCE_CHOREOGRAPHY.version),
    beatCount: z.number().int().positive(),
  }), z.object({
    id: z.literal(MEMORY_LAB_EDITORIAL_CHOREOGRAPHY.id),
    version: z.literal(MEMORY_LAB_EDITORIAL_CHOREOGRAPHY.version),
    beatCount: z.number().int().positive(),
  })]).optional(),
  unitMappings: z.array(z.object({
    sceneId: z.string().regex(/^S\d{3}$/),
    unitId: z.string().regex(/^N\d{3}$/),
    startMs: z.number().int().min(0),
    endMs: z.number().int().positive(),
  })).min(1),
  data: scenesAiOutputSchema,
  assetMap: z.record(z.string(), z.array(resolvedAssetSchema)),
  assetBindings: z.array(z.object({
    sceneId: z.string().min(1),
    requirementId: z.string().min(1),
    assetId: z.string().min(1),
    sourceType: z.string().min(1),
    sourceProvider: z.string().min(1),
    sourceUrl: z.string().nullable(),
    licenseStatus: z.string().min(1),
    localPath: z.string().min(1),
    attribution: z.string().nullable(),
  })),
  visualFamilies: z.array(z.string().min(1)).min(1),
  visualReadiness: z.object({
    ready: z.literal(true),
    totalScenes: z.number().int().positive(),
    requiredAssets: z.number().int().min(0),
    readyAssets: z.number().int().min(0),
    placeholderCount: z.literal(0),
  }),
});

export type VisualSourceV2 = z.infer<typeof visualSourceV2Schema>;
export interface VisualSourceV2Artifact {
  artifact: {id: string; version: number};
  visual: VisualSourceV2;
}

type ArtifactRow = {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  content_json: string;
};

export class VisualSourceV2Error extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'VisualSourceV2Error';
  }
}

function parseVisual(row: ArtifactRow): VisualSourceV2 | null {
  try {
    const parsed = visualSourceV2Schema.safeParse(JSON.parse(row.content_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readExactDesign(
  projectId: string,
  identity: {id: string; version: number},
): ScenesAiOutput {
  const row = getDb().prepare(
    `SELECT id, project_id, stage, version, content FROM project_versions WHERE id = ?`,
  ).get(identity.id) as {
    id: string;
    project_id: string;
    stage: string;
    version: number;
    content: string;
  } | undefined;
  if (!row || row.project_id !== projectId || row.stage !== 'scenes' || row.version !== identity.version) {
    throw new VisualSourceV2Error('DESIGN_SOURCE_INVALID', `exact scenes design 无效: ${identity.id}@${identity.version}`);
  }
  let raw: unknown;
  try { raw = JSON.parse(row.content); } catch { raw = null; }
  const parsed = scenesAiOutputSchema.safeParse(raw);
  if (!parsed.success || !validateScenesSemantics(parsed.data).ok) {
    throw new VisualSourceV2Error('DESIGN_SOURCE_INVALID', 'exact scenes design 未通过结构/语义校验');
  }
  return parsed.data;
}

function visualFamily(category: string, template: string | null): string {
  if (category === 'Archive') return 'Archival / Evidence';
  if (category === 'Editorial Graphic') return 'Editorial Typography';
  if (category === 'Minimal') return 'Minimal Breath';
  if (template === 'MG_ConceptCompare') return 'Comparison / Debate';
  if (template === 'MG_Timeline' || template === 'MG_ScheduleNodes') return 'Timeline / Evidence Map';
  return 'Cognitive Mechanism Diagram';
}

function visualFamiliesFor(data: ScenesAiOutput, choreography?: VisualSourceV2['choreography']): string[] {
  if (choreography?.id === MEMORY_LAB_EDITORIAL_CHOREOGRAPHY.id) {
    return [
      'Fragment Assembly',
      'Source Document',
      'Provenance Chain',
      'Experimental Stage',
      'Semantic Field',
      'Trace Comparison',
      'Source Attribution',
      'Longitudinal Record',
      'Procedure Safeguard',
      'Classification Funnel',
    ];
  }
  if (choreography) {
    return [
      'Persistent Cognitive System',
      'Annotated Archival Evidence',
      'Causal Mechanism Motion',
      'Activation / Threshold Process',
      'Evidence Evaluation',
      'Investigation / Final Synthesis',
    ];
  }
  return [...new Set(data.scenes.map((scene) => visualFamily(scene.category, scene.template)))];
}

function applyExactChoreography(
  data: ScenesAiOutput,
  identity?: {id: string; version: number},
): Pick<VisualSourceV2, 'data' | 'choreography'> {
  if (!identity) return {data};
  const isR2 = identity.id === V2_VISUAL_R2_CHOREOGRAPHY.id && identity.version === V2_VISUAL_R2_CHOREOGRAPHY.version;
  const isDarkEditorialV1 = identity.id === DARK_EDITORIAL_V1_CHOREOGRAPHY.id && identity.version === DARK_EDITORIAL_V1_CHOREOGRAPHY.version;
  const isDarkEditorialPacing = identity.id === DARK_EDITORIAL_V1_PACING_CHOREOGRAPHY.id && identity.version === DARK_EDITORIAL_V1_PACING_CHOREOGRAPHY.version;
  const isDarkEditorialStatePersistence = identity.id === DARK_EDITORIAL_V1_STATE_PERSISTENCE_CHOREOGRAPHY.id && identity.version === DARK_EDITORIAL_V1_STATE_PERSISTENCE_CHOREOGRAPHY.version;
  const isMemoryLabEditorial = identity.id === MEMORY_LAB_EDITORIAL_CHOREOGRAPHY.id && identity.version === MEMORY_LAB_EDITORIAL_CHOREOGRAPHY.version;
  const isDarkEditorial = isDarkEditorialV1 || isDarkEditorialPacing || isDarkEditorialStatePersistence;
  if (!isR2 && !isDarkEditorial && !isMemoryLabEditorial) {
    throw new VisualSourceV2Error('CHOREOGRAPHY_INVALID', `不支持 exact choreography: ${identity.id}@${identity.version}`);
  }
  if (isMemoryLabEditorial) {
    const scenes = data.scenes.map((scene) => {
      const memoryLab = scene.templateProps?.memoryLab;
      if (!memoryLab || typeof memoryLab !== 'object') {
        throw new VisualSourceV2Error('CHOREOGRAPHY_INVALID', `${scene.id} 缺少 memoryLab 视觉参数`);
      }
      return {
        ...scene,
        templateProps: {
          ...(scene.templateProps ?? {}),
          memoryLab: {...(memoryLab as Record<string, unknown>), version: MEMORY_LAB_EDITORIAL_RENDERER_VERSION},
        },
      };
    });
    return {
      data: scenesAiOutputSchema.parse({...data, scenes}),
      choreography: {...MEMORY_LAB_EDITORIAL_CHOREOGRAPHY, beatCount: scenes.length},
    };
  }
  const rendererVersion = isDarkEditorialStatePersistence
    ? DARK_EDITORIAL_V1_STATE_PERSISTENCE_RENDERER_VERSION
    : isDarkEditorialPacing
      ? DARK_EDITORIAL_V1_PACING_RENDERER_VERSION
      : isDarkEditorialV1
        ? DARK_EDITORIAL_V1_RENDERER_VERSION
        : V2_VISUAL_R2_RENDERER_VERSION;
  const beatsByScene = new Map<string, string[]>();
  for (const beat of v2VisualR2Choreography.beats) {
    const ids = beatsByScene.get(beat.sceneId) ?? [];
    ids.push(beat.beatId);
    beatsByScene.set(beat.sceneId, ids);
  }
  const scenes = data.scenes.map((scene) => {
    const beatIds = beatsByScene.get(scene.id);
    if (!beatIds?.length) {
      throw new VisualSourceV2Error('CHOREOGRAPHY_INVALID', `${scene.id} 没有 exact choreography beats`);
    }
    return {
      ...scene,
      templateProps: {
        ...(scene.templateProps ?? {}),
        v2VisualR2: {version: rendererVersion, beatIds},
      },
    };
  });
  return {
    data: scenesAiOutputSchema.parse({...data, scenes}),
    choreography: isDarkEditorial
      ? {
        ...(isDarkEditorialStatePersistence
          ? DARK_EDITORIAL_V1_STATE_PERSISTENCE_CHOREOGRAPHY
          : isDarkEditorialPacing
            ? DARK_EDITORIAL_V1_PACING_CHOREOGRAPHY
            : DARK_EDITORIAL_V1_CHOREOGRAPHY),
        beatCount: v2VisualR2Choreography.beats.length,
      }
      : {...V2_VISUAL_R2_CHOREOGRAPHY, beatCount: v2VisualR2Choreography.beats.length},
  };
}

function retimeDesign(input: {
  design: ScenesAiOutput;
  audio: NarrationAudioV2Artifact;
  subtitle: SubtitleTimingV2Artifact;
}): {data: ScenesAiOutput; unitMappings: VisualSourceV2['unitMappings']} {
  const speechUnits = input.audio.manifest.units.filter((unit) => unit.kind === 'speech');
  if (speechUnits.length !== input.design.scenes.length) {
    throw new VisualSourceV2Error(
      'DESIGN_UNIT_MISMATCH',
      `design scenes=${input.design.scenes.length} 与 speech units=${speechUnits.length} 不一致`,
    );
  }
  const ranges = new Map<string, {startMs: number; endMs: number}>();
  let cursor = 0;
  let activeSpeechId: string | null = null;
  for (const unit of input.audio.manifest.units) {
    const startMs = cursor;
    cursor += unit.durationMs;
    if (unit.kind === 'speech') {
      activeSpeechId = unit.unitId;
      ranges.set(unit.unitId, {startMs, endMs: cursor});
    } else if (activeSpeechId) {
      ranges.get(activeSpeechId)!.endMs = cursor;
    }
  }
  if (Math.abs(cursor - input.audio.manifest.master.durationMs) > 100) {
    throw new VisualSourceV2Error('AUDIO_TIMELINE_INVALID', 'unit timeline 与 master duration 不一致');
  }
  ranges.get(speechUnits[speechUnits.length - 1]!.unitId)!.endMs = input.audio.manifest.master.durationMs;

  const unitMappings = speechUnits.map((unit, index) => {
    const scene = input.design.scenes[index]!;
    const range = ranges.get(unit.unitId)!;
    const cues = input.subtitle.timing.cues.filter((cue) => cue.unitId === unit.unitId);
    if (cues.length === 0 || cues.some((cue) => cue.startMs < range.startMs || cue.endMs > range.endMs + 100)) {
      throw new VisualSourceV2Error('SUBTITLE_UNIT_MISMATCH', `${unit.unitId} subtitle timing 不在 exact audio unit 范围内`);
    }
    if (scene.chapter !== cues[0]!.chapter) {
      throw new VisualSourceV2Error('DESIGN_UNIT_MISMATCH', `${scene.id} chapter 与 ${unit.unitId} 不一致`);
    }
    return {sceneId: scene.id, unitId: unit.unitId, startMs: range.startMs, endMs: range.endMs};
  });

  const scenes = input.design.scenes.map((scene, index) => {
    const range = unitMappings[index]!;
    const start = range.startMs / 1000;
    const end = range.endMs / 1000;
    return {
      ...scene,
      start,
      end,
      duration: end - start,
      startFrame: Math.round(start * FPS),
      durationInFrames: Math.round((end - start) * FPS),
    };
  });
  const chapterTiming = input.design.chapterTiming.map((chapter) => {
    const chapterScenes = scenes.filter((scene) => scene.chapter === chapter.chapter);
    if (chapterScenes.length === 0) {
      throw new VisualSourceV2Error('DESIGN_UNIT_MISMATCH', `chapter ${chapter.chapter} 没有 scene`);
    }
    return {...chapter, start: chapterScenes[0]!.start, end: chapterScenes[chapterScenes.length - 1]!.end};
  });
  const data = scenesAiOutputSchema.parse({chapterTiming, scenes});
  const semantic = validateScenesSemantics(data);
  if (!semantic.ok) {
    throw new VisualSourceV2Error('VISUAL_SOURCE_INVALID', `[${semantic.issues[0]!.code}] ${semantic.issues[0]!.message}`);
  }
  return {data, unitMappings};
}

function exactAssets(projectId: string, data: ScenesAiOutput): Pick<VisualSourceV2, 'assetMap' | 'assetBindings' | 'visualReadiness'> {
  const readiness = evaluateVisualReadiness(projectId, data.scenes, {applyOverrides: false});
  if (!readiness.ready) {
    const first = readiness.missing[0];
    throw new VisualSourceV2Error('VISUAL_READINESS_FAILED', `${first?.sceneId ?? 'unknown'} ${first?.reason ?? 'asset not ready'}`);
  }
  const fullMap = buildAssetMap(projectId, data.scenes, {applyOverrides: false});
  const assetMap: VisualSourceV2['assetMap'] = {};
  const assetBindings: VisualSourceV2['assetBindings'] = [];
  for (const scene of data.scenes) {
    const plan = buildSceneAssetPlan(scene);
    if (!plan.needsAssets) continue;
    for (const requirement of plan.requirements) {
      const binding = getActiveBinding(projectId, scene.id, requirement.requirementId);
      const asset = binding ? getAssetById(binding.asset_id) : undefined;
      if (!binding || !asset) {
        throw new VisualSourceV2Error('VISUAL_READINESS_FAILED', `${scene.id}/${requirement.requirementId} exact binding 缺失`);
      }
      const resolved = fullMap[scene.id]?.find((item) => item.assetId === asset.id);
      if (!resolved || !fs.existsSync(path.join(process.cwd(), 'public', resolved.publicPath))) {
        throw new VisualSourceV2Error('VISUAL_READINESS_FAILED', `${scene.id}/${requirement.requirementId} 素材文件缺失`);
      }
      (assetMap[scene.id] ??= []).push(resolved);
      assetBindings.push({
        sceneId: scene.id,
        requirementId: requirement.requirementId,
        assetId: asset.id,
        sourceType: asset.source_type,
        sourceProvider: asset.source_provider,
        sourceUrl: asset.source_url,
        licenseStatus: asset.license_status,
        localPath: asset.local_path,
        attribution: asset.attribution,
      });
    }
  }
  return {
    assetMap,
    assetBindings,
    visualReadiness: {
      ready: true,
      totalScenes: data.scenes.length,
      requiredAssets: readiness.needAssets,
      readyAssets: readiness.readyRequirements,
      placeholderCount: 0,
    },
  };
}

const darkEditorialManifestSchema = z.object({
  assets: z.array(z.object({
    assetId: z.string().min(1),
    publicPath: z.string().min(1),
    mediaType: z.literal('image'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    creator: z.string().min(1),
    date: z.string().min(1),
    sourceProvider: z.string().min(1),
    sourceUrl: z.string().url(),
    license: z.string().min(1),
    publicDomainBasis: z.string().min(1),
    description: z.string().min(1),
  })),
  sceneAssets: z.record(z.string().regex(/^S\d{3}$/), z.array(z.string().min(1)).min(1)),
});

function resolvedAsset(asset: AssetRow): ResolvedAsset {
  return resolvedAssetSchema.parse({
    assetId: asset.id,
    publicPath: asset.local_path,
    mediaType: asset.media_type,
    width: asset.width,
    height: asset.height,
    description: asset.description ?? '',
    attribution: asset.attribution ?? '',
    sourceUrl: asset.source_url ?? '',
  });
}

function darkEditorialAssetMap(projectId: string, registerMissing: boolean): VisualSourceV2['assetMap'] {
  const manifest = darkEditorialManifestSchema.parse(r3aHistoricalAssets);
  const rows = listAssetsForProject(projectId);
  const byManifestId = new Map<string, AssetRow>();

  // Validate the complete fixed manifest before making any asset-row writes.
  for (const item of manifest.assets) {
    const physical = path.join(process.cwd(), 'public', item.publicPath);
    if (!item.publicPath.startsWith('assets/') || !fs.existsSync(physical) || fs.statSync(physical).size === 0) {
      throw new VisualSourceV2Error('VISUAL_READINESS_FAILED', `dark editorial 史料文件缺失: ${item.assetId}`);
    }
  }

  for (const item of manifest.assets) {
    let row = rows.find((candidate) => candidate.local_path === item.publicPath);
    if (!row && registerMissing) {
      row = insertAsset({
        ...(getAssetById(item.assetId) ? {} : {id: item.assetId}),
        projectId,
        sceneId: Object.entries(manifest.sceneAssets).find(([, ids]) => ids.includes(item.assetId))?.[0] ?? null,
        mediaType: item.mediaType,
        sourceType: 'archive',
        sourceProvider: item.sourceProvider,
        sourceUrl: item.sourceUrl,
        localPath: item.publicPath,
        mimeType: item.publicPath.endsWith('.png') ? 'image/png' : 'image/jpeg',
        width: item.width,
        height: item.height,
        licenseStatus: 'usable',
        licenseNote: item.publicDomainBasis,
        attribution: `${item.creator}, ${item.date}; ${item.license}`,
        description: item.description,
      });
      rows.push(row);
    }
    if (
      !row || row.project_id !== projectId || row.media_type !== item.mediaType ||
      row.source_type !== 'archive' || row.source_provider !== item.sourceProvider ||
      row.source_url !== item.sourceUrl || row.license_status !== 'usable' ||
      row.local_path !== item.publicPath
    ) {
      throw new VisualSourceV2Error('VISUAL_READINESS_FAILED', `dark editorial 史料 provenance 无效: ${item.assetId}`);
    }
    byManifestId.set(item.assetId, row);
  }

  const assetMap: VisualSourceV2['assetMap'] = {};
  for (const [sceneId, assetIds] of Object.entries(manifest.sceneAssets)) {
    assetMap[sceneId] = assetIds.map((assetId) => {
      const row = byManifestId.get(assetId);
      if (!row) throw new VisualSourceV2Error('VISUAL_READINESS_FAILED', `dark editorial 史料未解析: ${assetId}`);
      return resolvedAsset(row);
    });
  }
  return assetMap;
}

function isDarkEditorial(choreography: VisualSourceV2['choreography']): boolean {
  return choreography?.id === DARK_EDITORIAL_V1_CHOREOGRAPHY.id &&
    (choreography.version === DARK_EDITORIAL_V1_CHOREOGRAPHY.version ||
      choreography.version === DARK_EDITORIAL_V1_PACING_CHOREOGRAPHY.version ||
      choreography.version === DARK_EDITORIAL_V1_STATE_PERSISTENCE_CHOREOGRAPHY.version);
}

function mergeDarkEditorialAssets(
  base: VisualSourceV2['assetMap'],
  supplemental: VisualSourceV2['assetMap'],
): VisualSourceV2['assetMap'] {
  const merged = {...base};
  for (const [sceneId, editorialAssets] of Object.entries(supplemental)) {
    const seen = new Set(editorialAssets.map((asset) => asset.assetId));
    merged[sceneId] = [...editorialAssets, ...(base[sceneId] ?? []).filter((asset) => !seen.has(asset.assetId))];
  }
  return merged;
}

async function readExactSources(input: {
  projectId: string;
  designScenes: {id: string; version: number};
  narrationPlanV2: {id: string; version: number};
  narrationAudioV2: {id: string; version: number};
  subtitleTimingV2: {id: string; version: number};
}): Promise<{
  design: ScenesAiOutput;
  audio: NarrationAudioV2Artifact;
  subtitle: SubtitleTimingV2Artifact;
  scriptV2: {id: string; version: number};
}> {
  const design = readExactDesign(input.projectId, input.designScenes);
  const plan = getNarrationPlanV2Artifact(input.projectId, input.narrationPlanV2.id);
  if (!plan || plan.artifact.version !== input.narrationPlanV2.version) {
    throw new VisualSourceV2Error('NARRATION_PLAN_V2_INVALID', 'exact narration plan v2 无效');
  }
  const audio = await getExactNarrationAudioV2Artifact(input.projectId, {
    artifactId: input.narrationAudioV2.id,
    version: input.narrationAudioV2.version,
  });
  if (!audio || audio.manifest.source.narrationPlanV2ArtifactId !== plan.artifact.id ||
      audio.manifest.source.narrationPlanV2ArtifactVersion !== plan.artifact.version) {
    throw new VisualSourceV2Error('NARRATION_AUDIO_V2_INVALID', 'exact narration audio v2 无效或 plan source 不匹配');
  }
  const subtitle = getExactSubtitleTimingV2Artifact(input.projectId, {
    artifactId: input.subtitleTimingV2.id,
    version: input.subtitleTimingV2.version,
  }, audio);
  if (!subtitle) throw new VisualSourceV2Error('SUBTITLE_TIMING_V2_INVALID', 'exact subtitle timing v2 无效或 audio source 不匹配');
  return {
    design,
    audio,
    subtitle,
    scriptV2: {id: audio.manifest.source.scriptV2VersionId, version: audio.manifest.source.scriptV2Version},
  };
}

export async function buildVisualSourceV2(input: {
  projectId: string;
  designScenes: {id: string; version: number};
  narrationPlanV2: {id: string; version: number};
  narrationAudioV2: {id: string; version: number};
  subtitleTimingV2: {id: string; version: number};
  choreography?: {id: string; version: number};
}): Promise<VisualSourceV2Artifact & {reused: boolean}> {
  const exact = await readExactSources(input);
  const retimed = retimeDesign(exact);
  const choreographed = applyExactChoreography(retimed.data, input.choreography);
  const data = choreographed.data;
  const unitMappings = retimed.unitMappings;
  const baseAssets = exactAssets(input.projectId, data);
  const assets = isDarkEditorial(choreographed.choreography)
    ? {...baseAssets, assetMap: mergeDarkEditorialAssets(baseAssets.assetMap, darkEditorialAssetMap(input.projectId, true))}
    : baseAssets;
  const expected = visualSourceV2Schema.parse({
    schemaVersion: VISUAL_SOURCE_V2_SCHEMA_VERSION,
    compilerVersion: VISUAL_SOURCE_V2_COMPILER_VERSION,
    source: {
      designScenes: input.designScenes,
      narrationPlanV2: input.narrationPlanV2,
      narrationAudioV2: input.narrationAudioV2,
      subtitleTimingV2: input.subtitleTimingV2,
      scriptV2: exact.scriptV2,
      masterSha256: exact.audio.manifest.master.sha256,
      masterDurationMs: exact.audio.manifest.master.durationMs,
    },
    timingBasis: 'narration_audio_v2_unit_timeline',
    ...(choreographed.choreography ? {choreography: choreographed.choreography} : {}),
    unitMappings,
    data,
    ...assets,
    visualFamilies: visualFamiliesFor(data, choreographed.choreography),
  });
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, project_id, kind, version, content_json FROM artifacts
     WHERE project_id = ? AND kind = ? ORDER BY version DESC`,
  ).all(input.projectId, VISUAL_SOURCE_V2_ARTIFACT_KIND) as ArtifactRow[];
  for (const row of rows) {
    const visual = parseVisual(row);
    if (visual && isDeepStrictEqual(visual, expected)) {
      return {artifact: {id: row.id, version: row.version}, visual, reused: true};
    }
  }
  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(version),0)+1 FROM artifacts WHERE project_id=? AND kind=?), ?, NULL, ?)`,
    ).run(id, input.projectId, VISUAL_SOURCE_V2_ARTIFACT_KIND, input.projectId, VISUAL_SOURCE_V2_ARTIFACT_KIND, JSON.stringify(expected), new Date().toISOString());
    return db.prepare('SELECT version FROM artifacts WHERE id = ?').get(id) as {version: number};
  });
  const row = tx.immediate();
  return {artifact: {id, version: row.version}, visual: expected, reused: false};
}

export async function getExactVisualSourceV2Artifact(
  projectId: string,
  expected: {artifactId: string; version: number},
): Promise<VisualSourceV2Artifact | null> {
  const row = getDb().prepare(
    'SELECT id, project_id, kind, version, content_json FROM artifacts WHERE id = ?',
  ).get(expected.artifactId) as ArtifactRow | undefined;
  if (!row || row.project_id !== projectId || row.kind !== VISUAL_SOURCE_V2_ARTIFACT_KIND || row.version !== expected.version) return null;
  const visual = parseVisual(row);
  if (!visual) return null;
  try {
    const exact = await readExactSources({
      projectId,
      designScenes: visual.source.designScenes,
      narrationPlanV2: visual.source.narrationPlanV2,
      narrationAudioV2: visual.source.narrationAudioV2,
      subtitleTimingV2: visual.source.subtitleTimingV2,
    });
    const retimed = retimeDesign(exact);
    const choreographed = applyExactChoreography(retimed.data, visual.choreography
      ? {id: visual.choreography.id, version: visual.choreography.version}
      : undefined);
    const baseAssets = exactAssets(projectId, choreographed.data);
    const expectedAssetMap = isDarkEditorial(choreographed.choreography)
      ? mergeDarkEditorialAssets(baseAssets.assetMap, darkEditorialAssetMap(projectId, false))
      : baseAssets.assetMap;
    if (
      visual.compilerVersion !== VISUAL_SOURCE_V2_COMPILER_VERSION ||
      visual.source.scriptV2.id !== exact.scriptV2.id ||
      visual.source.scriptV2.version !== exact.scriptV2.version ||
      visual.source.masterSha256 !== exact.audio.manifest.master.sha256 ||
      visual.source.masterDurationMs !== exact.audio.manifest.master.durationMs ||
      !isDeepStrictEqual(visual.data, choreographed.data) ||
      !isDeepStrictEqual(visual.unitMappings, retimed.unitMappings) ||
      !isDeepStrictEqual(visual.assetMap, expectedAssetMap) ||
      !isDeepStrictEqual(visual.assetBindings, baseAssets.assetBindings) ||
      !isDeepStrictEqual(visual.visualReadiness, baseAssets.visualReadiness) ||
      !isDeepStrictEqual(visual.visualFamilies, visualFamiliesFor(choreographed.data, choreographed.choreography))
    ) return null;
    for (const assets of Object.values(visual.assetMap)) {
      for (const asset of assets) {
        const physical = path.join(process.cwd(), 'public', asset.publicPath);
        if (!fs.existsSync(physical) || fs.statSync(physical).size === 0) return null;
      }
    }
    for (const binding of visual.assetBindings) {
      const asset = getAssetById(binding.assetId);
      if (
        !asset || asset.project_id !== projectId ||
        asset.source_type !== binding.sourceType ||
        asset.source_provider !== binding.sourceProvider ||
        asset.source_url !== binding.sourceUrl ||
        asset.license_status !== binding.licenseStatus ||
        asset.local_path !== binding.localPath ||
        asset.attribution !== binding.attribution ||
        !visual.assetMap[binding.sceneId]?.some((item) => item.assetId === binding.assetId)
      ) return null;
    }
  } catch {
    return null;
  }
  return {artifact: {id: row.id, version: row.version}, visual};
}
