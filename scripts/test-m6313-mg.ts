/**
 * M6.3.13 「改用 MG」fallback（scene-level authoritative override）测试（零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m6313-mg.ts
 *
 * 覆盖（对应验收清单）：
 *   A. 纯函数：canSwitchToMg 闸门 / applyVisualOverrides 应用与失效 / buildMgPreviewProps
 *   B. eligible scene preview+switch 成功；resolver 暴露/剔除 switch_to_mg；
 *      不 fake binding（deactivate 历史保留）；guards（acquire/upload/generate/bind 409）
 *   C. override 后 buildFinalRenderProps/evaluateVisualReadiness 走 MG 且 denominator 减少；
 *      visual-gate 对 MG props 校验
 *   D. scenes_version_id 漂移 → override 失效（requirement 回 denominator）
 *   E. revert 后回 pending；二次 revert 404
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m6313-mg');
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {
  bindAssetToRequirement,
  getActiveBinding,
  insertAsset,
  listActiveBindingsForProject,
  listBindingsForProject,
  type AssetRow,
} from '../src/lib/assets/model';
import {evaluateVisualReadiness} from '../src/lib/assets/readiness';
import {buildProjectResolution} from '../src/lib/assets/resolver';
import {buildSceneAssetPlan} from '../src/lib/assets/requirements';
import {buildFinalRenderProps} from '../src/lib/final-render/bridge';
import {compileTimingReconciliation} from '../src/lib/reconciliation/compiler';
import {validateFinalVisualProps} from '../src/lib/render/visual-gate';
import {validateTemplateProps} from '../src/lib/scenes/mg-templates';
import {
  applyVisualOverrides,
  buildMgPreviewProps,
  canSwitchToMg,
  currentScenesVersionId,
  getVisualOverride,
  isSceneVisuallyOverridden,
  listVisualOverrides,
  switchSceneToMg,
} from '../src/lib/scenes/visual-overrides';
import {scenesAiOutputSchema} from '../src/lib/prompts/scenes';
import type {Scene} from '../src/lib/scene-schema';
import {POST as mgPreviewPOST} from '../src/app/api/projects/[id]/assets/mg-preview/route';
import {POST as switchToMgPOST} from '../src/app/api/projects/[id]/assets/switch-to-mg/route';
import {POST as revertMgPOST} from '../src/app/api/projects/[id]/assets/revert-mg/route';
import {POST as resolvePOST} from '../src/app/api/projects/[id]/assets/resolve/route';
import {POST as uploadPOST} from '../src/app/api/projects/[id]/assets/upload/route';
import {POST as generatePOST} from '../src/app/api/projects/[id]/assets/generate/route';
import {POST as bindPOST} from '../src/app/api/projects/[id]/assets/generated/[candidateId]/bind/route';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail));
  }
}

// ---------- fixture helpers ----------

function scene(partial: Partial<Scene> & Pick<Scene, 'id'>): Scene {
  return {
    chapter: 1,
    chapterTitle: '第一章',
    start: 0,
    end: 10,
    duration: 10,
    startFrame: 0,
    durationInFrames: 300,
    category: 'B-roll',
    visualType: 'Asset',
    template: null,
    sourceTemplate: null,
    assetRequirements: [],
    narrationSummary: '拖延并不是时间管理的问题',
    description: '一个人在书桌前犹豫不决',
    notes: '',
    assetIds: [],
    licenseStatus: 'not-applicable',
    subtitlePosition: 'bottom',
    transitionIn: 'none',
    transitionOut: 'cut',
    ...partial,
  } as Scene;
}

const REQ_BROLL = {
  kind: 'image' as const, subject: '书桌前的人', query: 'person at desk',
  usage: 'primary' as const, policy: 'public_domain' as const, requirementId: 'S001-R01',
};
const REQ_ARCHIVE = {
  kind: 'image' as const, subject: '弗洛伊德肖像', query: 'Freud portrait',
  usage: 'primary' as const, policy: 'public_domain' as const, requirementId: 'S002-R01',
};

/** P1 fixture：S001 B-roll（eligible）+ S002 Archive（authentic_required）。语义校验不作要求。 */
function p1Artifact(): string {
  return JSON.stringify({
    chapterTiming: [{chapter: 1, title: '第一章', start: 0, end: 20}],
    scenes: [
      scene({id: 'S001', assetRequirements: [REQ_BROLL]}),
      scene({id: 'S002', start: 10, end: 20, startFrame: 300, category: 'Archive', visualType: 'Archive', assetRequirements: [REQ_ARCHIVE]}),
    ],
  });
}

