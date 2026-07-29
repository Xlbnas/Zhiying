/**
 * Scenes Deterministic Compiler（M5：能由程序确定的字段，不交给 LLM 决定）。
 *
 * 管线位置：LLM Scene Proposal → zod 结构校验 → 本模块（Schema Normalize +
 * Deterministic Scene Compiler）→ 语义校验 → 只有语义问题才进 targeted LLM repair。
 *
 * 程序负责（deterministic）：
 * - enum alias 归一：category / visualType / licenseStatus（大小写、已知上游词表
 *   别名，如 shot_list 的 "Reality B-roll"）；真正语义无法判断的留成语义错误
 *   交给 LLM repair，不瞎猜。
 * - chapterTiming 连续化：保留 LLM 的章数、顺序、标题与相对时长（作为权重），
 *   重建绝对边界——chapter 1..N 连续、首章 start=0、章间零 gap 零 overlap。
 * - scene 绝对时间轴：chapter 归属内按 LLM 时长权重比例分配 start/end
 *   （chapter 内 scene 顺序保持 LLM 输出序），末 scene.end 精确等于 chapter.end；
 *   duration = end - start；startFrame/durationInFrames = round(秒 × FPS)。
 * - chapterTitle 由 chapterTiming 按 chapter 编号注入。
 *
 * LLM 仍负责：scene 顺序、chapter 归属、category/visualType 语义、MG 模板、
 * narrationSummary/description/notes/assetIds/subtitlePosition/转场。
 *
 * 设计约束：
 * - 不做简单 clamp(scene.end)（会制造 overlap/gap）；chapter 内做 proportional
 *   reflow，输出天然满足语义校验全部 timing invariants（首 scene.start=章首、
 *   前后相接、不跨章、末 scene.end=章末=末章末）。
 * - 输出幂等：对已合法的输出再跑一次结果不变（权重=现有 duration）。
 * - scene.chapter 指向不存在章节、chapter 内零 scene 等无法 deterministic
 *   修复的问题原样保留，由语义校验标记后走 LLM repair。
 */

import {
  MG_TEMPLATE_REGISTRY,
  SCENE_CATEGORIES,
  SCENE_LICENSE_STATUSES,
  SCENE_VISUAL_TYPES,
  SCENES_SYSTEM_FPS,
} from '../workflow/scenes-semantic-validation';
import {requirementIdOf, type AssetRequirement} from '../scene-schema';

type ChapterTiming = {chapter: number; title: string; start: number; end: number};
type Scene = {
  id: string;
  chapter: number;
  chapterTitle: string;
  start: number;
  end: number;
  duration: number;
  startFrame: number;
  durationInFrames: number;
  category: string;
  visualType: string | null;
  licenseStatus: string;
  [key: string]: unknown;
};
export interface ScenesAiOutputShape {
  chapterTiming: ChapterTiming[];
  scenes: Scene[];
}

export interface SceneCompileResult {
  output: ScenesAiOutputShape;
  /** 人类可读的 deterministic 修复记录（日志/审计用，不入 artifact）。 */
  fixes: string[];
}

const TIME_EPSILON = 0.001;
const MIN_CHAPTER_SECONDS = 1;
const MIN_SCENE_WEIGHT = 0.1;

// ---------- enum alias 归一（以小写归并后的 key 查表；不在表内 = 无法确定，留 repair） ----------

const CATEGORY_ALIASES: Record<string, string> = {
  mg: 'MG',
  'b-roll': 'B-roll',
  broll: 'B-roll',
  'b roll': 'B-roll',
  'reality b-roll': 'B-roll',
  'reality broll': 'B-roll',
  'b-roll footage': 'B-roll',
  asset: 'B-roll',
  archive: 'Archive',
  archival: 'Archive',
  'archive footage': 'Archive',
  minimal: 'Minimal',
  'editorial graphic': 'Editorial Graphic',
  'editorial-graphic': 'Editorial Graphic',
  editorialgraphic: 'Editorial Graphic',
  editorial: 'Editorial Graphic',
  graphic: 'Editorial Graphic',
};

const VISUAL_TYPE_ALIASES: Record<string, string> = {
  mg: 'MG',
  asset: 'Asset',
  'b-roll': 'Asset',
  broll: 'Asset',
  'b roll': 'Asset',
  'reality b-roll': 'Asset',
  'reality broll': 'Asset',
  archive: 'Archive',
  archival: 'Archive',
  minimal: 'Minimal',
  ui: 'UI',
};

