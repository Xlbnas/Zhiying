# 知影 M2-B 实现说明（LLM Provider + Prompt Registry + llm_usage）

> 基线：`326efec`（M2-A Hardening）+ `2142315`（src/remotion/data 恢复入库）。
> 范围严格限定：Prompt → Provider → Response → Usage Snapshot → Parse → Zod → ≤2 次 Repair → ValidatedStageResult。
> **未做**：run-stage API、worker 接入、UI、project_versions/project_stages 写入、llm_jobs 消费（全部 M2-C 起）。

## 1. Provider Contract（src/lib/llm/types.ts）

- `LLMRequest`：model / system / user / outputMode(text|json) / thinking(enabled|disabled) / reasoningEffort?(high|max) / maxTokens? / meta?.stage（仅 Mock/日志用，不发送）。
- `LLMResponse`：text / requestId / model / finishReason / usage。
- `LLMUsage`：promptTokens / cacheHitTokens / cacheMissTokens / completionTokens / reasoningTokens?（reasoning 已含于 completion，不重复计费）。
- `LLMError.code`（程序只按 code 判断，禁止解析 message 文本）：
  CONFIG_ERROR / PROVIDER_TIMEOUT / PROVIDER_HTTP_ERROR / PROVIDER_INVALID_RESPONSE / EMPTY_RESPONSE / OUTPUT_TRUNCATED / VALIDATION_FAILED。
- 响应分工：2xx 且结构完整 → 原样返回（空 text、finishReason=length 由 executor 在记 usage 后判定）；结构不完整或缺 usage → PROVIDER_INVALID_RESPONSE，不伪造成本。

## 2. DeepSeek Provider（src/lib/llm/deepseek.ts）

- Node 原生 fetch（可注入 fetchImpl 测试），POST `{baseUrl}/chat/completions`，显式 `stream:false`。
- thinking 显式发送 `{type: enabled|disabled}`；reasoning_effort 仅 enabled 时发送；不发送 temperature/top_p（思考模式不支持）。
- JSON 阶段 `response_format:{type:'json_object'}`。
- timeout 默认 120s（AbortController）；网络瞬时失败 / 429 / 5xx 最多 retry 1 次；4xx 不 retry；禁止无限 retry。
- usage 完整解析：prompt_tokens / prompt_cache_hit_tokens / prompt_cache_miss_tokens / completion_tokens / completion_tokens_details.reasoning_tokens。
- API Key 仅存在于 Authorization 头；永不 console.log / 入库 / 写 fixture / 进错误堆栈 / 进 Git。

## 3. Provider 安全规则（src/lib/llm/index.ts）

| 情形 | 行为 |
|---|---|
| production + LLM_PROVIDER=mock | CONFIG_ERROR |
| production 未配置 provider | CONFIG_ERROR |
| LLM_PROVIDER=deepseek 无 Key（任何环境） | CONFIG_ERROR |
| dev/test 未配置 provider | fallback mock + warning |
| dev/test 显式 mock | 允许 |

production 绝不自动 fallback Mock。

## 4. Stage Model Config（src/lib/llm/stage-models.ts）

| 阶段 | model | thinking | reasoningEffort | maxTokens |
|---|---|---|---|---|
| project_definition | deepseek-v4-flash | disabled | — | 4096 |
| research | deepseek-v4-flash | enabled | high | 8192 |
| evidence | deepseek-v4-flash | enabled | high | 8192 |
| argument_tree | deepseek-v4-pro | enabled | high | 8192 |
| script_v1 | deepseek-v4-pro | enabled | high | 16384 |
| script_v2 | deepseek-v4-pro | enabled | high | 16384 |
| narration_beat_map | deepseek-v4-flash | disabled | — | 8192 |
| visual_breakdown | deepseek-v4-flash | enabled | high | 8192 |
| shot_list | deepseek-v4-flash | disabled | — | 16384 |
| scenes | deepseek-v4-flash | disabled | — | 32768 |