/** P3 fixture：语义校验完全合法的 2 个 B-roll scene（buildFinalRenderProps 用）。 */
function p3Artifact(): string {
  return JSON.stringify({
    chapterTiming: [{chapter: 1, title: '第一章', start: 0, end: 20}],
    scenes: [
      scene({id: 'S001', assetRequirements: [REQ_BROLL]}),
      scene({id: 'S002', start: 10, end: 20, startFrame: 300, assetRequirements: [{...REQ_ARCHIVE, requirementId: 'S002-R01'}]}),
    ],
  });
}

function seedProject(projectId: string, artifact: string): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(projectId, `测试项目 ${projectId}`, now, now);
  getDb().prepare(
    `INSERT INTO project_versions (id, project_id, stage, version, content, content_type, source, created_at)
     VALUES (?, ?, 'scenes', 1, ?, 'json', 'repair', ?)`,
  ).run(`${projectId}-scenes-v1`, projectId, artifact, now);
}

function scenesOf(projectId: string): Scene[] {
  const row = getDb().prepare(
    `SELECT content FROM project_versions WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1`,
  ).get(projectId) as {content: string};
  return (JSON.parse(row.content) as {scenes: Scene[]}).scenes;
}

function seedAsset(input: Parameters<typeof insertAsset>[0]): AssetRow {
  const row = insertAsset(input);
  const abs = path.join(process.cwd(), 'public', row.local_path);
  fs.mkdirSync(path.dirname(abs), {recursive: true});
  fs.writeFileSync(abs, Buffer.from(`fake-image-${row.id}`));
  return row;
}

function uploadAssetInput(projectId: string, sceneId: string, requirement: typeof REQ_BROLL): Parameters<typeof insertAsset>[0] {
  return {
    projectId, sceneId, mediaType: 'image', sourceType: 'upload', sourceProvider: 'user_upload',
    sourceUrl: null, localPath: `assets/${projectId}/${crypto.randomUUID()}.jpg`, mimeType: 'image/jpeg',
    licenseStatus: 'user_provided', licenseNote: '用户上传', attribution: 'x.jpg',
    description: requirement.subject, requirement,
  };
}

function cleanupFiles(projectId: string): void {
  fs.rmSync(path.join(process.cwd(), 'public', 'assets', projectId), {recursive: true, force: true});
}

