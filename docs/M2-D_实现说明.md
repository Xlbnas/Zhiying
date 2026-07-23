# 知影 M2-D 实现说明（Research → Script V2）

> 基线：M2-C Hardening 冻结（a9e3c23）。中间 checkpoint：ed39180（依赖快照与提交门禁）。
> 开放范围：project_definition / research / evidence / argument_tree / script_v1 / script_v2。
> 后四阶段（narration_beat_map / visual_breakdown / shot_list / scenes）继续 STAGE_NOT_ENABLED，属 M2-E。

## 1. Enabled Stages

`src/lib/workflow/capabilities.ts`：`M2D_ENABLED_STAGES` + `isStageEnabled()` ——
API（run-stage / PATCH / lock-stage / rollback）与 UI 的唯一能力真相，不再各处复制 Set。

## 2. Payload V2

`llmJobPayloadSchema = discriminatedUnion('schemaVersion', V1 | V2)`：

- V1（1.0）：仅兼容 M2-C 旧 queued/history job 的解析，新任务不再使用。
- V2（2.0）：`{schemaVersion, stage, promptInput, upstreamVersions}`。
  `upstreamVersions` = 入队时刻全部上游 **locked_version** 快照（只存版本号，
  不复制大段内容；`payloadUpstreamVersions()` 对 V1 归一为 `{}`）。

## 3. Upstream Snapshot（原子捕获）

`src/lib/workflow/dependencies.ts`（依赖逻辑唯一出口）：

- `captureLockedUpstreamVersionsTx`：全部上游必须 status=locked 且 locked_version≠null，
  否则 UPSTREAM_NOT_LOCKED。
- `enqueueWorkflowStageJob`（llm-jobs.ts）：**单个 BEGIN IMMEDIATE** 内完成
  阶段存在 → assertRerunAllowed → 快照捕获 → project_inputs → 去重 → INSERT。
  Route 不得拆分这些步骤（快照与 INSERT 之间无可插入修改的窗口，双连接写锁互斥测试实证）。

## 4. Worker 精确读取历史版本

`resolveUpstreamVersionContents(projectId, snapshot)` 按 (project_id, stage, version)
精确读取 project_versions 历史行（不可修改，完全可复现），构造
`StagePromptInput.upstream`。Worker 禁止读 active_version / 当前 locked_version / UI state。

## 5. Dependency Preflight

`runLlmJob` 在 Provider 调用前 `checkDependencySnapshotTx`：任一上游不再
`status=locked && locked_version=snapshot` → `failed(DEPENDENCY_STALE)`（non-retryable），
Provider 调用次数 0。错误 detail 含 stage/expectedVersion/currentStatus/currentLockedVersion。

## 6. Dependency Commit Fence

`commitLlmJobResult` 在同一 BEGIN IMMEDIATE 事务内、cancel 检查之后：
从 job.payload_json 读 upstreamVersions → 逐个核对当前上游仍一致 →
不一致则同事务直接 `failed(DEPENDENCY_STALE, finished_at)`，不创建 project_version；
全部一致才 generateVersionTx + job→succeeded。返回码：
COMMITTED / CANCELLED / DEPENDENCY_STALE / JOB_NOT_RUNNING / JOB_NOT_FOUND / JOB_MISMATCH。

## 7. DEPENDENCY_STALE 语义

llm_job 的 failure reason（non-retryable，不反复烧 token）；**不是** project_stages
第六种状态——Stage 仍严格五态（not_started/generated/edited/locked/stale）。
Cancel 优先于 DEPENDENCY_STALE（commit 事务内先查 cancel_requested）。
usage 保留（请求已真实发生）；下游 not_started 阶段不因此改 stale（由 job 自己终结）。

## 8. Edit/Lock Gate 强化

`editVersion` / `lockStage` 增加上游门控（assertRunnable），非首阶段人工 edit/lock
前所有上游必须 locked；置于 NO_ACTIVE_VERSION / CONFIRM_STALE_REQUIRED /
STALE_MUST_RERUN 之后保持旧错误码语义（M2-A 56/56 零回归）。
「downstream stale + upstream unlocked → 人工 edit downstream → lock」漏洞已封闭（S10 测试）。

