/**
 * M6 Production MG 模板注册表（renderer 与语义校验/prompt 的唯一契约来源）。
 *
 * 与 M1 demo 模板（MG_ActionDelay 等 12 个硬编码 demo 版）彻底分离：
 * - 每个模板的 templateProps 有显式 zod schema，**无任何 demo 默认值**；
 * - renderer 只消费 templateProps；缺必填字段 = blocked（不 fallback）；
 * - hint 供 scenes prompt 做 template 语义选择（如冰山模型 → MG_LayeredDiagram，
 *   禁止语义漂移的 MG_TimePass 式乱配）。
 */

import {z} from 'zod';

export interface MgTemplateDef {
  id: string;
  /** 语义说明（注入 scenes prompt：什么时候选这个模板）。 */
  hint: string;
  /** templateProps 的 zod 校验器。 */
  propsSchema: z.ZodTypeAny;
  /** 必填顶层字段（错误信息/prompt 用）。 */
  required: string[];
}

const labelNote = z.object({label: z.string().min(1), note: z.string().optional()});

export const MG_TEMPLATES: Record<string, MgTemplateDef> = {
  MG_LayeredDiagram: {
    id: 'MG_LayeredDiagram',
    hint: '分层结构图（冰山/金字塔/层级模型，如意识·前意识·潜意识）',
    propsSchema: z.object({
      title: z.string().min(1),
      layers: z.array(labelNote).min(2).max(8),
      caption: z.string().optional(),
    }),
    required: ['title', 'layers'],
  },
  MG_RelationGraph: {
    id: 'MG_RelationGraph',
    hint: '关系/冲突结构图（多节点+连线，如本我·自我·超我三角关系）',
    propsSchema: z.object({
      title: z.string().min(1),
      nodes: z.array(z.object({id: z.string().min(1), label: z.string().min(1)})).min(2).max(6),
      edges: z.array(z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        label: z.string().optional(),
      })).min(1),
      caption: z.string().optional(),
    }),
    required: ['title', 'nodes', 'edges'],
  },
  MG_Timeline: {
    id: 'MG_Timeline',
    hint: '时间线（年代/阶段推进，如 1900 年《梦的解析》→ 现代科学评价）',
    propsSchema: z.object({
      title: z.string().min(1),
      events: z.array(z.object({
        label: z.string().min(1),
        time: z.string().optional(),
      })).min(2).max(8),
      caption: z.string().optional(),
    }),
    required: ['title', 'events'],
  },
  MG_ConceptCompare: {
    id: 'MG_ConceptCompare',
    hint: '双概念对比（左 vs 右，如"可证伪"与"不可证伪"）',
    propsSchema: z.object({
      title: z.string().optional(),
      left: z.string().min(1),
      right: z.string().min(1),
      note: z.string().optional(),
    }),
    required: ['left', 'right'],
  },
  MG_MessageFocus: {
    id: 'MG_MessageFocus',
    hint: '单一关键信息聚焦（一句话/一个核心论断，配合上下文）',
    propsSchema: z.object({
      message: z.string().min(1),
      context: z.string().optional(),
    }),
    required: ['message'],
  },
  MG_ScheduleNodes: {
    id: 'MG_ScheduleNodes',
    hint: '清单/步骤节点（有序列表推进，如研究方法的几个步骤）',
    propsSchema: z.object({
      title: z.string().min(1),
      items: z.array(z.object({
        label: z.string().min(1),
        done: z.boolean().optional(),
      })).min(2).max(8),
      caption: z.string().optional(),
    }),
    required: ['title', 'items'],
  },
};

export const MG_TEMPLATE_IDS: ReadonlySet<string> = new Set(Object.keys(MG_TEMPLATES));

/** 语义校验用：template 已注册 + templateProps 通过模板 schema。 */
export function validateTemplateProps(
  template: string,
  props: unknown,
): {ok: true} | {ok: false; message: string} {
  const def = MG_TEMPLATES[template];
  if (!def) return {ok: false, message: `template 未注册: ${template}`};
  if (props === undefined || props === null) {
    return {ok: false, message: `缺少 templateProps（必填: ${def.required.join(', ')}）`};
  }
  const parsed = def.propsSchema.safeParse(props);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      message: `templateProps 不完整: ${first ? `${first.path.join('.') || '(root)'} ${first.message}` : parsed.error.message}`,
    };
  }
  return {ok: true};
}

/** prompt 注入用注册表描述。 */
export function describeMgTemplatesForPrompt(): string {
  return Object.values(MG_TEMPLATES)
    .map((t) => `  · ${t.id} —— ${t.hint}（templateProps 必填: ${t.required.join(', ')}）`)
    .join('\n');
}