const jsonReq = (body: unknown): Request =>
  new Request('http://test/mg', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

const params = (id: string): {params: Promise<{id: string}>} => ({params: Promise.resolve({id})});

// ---------- main ----------

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m6313-mg'), {recursive: true, force: true});
  getDb();

  // ============ A. 纯函数 ============
  {
    const brollPlan = buildSceneAssetPlan(scene({id: 'S001', assetRequirements: [REQ_BROLL]}));
    const archivePlan = buildSceneAssetPlan(scene({id: 'S002', category: 'Archive', assetRequirements: [REQ_ARCHIVE]}));
    ok(canSwitchToMg(brollPlan).ok === true, '[A01] B-roll（synthetic_allowed）可改用 MG');
    const no = canSwitchToMg(archivePlan);
    ok(no.ok === false && typeof no.reason === 'string', '[A02] Archive（authentic_required）禁止改用 MG + 原因', no);

    const raw = scene({id: 'S001', assetRequirements: [REQ_BROLL]});
    const override = {sceneId: 'S001', scenesVersionId: 'v1', strategy: 'mg', template: 'MG_MessageFocus', templateProps: {message: '核心论断'}};
    const applied = applyVisualOverrides([raw], [override], 'v1');
    ok(applied[0]!.category === 'MG' && applied[0]!.visualType === 'MG', '[A03] override 命中 → category/visualType 切 MG');
    ok(applied[0]!.template === 'MG_MessageFocus' && applied[0]!.sourceTemplate === 'MG_MessageFocus', '[A04] template/sourceTemplate 注入');
    ok(applied[0]!.duration === raw.duration && applied[0]!.narrationSummary === raw.narrationSummary && applied[0]!.startFrame === raw.startFrame, '[A05] 其他字段（时长/摘要/帧）一律不动');
    ok(applyVisualOverrides([raw], [override], 'v2')[0]!.category === 'B-roll', '[A06] version 不匹配 → 跳过（失效）');
    ok(applyVisualOverrides([raw], [override], null)[0]!.category === 'B-roll', '[A07] 无当前版本 → 不应用');

    const withYears = scene({id: 'S009', narrationSummary: '1900 年《梦的解析》出版，1950 年学界重新评价'});
    ok(buildMgPreviewProps(withYears)?.template === 'MG_Timeline', '[A08] 含 ≥2 年份 → deterministic 选 MG_Timeline');
    const plain = buildMgPreviewProps(scene({id: 'S010'}));
    ok(plain?.template === 'MG_MessageFocus' && validateTemplateProps(plain.template, plain.templateProps).ok, '[A09] 无年份 → 兜底 MG_MessageFocus 且过 schema');
    ok(buildMgPreviewProps(scene({id: 'S011', narrationSummary: '  ', description: ' ' })) === null, '[A10] 空文案 → 构建不出（null → 409）');
  }

  // ============ B. P1：preview + switch + resolver + guards ============
  const P1 = 'test-mg-p1';
  seedProject(P1, p1Artifact());
  {
    const scenes = scenesOf(P1);
    // resolver：switch_to_mg 暴露/剔除 + 原因字段
    const r0 = buildProjectResolution(P1, scenes);
    const s001 = r0.find((x) => x.sceneId === 'S001')!;
    const s002 = r0.find((x) => x.sceneId === 'S002')!;
    ok(s001.requirements[0]!.availableActions.includes('switch_to_mg'), '[B01] eligible scene resolver 暴露 switch_to_mg');
    ok(s001.requirements[0]!.switchToMgEligible === true, '[B02] eligible → switchToMgEligible=true');
    ok(!s002.requirements[0]!.availableActions.includes('switch_to_mg'), '[B03] authentic_required → resolver 不暴露 switch_to_mg');
    ok(s002.requirements[0]!.switchToMgEligible === false && !!s002.requirements[0]!.switchToMgDisabledReason, '[B04] authentic_required → 原因字段供 UI 展示');

    // mg-preview
    const prev1 = await mgPreviewPOST(jsonReq({sceneId: 'S001'}), params(P1));
    const prev1Body = (await prev1.json()) as {template: string; templateProps: Record<string, unknown>};
    ok(prev1.status === 200 && prev1Body.template === 'MG_MessageFocus', '[B05] eligible scene preview 200 + deterministic 模板', prev1Body);
    ok(validateTemplateProps(prev1Body.template, prev1Body.templateProps).ok, '[B06] preview props 过 validateTemplateProps');
    const prev2 = await mgPreviewPOST(jsonReq({sceneId: 'S002'}), params(P1));
    ok(prev2.status === 409 && ((await prev2.json()) as {error: string}).error === 'mg_switch_not_allowed', '[B07] authentic_required preview → 409');

    // 先绑定 S001（验证 switch 后 deactivate、不 fake binding）
    const a1 = seedAsset(uploadAssetInput(P1, 'S001', REQ_BROLL));
    bindAssetToRequirement({projectId: P1, sceneId: 'S001', requirementId: 'S001-R01', assetId: a1.id});
    ok(evaluateVisualReadiness(P1, scenes).readyRequirements === 1, '[B08] switch 前 S001 已绑定（1/2）');

    // switch：坏 props 400 / authentic 409 / 合法 200
    const bad = await switchToMgPOST(jsonReq({sceneId: 'S001', template: 'MG_MessageFocus', templateProps: {message: ''}}), params(P1));
    ok(bad.status === 400 && ((await bad.json()) as {error: string}).error === 'invalid_template_props', '[B09] 非法 templateProps → 400（服务端不信客户端）');
    const denied = await switchToMgPOST(jsonReq({sceneId: 'S002', template: 'MG_MessageFocus', templateProps: {message: 'x'}}), params(P1));
    ok(denied.status === 409, '[B10] authentic_required switch → 409');
    const switched = await switchToMgPOST(jsonReq({sceneId: 'S001', template: prev1Body.template, templateProps: prev1Body.templateProps}), params(P1));
    ok(switched.status === 200 && ((await switched.json()) as {switched: boolean}).switched === true, '[B11] eligible switch → 200');

    const ov = getVisualOverride(P1, 'S001');
    ok(ov !== null && ov.scenesVersionId === currentScenesVersionId(P1), '[B12] override 落库且携带当前 scenes 版本行 id');
    ok(getActiveBinding(P1, 'S001', 'S001-R01') === undefined, '[B13] switch 后无 active binding（不 fake binding）');
    const hist = listBindingsForProject(P1).filter((b) => b.scene_id === 'S001');
    ok(hist.length === 1 && hist[0]!.active === 0, '[B14] 旧 binding 转历史（active=0）保留');

    // override 后 resolver / readiness
    const r1 = buildProjectResolution(P1, scenes);
    const s001After = r1.find((x) => x.sceneId === 'S001')!;
    ok(s001After.mgOverride?.template === 'MG_MessageFocus' && s001After.totalRequired === 0, '[B15] override 后 resolver 暴露 mgOverride 且需求清零');
    ok(s001After.category === 'MG', '[B16] override 后 resolver category=MG');
    const v1 = evaluateVisualReadiness(P1, scenes);
    ok(v1.needAssets === 1 && v1.missing.every((m) => m.sceneId === 'S002'), '[B17] denominator 减少（2→1），missing 只剩 S002');

    // guards：已 override scene 的 requirement 操作一律 409
    const gAcquire = await resolvePOST(jsonReq({sceneId: 'S001', requirementId: 'S001-R01'}), params(P1));
    ok(gAcquire.status === 409 && ((await gAcquire.json()) as {error: string}).error === 'scene_overridden', '[B18] override 后 acquire（resolve POST）→ 409');
    const form = new FormData();
    form.append('file', new File([Buffer.from('x')], 'a.jpg', {type: 'image/jpeg'}));
    form.append('sceneId', 'S001');
    form.append('requirementId', 'S001-R01');
    const gUpload = await uploadPOST(new Request('http://test/upload', {method: 'POST', body: form}), params(P1));
    ok(gUpload.status === 409, '[B19] override 后 upload → 409');
    const gGenerate = await generatePOST(jsonReq({sceneId: 'S001', requirementId: 'S001-R01', prompt: 'x'}), params(P1));
    ok(gGenerate.status === 409, '[B20] override 后 generate → 409（守卫在计费之前）');
    const cand = seedAsset({
      projectId: P1, sceneId: 'S001', mediaType: 'image', sourceType: 'generated', sourceProvider: 'apiyi',
      sourceUrl: null, localPath: `assets/${P1}/${crypto.randomUUID()}.jpg`, mimeType: 'image/jpeg',
      licenseStatus: 'generated', licenseNote: 'AI 生成 (待确认)', attribution: 'API易 / test',
      description: REQ_BROLL.subject, requirement: REQ_BROLL,
    });
    const gBind = await bindPOST(jsonReq({sceneId: 'S001', requirementId: 'S001-R01'}), {params: Promise.resolve({id: P1, candidateId: cand.id})});
    ok(gBind.status === 409, '[B21] override 后 bind candidate → 409');
    // 清理 bind 守卫测试用的未绑定候选（否则 revert 后 resolver 推导 candidate_waiting 而非 pending）
    getDb().prepare('DELETE FROM assets WHERE id = ?').run(cand.id);

    // ============ E. revert ============
    const rev = await revertMgPOST(jsonReq({sceneId: 'S001'}), params(P1));
    ok(rev.status === 200 && ((await rev.json()) as {reverted: boolean}).reverted === true, '[E01] revert → 200');
    ok(listVisualOverrides(P1).length === 0, '[E02] revert 后 override 删除');
    const r2 = buildProjectResolution(P1, scenes);
    const s001Rev = r2.find((x) => x.sceneId === 'S001')!;
    ok(s001Rev.mgOverride == null && s001Rev.requirements[0]!.status === 'pending', '[E03] revert 后 requirement 回 pending（旧 binding 不自动恢复）');
    ok(evaluateVisualReadiness(P1, scenes).needAssets === 2, '[E04] revert 后 denominator 恢复为 2');
    const rev2 = await revertMgPOST(jsonReq({sceneId: 'S001'}), params(P1));
    ok(rev2.status === 404, '[E05] 二次 revert → 404');
  }

  // ============ C. P3：buildFinalRenderProps / readiness 走 MG + visual-gate ============
  const P3 = 'test-mg-p3';
  seedProject(P3, p3Artifact());
  {
    const parsed = scenesAiOutputSchema.parse(JSON.parse(p3Artifact()));
    const versionId = currentScenesVersionId(P3)!;
    // S002 绑定真实文件素材（最终 readiness 全绿）
    const a2 = seedAsset(uploadAssetInput(P3, 'S002', {...REQ_ARCHIVE, requirementId: 'S002-R01'}));
    bindAssetToRequirement({projectId: P3, sceneId: 'S002', requirementId: 'S002-R01', assetId: a2.id});

    const before = evaluateVisualReadiness(P3, parsed.scenes);
    ok(before.needAssets === 2 && !before.ready, '[C01] switch 前 needAssets=2 且未就绪');

    switchSceneToMg({
      projectId: P3, sceneId: 'S001', scenesVersionId: versionId,
      template: 'MG_MessageFocus', templateProps: {message: '拖延不是时间管理问题'},
      requirements: buildSceneAssetPlan(parsed.scenes[0]!).requirements,
    });
    const after = evaluateVisualReadiness(P3, parsed.scenes);
    ok(after.needAssets === 1 && after.ready === true, '[C02] override 后 denominator 减少（2→1）且整体 ready（MG + 已绑定）');

    const rec = compileTimingReconciliation({
      scenes: parsed,
      refs: {
        scenesVersionId: versionId, scenesVersion: 1,
        narrationAudioArtifactId: 'aud-1', narrationAudioArtifactVersion: 1,
        subtitleTimingArtifactId: 'sub-1', subtitleTimingArtifactVersion: 1,
        narrationPlanArtifactId: 'plan-1', narrationPlanArtifactVersion: 1,
        scriptV2Version: 1, narrationCompilerVersion: '1', subtitleCompilerVersion: '1',
        masterSha256: 'x', masterDurationMs: 20000,
      },
      unresolvedNarrationUnitIds: [],
    });
    const props = buildFinalRenderProps({
      projectId: P3,
      title: '测试',
      templateVersion: 'freud-mg-v1.0',
      src: {
        scenes: {kind: 'ready', versionId, version: 1, data: parsed},
        audio: {artifact: {id: 'aud-1', version: 1}, manifest: {master: {durationMs: 20000, sha256: 'x', filePath: 'x.wav'}} as never},
        subtitle: {artifact: {id: 'sub-1', version: 1}, timing: {cues: [], compilerVersion: '1'} as never},
        reconciliation: {artifact: {id: 'rec-1', version: 1}, reconciliation: rec},
      },
    });
    const pS001 = props.data.scenes.find((s) => s.id === 'S001')!;
    ok(pS001.category === 'MG' && pS001.template === 'MG_MessageFocus', '[C03] buildFinalRenderProps 输出 scene 走 MG');
    ok((pS001.templateProps as {message?: string})?.message === '拖延不是时间管理问题', '[C04] templateProps 到达最终 props');
    ok((props.data.assetMap?.['S002']?.length ?? 0) === 1 && props.data.assetMap?.['S001'] === undefined, '[C05] assetMap 只含未 override 的 S002');
    const gate = validateFinalVisualProps(props, {assetFileExists: () => true});
    ok(gate.ok === true, '[C06] visual-gate：MG + 已绑定素材 → 通过', gate);
    const tampered = {
      ...props,
      data: {...props.data, scenes: props.data.scenes.map((s) => s.id === 'S001' ? {...s, templateProps: {message: ''}} : s)},
    };
    const gate2 = validateFinalVisualProps(tampered, {assetFileExists: () => true});
    ok(gate2.ok === false && gate2.issues.some((i) => i.sceneId === 'S001'), '[C07] visual-gate：非法 MG props → 拦截', gate2);
  }

  // ============ D. P4：scenes_version_id 漂移 → override 失效 ============
  const P4 = 'test-mg-p4';
  seedProject(P4, JSON.stringify({
    chapterTiming: [{chapter: 1, title: '第一章', start: 0, end: 10}],
    scenes: [scene({id: 'S001', assetRequirements: [REQ_BROLL]})],
  }));
  {
    const scenes = scenesOf(P4);
    const prev = await mgPreviewPOST(jsonReq({sceneId: 'S001'}), params(P4));
    const prevBody = (await prev.json()) as {template: string; templateProps: Record<string, unknown>};
    const sw = await switchToMgPOST(jsonReq({sceneId: 'S001', template: prevBody.template, templateProps: prevBody.templateProps}), params(P4));
    ok(sw.status === 200, '[D01] P4 switch 成功');
    ok(evaluateVisualReadiness(P4, scenes).needAssets === 0, '[D02] switch 后 denominator=0（MG 无需素材）');

    // scenes 重新生成 → 新版本行（id 漂移）
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO project_versions (id, project_id, stage, version, content, content_type, source, created_at)
       VALUES (?, ?, 'scenes', 2, ?, 'json', 'ai_generate', ?)`,
    ).run(`${P4}-scenes-v2`, P4, JSON.stringify({
      chapterTiming: [{chapter: 1, title: '第一章', start: 0, end: 10}],
      scenes: [scene({id: 'S001', assetRequirements: [REQ_BROLL]})],
    }), now);

    const drifted = evaluateVisualReadiness(P4, scenesOf(P4));
    ok(drifted.needAssets === 1 && !drifted.ready, '[D03] version 漂移 → override 失效，requirement 回 denominator');
    ok(isSceneVisuallyOverridden(P4, 'S001') === false, '[D04] version 漂移 → 守卫解除（可重新准备素材）');
    const r = buildProjectResolution(P4, scenesOf(P4));
    ok(r[0]!.mgOverride == null && r[0]!.totalRequired === 1, '[D05] version 漂移 → resolver 不再视为 MG');
    // 失效后可在新版本上重新 switch
    const sw2 = await switchToMgPOST(jsonReq({sceneId: 'S001', template: prevBody.template, templateProps: prevBody.templateProps}), params(P4));
    ok(sw2.status === 200 && getVisualOverride(P4, 'S001')!.scenesVersionId === currentScenesVersionId(P4), '[D06] 新版本上可重新 switch（override 指向新版本）');
  }

  // ---------- 收尾 ----------
  cleanupFiles(P1);
  cleanupFiles(P3);
  cleanupFiles(P4);
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m6313-mg'), {recursive: true, force: true});

  console.log(`\n${pass} PASS / ${fail} FAIL / ${pass + fail} TOTAL`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