- thinking 由本表显式决定，不依赖供应商默认值（官方默认 enabled）。
- `LLM_STAGE_MODEL_<STAGE>` 仅覆盖模型名；thinking/effort 不允许环境变量改动。UI 不参与模型配置。

## 5. Prompt Registry（src/lib/prompts/）

- 版本：project-definition@1.0 / research@1.0 / evidence@1.0 / argument-tree@1.0 / script-v1@1.0 / script-v2@1.0 / narration-beat-map@1.0 / visual-breakdown@1.0 / shot-list@1.0 / scenes@1.0。
- 每模板含：Role / Goal / Input contract / Evidence boundary / Reasoning-output behavior / Output contract / Forbidden behavior / Self-check。
- system 静态（利于前缀缓存），项目变量 + 上游产物 + sourceContext 走 user。
- outputKind：markdown×6（project_definition/research/script_v1/script_v2/narration_beat_map/visual_breakdown）；json×4（evidence/argument_tree/shot_list/scenes，全部带 zod schema）。
- scenes 复用 M1 sceneSchema/chapterTimingSchema；AI 只负责 chapterTiming + scenes[]；schemaVersion/templateVersion/composition/fps/width/height 为系统数据（schema 层剥离，FPS=30 仅作帧换算常量经 user 告知）。
- 来源边界：无联网能力、禁止伪造（论文/URL/作者/页码/引文/Source ID），UNVERIFIED / SOURCE_REQUIRED / INSUFFICIENT_SOURCES 三态降级；预留 sourceContext?（M4）。
- 视觉阶段：MG 是解释语言非整片视觉；五类视觉 Reality B-roll / Archive / MG / Minimal / Editorial Graphic；避免连续同布局；禁 cyberpunk HUD / generic AI dashboard；风格来自项目上下文，不硬编码 Freud 示例。

## 6. Repair Policy（src/lib/llm/executor.ts）

- JSON 阶段：首次 + 最多 2 次 repair（共 ≤3 次真实请求，每次独立记 usage）。
- repair prompt：原始 user + 精确 Zod issues（≤2000 字符）+ 原始输出（≤4000 字符）+ schema 要求 + JSON ONLY。
- JSON parse error → repair；Zod error → repair；EMPTY_RESPONSE → 同 prompt 重问（占 repair 次数，可 recovery）；finishReason=length → OUTPUT_TRUNCATED 不做普通 repair。
- ValidatedStageResult：stage / content / contentType / parsed? / provider / model / promptVersion / repairCount / requestIds / versionSource(ai_generate|repair)。

## 7. Usage Policy（src/lib/llm/usage.ts + pricing.ts）

- 顺序铁律：Provider Response → Record Usage → Parse/Validate；校验失败/截断的请求照样记成本；transport 层无 usage 则不记录、不伪造。
- 单价写入时快照（price_cache_hit_per_m / price_cache_miss_per_m / price_output_per_m + cost_cny），历史行禁止按未来价格重算；禁止 DB migration（仅 INSERT 现有 llm_usage 表）。
- 成本公式：cacheHit×hit + cacheMiss×miss + completion×out（元/百万 tokens）；reasoningTokens 不重复计费。
- 未知模型拒绝估算（CONFIG_ERROR）。

### 官方价格核对（执行当天 2026-07-22）

- 来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>（人民币页）。
- priceTableVersion：`deepseek-cny-2026-07-22`；checkedAt：2026-07-22。
- deepseek-v4-flash：缓存命中 0.02 / 未命中 1 / 输出 2（元/百万）。
- deepseek-v4-pro：缓存命中 0.025 / 未命中 3 / 输出 6（元/百万）。

### 与 M2 计划相比的官方文档变化（以执行当天官方文档为准）

