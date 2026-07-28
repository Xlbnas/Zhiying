import type {ChapterTiming, Scene} from '../scene-schema';

/**
 * Scenes 语义校验（M2-E-A，DEFERRED_M2E_SCENE_SEMANTIC_VALIDATION 落地）。
 *
 * 分层边界：
 * - M1 冻结结构契约：sceneSchema / chapterTimingSchema（src/lib/scene-schema.ts，不改动）
 * - 本模块：M2-E AI 输出（与未来人工 JSON 编辑）的跨字段/跨 Scene/跨 Chapter
 *   **确定性语义校验**——Prompt 只是期望，本模块才是安全边界。
 *
 * 只校验，不修正：禁止自动重排/补洞/改时长/改帧/重编号。
 *
 * 数据来源调查（M1 真实实现，docs/M2-E-A 报告 C 节）：
 * - MG 模板：src/remotion/templates/ 12 个组件 + types/scene.ts TemplateName union +
 *   SceneRenderer switch —— 本模块 MG_TEMPLATE_REGISTRY 与之逐一对应，不创造新模板。
 * - sourceTemplate 语义（M1 真实数据）：原始 Storyboard 建议模板（追踪改分类）；
 *   MG 场景 template/sourceTemplate 均非空；非 MG 场景 template 恒为 null，
 *   sourceTemplate 可为已注册 MG ID（35/56 个非 MG 场景如此）。
 */

/** 帧换算系统常量（M1 契约；AI 不控制，仅用于一致性校验）。 */
export const SCENES_SYSTEM_FPS = 30;

/** 秒级浮点统一容差（全模块唯一，禁止各处自写）。 */
export const SECONDS_EPSILON = 0.001;

/**
 * 已注册 MG 模板 ID（从 M1 Remotion 实现提取：
 * src/remotion/templates/MG_*.tsx × 12 = types/scene.ts TemplateName = SceneRenderer case）。
 */
export const MG_TEMPLATE_REGISTRY: ReadonlySet<string> = new Set([
  'MG_ActionDelay',
  'MG_ConceptSeparation',
  'MG_IntentConflict',
  'MG_IntentPath',
  'MG_InwardQuestion',
  'MG_LastStepThreshold',
  'MG_LocalConflictSpread',
  'MG_MessageFocus',
  'MG_ScheduleNodes',
  'MG_ThinkNoThink',
  'MG_TimePass',
  'MG_WorthQuestioning',
]);

/**
 * 注册模板的语义提示（供 scenes prompt 注入：模型只能在注册表内选择，
 * 提示取自 M1 模板 props 的真实结构）。修改模板集合时同步更新。
 */
export const MG_TEMPLATE_HINTS: ReadonlyArray<{id: string; hint: string}> = [
  {id: 'MG_ActionDelay', hint: '意图与行动之间的拖延清单（意图 label + 逐项 delay）'},
  {id: 'MG_ConceptSeparation', hint: '两个易混概念的区分对比（left ≠ right + 注释）'},
  {id: 'MG_IntentConflict', hint: '意图与行动的冲突/干扰（含冲突标注）'},
  {id: 'MG_IntentPath', hint: '从意图到行动的路径推进（pathProgress）'},
  {id: 'MG_InwardQuestion', hint: '从外部现象转向向内的自我追问'},
  {id: 'MG_LastStepThreshold', hint: '步骤推进到最后一步的门槛与后果'},
  {id: 'MG_LocalConflictSpread', hint: '一条核心信息/局部冲突的扩散与冻结（支持历史模式）'},
  {id: 'MG_MessageFocus', hint: '多条信息中聚焦一条关键信息（其余压暗）'},
  {id: 'MG_ScheduleNodes', hint: '日程/清单节点的完成与错过'},
  {id: 'MG_ThinkNoThink', hint: '压抑一个念头反而被想起（提示与记忆的拉扯）'},
  {id: 'MG_TimePass', hint: '时间流逝的视觉表达'},
  {id: 'MG_WorthQuestioning', hint: '对习以为常的说法提出质疑'},
];

/** Scenes Prompt 契约允许的取值（M1 历史数据为其子集，无冲突）。 */
export const SCENE_CATEGORIES = ['MG', 'B-roll', 'Archive', 'Minimal', 'Editorial Graphic'] as const;
export const SCENE_VISUAL_TYPES = ['MG', 'Asset', 'Archive', 'Minimal', 'UI'] as const;
export const SCENE_LICENSE_STATUSES = ['verified', 'review-required', 'not-applicable'] as const;

