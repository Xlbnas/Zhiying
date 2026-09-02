import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {ARCHIVE_VISUAL_PRESENTATION_V1} from '../src/remotion/templates/production/MemoryLabEditorialScene';

const root = process.cwd();
const renderer = fs.readFileSync(path.join(root, 'src/remotion/templates/production/MemoryLabEditorialScene.tsx'), 'utf8');
const design = JSON.parse(fs.readFileSync(path.join(root, 'docs/long_video/scenes-design.json'), 'utf8')) as {scenes: Array<{id: string}>};
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {dependencies: Record<string, string>};
const sha256 = (relativePath: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');

assert.deepEqual(ARCHIVE_VISUAL_PRESENTATION_V1, {
  S015: 'SOURCE_CHAIN_WITH_SUPPORTING_THUMBNAIL',
  S022: 'IDENTITY',
  S067: 'CONTEXT',
  S078: 'CONTEXT',
  S079: 'EDITORIAL_REPLACEMENT',
  S098: 'CONTEXT_WITH_ANNOTATION',
  S106: 'RECORD_CHAIN_WITH_SUPPORTING_DOCUMENT',
});
assert.equal(design.scenes.length, 111, 'scene boundary count changed');
assert.equal(pkg.dependencies['@remotion/renderer'], '4.0.492', 'Remotion version changed');
assert.equal(sha256('outputs/extreme-long-video/audio/narration-master.wav'), '658235d97a94f67feb9bc50d0849e7b15c2edf85f95b8db229b40b12a2460997', 'frozen audio changed');
assert.equal(sha256('outputs/extreme-long-video/subtitles/subtitle_timing_v2.json'), 'dfab1dab6b1ef7707b9d6173b44455428ec6e59b74c81c528a6ed8a3ea29237b', 'frozen subtitle timing changed');
assert.match(renderer, /scene\.id === 'S079' \? undefined : boundAsset/, 'S079 must use its existing editorial family instead of a second similar lineup image');
assert.match(renderer, /来源卷 · 不是《幽灵之战》的故事原页/, 'S015 scope disclosure missing');
assert.match(renderer, /1880–1893 讲义笔记/, 'S106 content-bearing annotation missing');
assert.match(renderer, /St\. Louis Police Lantern Slides \/ DPLA · 无已知版权限制/, 'human-readable lineup attribution missing');
assert.match(renderer, /真实家庭故事 → 研究者加入的虚构事件/, 'S098 contextual annotation missing');

console.log(JSON.stringify({
  ok: true,
  scenes: design.scenes.length,
  archiveScenes: Object.keys(ARCHIVE_VISUAL_PRESENTATION_V1).length,
  editorialReplacements: 1,
  remotion: pkg.dependencies['@remotion/renderer'],
}, null, 2));
