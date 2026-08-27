#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [inputRaw, outputRaw] = process.argv.slice(2);
if (!inputRaw || !outputRaw) throw new Error('Usage: build-r3a-preview-assets.mjs <input-props> <output-props>');

const root = path.resolve(import.meta.dirname, '..');
const input = path.resolve(root, inputRaw);
const output = path.resolve(root, outputRaw);
const manifestPath = path.resolve(root, 'src/data/r3a-historical-assets.json');
const props = JSON.parse(fs.readFileSync(input, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (props.data?.project?.projectId !== '3778ffb0-c430-4499-9f7f-2590f45cb8cb') {
  throw new Error('R3-A preview props project mismatch');
}
if (!props.data.scenes.every((scene) => scene.templateProps?.v2VisualR2?.version === 'dark-editorial-v1@1')) {
  throw new Error('R3-A preview requires explicit dark-editorial-v1@1 on every scene');
}

const byId = new Map(manifest.assets.map((asset) => [asset.assetId, asset]));
for (const asset of manifest.assets) {
  const absolutePath = path.resolve(root, 'public', asset.publicPath);
  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).size === 0) {
    throw new Error(`Historical preview asset missing: ${asset.assetId}`);
  }
}

const assetMap = {...props.data.assetMap};
for (const [sceneId, assetIds] of Object.entries(manifest.sceneAssets)) {
  assetMap[sceneId] = assetIds.map((assetId) => {
    const asset = byId.get(assetId);
    if (!asset) throw new Error(`Unknown historical asset: ${assetId}`);
    return {
      assetId: asset.assetId,
      publicPath: asset.publicPath,
      mediaType: asset.mediaType,
      width: asset.width,
      height: asset.height,
      description: asset.description,
      attribution: `${asset.creator}, ${asset.date}; ${asset.license}`,
      sourceUrl: asset.sourceUrl,
    };
  });
}

props.data.assetMap = assetMap;
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, `${JSON.stringify(props, null, 2)}\n`);
console.log(JSON.stringify({output, uniqueHistoricalAssets: manifest.assets.length, sceneAssets: manifest.sceneAssets}, null, 2));