export type SceneSemanticIssueCode =
  | 'SCENE_ID_SEQUENCE_INVALID'
  | 'SCENE_TIME_INVALID'
  | 'SCENE_DURATION_MISMATCH'
  | 'SCENE_TIMELINE_GAP'
  | 'SCENE_TIMELINE_OVERLAP'
  | 'SCENE_FRAME_MISMATCH'
  | 'CHAPTER_TIMING_INVALID'
  | 'SCENE_CHAPTER_MISMATCH'
  | 'SCENE_CHAPTER_TITLE_MISMATCH'
  | 'SCENE_CATEGORY_INVALID'
  | 'SCENE_VISUAL_TYPE_INVALID'
  | 'SCENE_LICENSE_STATUS_INVALID'
  | 'MG_TEMPLATE_REQUIRED'
  | 'MG_TEMPLATE_NOT_REGISTERED'
  | 'NON_MG_TEMPLATE_NOT_NULL';

export interface SceneSemanticIssue {
  code: SceneSemanticIssueCode;
  message: string;
  sceneId?: string;
  sceneIndex?: number;
  chapter?: number;
  expected?: string | number;
  actual?: string | number;
}

export type SemanticValidationResult =
  | {ok: true; issues: []}
  | {ok: false; issues: SceneSemanticIssue[]};

/** 输入类型（结构层已由 zod 保证；不依赖 prompt 模块，保持业务契约独立）。 */
export interface ScenesSemanticInput {
  chapterTiming: ChapterTiming[];
  scenes: Scene[];
}

export interface ScenesSemanticOptions {
  fps?: number;
  registeredMgTemplateIds?: ReadonlySet<string>;
}

function expectedSceneId(index: number): string {
  return `S${String(index + 1).padStart(3, '0')}`;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= SECONDS_EPSILON;
}

/**
 * 确定性语义校验：返回全部问题（不短路），调用方决定 repair / 拒绝。
 * value 必须先通过 scenesAiOutputSchema 结构校验。
 */
