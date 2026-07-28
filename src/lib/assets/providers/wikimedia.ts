/**
 * M6 Wikimedia Commons Provider（无需 API key，公共领域/CC 授权档案素材）。
 *
 * 适用范围：历史照片、手稿、古籍封面、建筑、博物馆藏品（弗洛伊德、维也纳、
 * 《梦的解析》等 public domain 内容的理想来源）。
 *
 * 版权策略（license policy）：
 * - usable：Public domain / CC0 / CC-BY / CC-BY-SA（记录 attribution）
 * - blocked：Non-free / Fair use / 未知许可（不自动使用）
 *
 * 仅实现 image（视频本期不支持）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type {AssetRequirement} from '../../scene-schema';
import {AssetProviderError, type AssetProvider, type AssetSearchHit} from './types';

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'ZhiyingBot/1.0 (knowledge-video production; contact: admin)';

interface CommonsImageInfo {
  url: string;
  descriptionurl: string;
  mime: string;
  width: number;
  height: number;
  extmetadata?: Record<string, {value: string}>;
}

interface CommonsPage {
  title: string;
  imageinfo?: CommonsImageInfo[];
}

interface CommonsResponse {
  query?: {pages?: Record<string, CommonsPage>};
}

const USABLE_LICENSES = [
  'public domain',
  'cc0',
  'cc-zero',
  'cc by',
  'cc-by',
  'attribution',
  'pdm',
];

function classifyLicense(meta: Record<string, {value: string}> | undefined): {
  status: 'usable' | 'blocked';
  note: string;
} {
  const short = meta?.LicenseShortName?.value?.toLowerCase() ?? '';
  const license = meta?.License?.value?.toLowerCase() ?? '';
  const text = `${short} ${license}`;
  if (!text.trim()) return {status: 'blocked', note: 'unknown license'};
  if (USABLE_LICENSES.some((l) => text.includes(l))) {
    return {status: 'usable', note: meta?.LicenseShortName?.value ?? license};
  }
  return {status: 'blocked', note: meta?.LicenseShortName?.value ?? 'non-free'};
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchJson(url: string): Promise<CommonsResponse> {
  const res = await fetch(url, {headers: {'user-agent': UA}, signal: AbortSignal.timeout(20_000)});
  if (!res.ok) throw new AssetProviderError('SEARCH_FAILED', `Wikimedia API HTTP ${res.status}`);
  return (await res.json()) as CommonsResponse;
}

export class WikimediaCommonsProvider implements AssetProvider {
  readonly name = 'wikimedia';

  async search(requirement: AssetRequirement, limit = 3): Promise<AssetSearchHit[]> {
    if (requirement.kind !== 'image') return [];
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      generator: 'search',
      gsrsearch: `filetype:bitmap ${requirement.query}`,
      gsrnamespace: '6',
      gsrlimit: String(limit * 2),
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
    });
    const data = await fetchJson(`${API}?${params.toString()}`);
    const pages = Object.values(data.query?.pages ?? {});
    const hits: AssetSearchHit[] = [];
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      if (!info.mime.startsWith('image/')) continue;
      const license = classifyLicense(info.extmetadata);
      const author = stripHtml(info.extmetadata?.Artist?.value ?? '');
      hits.push({
        provider: this.name,
        sourceUrl: info.descriptionurl,
        downloadUrl: info.url,
        mimeType: info.mime,
        width: info.width ?? null,
        height: info.height ?? null,
        description: stripHtml(info.extmetadata?.ImageDescription?.value ?? page.title).slice(0, 200) || page.title,
        licenseStatus: license.status,
        licenseNote: license.note,
        attribution: author ? `${author}, Wikimedia Commons` : 'Wikimedia Commons',
      });
    }
    return hits;
  }

  async download(hit: AssetSearchHit, destAbsPath: string): Promise<void> {
    const res = await fetch(hit.downloadUrl, {headers: {'user-agent': UA}, signal: AbortSignal.timeout(60_000)});
    if (!res.ok) throw new AssetProviderError('DOWNLOAD_FAILED', `下载失败 HTTP ${res.status}: ${hit.downloadUrl}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new AssetProviderError('DOWNLOAD_FAILED', `文件过小（${buf.length}B），疑似错误页`);
    fs.mkdirSync(path.dirname(destAbsPath), {recursive: true});
    fs.writeFileSync(destAbsPath, buf);
  }
}
