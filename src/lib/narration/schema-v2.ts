import {z} from 'zod';
import {findDirectiveLeakage, describeLeakage} from './leakage';

/**
 * Narration Plan V2 数据契约（M7.1，REVIEW DECISIONS 1.1 冻结）。
 *
 * 与 v1（narration-plan@1.0，schema.ts）并存：v1 只读兼容，v2 是新写入路径。
 * 核心变更：NarrationUnit 是真正的 discriminated union——
 * SpeechUnit（spokenText 非空 + delivery）| SilenceUnit（durationMs 显式）。
 * 禁止 pause unit 与 pauseBefore/pauseAfter 双重表示；「旁白无」无明确时长
 * 不得成为 unit，只能进入 needsReview（fail-closed）。
 *
 * needsReview 非空的 plan 可作为 candidate artifact 保存，但不得 current/lock
 * （plan-v2.ts 的 current 判定强制执行，schema 层只保证结构合法）。
 */

export const NARRATION_PLAN_V2_SCHEMA_VERSION = 'narration-plan@2.0';
export const NARRATION_V2_COMPILER_VERSION = '2.0';
export const NARRATION_PLAN_V2_ARTIFACT_KIND = 'narration_plan_v2';

/** silence 时长上限（ms）：防御 LLM/手误产生的荒谬时长（测试锁定）。 */
export const MAX_SILENCE_MS = 30_000;

export const deliverySchema = z.enum([
  'normal',
  'slow',
  'fast',
  'soft',
  'firm',
  'emphasis',
]);
export type Delivery = z.infer<typeof deliverySchema>;

const unitIdSchema = z.string().regex(/^N\d{3}$/);
const reviewIdSchema = z.string().regex(/^R\d{3}$/);
const evidenceIdSchema = z.string().regex(/^E\d+$/);

export const speechUnitV2Schema = z
  .object({
    id: unitIdSchema,
    kind: z.literal('speech'),
    chapter: z.number().int().positive(),
    /** 唯一进入 TTS 的文本：非空、无指令语法位。 */
    spokenText: z.string().min(1),
    /** 唯一进入字幕的文本；null = 该句不上字幕。 */
    subtitleText: z.string().min(1).nullable(),
    delivery: deliverySchema,
    evidenceIds: z.array(evidenceIdSchema),
    /** trace 用原文，永不进入 TTS/字幕/画面。 */
    sourceText: z.string(),
  })
  .strict();

export const silenceUnitV2Schema = z
  .object({
    id: unitIdSchema,
    kind: z.literal('silence'),
    chapter: z.number().int().positive(),
    /** 显式时长：有限正整数，<= MAX_SILENCE_MS。 */
    durationMs: z.number().int().min(1).max(MAX_SILENCE_MS),
    reason: z.enum(['pause', 'visual_breath']),
    sourceText: z.string(),
  })
  .strict();

export const narrationUnitV2Schema = z.discriminatedUnion('kind', [
  speechUnitV2Schema,
  silenceUnitV2Schema,
]);
export type SpeechUnitV2 = z.infer<typeof speechUnitV2Schema>;
export type SilenceUnitV2 = z.infer<typeof silenceUnitV2Schema>;
export type NarrationUnitV2 = z.infer<typeof narrationUnitV2Schema>;

export const narrationReviewKindSchema = z.enum([
  'pause_without_duration',
  'no_narration_without_duration',
  'visual_breath_without_duration',
  'visual_directive',
  'unknown_directive',
  'invalid_directive',
]);
export type NarrationReviewKind = z.infer<typeof narrationReviewKindSchema>;

export const narrationReviewItemSchema = z
  .object({
    id: reviewIdSchema,
    kind: narrationReviewKindSchema,
    chapter: z.number().int().positive(),
    /** 触发 review 的原始片段（完整保留，不 silent drop）。 */
    raw: z.string().min(1),
    /** 在原文中的定位（段落序 + 前文截断），人工处理依据。 */
    context: z.string(),
    reason: z.string().min(1),
  })
  .strict();
