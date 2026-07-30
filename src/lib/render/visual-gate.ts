/**
 * M6.3.12：Final Render 的 render-input readiness gate + 最终视觉审计（P0）。
 *
 * 与 domain readiness（assets/readiness.ts：binding/license/文件存在）互补：
 * 本模块校验「renderer 真正消费的 props」——assetMap 是否注入、MG templateProps
 * 是否随 props 到达 renderer、素材物理文件是否可读。两个 gate 都过才允许
 * Final Render（bridge enqueue 与 worker runJob 双点兜底）。
 *
 * 历史 P0：domain readiness 全绿，但 TimedScene 字段裁剪丢弃 templateProps，
 * renderer 收到 undefined → 全部 MG scene 渲染成「视觉素材待准备」占位。
 * 本 gate 直接以最终 props 为准，杜绝该类 gate/renderer 分歧。
 *
 * auditFinalVisuals 产出视觉分布/静态时长/素材复用数据（不落硬阈值，供报告
 * 与面板技术详情）；placeholder 类恒为 0——final 模式 placeholder 已 throw
 * （render-mode.ts），能走到审计即代表无占位。
 */
import type {Scene, ZhiyingFullCutProps} from '../scene-schema';
import {MG_TEMPLATES, validateTemplateProps} from '../scenes/mg-templates';

// ---------- render-input gate ----------

export interface VisualGateIssue {
  sceneId: string;
  reason: string;
}

export type VisualGateResult = {ok: true} | {ok: false; issues: VisualGateIssue[]};

export interface VisualGateOptions {
  /** public 相对路径（如 assets/<pid>/x.jpg）→ 物理文件是否存在且非空。 */
  assetFileExists: (publicPath: string) => boolean;
}

/**
 * 逐 scene 验证 Final renderer 视觉输入可解析：
 * - MG：template 已注册 + templateProps 通过模板 schema（与 renderer 分派一致）
 * - Archive/B-roll：assetMap[sceneId] 非空；renderer 消费的首个素材是 image
 *   且全部素材物理文件存在
 * - 其余 category（Minimal 等 typography 驱动）：无外部视觉输入，直接通过
 */
export function validateFinalVisualProps(
  props: ZhiyingFullCutProps,
  opts: VisualGateOptions,
): VisualGateResult {
  const issues: VisualGateIssue[] = [];
  const assetMap = props.data.assetMap ?? {};
  for (const scene of props.data.scenes) {
    if (scene.category === 'MG') {
      const template = scene.template;
      if (!template) {
        issues.push({sceneId: scene.id, reason: 'MG scene 缺少 template'});
        continue;
      }
      if (!MG_TEMPLATES[template]) {
        issues.push({sceneId: scene.id, reason: `未知 MG 模板：${template}`});
        continue;
      }
      const check = validateTemplateProps(template, scene.templateProps);
      if (!check.ok) {
        issues.push({sceneId: scene.id, reason: check.message});
      }
      continue;
    }
    if (scene.category === 'Archive' || scene.category === 'B-roll') {
      const assets = assetMap[scene.id];
      if (!assets || assets.length === 0) {
        issues.push({sceneId: scene.id, reason: 'assetMap 无可用素材（renderer 将退化为占位）'});
        continue;
      }
      const first = assets[0]!;
      if (first.mediaType !== 'image') {
        issues.push({sceneId: scene.id, reason: `暂不支持视频素材：${first.mediaType}`});
        continue;
      }
      for (const asset of assets) {
        if (!opts.assetFileExists(asset.publicPath)) {
          issues.push({sceneId: scene.id, reason: `素材文件缺失或为空：${asset.publicPath}`});
        }
      }
    }
  }
  return issues.length === 0 ? {ok: true} : {ok: false, issues};
}

// ---------- 最终视觉审计 ----------

export type FinalVisualClass = 'generated_image' | 'real_image' | 'mg' | 'title_card';

export interface ClassStat {
  scenes: number;
  durationSec: number;
}

export interface ReuseEntry {
  assetId: string;
  sceneCount: number;
  totalDurationSec: number;
  /** 每次使用的时间点（scene.start 秒）。 */
  usages: Array<{sceneId: string; startSec: number}>;
  /** 同素材被 ≥2 个不相邻 scene 复用（语义不同场景重复，供人工审核，不禁止）。 */
  suspicious: boolean;
}

