import fs from 'node:fs';
import path from 'node:path';
import {getDb} from '../src/lib/db';
import {getActiveBinding, getAssetById, insertAsset, bindAssetToRequirement} from '../src/lib/assets/model';
import {type AssetRequirement, type Scene} from '../src/lib/scene-schema';
import {scenesAiOutputSchema} from '../src/lib/prompts/scenes';
import {editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import {getVersion} from '../src/lib/workflow/versions';

const PROJECT_ID = '8f955b4c-42dd-4a02-8e76-e721a37fab41';
const EXPECTED_V1_ID = '94b1697c-a9c5-4bb1-ab20-9b8a5a933b34';
const STAGING = process.env.ZHIYING_ARCHIVE_STAGING_DIR;
if (!STAGING) throw new Error('ZHIYING_ARCHIVE_STAGING_DIR is required');

type BindingSpec = {
  sceneId: string;
  assetKey: string;
  filename: string;
  classification: 'EXACT_EVIDENCE' | 'CONTEXTUAL_ARCHIVE';
  provider: string;
  sourceUrl: string;
  license: string;
  creator: string;
};

const bindings: BindingSpec[] = [
  {sceneId: 'S015', assetKey: 'A20', filename: '20-kathlamet-texts.jpg', classification: 'EXACT_EVIDENCE', provider: 'Wikimedia Commons / Internet Archive', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Kathlamet_texts_(IA_kathlamettexts00boas).pdf', license: 'Public domain', creator: 'Franz Boas'},
  {sceneId: 'S022', assetKey: 'A03', filename: '03-elizabeth-loftus.jpg', classification: 'EXACT_EVIDENCE', provider: 'Wikimedia Commons', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Elizabeth_Loftus.jpg', license: 'CC BY-SA 4.0', creator: 'Vishakabhat'},
  {sceneId: 'S067', assetKey: 'A11', filename: '11-radio-listeners.jpg', classification: 'CONTEXTUAL_ARCHIVE', provider: 'Wikimedia Commons / Library of Congress', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Australian_Army_Y.M.C.A._in_Julis_Camp._Group_of_soldiers_listening_to_the_radio_LOC_matpc.20685.jpg', license: 'Public domain', creator: 'Matson Collection'},
  {sceneId: 'S078', assetKey: 'A05', filename: '05-lineup-room-a.jpg', classification: 'CONTEXTUAL_ARCHIVE', provider: 'Wikimedia Commons / DPLA / Missouri Historical Society', sourceUrl: 'https://commons.wikimedia.org/wiki/File:St._Louis_Police_Lantern_Slides-_Lineup_room._-_DPLA_-_27075ec69414cd73820bdf76f0cb6a72.jpg', license: 'No restrictions', creator: 'Unknown'},
  {sceneId: 'S079', assetKey: 'A06', filename: '06-lineup-room-b.jpg', classification: 'CONTEXTUAL_ARCHIVE', provider: 'Wikimedia Commons / DPLA / Missouri Historical Society', sourceUrl: 'https://commons.wikimedia.org/wiki/File:St._Louis_Police_Lantern_Slides-_Lineup_room._-_DPLA_-_3aca7e00dc4babf4b3d7424214663ee8.jpg', license: 'No restrictions', creator: 'Unknown'},
  {sceneId: 'S098', assetKey: 'A07', filename: '07-indiana-family.jpg', classification: 'CONTEXTUAL_ARCHIVE', provider: 'Wikimedia Commons / DPLA', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Indiana_family_photo,_c._1900.jpg', license: 'Public domain', creator: 'Unknown'},
  {sceneId: 'S106', assetKey: 'A15', filename: '15-notebook-page-37.jpg', classification: 'CONTEXTUAL_ARCHIVE', provider: 'Wikimedia Commons / DPLA / Indiana State Library', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Grace_Julian_Clarke_freshman_lectures_notebook,_1880-1893_-_DPLA_-_c7d173cf312b48aa477541bbcccae752_(page_37).jpg', license: 'Public domain', creator: 'Grace Julian Clarke'},
];

const retained = new Map(bindings.map((item) => [item.sceneId, item]));
const editorialFamilies: Record<string, string> = {
  S013: 'source-attribution', S018: 'trace-comparison', S019: 'experimental-stage',
  S021: 'provenance-chain', S053: 'trace-comparison', S058: 'procedure-safeguard',
  S066: 'procedure-safeguard', S076: 'longitudinal-record', S083: 'procedure-safeguard',
  S084: 'procedure-safeguard', S087: 'procedure-safeguard', S090: 'experimental-stage',
};

function transformedScene(scene: Scene): Scene {
  if (!scene.assetRequirements.length) return scene;
  const kept = retained.get(scene.id);
  const memoryLab = {...((scene.templateProps?.memoryLab ?? {}) as Record<string, unknown>)};
  if (!kept) {
    return {
      ...scene,
      category: 'Minimal',
      visualType: 'Minimal',
      templateProps: {memoryLab: {...memoryLab, family: editorialFamilies[scene.id] ?? 'provenance-chain'}},
      assetRequirements: [],
      assetIds: [],
      licenseStatus: 'not-applicable',
      notes: `${scene.notes}; archive semantic audit -> EDITORIAL_REPLACEMENT`,
    };
  }
  const req = scene.assetRequirements[0] as AssetRequirement;
  const contextual = kept.classification === 'CONTEXTUAL_ARCHIVE';
  return {
    ...scene,
    assetRequirements: [{...req, subject: `${kept.classification}: ${req.subject}`}],
    templateProps: {memoryLab: {
      ...memoryLab,
      supporting: contextual
        ? `背景资料 - 非研究现场/参与者。${String(memoryLab.supporting ?? '')}`
        : `真实人物或原始来源；不把封面/肖像表示为实验现场。${String(memoryLab.supporting ?? '')}`,
    }},
    notes: `${scene.notes}; archive semantic audit -> ${kept.classification}`,
  };
}

const stage = getDb().prepare('SELECT status,active_version,locked_version FROM project_stages WHERE project_id=? AND stage=?').get(PROJECT_ID, 'scenes') as {status: string; active_version: number; locked_version: number};
const current = getVersion(PROJECT_ID, 'scenes', stage.active_version);
if (!current) throw new Error('active scenes version is missing');
if (current.version === 1 && current.id !== EXPECTED_V1_ID) throw new Error(`unexpected scenes v1 identity: ${current.id}`);
const original = scenesAiOutputSchema.parse(JSON.parse(current.content));
const transformed = scenesAiOutputSchema.parse({...original, scenes: original.scenes.map(transformedScene)});
const alreadyApplied = transformed.scenes.every((scene) => scene.notes?.includes('archive semantic audit') || !original.scenes.find((item) => item.id === scene.id)?.assetRequirements.length);

let scenesRow = current;
if (!(stage.status === 'locked' && current.version > 1 && alreadyApplied)) {
  scenesRow = editVersion({
    projectId: PROJECT_ID,
    stage: 'scenes',
    content: JSON.stringify(transformed),
    contentType: 'json',
    source: 'manual_edit',
    note: 'archive semantic audit: 2 exact, 5 contextual, 12 editorial replacements',
  }, {confirmStale: true});
  lockStage(PROJECT_ID, 'scenes');
}

for (const spec of bindings) {
  const scene = transformed.scenes.find((item) => item.id === spec.sceneId);
  const requirement = scene?.assetRequirements[0];
  if (!scene || !requirement) throw new Error(`${spec.sceneId} retained requirement is missing`);
  if (!requirement.requirementId) throw new Error(`${spec.sceneId} retained requirement has no stable ID`);
  const assetId = `extreme-archive-${spec.sceneId}-${spec.assetKey}`;
  const ext = path.extname(spec.filename);
  const localPath = path.posix.join('assets', PROJECT_ID, `${assetId}${ext}`);
  const sourcePath = path.join(STAGING, spec.filename);
  const targetPath = path.join(process.cwd(), 'public', localPath);
  const stat = fs.statSync(sourcePath);
  if (stat.size < 1024) throw new Error(`${sourcePath} is too small`);
  fs.mkdirSync(path.dirname(targetPath), {recursive: true});
  if (!fs.existsSync(targetPath)) {
    const tempPath = `${targetPath}.tmp`;
    fs.copyFileSync(sourcePath, tempPath);
    fs.renameSync(tempPath, targetPath);
  }
  if (!getAssetById(assetId)) {
    insertAsset({
      id: assetId,
      projectId: PROJECT_ID,
      sceneId: spec.sceneId,
      mediaType: 'image',
      sourceType: 'archive',
      sourceProvider: spec.provider,
      sourceUrl: spec.sourceUrl,
      localPath,
      mimeType: ext === '.png' ? 'image/png' : 'image/jpeg',
      licenseStatus: 'usable',
      licenseNote: spec.license,
      attribution: `${spec.classification === 'CONTEXTUAL_ARCHIVE' ? '背景资料 - 非研究现场/参与者 | ' : ''}${spec.creator} | ${spec.license}`,
      description: requirement.subject,
      requirement,
    });
  }
  const active = getActiveBinding(PROJECT_ID, spec.sceneId, requirement.requirementId);
  if (!active || active.asset_id !== assetId) {
    bindAssetToRequirement({projectId: PROJECT_ID, sceneId: spec.sceneId, requirementId: requirement.requirementId, assetId});
  }
}

console.log(JSON.stringify({
  projectId: PROJECT_ID,
  scenes: {id: scenesRow.id, version: scenesRow.version},
  archiveAudit: {total: 19, exact: 2, contextual: 5, editorialReplacements: 12, unbound: 0, rightsBlockedCandidatesExcluded: 1},
  bindings: bindings.map((item) => ({sceneId: item.sceneId, assetId: `extreme-archive-${item.sceneId}-${item.assetKey}`, classification: item.classification})),
}, null, 2));
