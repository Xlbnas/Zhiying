/**
 * evidence 阶段（PHASE 2 — Evidence）。
 * 输出：证据库 JSON（zod 校验）。每条主张绑定 Evidence ID 与边界措辞。
 */

import {z} from 'zod';
import {
  composeSystem,
  projectVarsBlock,
  SHARED_ROLE,
  SHARED_RESEARCH_PRINCIPLES,
  SHARED_SOURCE_BOUNDARY,
  sourceContextBlock,
  upstreamBlock,
  type StagePrompt,
} from './shared';

/** 来源类型：原始来源 / 二手来源 / 现代研究 / 理论解释 / 合理推论 / 禁止推论。 */
export const evidenceSourceTypeSchema = z.enum([
  'primary',
  'secondary',
  'modern-research',
  'theory',
  'interpretation',
  'forbidden-extrapolation',
]);

/** 核实状态：sourceContext 不足时必须降级为这三态之一。 */
export const evidenceVerificationSchema = z.enum([
  'VERIFIED',
  'UNVERIFIED',
  'SOURCE_REQUIRED',
  'INSUFFICIENT_SOURCES',
]);

export const evidenceItemSchema = z.object({
  /** 稳定 Evidence ID，如 E01。 */
  id: z.string().min(1),
  /** 可用于视频的陈述（可核查语言）。 */
  claim: z.string().min(1),
  /** 来源描述；无来源时填 "SOURCE_REQUIRED"，禁止编造。 */
  source: z.string().min(1),
  sourceType: evidenceSourceTypeSchema,
  verification: evidenceVerificationSchema,
  /** 支持强度。 */
  supportLevel: z.enum(['high', 'medium', 'low', 'none']),
  /** 允许措辞（写到脚本里的最大口径）。 */
  allowedWording: z.string().min(1),
  /** 禁止推论（越界写法）。 */
  forbiddenInference: z.string(),
  notes: z.string().default(''),
});

export const evidenceDocSchema = z.object({
  evidence: z.array(evidenceItemSchema).min(1),
  /** 证据缺口：需要来源但目前没有的主张。 */
  gaps: z.array(z.string()).default([]),
});

export type EvidenceDoc = z.infer<typeof evidenceDocSchema>;

const system = composeSystem(
  SHARED_ROLE,
  `【本阶段角色】证据编辑。你把研究地图转成带稳定 Evidence ID 的证据库，逐条标注边界。`,
  SHARED_RESEARCH_PRINCIPLES,
  SHARED_SOURCE_BOUNDARY,
  `【目标】把 Research 转为结构化证据库：每条记录 claim / source / sourceType / verification / supportLevel / allowedWording / forbiddenInference / notes，并标记缺口。`,
  `【推理与输出行为】
- 每条重要事实、历史断言、实验结果和数字对应一个 Evidence ID（E01、E02 … 稳定递增）。
- 事实、理论、推论必须分开：理论解释主语明确（如"弗洛伊德认为"）；现代研究只说明实验支持到哪里。
- 对每个常见错误外推，显式建立 forbidden-extrapolation 条目（supportLevel=none），供下游禁用。
- 无 sourceContext 支撑的来源一律 verification≠VERIFIED，并在 allowedWording 中降级措辞。`,
  `【输出契约】仅输出 JSON（不要 Markdown 代码围栏），结构：
{
  "evidence": [
    {"id": "E01", "claim": "…", "source": "…", "sourceType": "primary|secondary|modern-research|theory|interpretation|forbidden-extrapolation",
     "verification": "VERIFIED|UNVERIFIED|SOURCE_REQUIRED|INSUFFICIENT_SOURCES",
     "supportLevel": "high|medium|low|none", "allowedWording": "…", "forbiddenInference": "…", "notes": "…"}
  ],
  "gaps": ["…"]
}`,
  `【禁止行为】
- 禁止伪造来源字段（论文、URL、作者、页码、直接引文）。
- 禁止把二手资料标成 primary，把未核实内容标成 VERIFIED。
- 不得输出 JSON 以外的任何文字。`,
  `【自检】输出前确认：每条都有 ID 与边界措辞？verification 状态是否与 sourceContext 匹配？是否有禁止推论条目？JSON 是否可解析？`,
);

export const evidencePrompt: StagePrompt = {
  stage: 'evidence',
  promptVersion: 'evidence@1.0',
  outputKind: 'json',
  system,
  zodSchema: evidenceDocSchema,
  buildUser(input) {
    return [
      projectVarsBlock(input),
      upstreamBlock(input, ['project_definition', 'research']),
      sourceContextBlock(input),
      '请仅执行 evidence 阶段，输出证据库 JSON。',
    ].join('\n\n');
  },
};
