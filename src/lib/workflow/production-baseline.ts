import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';

/** 当前正式 production workflow contract 的唯一默认身份。 */
export const INITIAL_PRODUCTION_BASELINE_V1 = 'INITIAL_PRODUCTION_BASELINE_V1' as const;
export const DEFAULT_PRODUCTION_BASELINE = INITIAL_PRODUCTION_BASELINE_V1;
export const PRODUCTION_BASELINE_MANIFEST_PATH =
  'docs/skill_migration/reference_masters/long-video-initial-production-v1.json' as const;
export const INITIAL_PRODUCTION_BASELINE_FREEZE_COMMIT =
  'ffee9e9330de0d88c8b6318f855b24dcd677338a' as const;

const EXPECTED_REFERENCE_MASTER_SHA256 =
  '3f79bf4215964f2dbb35d64da61ebdee5a6a58e0aafaed61f53c47df2f865239' as const;
const EXPECTED_RENDERER_COMMIT =
  '511b8b26772fb87488b40943511504437e7f7865' as const;
const EXPECTED_TAG = 'long-video-initial-production-v1' as const;

/**
 * 这些是 production baseline 的规则身份，不是题材/场景内容。
 * 规则继续由现有 workflow、asset、visual gate 和人工 review 执行；这里只声明
 * 它们归属哪个 baseline，避免把一次视频的具体内容变成全局规则。
 */
export const INITIAL_PRODUCTION_BASELINE_RULES = {
  chain: [
    'narration_plan',
    'narration_audio',
    'subtitles',
    'scene_design',
    'visual_sources',
    'reconciliation',
    'production_build',
    'preview_qc',
    'formal_render_authorization',
    'formal_render',
    'final_review',
    'artifact_freeze',
  ],
  finalReview: {maxP0: 0, maxP1: 0},
  semanticStateDensity: 'required',
  imageSemanticUtility: 'required',
  archiveClassification: [
    'EXACT_EVIDENCE',
    'IDENTITY',
    'CONTEXT',
    'CONTENT_BEARING_DOCUMENT',
  ],
  visualGuards: [
    'NO_FLOATING_OVERSIZED_CORAL_OVERLAY',
    'NO_FUTURE_ANSWER_LEAK',
    'NO_UNRESOLVED_PLACEHOLDER',
    'NO_BEAT_REPLAY',
    'NO_LONG_STATIC_REGRESSION',
  ],
  cleanMaster: {subtitleMode: 'none', showSubtitles: false},
} as const;

export type ProductionWorkflowChannel = 'production' | 'experimental';

export const productionWorkflowChannelSchema = z.enum([
  'production',
  'experimental',
]);

const baselineManifestSchema = z.object({
  schemaVersion: z.literal('1.0'),
  id: z.literal(INITIAL_PRODUCTION_BASELINE_V1),
  status: z.literal('FROZEN_INITIAL_PRODUCTION'),
  userApproved: z.literal(true),
  notGoldenFinal: z.literal(true),
  tag: z.literal(EXPECTED_TAG),
  freezeCommit: z.literal(INITIAL_PRODUCTION_BASELINE_FREEZE_COMMIT),
  projectId: z.literal('8f955b4c-42dd-4a02-8e76-e721a37fab41'),
  conformanceFixture: z.object({
    projectId: z.literal('8f955b4c-42dd-4a02-8e76-e721a37fab41'),
    role: z.literal('CONFORMANCE_FIXTURE'),
  }),
  renderer: z.object({
    commit: z.literal(EXPECTED_RENDERER_COMMIT),
  }).passthrough(),
  formalRenderAttempt2: z.object({
    kind: z.literal('no-subtitles'),
    showSubtitles: z.literal(false),
    status: z.literal('succeeded'),
    localMasterPath: z.string().min(1),
    sha256: z.literal(EXPECTED_REFERENCE_MASTER_SHA256),
  }).passthrough(),
  review: z.object({
    formalMasterVerdict: z.literal('PASS'),
    p0: z.literal(0),
    p1: z.literal(0),
  }).passthrough(),
  frozenRules: z.object({
    imageSemanticUtilityGate: z.literal(true),
  }).passthrough(),
}).passthrough();

export type ProductionBaselineManifest = z.infer<typeof baselineManifestSchema>;

export interface WorkflowBaselineResolution {
  channel: ProductionWorkflowChannel;
  productionBaseline: typeof INITIAL_PRODUCTION_BASELINE_V1;
  basedOn: typeof INITIAL_PRODUCTION_BASELINE_V1 | null;
  experimentalOverride: string | null;
}

export class ProductionBaselineError extends Error {
  constructor(public readonly code: 'REFERENCE_MANIFEST_INVALID' | 'PRODUCTION_OVERRIDE_FORBIDDEN', message: string) {
    super(message);
    this.name = 'ProductionBaselineError';
  }
}

/** 每次读取都从仓库文件读取；不写 manifest，也不把它当 runtime database。 */
export function readProductionBaselineManifest(): ProductionBaselineManifest {
  const manifestFile = path.resolve(process.cwd(), PRODUCTION_BASELINE_MANIFEST_PATH);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (err) {
    throw new ProductionBaselineError(
      'REFERENCE_MANIFEST_INVALID',
      `production baseline manifest 无法读取: ${manifestFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = baselineManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProductionBaselineError(
      'REFERENCE_MANIFEST_INVALID',
      `production baseline manifest 身份校验失败: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

/** 最小 reference authority 校验：身份、freeze、renderer、tag、master SHA 和 review gate。 */
export function assertProductionBaselineReference(): ProductionBaselineManifest {
  return readProductionBaselineManifest();
}

/** 默认 production 永远解析到冻结 baseline；实验必须通过显式 channel/override 进入。 */
export function resolveWorkflowBaseline(input: {
  channel?: ProductionWorkflowChannel;
  experimentalOverride?: string | null;
} = {}): WorkflowBaselineResolution {
  assertProductionBaselineReference();
  const channel = input.channel ?? 'production';
  const experimentalOverride = input.experimentalOverride?.trim() || null;
  if (channel === 'production' && experimentalOverride !== null) {
    throw new ProductionBaselineError(
      'PRODUCTION_OVERRIDE_FORBIDDEN',
      'production workflow 不接受 experimental override；请显式选择 experimental channel',
    );
  }
  return {
    channel,
    productionBaseline: INITIAL_PRODUCTION_BASELINE_V1,
    basedOn: channel === 'experimental' ? INITIAL_PRODUCTION_BASELINE_V1 : null,
    experimentalOverride,
  };
}

export function resolveProductionSubtitleMode(mode?: 'none' | 'burned'): 'none' | 'burned' {
  return mode ?? INITIAL_PRODUCTION_BASELINE_RULES.cleanMaster.subtitleMode;
}

export function resolveProductionRenderJobKind(mode?: 'none' | 'burned'): 'fullcut' | 'no-subtitles' {
  return resolveProductionSubtitleMode(mode) === 'none' ? 'no-subtitles' : 'fullcut';
}
