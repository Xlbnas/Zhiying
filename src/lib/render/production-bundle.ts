import fs from 'node:fs';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {TEMPLATE_VERSION} from '@/lib/scene-schema';
import {bundleCacheKey} from '@/worker/bundle-key';

/**
 * The same Remotion entry point and webpack compatibility settings used by the
 * current Worker. The output directory is caller-owned so local render never
 * writes to a NAS path or mutates the production Worker cache.
 */
export async function ensureProductionBundle(outDir: string): Promise<string> {
  const bundleDir = path.resolve(outDir);
  const marker = path.join(bundleDir, 'index.html');
  if (fs.existsSync(marker)) return bundleDir;

  const entryPoint = path.resolve(process.cwd(), 'src/remotion/index.ts');
  if (!fs.existsSync(entryPoint)) throw new Error(`Remotion entry not found: ${entryPoint}`);
  fs.rmSync(bundleDir, {recursive: true, force: true});
  fs.mkdirSync(bundleDir, {recursive: true});

  return bundle({
    entryPoint,
    outDir: bundleDir,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        alias: {
          ...(config.resolve?.alias ?? {}),
          '@': path.resolve(process.cwd(), 'src'),
        },
      },
      module: {
        ...config.module,
        rules: (config.module?.rules ?? []).map((rule) => {
          if (!rule || typeof rule !== 'object' || !('use' in rule)) return rule;
          const uses = Array.isArray(rule.use) ? rule.use : [rule.use];
          return {
            ...rule,
            use: uses.map((use) => {
              if (
                !use || typeof use !== 'object' || !('loader' in use) ||
                typeof use.loader !== 'string' || !use.loader.includes('esbuild-loader')
              ) return use;
              const options = use.options && typeof use.options === 'object' ? use.options : {};
              return {...use, options: {...options, jsx: 'automatic'}};
            }),
          };
        }),
      },
    }),
  });
}

/** Stable identity for reports; it is not a new production baseline. */
export function productionBundleKey(): string {
  return bundleCacheKey(TEMPLATE_VERSION, process.cwd());
}