export interface FinalVisualAudit {
  compilerVersion: 'm6312-visual-audit-v1';
  totalScenes: number;
  totalDurationSec: number;
  /** 主分类时长分布（real_image = 非生成的真实素材，含 archive/b-roll）。 */
  byClass: Record<FinalVisualClass, ClassStat>;
  /** 原始 category 分布（Archive/B-roll/MG/Minimal…）。 */
  byCategory: Record<string, ClassStat>;
  /** Final 模式 placeholder 恒为 0（placeholder 在 final render 直接 throw）。 */
  placeholder: ClassStat;
  /** title/MG-only 占比（无真实/生成图像的画面）。 */
  titleMgOnly: {durationSec: number; ratio: number};
  /** 单静态图像连续展示超长的 scene（>8s / >12s 两档）。 */
  staticShotsOver8s: Array<{sceneId: string; durationSec: number}>;
  staticShotsOver12s: Array<{sceneId: string; durationSec: number}>;
  /** 素材复用明细（assetId → scene 数/总时长/时间点）。 */
  assetReuse: ReuseEntry[];
}

function isGeneratedAsset(sourceUrl: string, attribution: string): boolean {
  return sourceUrl.trim() === '' || attribution.includes('AI 生成');
}

function classifyScene(scene: Scene, props: ZhiyingFullCutProps): FinalVisualClass {
  if (scene.category === 'MG') return 'mg';
  if (scene.category === 'Archive' || scene.category === 'B-roll') {
    const assets = props.data.assetMap?.[scene.id];
    const first = assets?.[0];
    if (first && isGeneratedAsset(first.sourceUrl, first.attribution)) return 'generated_image';
    return 'real_image';
  }
  return 'title_card';
}

/** 对 Final props 做确定性视觉审计（纯函数，无 IO）。 */
export function auditFinalVisuals(props: ZhiyingFullCutProps): FinalVisualAudit {
  const byClass: Record<FinalVisualClass, ClassStat> = {
    generated_image: {scenes: 0, durationSec: 0},
    real_image: {scenes: 0, durationSec: 0},
    mg: {scenes: 0, durationSec: 0},
    title_card: {scenes: 0, durationSec: 0},
  };
  const byCategory: Record<string, ClassStat> = {};
  const staticShotsOver8s: Array<{sceneId: string; durationSec: number}> = [];
  const staticShotsOver12s: Array<{sceneId: string; durationSec: number}> = [];
  const reuseMap = new Map<string, ReuseEntry>();

  for (const scene of props.data.scenes) {
    const cls = classifyScene(scene, props);
    byClass[cls].scenes += 1;
    byClass[cls].durationSec += scene.duration;
    const cat = byCategory[scene.category] ?? {scenes: 0, durationSec: 0};
    cat.scenes += 1;
    cat.durationSec += scene.duration;
    byCategory[scene.category] = cat;

    if ((cls === 'generated_image' || cls === 'real_image') && scene.duration > 8) {
      staticShotsOver8s.push({sceneId: scene.id, durationSec: scene.duration});
      if (scene.duration > 12) {
        staticShotsOver12s.push({sceneId: scene.id, durationSec: scene.duration});
      }
    }

    for (const asset of props.data.assetMap?.[scene.id] ?? []) {
      const entry = reuseMap.get(asset.assetId) ?? {
        assetId: asset.assetId, sceneCount: 0, totalDurationSec: 0, usages: [], suspicious: false,
      };
      entry.sceneCount += 1;
      entry.totalDurationSec += scene.duration;
      entry.usages.push({sceneId: scene.id, startSec: scene.start});
      reuseMap.set(asset.assetId, entry);
    }
  }

  // suspicious：同 asset 被 ≥2 个 scene 复用即标记（不禁止，供人工审核；usages 含时间点）
  const assetReuse = [...reuseMap.values()].map((entry) => ({
    ...entry,
    suspicious: entry.sceneCount >= 2,
  }));

  const totalDurationSec = props.data.scenes.reduce((sum, s) => sum + s.duration, 0);
  const titleMgOnlySec = byClass.mg.durationSec + byClass.title_card.durationSec;
  return {
    compilerVersion: 'm6312-visual-audit-v1',
    totalScenes: props.data.scenes.length,
    totalDurationSec,
    byClass,
    byCategory,
    placeholder: {scenes: 0, durationSec: 0},
    titleMgOnly: {
      durationSec: titleMgOnlySec,
      ratio: totalDurationSec > 0 ? titleMgOnlySec / totalDurationSec : 0,
    },
    staticShotsOver8s,
    staticShotsOver12s,
    assetReuse,
  };
}
