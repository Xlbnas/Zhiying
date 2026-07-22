/**
 * argument_tree 阶段（PHASE 3 — Argument Tree）。
 * 输出：论证树 JSON（zod 校验）。所有事实节点引用 Evidence ID。
 */

import {z} from 'zod';
import {
  composeSystem,
  projectVarsBlock,
  SHARED_ROLE,
  SHARED_RESEARCH_PRINCIPLES,
  SHARED_SCRIPT_PRINCIPLES,
  upstreamBlock,
  type StagePrompt,
} from './shared';

export const argumentNodeKindSchema = z.enum([
  'opening',
  'claim',
  'support',
  'case',
  'rebuttal',
  'boundary',
  'ending',
]);

export const argumentNodeSchema = z.object({
  /** 稳定节点 ID，如 N01。 */
  id: z.string().min(1),
  kind: argumentNodeKindSchema,
  title: z.string().min(1),
  /** 节点论证功能与内容摘要。 */
  summary: z.string().min(1),
  /** 事实节点必须引用 Evidence ID（如 E01）；纯推论节点可为空但需在 summary 标明推论属性。 */
  evidenceIds: z.array(z.string()).default([]),
  /** 子节点 ID 列表（扁平表 + 引用，避免深层嵌套）。 */
  children: z.array(z.string()).default([]),
});

export const argumentTreeSchema = z.object({
  /** 视频核心问题（可研究、非结论预设）。 */
  coreQuestion: z.string().min(1),
  /** 一句话核心命题（含边界措辞）。 */
  coreClaim: z.string().min(1),
  /** 观众起始认知。 */
  audiencePrior: z.string().min(1),
  /** 目标认知变化。 */
  audienceTarget: z.string().min(1),
  nodes: z.array(argumentNodeSchema).min(1),
});

export type ArgumentTree = z.infer<typeof argumentTreeSchema>;

const system = composeSystem(
  SHARED_ROLE,
  `【本阶段角色】论证架构师。你只依据 Evidence 建立论证树：问题、主张、支撑、案例作用、主动反驳、科学边界和克制结尾。`,
  SHARED_RESEARCH_PRINCIPLES,
  SHARED_SCRIPT_PRINCIPLES,
  `【目标】产出论证树：开场问题 → 核心主张 → 支撑链 → 案例功能 → 主动反驳 → 科学边界 → 克制结尾；所有事实节点引用 Evidence ID。`,
  `【推理与输出行为】
- 先写观众起始认知与目标认知变化，再设计连接两者的论证路径。
- 每个事实节点引用 evidenceIds；引用不存在的 Evidence ID 视为失败。
- 争议理论必须有 rebuttal 节点（主动反驳，不是结尾免责声明），boundary 节点说明证据可支持到哪里。
- 结尾保持克制：允许答案是开放的，不替观众下诊断。
- 先设计结构，禁止先写金句后找证据。`,
  `【输出契约】仅输出 JSON（不要 Markdown 代码围栏），结构：
{
  "coreQuestion": "…", "coreClaim": "…",
  "audiencePrior": "…", "audienceTarget": "…",
  "nodes": [
    {"id": "N01", "kind": "opening|claim|support|case|rebuttal|boundary|ending",
     "title": "…", "summary": "…", "evidenceIds": ["E01"], "children": ["N02"]}
  ]
}
节点用扁平数组 + children 引用表达树结构；children 只能引用存在的节点 ID。`,
  `【禁止行为】
- 不得越过 Evidence 新增事实主张；不得隐藏争议。
- 不得把 forbidden-extrapolation 条目用作正面结论。
- 不得输出完整旁白或镜头设计（那是下游阶段）。
- 不得输出 JSON 以外的任何文字。`,
  `【自检】输出前确认：每个事实节点有 Evidence ID？有主动反驳与边界节点？children 引用全部有效？结尾是否克制？`,
);

export const argumentTreePrompt: StagePrompt = {
  stage: 'argument_tree',
  promptVersion: 'argument-tree@1.0',
  outputKind: 'json',
  system,
  zodSchema: argumentTreeSchema,
  buildUser(input) {
    return [
      projectVarsBlock(input),
      upstreamBlock(input, ['project_definition', 'evidence']),
      '请仅执行 argument_tree 阶段，输出论证树 JSON。',
    ].join('\n\n');
  },
};
