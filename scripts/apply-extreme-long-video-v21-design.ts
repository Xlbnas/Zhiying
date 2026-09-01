import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {getDb} from '../src/lib/db';
import {getAssetById, getActiveBinding} from '../src/lib/assets/model';
import {scenesAiOutputSchema} from '../src/lib/prompts/scenes';
import {editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import {getVersion} from '../src/lib/workflow/versions';

const projectId = process.env.ZHIYING_PROJECT_ID ?? '8f955b4c-42dd-4a02-8e76-e721a37fab41';
const manifestPath = process.env.ZHIYING_V21_MANIFEST ?? path.join(process.cwd(), 'docs/long_video/scenes-design.json');
const requiredAssets: Record<string, string> = {
  S015: 'extreme-archive-S015-A20', S022: 'extreme-archive-S022-A03', S067: 'extreme-archive-S067-A11', S078: 'extreme-archive-S078-A05',
  S079: 'extreme-archive-S079-A06', S098: 'extreme-archive-S098-A07', S106: 'extreme-archive-S106-A15',
};
const chinese = (value: string) => value.replace(/[^\u4e00-\u9fff]/g, '');
const hasHighOverlap = (narration: string, thesis: string) => {
  const source = chinese(narration); const target = chinese(thesis);
  if (!target || source === target) return true;
  for (let width = Math.min(18, target.length); width >= 8; width -= 1) {
    for (let index = 0; index <= target.length - width; index += 1) if (source.includes(target.slice(index, index + width))) return true;
  }
  return false;
};
const manifest = scenesAiOutputSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
const stage = getDb().prepare('SELECT status, active_version, locked_version FROM project_stages WHERE project_id = ? AND stage = ?').get(projectId, 'scenes') as {status: string; active_version: number; locked_version: number | null} | undefined;
if (!stage?.locked_version || stage.status !== 'locked') throw new Error('scenes stage must be locked before applying V2.1');
const current = getVersion(projectId, 'scenes', stage.locked_version);
if (!current) throw new Error('locked scenes version is missing');
const existing = scenesAiOutputSchema.parse(JSON.parse(current.content));
assert.equal(existing.scenes.length, 111, 'existing scene count drift');
assert.equal(manifest.scenes.length, 111, 'V2.1 scene count drift');
for (const [index, scene] of manifest.scenes.entries()) {
  const old = existing.scenes[index];
  assert.ok(old, `${scene.id}: existing scene missing`);
  assert.equal(scene.id, old.id, `${scene.id}: scene order/id drift`);
  assert.equal(scene.narrationSummary, old.narrationSummary, `${scene.id}: frozen narration changed`);
  const memoryLab = scene.templateProps?.memoryLab as {visualThesis?: unknown; narrationText?: unknown; debugOverlay?: unknown; showSceneId?: unknown} | undefined;
  assert.equal(memoryLab?.narrationText, scene.narrationSummary, `${scene.id}: narration authority mismatch`);
  assert.equal(memoryLab?.debugOverlay, undefined, `${scene.id}: debugOverlay must not be set`);
  assert.equal(memoryLab?.showSceneId, undefined, `${scene.id}: showSceneId must not be set`);
  assert.ok(typeof memoryLab?.visualThesis === 'string' && !hasHighOverlap(scene.narrationSummary, String(memoryLab.visualThesis)), `${scene.id}: visual thesis conflicts with narration`);
}
const theses = manifest.scenes.map((scene) => String((scene.templateProps?.memoryLab as {visualThesis?: unknown} | undefined)?.visualThesis));
assert.equal(new Set(theses).size, 111, 'visual thesis must remain unique');
assert.deepEqual(manifest.scenes.filter((scene) => scene.assetRequirements.length).map((scene) => scene.id), Object.keys(requiredAssets), 'archive requirement scene set drift');
for (const scene of manifest.scenes.filter((item) => item.assetRequirements.length)) {
  const requirement = scene.assetRequirements[0];
  if (!requirement) throw new Error(`${scene.id}: archive requirement missing`);
  if (!requirement.requirementId) throw new Error(`${scene.id}: archive requirement ID missing`);
  const assetId = requiredAssets[scene.id]!;
  const asset = getAssetById(assetId);
  if (!asset || asset.project_id !== projectId || asset.license_status !== 'usable') throw new Error(`${scene.id}: required asset is not usable`);
  if (!fs.existsSync(path.join(process.cwd(), 'public', asset.local_path))) throw new Error(`${scene.id}: required asset file is missing`);
  const binding = getActiveBinding(projectId, scene.id, requirement.requirementId);
  if (!binding || binding.asset_id !== assetId) throw new Error(`${scene.id}: archive binding mismatch`);
}
const result = editVersion({
  projectId,
  stage: 'scenes',
  content: JSON.stringify(manifest),
  contentType: 'json',
  source: 'manual_edit',
  note: 'Visual Grammar V2.1: unique visual thesis, dark default, archive semantic binding, production clean master',
}, {confirmStale: true});
lockStage(projectId, 'scenes');
console.log(JSON.stringify({
  ok: true,
  projectId,
  previousScenes: {id: current.id, version: current.version},
  scenes: {id: result.id, version: result.version},
  visualThesisUnique: theses.length,
  archive: {requirements: 19, exact: 2, contextual: 5, editorialReplacement: 12, bound: Object.keys(requiredAssets).length},
  debugOverlay: false,
  showSceneId: false,
}, null, 2));
