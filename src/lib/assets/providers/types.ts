/**
 * M6 Asset Provider 抽象：搜索 → 选择 → 下载 → 校验。
 * 任何具体素材网站只实现本接口，不进入 renderer/scene 层。
 */

import type {AssetRequirement} from '../../scene-schema';

export interface AssetSearchHit {
  provider: string;
  /** 素材页面 URL（attribution/provenance 用）。 */
  sourceUrl: string;
  /** 可直接下载的文件 URL。 */
  downloadUrl: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  description: string;
  licenseStatus: 'usable' | 'review_required' | 'blocked';
  licenseNote: string;
  attribution: string;
}

export interface AssetProvider {
  name: string;
  /** 按需求搜索候选（按相关度排序）。 */
  search(requirement: AssetRequirement, limit?: number): Promise<AssetSearchHit[]>;
  /** 下载到目标路径（实现方负责创建目录）。 */
  download(hit: AssetSearchHit, destAbsPath: string): Promise<void>;
}

export class AssetProviderError extends Error {
  constructor(
    public readonly code: 'SEARCH_FAILED' | 'NO_RESULT' | 'DOWNLOAD_FAILED' | 'POLICY_BLOCKED',
    message: string,
  ) {
    super(message);
    this.name = 'AssetProviderError';
  }
}