## 9. Markdown / JSON 编辑

PATCH contentType 由 Prompt Registry outputKind 决定（不再硬编码 markdown）。
JSON 阶段（evidence/argument_tree）：JSON.parse → 阶段 zodSchema.safeParse，
失败 → 422 INVALID_STAGE_CONTENT（≤10 条 issues，限长），非法 JSON 绝不入库；
通过存储 JSON.stringify(validatedData)。

## 10. Version History / Rollback

- `GET …/stage/:stage/versions`：metadata 倒序（source/promptVersion/model/note/time/
  isActive/isLocked/preview 120 字符）；`?version=N` 返回完整内容。唯一来源 project_versions。
- `POST …/stage/:stage/rollback`：enabled + 无活跃 job + 目标存在 → rollbackToVersion
  （复制旧版为新 version，source=rollback，历史不移动 → active 指向新版 → status=edited；
  locked 需 confirmStale，下游传播 stale）。无指针回退。
- UI：StagePanel 版本历史 Drawer（查看内容 / 回滚确认条明示「不删除后续版本」），
  stale 阶段失效提示条（旧内容保留、不可直接 lock）。

## 11. Jobs 页 LLM 区块

`/api/jobs` 返回 `{jobs, llmJobs}`（llmJobs 附最近 usage 的 provider/model）；
Jobs 页同页两区块（LLM 生成任务 + 渲染任务），render 部分零改动。

## 12. Mock 全链

test-m2d.ts [F]：六阶段依次 run+lock，每阶段 succeeded、prompt_version/model/job_id
正确、JSON 阶段内容过 zod、快照一致、六阶段全 locked。

## 13. Prompt Hardening 审阅（§四十二）

对照原始 Prompt Pack（总控提示词 / 阶段模板 01–06 / 工作流说明 / 脚本与 Evidence 规范 /
弗洛伊德示例产物）逐节审查 research@1.0 / evidence@1.0 / argument-tree@1.0 /
script-v1@1.0 / script-v2@1.0：

- Evidence 字段七要素、HTML Evidence 注释、理论主语、反驳节点、V2 不删边界不增事实、
  观众先验/目标认知变化、来源边界三态 —— 全部覆盖。
- Evidence ID 分配在 evidence 阶段（与总控提示词 PHASE 2 一致；规范文档的
  「研究阶段创建」为宽泛表述，不构成冲突）。
- **结论：无重大语义遗漏，promptVersion 保持 @1.0，本轮无 Prompt 文本变更。**

## 14. REAL_M2D_DEEPSEEK_SMOKE

**NOT_RUN**（本机未配置 DEEPSEEK_API_KEY；不阻塞）。

## 15. Browser QA（agent-browser，LLM_PROVIDER=mock）

新建项目 → pd 生成/锁定 → research 生成/锁定 → evidence 生成/查看 JSON/锁定 →
argument_tree 生成/锁定 → script_v1 生成/锁定 → 重新生成（确认条含 stale 警告）→
编辑 → 锁定 → script_v2 生成/锁定 → Stepper 显示 narration_beat_map 当前但禁用 →
script_v1 版本历史 Drawer（查看 v1 内容）→ 回滚 v1（确认条）→ v5 rollback 新版本
（非指针移动）+ script_v2 stale → stale banner 正确 → Research 重新生成（确认）→
证据→脚本 V2 全部 stale → 刷新全部持久化 → Jobs 页 LLM 区块（9 任务，
provider/model/attempt/时间正确）→ 1366/1440/1920 三宽度布局正常。

## 16. 回归

- test-m2d.ts **63/63 PASS**（S1 能力 / D1–D8 依赖 / S9 stale 传播 / S10 edit gate /
  S11 JSON 编辑 / F 六连跑 / V 版本与回滚）
- M2-C **100/100**、M2-B **102/102**、M2-A **56/56**
- pnpm typecheck PASS、pnpm build PASS、verify-roundtrip **682/682 PASS**
- REMOTION_SMOKE = SKIPPED_ENV_MISSING_ASSETS（public/full、pilot 未入 Git）
