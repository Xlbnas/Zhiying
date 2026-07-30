/**
 * M6.3.11：Remotion bundle 缓存键。
 *
 * P0 根因：旧缓存键仅 TEMPLATE_VERSION（'freud-mg-v1.0' 自 M1 起未变），
 * renderer 源码演进（M6 asset/templateProps 管线）不会触发重建，
 * 持久卷上的 M1 陈旧 bundle 被无限复用 → Final Render 产出旧 Demo 视觉。
 *
 * 新键 = <TEMPLATE_VERSION>-<rendererSourceHash[:12]>：
 *   hash 覆盖 src/remotion/** 全部文件（相对路径 + 内容）+ scene-schema
 *   + remotion/@remotion/bundler 版本。
 * 源码或渲染依赖任何变化 → 新键 → cache miss → 重新打包；无变化 → 稳定命中。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HASH_INPUT_FILES = ['src/lib/scene-schema.ts'];
const HASH_INPUT_DIRS = ['src/remotion'];
const HASH_INPUT_PACKAGES = ['remotion', '@remotion/bundler'];

function walkFiles(dir: string, base: string, out: string[]): void {
  const entries = fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(abs, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, abs));
    }
  }
}

function packageVersion(rootDir: string, pkg: string): string {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'node_modules', pkg, 'package.json'), 'utf8');
    return (JSON.parse(raw) as {version?: string}).version ?? 'unknown';
  } catch {
    return 'missing';
  }
}

/**
 * 计算 renderer 源码 + 渲染依赖版本的内容 hash。
 * rootDir = 应用根（worker process.cwd()）；可指向临时目录用于测试。
 */
export function computeRendererSourceHash(rootDir: string): string {
  const hash = crypto.createHash('sha256');
  const feed = (relPath: string, content: Buffer | string): void => {
    hash.update(relPath);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  };
  for (const rel of HASH_INPUT_FILES) {
    const abs = path.join(rootDir, rel);
    if (fs.existsSync(abs)) feed(rel, fs.readFileSync(abs));
  }
  for (const relDir of HASH_INPUT_DIRS) {
    const absDir = path.join(rootDir, relDir);
    if (!fs.existsSync(absDir)) continue;
    const files: string[] = [];
    walkFiles(absDir, rootDir, files);
    for (const rel of files.sort()) {
      feed(rel, fs.readFileSync(path.join(rootDir, rel)));
    }
  }
  for (const pkg of HASH_INPUT_PACKAGES) {
    feed(`pkg:${pkg}`, packageVersion(rootDir, pkg));
  }
  return hash.digest('hex');
}

/** bundle 缓存目录键：template 版本 + 源码 hash 前缀。 */
export function bundleCacheKey(templateVersion: string, rootDir: string): string {
  return `${templateVersion}-${computeRendererSourceHash(rootDir).slice(0, 12)}`;
}