export function validateScenesSemantics(
  value: ScenesSemanticInput,
  options: ScenesSemanticOptions = {},
): SemanticValidationResult {
  const fps = options.fps ?? SCENES_SYSTEM_FPS;
  const registry = options.registeredMgTemplateIds ?? MG_TEMPLATE_REGISTRY;
  const issues: SceneSemanticIssue[] = [];
  const {chapterTiming, scenes} = value;

  // ---------- 1. Scene ID 严格序列（S001…S00N，覆盖起始/递增/重复/格式） ----------
  scenes.forEach((scene, index) => {
    const expected = expectedSceneId(index);
    if (scene.id !== expected) {
      issues.push({
        code: 'SCENE_ID_SEQUENCE_INVALID',
        message: `Scene[${index}] 的 id 必须是 ${expected}（严格连续序列）`,
        sceneId: scene.id,
        sceneIndex: index,
        expected,
        actual: scene.id,
      });
    }
  });

  // ---------- 2. 单 Scene 时间与 duration ----------
  scenes.forEach((scene, index) => {
    const ref = {sceneId: scene.id, sceneIndex: index, chapter: scene.chapter};
    if (scene.start < 0) {
      issues.push({code: 'SCENE_TIME_INVALID', message: `${scene.id} start < 0`, ...ref, expected: '>= 0', actual: scene.start});
    }
    if (scene.end <= scene.start) {
      issues.push({code: 'SCENE_TIME_INVALID', message: `${scene.id} end 必须大于 start`, ...ref, expected: `> ${scene.start}`, actual: scene.end});
    }
    if (scene.duration <= 0) {
      issues.push({code: 'SCENE_TIME_INVALID', message: `${scene.id} duration 必须为正`, ...ref, expected: '> 0', actual: scene.duration});
    }
    if (!near(scene.duration, scene.end - scene.start)) {
      issues.push({
        code: 'SCENE_DURATION_MISMATCH',
        message: `${scene.id} duration 必须等于 end - start（容差 ±${SECONDS_EPSILON}s）`,
        ...ref,
        expected: scene.end - scene.start,
        actual: scene.duration,
      });
    }
  });

  // ---------- 3. 全片时间轴连续（数组顺序即时间线；首个 start=0） ----------
  if (scenes.length > 0) {
    const first = scenes[0]!;
    if (!near(first.start, 0)) {
      issues.push({
        code: 'SCENE_TIMELINE_GAP',
        message: `首个 Scene ${first.id} 必须从 0 开始`,
        sceneId: first.id,
        sceneIndex: 0,
        expected: 0,
        actual: first.start,
      });
    }
    for (let i = 1; i < scenes.length; i++) {
      const prev = scenes[i - 1]!;
      const current = scenes[i]!;
      if (near(current.start, prev.end)) continue;
      issues.push({
        code: current.start > prev.end ? 'SCENE_TIMELINE_GAP' : 'SCENE_TIMELINE_OVERLAP',
        message:
          current.start > prev.end
            ? `${current.id} 与 ${prev.id} 之间存在时间空洞`
            : `${current.id} 与 ${prev.id} 时间轴重叠`,
        sceneId: current.id,
        sceneIndex: i,
        expected: prev.end,
        actual: current.start,
      });
    }
  }

  // ---------- 4. 帧换算一致（Math.round，exact integer match） ----------
  scenes.forEach((scene, index) => {
    const ref = {sceneId: scene.id, sceneIndex: index, chapter: scene.chapter};
    const expectedStartFrame = Math.round(scene.start * fps);
    const expectedDurationFrames = Math.round(scene.duration * fps);
    if (scene.startFrame !== expectedStartFrame) {
      issues.push({code: 'SCENE_FRAME_MISMATCH', message: `${scene.id} startFrame 应为 round(start×${fps})`, ...ref, expected: expectedStartFrame, actual: scene.startFrame});
    }
    if (scene.durationInFrames !== expectedDurationFrames) {
      issues.push({code: 'SCENE_FRAME_MISMATCH', message: `${scene.id} durationInFrames 应为 round(duration×${fps})`, ...ref, expected: expectedDurationFrames, actual: scene.durationInFrames});
    }
    if (scene.startFrame < 0 || scene.durationInFrames <= 0) {
      issues.push({code: 'SCENE_FRAME_MISMATCH', message: `${scene.id} 帧字段必须 startFrame>=0 且 durationInFrames>0`, ...ref, expected: '>=0 / >0', actual: `${scene.startFrame}/${scene.durationInFrames}`});
    }
  });

  // ---------- 5. chapterTiming 自身语义 ----------
  chapterTiming.forEach((chapter, index) => {
    const expectedChapter = index + 1;
    if (chapter.chapter !== expectedChapter) {
      issues.push({
        code: 'CHAPTER_TIMING_INVALID',
        message: `chapterTiming[${index}] 的 chapter 必须是 ${expectedChapter}（从 1 连续递增）`,
        chapter: chapter.chapter,
        expected: expectedChapter,
        actual: chapter.chapter,
      });
    }
    if (chapter.end <= chapter.start) {
      issues.push({code: 'CHAPTER_TIMING_INVALID', message: `第 ${chapter.chapter} 章 end 必须大于 start`, chapter: chapter.chapter, expected: `> ${chapter.start}`, actual: chapter.end});
    }
    if (index === 0 && !near(chapter.start, 0)) {
      issues.push({code: 'CHAPTER_TIMING_INVALID', message: '第一章必须从 0 开始', chapter: chapter.chapter, expected: 0, actual: chapter.start});
    }
    if (index > 0) {
      const prev = chapterTiming[index - 1]!;
      if (!near(chapter.start, prev.end)) {
        issues.push({
          code: 'CHAPTER_TIMING_INVALID',
          message: `第 ${chapter.chapter} 章与第 ${prev.chapter} 章时间不连续（gap/overlap）`,
          chapter: chapter.chapter,
          expected: prev.end,
          actual: chapter.start,
        });
      }
    }
  });
  const lastChapter = chapterTiming[chapterTiming.length - 1];
  const lastScene = scenes[scenes.length - 1];
  if (lastChapter && lastScene && !near(lastChapter.end, lastScene.end)) {
    issues.push({
      code: 'CHAPTER_TIMING_INVALID',
      message: '最后一章 end 必须与最后一个 Scene end 一致',
      chapter: lastChapter.chapter,
      expected: lastScene.end,
      actual: lastChapter.end,
    });
  }

  // ---------- 6. Scene ↔ Chapter 对齐与覆盖 ----------
  const chapterMap = new Map(chapterTiming.map((c) => [c.chapter, c]));
  const coveredChapters = new Set<number>();
  scenes.forEach((scene, index) => {
    const chapter = chapterMap.get(scene.chapter);
    if (!chapter) {
      issues.push({
        code: 'SCENE_CHAPTER_MISMATCH',
        message: `${scene.id} 引用了不存在的 chapter ${scene.chapter}`,
        sceneId: scene.id,
        sceneIndex: index,
        chapter: scene.chapter,
      });
      return;
    }
    coveredChapters.add(scene.chapter);
    // 一个 Scene 只能完全落在单一 chapter 范围内（禁止跨 chapter 边界）
    if (scene.start < chapter.start - SECONDS_EPSILON || scene.end > chapter.end + SECONDS_EPSILON) {
      issues.push({
        code: 'SCENE_CHAPTER_MISMATCH',
        message: `${scene.id} 超出第 ${scene.chapter} 章范围 [${chapter.start}, ${chapter.end}]（禁止跨章）`,
        sceneId: scene.id,
        sceneIndex: index,
        chapter: scene.chapter,
        expected: `[${chapter.start}, ${chapter.end}]`,
        actual: `[${scene.start}, ${scene.end}]`,
      });
    }
    if (scene.chapterTitle.trim() !== chapter.title.trim()) {
      issues.push({
        code: 'SCENE_CHAPTER_TITLE_MISMATCH',
        message: `${scene.id} 的 chapterTitle 与 chapterTiming.title 不一致`,
        sceneId: scene.id,
        sceneIndex: index,
        chapter: scene.chapter,
        expected: chapter.title,
        actual: scene.chapterTitle,
      });
    }
  });
  chapterTiming.forEach((chapter) => {
    if (!coveredChapters.has(chapter.chapter)) {
      issues.push({
        code: 'CHAPTER_TIMING_INVALID',
        message: `第 ${chapter.chapter} 章没有任何 Scene（章节覆盖必须完整）`,
        chapter: chapter.chapter,
      });
    }
  });

  // ---------- 7. 枚举式契约值 ----------
  scenes.forEach((scene, index) => {
    const ref = {sceneId: scene.id, sceneIndex: index, chapter: scene.chapter};
    if (!(SCENE_CATEGORIES as readonly string[]).includes(scene.category)) {
      issues.push({code: 'SCENE_CATEGORY_INVALID', message: `${scene.id} category 非法`, ...ref, expected: SCENE_CATEGORIES.join(' | '), actual: scene.category});
    }
    if (!(SCENE_VISUAL_TYPES as readonly string[]).includes(scene.visualType ?? '')) {
      issues.push({code: 'SCENE_VISUAL_TYPE_INVALID', message: `${scene.id} visualType 非法`, ...ref, expected: SCENE_VISUAL_TYPES.join(' | '), actual: scene.visualType ?? 'null'});
    }
    if (!(SCENE_LICENSE_STATUSES as readonly string[]).includes(scene.licenseStatus)) {
      issues.push({code: 'SCENE_LICENSE_STATUS_INVALID', message: `${scene.id} licenseStatus 非法（禁止 unknown）`, ...ref, expected: SCENE_LICENSE_STATUSES.join(' | '), actual: scene.licenseStatus});
    }
  });

  // ---------- 8. MG 模板 ----------
  scenes.forEach((scene, index) => {
    const ref = {sceneId: scene.id, sceneIndex: index, chapter: scene.chapter};
    if (scene.category === 'MG') {
      if (scene.template === null) {
        issues.push({code: 'MG_TEMPLATE_REQUIRED', message: `${scene.id} 是 MG 场景，template 不得为 null`, ...ref});
      } else if (!registry.has(scene.template)) {
        issues.push({code: 'MG_TEMPLATE_NOT_REGISTERED', message: `${scene.id} template 未注册`, ...ref, expected: '已注册 MG 模板 ID', actual: scene.template});
      }
      if (scene.sourceTemplate === null) {
        issues.push({code: 'MG_TEMPLATE_REQUIRED', message: `${scene.id} 是 MG 场景，sourceTemplate 不得为 null`, ...ref});
      } else if (!registry.has(scene.sourceTemplate)) {
        issues.push({code: 'MG_TEMPLATE_NOT_REGISTERED', message: `${scene.id} sourceTemplate 未注册`, ...ref, expected: '已注册 MG 模板 ID', actual: scene.sourceTemplate});
      }
    } else {
      // M1 真实语义：非 MG 场景 template 恒为 null；sourceTemplate 可为已注册 MG ID
      if (scene.template !== null) {
        issues.push({code: 'NON_MG_TEMPLATE_NOT_NULL', message: `${scene.id} 非 MG 场景，template 必须为 null`, ...ref, expected: 'null', actual: scene.template});
      }
      if (scene.sourceTemplate !== null && !registry.has(scene.sourceTemplate)) {
        issues.push({code: 'MG_TEMPLATE_NOT_REGISTERED', message: `${scene.id} sourceTemplate 未注册`, ...ref, expected: '已注册 MG 模板 ID 或 null', actual: scene.sourceTemplate});
      }
    }
  });

  return issues.length === 0 ? {ok: true, issues: []} : {ok: false, issues};
}

/** 供 StagePrompt.semanticValidate / executor / PATCH 复用的最小形态。 */
export function scenesSemanticIssues(data: unknown): Array<{code: string; message: string}> {
  const result = validateScenesSemantics(data as ScenesSemanticInput);
  return result.ok ? [] : result.issues;
}
