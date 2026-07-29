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
  /** 该 requirement 在 scene.assetRequirements 中的 index */
  index: number;
  requirement: AssetRequirement;
  status: ResolutionStatus;
  /** 已绑定的 asset（ready 时非 null） */
  boundAssetId: string | null;
  boundAsset: AssetRow | null;
  /** 搜索尝试记录 */
  queriesTried: string[];
  /** 最终使用的 query */
  queryUsed: string | null;
  /** 搜索候选（搜索成功但未绑定的候选项） */
  candidates: AssetSearchCandidate[];
  /** 该 requirement 支持的操作 */
  availableActions: ResolverAction[];
  /** 用户可见的状态描述（中文） */
  friendlyStatus: string;
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
  requirementIndex?: number; // 可指定单 requirement；不指定 = 全部
  action: ResolverAction;
  /** upload action 需要提供文件 body（multipart）*/
  uploadFile?: File;
  /** generate action 可选自定义 prompt */
  generatePrompt?: string;
  /** select_candidate 需要指定 candidate index */
  candidateIndex?: number;
}

export interface ResolveResult {
  sceneId: string;
  requirementIndex: number;
  status: ResolutionStatus;
  assetId: string | null;
  message: string;
}