export type NarrationReviewItem = z.infer<typeof narrationReviewItemSchema>;

export const narrationChapterV2Schema = z.object({
  chapter: z.number().int().positive(),
  title: z.string().min(1),
  firstUnitId: unitIdSchema.nullable(),
  lastUnitId: unitIdSchema.nullable(),
});
export type NarrationChapterV2 = z.infer<typeof narrationChapterV2Schema>;

export const narrationPlanV2Schema = z
  .object({
    schemaVersion: z.literal(NARRATION_PLAN_V2_SCHEMA_VERSION),
    compilerVersion: z.literal(NARRATION_V2_COMPILER_VERSION),
    /** 编译输入模式：strict=script-v2@2.0 DSL；legacy=script-v2@1.x 兼容迁移。 */
    inputMode: z.enum(['strict', 'legacy']),
    source: z.object({
      /** project_versions 行 id（精确 provenance，禁止隐式 latest）。 */
      scriptV2VersionId: z.string().min(1),
      scriptV2Version: z.number().int().positive(),
      scriptV2PromptVersion: z.string().nullable(),
      /** locked 内容 sha256——content 漂移必现。 */
      scriptV2ContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }),
    chapters: z.array(narrationChapterV2Schema).min(1),
    units: z.array(narrationUnitV2Schema).min(1),
    /** 非空 → candidate 可保存，但 plan-v2.ts 的 current 判定必须拒绝。 */
    needsReview: z.array(narrationReviewItemSchema),
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
    // review ID 连续
    plan.needsReview.forEach((item, index) => {
      const expected = `R${String(index + 1).padStart(3, '0')}`;
      if (item.id !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `needsReview[${index}] id 必须是 ${expected}（实际 ${item.id}）`,
        });
      }
    });
    // chapter 引用存在 + 递增 + first/last 一致
    const chapterSet = new Set(plan.chapters.map((c) => c.chapter));
    const idsByChapter = new Map<number, string[]>();
    plan.units.forEach((unit) => {
      if (!chapterSet.has(unit.chapter)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${unit.id} 引用了不存在的 chapter ${unit.chapter}`,
        });
      }
      const list = idsByChapter.get(unit.chapter) ?? [];
      list.push(unit.id);
      idsByChapter.set(unit.chapter, list);
    });
    plan.chapters.forEach((chapter, index) => {
      if (index > 0 && chapter.chapter <= plan.chapters[index - 1]!.chapter) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `chapter 编号必须递增（第 ${chapter.chapter} 章位置错误）`,
        });
      }
      const ids = idsByChapter.get(chapter.chapter) ?? [];
      if (
        chapter.firstUnitId !== (ids[0] ?? null) ||
        chapter.lastUnitId !== (ids[ids.length - 1] ?? null)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `第 ${chapter.chapter} 章 first/lastUnitId 与 units 不一致`,
        });
      }
    });
    // speech 文本不得含指令语法位（统一 leakage 校验器）
    for (const unit of plan.units) {
      if (unit.kind !== 'speech') continue;
      const spokenLeak = findDirectiveLeakage(unit.spokenText);
      if (spokenLeak.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${unit.id} spokenText 含指令泄漏：${describeLeakage(spokenLeak)}`,
        });
      }
      if (unit.subtitleText !== null) {
        const subLeak = findDirectiveLeakage(unit.subtitleText);
        if (subLeak.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${unit.id} subtitleText 含指令泄漏：${describeLeakage(subLeak)}`,
          });
        }
      }
    }
  });

export type NarrationPlanV2 = z.infer<typeof narrationPlanV2Schema>;

/** current/lock 资格（REVIEW 1.1/冻结）：needsReview 必须为空。 */
export function isPlanV2Eligible(plan: NarrationPlanV2): boolean {
  return plan.needsReview.length === 0;
}
