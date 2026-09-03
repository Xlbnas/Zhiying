import {z} from 'zod';

/**
 * Narration Plan 数据契约（M3-A）。
 *
 * 定位：locked Script V2（给人看的 Markdown）→ 给 TTS / Subtitle / Timing
 * 系统消费的稳定机器契约。deterministic compiler output——
 * 同一 (script_v2 locked version, compilerVersion) 重复编译结果字节级稳定。
 *
 * schemaVersion（本数据契约）与 promptVersion（生成脚本的提示词版本）严格区分。
 */

export const NARRATION_PLAN_SCHEMA_VERSION = 'narration-plan@1.0';
/**
 * M3-A Hardening：Evidence 归属规则（paragraph 边界）与 chapter 时间区间
 * 解析行为修正，compilerVersion 1.0 → 1.1（数据结构不变）。
 * 旧 compiler@1.0 的 plan 不再视为 current（幂等键含 compilerVersion），
 * 重新 Build 产生 1.1 artifact，旧版保留为历史。
 *
 * M6.3.1.3：speech text sanitation——Markdown horizontal rule（`---` 等）与
 * 纯标点段不再产生 speech unit，compilerVersion 1.1 → 1.2（数据结构不变）。
 * 旧 compiler@1.1 的 plan 因 version 不匹配自动失效，重新 Build 产生 1.2 artifact。
 */
export const NARRATION_COMPILER_VERSION = '1.2';

export const narrationUnitKindSchema = z.enum([
  'speech',
  'pause',
  'visual_breath',
  'prosody',
]);

export type NarrationUnitKind = z.infer<typeof narrationUnitKindSchema>;

export const narrationUnitSchema = z
  .object({
    /** 稳定 ID：N001…N00N（编译器顺序生成，禁止 random/timestamp）。 */
    id: z.string().regex(/^N\d{3}$/),
    chapter: z.number().int().positive(),
    kind: narrationUnitKindSchema,
    /** kind=speech：可朗读文本（剥离全部标记后非空）；其余 kind 恒为 null。 */
    text: z.string().nullable(),
    /** kind=pause（无时长）/prosody：语义指令原文（如 "停顿"/"放慢"）。 */
    directive: z.string().nullable(),
    /** kind=pause：毫秒；未声明时长的停顿为 null（不拍脑袋默认）。 */
    pauseMs: z.number().int().positive().nullable(),
    /** 从 HTML 注释抽取的 Evidence ID（去重、首次出现顺序）。 */
    evidenceIds: z.array(z.string()),
    /** 产生该 unit 的原始段落文本（trace 用，不进入 TTS）。 */
    sourceText: z.string(),
  })
  .superRefine((unit, ctx) => {
    if (unit.kind === 'speech') {
      if (!unit.text || unit.text.trim().length === 0) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: 'speech unit 必须有非空 text'});
      }
      if (unit.directive !== null || unit.pauseMs !== null) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: 'speech unit 不得携带 directive/pauseMs'});
      }
    } else {
      if (unit.text !== null) {
        ctx.addIssue({code: z.ZodIssueCode.custom, message: `${unit.kind} unit 不得携带朗读 text`});
      }
    }
    if (unit.kind === 'pause' && unit.pauseMs === null && !unit.directive) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: 'pause unit 需 pauseMs 或 directive 至少其一'});
    }
    if (unit.kind === 'prosody' && !unit.directive) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: 'prosody unit 必须有 directive'});
    }
  });

export const narrationChapterSchema = z.object({
  chapter: z.number().int().positive(),
  title: z.string().min(1),
  /** 章内首个/末个 unit（无 unit 的章为 null）。 */
  firstUnitId: z.string().regex(/^N\d{3}$/).nullable(),
  lastUnitId: z.string().regex(/^N\d{3}$/).nullable(),
});

export const narrationPlanSchema = z
  .object({
    schemaVersion: z.literal(NARRATION_PLAN_SCHEMA_VERSION),
    /** compilerVersion 为历史可读字段（1.0/1.1…）；是否 current 由 plan.ts 判定。 */
    compilerVersion: z.string().min(1),
    source: z.object({
      stage: z.literal('script_v2'),
      /** script_v2.locked_version（immutable source snapshot，绝不读 active_version）。 */
      version: z.number().int().positive(),
      /** Script V2 的 promptVersion（溯源用）。 */
      promptVersion: z.string().nullable(),
      /** 外部已审批正文经 production admission 接入时保留原 artifact identity。 */
      artifactId: z.string().min(1).optional(),
      plaintextSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      approvalRecordId: z.string().min(1).optional(),
      admission: z.literal('approved_external_artifact').optional(),
    }),
    chapters: z.array(narrationChapterSchema).min(1),
    units: z.array(narrationUnitSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    // unit ID 唯一且严格 N001…N00N 连续
    plan.units.forEach((unit, index) => {
      const expected = `N${String(index + 1).padStart(3, '0')}`;
      if (unit.id !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unit[${index}] id 必须是 ${expected}（实际 ${unit.id}）`,
        });
      }
    });
    // unit.chapter 必须存在
    const chapterSet = new Set(plan.chapters.map((c) => c.chapter));
    plan.units.forEach((unit) => {
      if (!chapterSet.has(unit.chapter)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${unit.id} 引用了不存在的 chapter ${unit.chapter}`,
        });
      }
    });
    // chapter 编号递增；first/last unit 引用一致
    const unitIdsByChapter = new Map<number, string[]>();
    plan.units.forEach((unit) => {
      const list = unitIdsByChapter.get(unit.chapter) ?? [];
      list.push(unit.id);
      unitIdsByChapter.set(unit.chapter, list);
    });
    plan.chapters.forEach((chapter, index) => {
      if (index > 0 && chapter.chapter <= plan.chapters[index - 1]!.chapter) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `chapter 编号必须递增（第 ${chapter.chapter} 章位置错误）`,
        });
      }
      const ids = unitIdsByChapter.get(chapter.chapter) ?? [];
      const expectedFirst = ids[0] ?? null;
      const expectedLast = ids[ids.length - 1] ?? null;
      if (chapter.firstUnitId !== expectedFirst || chapter.lastUnitId !== expectedLast) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `第 ${chapter.chapter} 章 first/lastUnitId 与 units 不一致`,
        });
      }
    });
  });

export type NarrationUnit = z.infer<typeof narrationUnitSchema>;
export type NarrationChapter = z.infer<typeof narrationChapterSchema>;
export type NarrationPlan = z.infer<typeof narrationPlanSchema>;