const LICENSE_STATUS_ALIASES: Record<string, string> = {
  verified: 'verified',
  'review-required': 'review-required',
  'review required': 'review-required',
  review_required: 'review-required',
  'not-applicable': 'not-applicable',
  'not applicable': 'not-applicable',
  not_applicable: 'not-applicable',
  'n/a': 'not-applicable',
  na: 'not-applicable',
};

function normalizeEnum(
  value: string | null,
  aliases: Record<string, string>,
  canonical: readonly string[],
): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const hit = aliases[trimmed.toLowerCase()];
  if (hit !== undefined) return hit;
  return (canonical as readonly string[]).includes(trimmed) ? trimmed : value;
}

/**
 * MG 模板 ID 归一：注册表 ID 的「仅小写字母数字」形态是唯一键，
 * 大小写 / 下划线 / 连字符 / 空格 / 多余前缀变体均可确定性归一到注册 ID；
 * 归一不了的是模型编造的 ID（如 MG_FreudCouch），原样留给语义校验 → LLM repair
 * （repair prompt 现在携带完整注册表，可正确选择）。
 */
const TEMPLATE_CANONICAL_BY_KEY: Map<string, string> = (() => {
  const keyOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = new Map<string, string>();
  for (const id of MG_TEMPLATE_REGISTRY) {
    map.set(keyOf(id), id);
  }
  return map;
})();

