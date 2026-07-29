/**
 * M6.3 Asset Resolver — per-scene resolution state + provider contract extensions.
 *
 * 核心原则：任何 pending asset 都必须有明确的下一步动作。
 */
import type {AssetRequirement, ResolvedAsset, Scene} from '../scene-schema';
import type {AssetRow} from './model';

/** per-requirement 的解析状态（provider-independent） */
export type ResolutionStatus =
  | 'ready'           // 已绑定 usable asset + 文件存在
  | 'searching'       // 正在 Wikimedia/stock 搜索中（transient）
  | 'generating'      // 正在 AI 生成中（transient）
  | 'pending'         // 从未尝试
  | 'no_result'       // 所有 provider/query 均无结果
  | 'download_failed' // 下载可重试
  | 'policy_blocked'  // 无可用 provider（如 generated 未实现）
  | 'generation_failed' // AI 生成失败
  | 'candidate_waiting' // M6.3.9：已有未绑定 AI 候选，等待用户确认（derived，不持久化）
  | 'manual_required'; // 需要用户上传或选择其他方案

/** 每个 scene 的整体素材状态 + 每项 requirement 的解析进度 */
export interface SceneAssetResolution {
  sceneId: string;
  category: string;
  /** scene 当前需要的素材数 */
  totalRequired: number;
  /** 已 ready 的素材数 */
  ready: number;
  /** 整体状态 */
  overallStatus: ResolutionStatus;
  requirements: RequirementResolution[];
}

export interface RequirementResolution {
  /** M6.3.8：稳定需求身份（exact binding 的唯一匹配键）。 */
  requirementId: string;
  /** 该 requirement 在 scene.assetRequirements 中的 index（仅 UI 展示"需求 1/2"用，不作身份）。 */
  index: number;
  requirement: AssetRequirement;
  status: ResolutionStatus;
  /** 已绑定的 asset（ready 时非 null；来自 active binding，非顺序猜测） */
  boundAssetId: string | null;
  boundAsset: AssetRow | null;
  /** 搜索尝试记录 */
  queriesTried: string[];
  /** 最终使用的 query */
  queryUsed: string | null;
  /** 搜索候选（搜索成功但未绑定的候选项） */
  candidates: AssetSearchCandidate[];
  /** 未绑定的 AI 生成候选（candidate-first：需用户显式"使用这张"才绑定） */
  generatedCandidates: GeneratedCandidateInfo[];
  /** 该 requirement 支持的操作（recommendedAction 排在首位） */
  availableActions: ResolverAction[];
  /** 用户可见的状态描述（中文） */
  friendlyStatus: string;
  /** M6.3.9：真实性要求（authenticityOf 推导结果；AI fallback 的语义闸门） */
  authenticity: 'authentic_required' | 'authentic_preferred' | 'synthetic_allowed';
  /** M6.3.9：系统推荐下一步动作（null = 无需动作，如 ready） */
  recommendedAction: ResolverAction | null;
  /** M6.3.9：语义上允许 AI 生成（尚未叠加 provider health） */
  generateEligible: boolean;
  /** M6.3.9：authentic_preferred 时 true —— UI 应标注「AI生成替代」 */
  generateSecondary: boolean;
  /** M6.3.9：generate 不可用的原因（语义禁止或 provider 不可用；可用时为 null） */
  generateDisabledReason: string | null;
  /** M6.3.9：最近一次失败尝试的原因（来自 asset_resolution_state，无则 null） */
  failureReason: string | null;
  /** M6.3.9：用户态说明 —— 发生了什么 / 为什么 / 建议下一步（一句话） */
  statusHint: string;
}

/** 未绑定 AI 生成候选的展示信息。 */
export interface GeneratedCandidateInfo {
  assetId: string;
  publicPath: string;
  provider: string;
  prompt: string;
  createdAt: string;
}

export interface AssetSearchCandidate {
  provider: string;
  sourceUrl: string;
  downloadUrl: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  description: string;
  licenseStatus: 'usable' | 'review_required' | 'blocked';
  licenseNote: string;
  attribution: string;
  thumbnailUrl?: string;
}

export type ResolverAction =
  | 'search'          // Wikimedia/stock 重新搜索
  | 'retry_download'  // 下载重试
  | 'generate'        // AI 生成
  | 'upload'          // 手动上传
  | 'switch_to_mg'    // 改为 MG 模板
  | 'select_candidate' // 从候选中选择
  | 'replace';        // 替换已有素材

export interface ResolveRequest {
  projectId: string;
  sceneId: string;
  /** M6.3.8：exact requirement 身份（不再使用位置 index）。 */
  requirementId: string;
  action: ResolverAction;
  /** upload action 需要提供文件 body（multipart）*/
  uploadFile?: File;
  /** generate action 可选自定义 prompt */
  generatePrompt?: string;
  /** select_candidate 需要指定 candidate asset id */
  candidateAssetId?: string;
}

export interface ResolveResult {
  sceneId: string;
  requirementId: string;
  status: ResolutionStatus;
  assetId: string | null;
  message: string;
}