1. `deepseek-chat` / `deepseek-reasoner` 将于 2026-07-24 23:59（北京时间）弃用，当前分别映射 deepseek-v4-flash 的非思考/思考模式——本项目只使用 v4 模型名，不受影响。
2. thinking 参数 `{type: enabled|disabled}`，官方默认 enabled——本实现一律显式发送，不依赖默认值。
3. `reasoning_effort` 官方取值 high/max（low/medium 映射 high，xhigh 映射 max）；普通请求默认 high。
4. 思考模式不支持 temperature/top_p/presence_penalty/frequency_penalty——本实现不发送采样参数。
5. 美元价（参考）：flash $0.0028/$0.14/$0.28，pro $0.003625/$0.435/$0.87；成本结算一律用人民币价目表。
6. 上下文 1M、最大输出 384K、JSON Output 双模型支持（官方功能表）。

## 8. 测试结果

- `npx tsx scripts/test-m2b.ts`：**92/92 PASS**（Provider 选择器/production 禁 mock/无 Key CONFIG_ERROR/请求体/thinking 显式/response_format/usage 解析/超时与错误映射/retry 上限/Registry 完整性/outputKind/schema 齐全/十阶段 Mock 全过/bad JSON→repair/bad schema→repair/repair 上限 VALIDATION_FAILED/empty recovery/length 不 repair/成本公式手算/repair 独立 usage/失败仍记 usage/transport 不伪造/来源边界/Mock 确定性/executor 不触 workflow 层/secret 静态检查）。
- `npx tsx scripts/test-workflow-stages.ts`：**56/56 PASS**（M2-A 回归）。
- `pnpm typecheck`：PASS（tsc 零错误）。
- `pnpm build`：PASS。
- `pnpm verify:roundtrip`：**682/682 PASS**（M1 回归）。
- Remotion renderStill smoke：**SKIPPED_ENV_MISSING_ASSETS**（public/full、public/pilot 为 gitignored 大型素材，新机缺失；未伪造资产）。

## 9. REAL_DEEPSEEK_SMOKE

**NOT_RUN**（本机未配置 DEEPSEEK_API_KEY；脚本 `scripts/smoke-deepseek.ts` 仅检查存在性，不打印值；配置后执行一次极小 project_definition 真实请求并打印 requestId/model/usage/成本快照）。

## 10. ORIGINAL_PROMPT_PACK / PROMPT_MIGRATION_REQUIRED

- **ORIGINAL_PROMPT_PACK = AVAILABLE**（不在 Git 内，但存在于本机 `~/Documents/kimi/Workspaces/AI Video Test/AI_Video_Production_Workflow_V1_CN/`：总控提示词、阶段模板 01–11、工作流说明、脚本/Evidence/Scenes 规范、弗洛伊德示例产物）。M2-B Prompt Registry 已基于其完成产品化第一版。
- **PROMPT_MIGRATION_REQUIRED = false**。旧机恢复后仍应做 Prompt Hardening（真实 DeepSeek 逐阶段校准输出质量，M2-C/D 按 M2 计划风险 #1 执行）。

## 11. 新设备缺失的 runtime assets（预期，不阻塞）

- data/zhiying.db、bundle-cache、render job history、MP4、测试截图、public/full、public/pilot（均 gitignored）。
- `src/remotion/data/*` 旧机未入库且被 `.gitignore` 的 `data/` 误吞——已恢复并以 `2142315` 入库（`.gitignore` 锚定为 `/data/`）。
- 架构文档《视频生成器_架构设计文档.md》不在本机/Git（M2-B 以 docs/M2_实施计划.md + 官方文档为准）。

## 12. 新增/修改文件清单

- 新增：src/lib/llm/{types,deepseek,mock,index,stage-models,pricing,usage,executor}.ts
- 新增：src/lib/prompts/{shared,registry,fixtures,project-definition,research,evidence,argument-tree,script-v1,script-v2,narration-beat-map,visual-breakdown,shot-list,scenes}.ts
- 新增：scripts/test-m2b.ts、scripts/smoke-deepseek.ts、docs/M2-B_实现说明.md
- 修改：.env.example（追加 LLM 配置说明）
- 未修改：workflow transaction 层（operations.ts/stages.ts/versions.ts）、worker、API、UI、DB schema、lockfile。