function normalizeTemplateId(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (MG_TEMPLATE_REGISTRY.has(trimmed)) return trimmed;
  const key = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
  return TEMPLATE_CANONICAL_BY_KEY.get(key) ?? value;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** chapterTiming 连续化：保留章数/顺序/标题/相对时长，重建连续绝对边界。 */
function reflowChapterTiming(
  input: ChapterTiming[],
  fixes: string[],
): {chapters: ChapterTiming[]; chapterRemap: Map<number, number>} {
  // 章编号归并为 1..N（保持 LLM 的章顺序），scene.chapter 按同一张 remap 表跟随
  const ordered = [...input].sort((a, b) => a.chapter - b.chapter);
  const chapterRemap = new Map<number, number>();
  const chapters: ChapterTiming[] = [];
  let cursor = 0;
  ordered.forEach((ch, idx) => {
    const newNumber = idx + 1;
    chapterRemap.set(ch.chapter, newNumber);
    const llmDuration = ch.end - ch.start;
    const duration = llmDuration >= MIN_CHAPTER_SECONDS ? llmDuration : MIN_CHAPTER_SECONDS;
    if (
      ch.chapter !== newNumber ||
      Math.abs(ch.start - cursor) > TIME_EPSILON ||
      llmDuration < MIN_CHAPTER_SECONDS
    ) {
      fixes.push(
        `chapterTiming 第 ${ch.chapter} 章边界程序化重建（编号 ${ch.chapter}→${newNumber}，start ${ch.start}→${round3(cursor)}）`,
      );
    }
    chapters.push({
      chapter: newNumber,
      title: ch.title,
      start: round3(cursor),
      end: round3(cursor + duration),
    });
    cursor += duration;
  });
  return {chapters, chapterRemap};
}

/** chapter 内 scenes 按比例 reflow（权重 = LLM 时长；非法权重退化均分）。 */
function reflowChapterScenes(
  chapter: ChapterTiming,
  scenes: Scene[],
): void {
  const chapterLen = chapter.end - chapter.start;
  const weights = scenes.map((s) => {
    const byRange = s.end - s.start;
    const byDuration = s.duration;
    const w =
      byRange > TIME_EPSILON ? byRange : byDuration > TIME_EPSILON ? byDuration : 1;
    return Math.max(w, MIN_SCENE_WEIGHT);
  });
  let weightTotal = weights.reduce((a, b) => a + b, 0);
  if (!(weightTotal > 0)) weightTotal = scenes.length;

  let cursor = chapter.start;
  scenes.forEach((scene, idx) => {
    const isLast = idx === scenes.length - 1;
    const start = round3(cursor);
    // 末 scene 精确收在 chapter.end，消除浮点残差（其余按比例取整到毫秒）
    const end = isLast
      ? chapter.end
      : round3(chapter.start + (weights.slice(0, idx + 1).reduce((a, b) => a + b, 0) / weightTotal) * chapterLen);
    const duration = round3(end - start);
    scene.start = start;
    scene.end = end;
    scene.duration = duration;
    scene.startFrame = Math.round(start * SCENES_SYSTEM_FPS);
    scene.durationInFrames = Math.round(duration * SCENES_SYSTEM_FPS);
    scene.chapterTitle = chapter.title;
    cursor = end;
  });
}

/**
 * Scenes AI 输出的 deterministic normalize + compile。
 * 输入已通过 zod 结构校验；输出供语义校验与 artifact 持久化。
 */
export function compileScenesAiOutput(input: unknown): SceneCompileResult {
  const raw = input as ScenesAiOutputShape;
  const fixes: string[] = [];

  // 1. enum alias 归一（无法映射的原样保留 → 语义校验 → LLM repair）
  const scenes = raw.scenes.map((s) => ({...s}));
  for (const scene of scenes) {
    const category = normalizeEnum(scene.category, CATEGORY_ALIASES, SCENE_CATEGORIES);
    if (category !== null && category !== scene.category) {
      fixes.push(`${scene.id} category "${scene.category}" → "${category}"`);
      scene.category = category ?? scene.category;
    }
    const visualType = normalizeEnum(scene.visualType, VISUAL_TYPE_ALIASES, SCENE_VISUAL_TYPES);
    if (visualType !== scene.visualType) {
      fixes.push(`${scene.id} visualType "${scene.visualType}" → "${visualType}"`);
      scene.visualType = visualType;
    }
    const licenseStatus = normalizeEnum(scene.licenseStatus, LICENSE_STATUS_ALIASES, SCENE_LICENSE_STATUSES);
    if (licenseStatus !== null && licenseStatus !== scene.licenseStatus) {
      fixes.push(`${scene.id} licenseStatus "${scene.licenseStatus}" → "${licenseStatus}"`);
      scene.licenseStatus = licenseStatus ?? scene.licenseStatus;
    }
    for (const field of ['template', 'sourceTemplate'] as const) {
      const current = (scene[field] as string | null) ?? null;
      const normalized = normalizeTemplateId(current);
      if (normalized !== current) {
        fixes.push(`${scene.id} ${field} "${current}" → "${normalized}"`);
        scene[field] = normalized;
      }
    }
    // M6.3.8：为 assetRequirements 注入稳定 requirementId（fill-if-missing）。
    // 幂等：已有显式 id 原样保留；缺失时按 sceneId + 数组序号 deterministic
    // 推导（与 requirementIdOf 同一规则），再次编译结果不变。
    if (Array.isArray(scene.assetRequirements)) {
      scene.assetRequirements = (scene.assetRequirements as AssetRequirement[]).map(
        (req, index) => {
          if (!req || typeof req !== 'object') return req;
          if (typeof req.requirementId === 'string' && req.requirementId.length > 0) return req;
          return {...req, requirementId: requirementIdOf(scene.id, req, index)};
        },
      );
    }
  }

  // 2. chapterTiming 连续化（章编号 1..N + 边界相接）
  const {chapters, chapterRemap} = reflowChapterTiming(raw.chapterTiming, fixes);
  const chapterByNumber = new Map(chapters.map((c) => [c.chapter, c]));

  // 3. scene 绝对时间轴（chapter 归属内 reflow；chapter 指向不存在的章 → 留语义错误）
  for (const scene of scenes) {
    const mapped = chapterRemap.get(scene.chapter) ?? scene.chapter;
    if (mapped !== scene.chapter) {
      scene.chapter = mapped;
    }
  }
  for (const chapter of chapters) {
    const inChapter = scenes.filter((s) => s.chapter === chapter.chapter);
    if (inChapter.length === 0) continue; // 章内零 scene：无法凭空生成 → 语义校验 → repair
    const before = inChapter.map(
      (s) => `${s.id}[${s.start},${s.end}]`,
    );
    reflowChapterScenes(chapter, inChapter);
    const changed = inChapter.some(
      (s, i) => before[i] !== `${s.id}[${s.start},${s.end}]`,
    );
    if (changed) {
      fixes.push(`第 ${chapter.chapter} 章 ${inChapter.length} 个 scene 时间轴程序化 reflow`);
    }
  }
  // chapter 编号未被任何章拥有的 scene（如 LLM 编造章号）：不 reflow，留 SCENE_CHAPTER_MISMATCH

  return {output: {chapterTiming: chapters, scenes}, fixes};
}

/** StagePrompt.normalizeOutput 适配器：只返回归一后的输出对象。 */
export function normalizeScenesOutput(input: unknown): unknown {
  return compileScenesAiOutput(input).output;
}
