# Zhiying → Codex Skill Migration
# Phase 1B — KEEP / EXTRACT / RETIRE Audit

审计日期：2026-08-22（Asia/Shanghai）  
审计输入：`docs/skill_migration/01_CURRENT_SYSTEM_INVENTORY.md`、关键源码、当前 compose/adapter 文档。  
审计性质：只读架构判断；本报告是本阶段唯一新增文件。

## Executive Verdict

当前 Zhiying 可以沿着“Codex → Skill → 薄 CLI → artifacts/manifest → 确定性执行器”迁移，但不应把整个 `src/worker/`、SQLite 或 TTS/Render 代码一并删除。

事实分层如下：

1. Remotion composition、scene schema、FFmpeg/ffprobe、TTS provider/IndexTTS2 adapter、subtitle timing、timing reconciliation、asset/provenance、render visual/loudness gates 已经承担真实生产职责，应继续复用。
2. Next.js workflow UI、LLM stage API、prompt/provider orchestration、`project_stages` 状态机和 LLM job 队列主要服务旧平台的“生成—锁定—推进”流程，目标迁移后应逐步退出；其中 prompts/SOP 内容应抽取到 Skill，而不是丢弃。
3. 当前 Scheduler/Worker 不是纯胶水：它实际承担渲染/TTS 执行、SQLite 原子 claim、heartbeat、取消、stale recovery、GPU lease 和优雅退出。因此它不能在没有等价执行入口与故障恢复验证前直接标记为 RETIRE；最小动作是先从其中抽取确定性 executor，再评估是否退休通用队列。
4. 当前没有可直接调用的 production CLI；`package.json` 只有 `worker`、`build`、round-trip/import 脚本。CLI 的最小新增量应是薄适配层，不应重写 provider、renderer、reconciliation 或 manifest 逻辑。

本报告的 `RETIRE` 表示“目标架构中的退出候选”，不表示本阶段可以删除。`UNKNOWN` 表示证据不足，不作推断。

## KEEP / EXTRACT / RETIRE / UNKNOWN Matrix

| Component | Path | Current Role | Classification | Evidence | Target Role | Migration Action | Risk |
|---|---|---|---|---|---|---|---|
| Remotion compositions / props schema | `src/remotion/`, `src/remotion/Root.tsx`, `src/lib/scene-schema.ts` | 注册 composition，按 `ZhiyingFullCutProps` 消费 scenes、assets、subtitles、audio | KEEP | Worker 调用 `selectComposition` + `renderMedia`；本地 Golden Case MP4 tag 为 Remotion 4.0.492；所有 Remotion 包精确同版本 | 生产渲染核心 | 原样复用；CLI 只传入现有 schema 的完整 props，不绕过 renderer | 中 |
| Render input gates | `src/lib/render/visual-gate.ts`, `src/lib/workflow/scenes-semantic-validation.ts` | 校验模板、MG props、assetMap，阻止占位或不可渲染输入 | KEEP | Gate 以 renderer 真正消费的 props 为准；Final Bridge 与 Worker 双点校验 | Render 前置检查 | 保持现有 gate；CLI 调用同一函数 | 高 |
| Render execution | `src/worker/index.ts:136-220,229-395,598-665` | bundle、runtime staging、composition 选择、Remotion render、取消/lease fence | EXTRACT | `runJob` 直接执行真实 Remotion/Chrome 渲染；`runRenderJob` 管理 bundle 与 lease | `zhiying render` 的确定性执行函数 | 从 Worker 分支抽出可单次调用的 executor；保留 staging、cancel、fence、atomic publish | 高 |
| FFmpeg / ffprobe helpers | `src/lib/narration/audio.ts`, `src/lib/render/loudness.ts`, `src/lib/render/artifact.ts`, `src/worker/index.ts` | master WAV、loudnorm、音频/视频 probe、codec/duration/frame gate | KEEP | 生产链和 M6 报告均以 ffprobe/loudnorm 作为最终 gate；不是 UI 能力 | 媒体处理核心 | 原样复用现有 `execFile`/helper；不引入新媒体服务 | 高 |
| Render manifest / provenance | `src/lib/render/artifact.ts`, `src/lib/final-render/schema.ts`, `render_artifacts` | 记录 output path、hash、size、duration、encoder、audit、loudness 与 source snapshot | KEEP | Worker 在 publish 前完成 probe/gate/hash，成功后写 manifest 再 atomic rename | artifact/manifest truth | 保留现有 manifest 字段和写入顺序；新 CLI 只能复用 writer | 高 |
| IndexTTS2 Node provider | `src/lib/tts/indextts2.ts`, `src/lib/tts/index.ts` | health gate 后 POST `/v1/synthesize`，固定 voice profile/revision、`useRandom=false`，返回 WAV | KEEP | Provider 明确调用 `INDEXTTS2_BASE_URL`，production 禁止 mock；调用契约是稳定的 Node→HTTP 方式 | TTS adapter 的 Node 侧 | 原样复用；不改成 MCP、不在 Skill 中重写 HTTP | 高 |
| IndexTTS2 adapter | `services/indextts2-api-adapter/server.py` | registry/reference 校验、speaker identity/reuse、HTTP 翻译到独立 GPU upstream | KEEP | README 与 compose 明确 adapter 无 GPU/torch，仅把 `:9880` 请求转给 `indextts2:8002`；registry 与 reference SHA fail-closed | Feiniu 外部执行器 | 原样保留；只确认现场 env/mount/health，不新增 sidecar | 高 |
| TTS audio validation / finalize | `src/worker/tts-executor.ts`, `src/lib/tts-c/audio-probe.ts`, `src/lib/narration/audio.ts` | provider 调用、WAV/ffprobe 校验、临时文件、hash、atomic rename、manifest finalize | EXTRACT | `runTtsJob` 明确包含 provider snapshot、cancel/shutdown/lease fence、WAV validation；audio compiler 生成 master WAV | `zhiying tts` 的执行核心 | 从 job claim 外壳中抽出单次 TTS executor；保留校验、manifest、provider snapshot | 高 |
| Voice registry / reference identity | `src/lib/voice-library/`, `services/indextts2-api-adapter/` | voice profile/revision、reference WAV、registry publication/recovery、SHA identity | KEEP | adapter 以 registry 和 reference SHA 为 readiness 条件；当前 production compose 已接入 `/voices`、`/registry` | TTS 输入事实与 provenance | 保留 registry 文件及现有 identity 语义；现场状态仍需核验 | 高 |
| Narration plan compiler | `src/lib/narration/plan.ts`, `src/lib/narration/compiler.ts` | locked `script_v2` 转 narration units/plan artifact | KEEP | M6 链路明确由 locked script 进入 narration plan；产物是后续音频/subtitle 输入 | Skill 产出的 script 与 TTS 之间的确定性转换 | 复用 schema/compiler；不保留“推进 stage”的控制职责 | 中 |
| Narration audio orchestration | `src/lib/narration/audio.ts`, narration API routes | 读取 current plan、为 speech units 入队、lazy finalize、生成 master manifest | EXTRACT | API 只 enqueue，实际 provider 在 Worker；`audio.ts` 同时包含 plan snapshot、TTS job 与 finalize 逻辑 | CLI 的 plan→audio artifact 适配层 | 把 plan snapshot、unit reuse、master finalize 暴露为直接函数；不复制一套音频状态机 | 高 |
| Subtitle compiler/timing/renderer | `src/lib/subtitles/compiler.ts`, `timing.ts`, `renderer.ts` | 从 narration plan + measured audio 生成 cue、timing artifact、SRT/renderer cues | KEEP | M6 记录 subtitle-timing 201；源码 imports/calls 未发现 STT provider | 确定性字幕产物生成 | 原样复用；由 CLI 或 render preflight 调用 | 中 |
| Timing reconciliation | `src/lib/reconciliation/` | scenes、master audio、subtitle timing 汇合为 target frames/source snapshot | KEEP | `src/lib/reconciliation/timing.ts` 对 frame/duration/residual 做 schema 校验；M6 记录成功 | Render 前确定性时间契约 | 原样复用；CLI 输入/输出 artifact 化 | 高 |
| Asset acquisition / binding | `src/lib/assets/`, `src/app/api/projects/[id]/assets/` | Wikimedia/上传/APIYi 获取素材，保存文件、license/provenance，绑定 scene requirement | KEEP | M6 文档记录真实 upload/binding/MG override/Final readiness；resolver 与 visual gate 读取绑定 | 素材事实与 renderer 输入 | 保留 provider、resolver、binding、license/provenance；API enqueue 外壳另行抽取 | 高 |
| Asset API / generation enqueue | `src/lib/assets/generation-jobs.ts`, asset API routes | 对外接收生成请求、request id、source fence、durable job enqueue | EXTRACT | M7 generation job 有 source version、request id、billing 状态；当前本地 DB 相关行数为 0，未证实进入当前 M6 生产链 | 可选的外部素材执行适配 | 先保留代码；若未来需要，只抽 provider call + asset manifest，不迁移整套 M7 调度 | 高 |
| Final Render Bridge | `src/lib/final-render/bridge.ts`, `src/app/api/projects/[id]/final-render/route.ts` | 汇合 current artifacts、source fence、readiness、props snapshot，创建 render job/source/attempt | EXTRACT | `enqueueFinalRender` 写 `final_render_source`/`final_render_attempt` 后调用 `enqueueRenderJob`；M6 report 记录 Final readiness | `zhiying render` 的输入组装与 provenance facade | 保留 source fence、readiness、props snapshot；去掉 Next Route 和旧 job 依赖 | 高 |
| Render job persistence | `src/lib/jobs.ts`, `render_jobs`, `artifacts(kind=render_output)` | queue row、atomic claim、heartbeat、retry/cancel、成功 artifact | EXTRACT | `jobs.ts:59-210` 明确实现 queue/recovery；成功事务写 render output artifact；本地 Golden Case 依赖它 | 过渡兼容层或 CLI execution record | 过渡期可继续写；新 CLI 先输出同等 render manifest，是否写旧 queue row 由兼容需求决定 | 高 |
| Unified scheduler | `src/lib/scheduler.ts`, `src/worker/job-runner.ts` | 多队列全局 FIFO、资源类别、production GPU lease、并行 loop、job dispatch | EXTRACT | scheduler union 查询 render/llm/tts/dispatch/asset jobs；GPU claim 先于 running；worker loop 负责并发、AbortController、lease release | 过渡期 executor host；不是目标领域层 | 先抽出 render/tts 单次 executor；验证直接 CLI 的恢复语义后再决定是否退役通用 scheduler | 高 |
| Worker bootstrap / recovery | `src/worker/index.ts:671-815` | 启动 stale recovery、TTS-C recovery、registry recovery、poll loop、graceful shutdown | EXTRACT | 启动时恢复 render/LLM/TTS/dispatch/asset jobs；运行时维护 recovery controllers；这不是单纯 render helper | 过渡期后台执行器 | 不在本阶段删除；把可复用 recovery/cleanup 语义作为抽取边界，逐项验证 | 高 |
| LLM provider/executor | `src/lib/llm/`, `src/worker/llm-executor.ts` | DeepSeek OpenAI-compatible 请求、parse/repair、usage、写入 stage version | RETIRE | `run-stage` 只 enqueue；`llm-executor` 才调用 provider；compose 只给 worker `DEEPSEEK_API_KEY`；目标明确由 Codex 推理 | 不再是 Zhiying production runtime | 不迁移执行器；把需要保留的输入/输出 schema、错误规则和 usage 事实提取到 Skill/文档 | 高 |
| Prompt registry / domain SOP | `src/lib/prompts/` | research/evidence/argument tree/script 等阶段 prompt 与 output schema | EXTRACT | registry 包含 domain stages；其内容是领域方法，不等同于 worker queue | Zhiying Skill 的 SOP/review 输入 | 只抽取方法、schema、review rules；不把 prompt registry 原样变成新的 workflow engine | 中 |
| Workflow stage state | `src/lib/workflow/stages.ts`, `operations.ts`, `versions.ts`, `project_stages` | stage active/locked/stale、锁定、回滚、上游依赖、运行权限 | RETIRE | `run-stage`/`lock-stage` 直接调用它；`project_stages` 是状态与 pointer，不是视频媒体事实；当前本地有 160 rows | Skill/agent 的显式流程判断 | 新流程使用 artifact references/manifest；旧项目兼容期间只读保留，禁止本阶段删除 | 高 |
| LLM/job orchestration API | `src/app/api/workflow/run-stage/`, `lock-stage/`, `cancel-job/` | Next.js 自己的 validation、enqueue、stage lock/cancel glue | RETIRE | `run-stage` 明确 202 后不直接 LLM；接口只服务旧 workflow | 无；由 Codex/Skill 直接决定下一步 | 作为旧平台退出候选；先冻结 contract，迁移期间不再扩展 | 中 |
| Workflow UI / Jobs UI | `src/app/page.tsx`, `src/app/project/`, `src/app/jobs/`, `src/app/settings/` | 项目编辑、阶段推进、jobs 监控、voice/settings 控制面 | RETIRE | UI 通过 Next API 访问 project/workflow/jobs；不是 renderer、TTS 或 FFmpeg 本体 | Codex conversation + read-only inspect output | 不迁移 UI 交互；保留旧平台可启动性直到旧项目完成过渡 | 中 |
| M7 durable dispatch/DAG state | `src/lib/llm-generation/`, `src/lib/workflow/dag.ts`, `generation_*` tables | M7 LLM dispatch、single-flight、attempt journal、asset generation queue | UNKNOWN | Phase 1A 证实当前 17 个项目均 `pipeline_version=m6`，相关本地 rows 为 0；无法证明 production 已依赖 | 需先确认是否有 production consumer | 不纳入本次迁移；没有现场证据前不标 RETIRE、不迁移 | 高 |
| SQLite connection/schema | `src/lib/db.ts`, `data/zhiying.db` | 混合承载项目事实、artifact、workflow state、runtime jobs、leases、usage | UNKNOWN | 当前 DB 同时含上述四类数据；生产 DB 未现场读取；目标是否要求文件 manifest 取代全部 DB 尚未确认 | 过渡持久层；未来可能只保留兼容索引/manifest metadata | 不改 schema、不删表；先定义 artifact canonical boundary，再决定保留范围 | 高 |
| Project identity/input/version tables | `projects`, `project_inputs`, `project_versions` | 项目身份、用户输入、内容版本、stage 版本与锁定指针 | UNKNOWN | `projects/project_inputs` 是业务事实；`project_versions` 保存真实内容，但部分 pointer/status 与 workflow 耦合 | 新项目 artifact manifest 的业务事实来源 | 先保持兼容；按字段拆分“内容事实”和“workflow pointer”，不整体退休 | 高 |
| Usage/cost records | `llm_usage`, `project_usage_events`, `src/lib/usage/` | LLM/TTS/render/image usage 与成本/墙钟/GPU 秒记账 | UNKNOWN | 当前 rows 为 LLM 74、其他 usage 0；Codex 侧计费/usage 是否需要回写未定义 | 可选 provenance/operational evidence | 不删除；等待 Codex/外部执行器是否要求同一账本 | 中 |
| Deployment/runtime packaging | `Dockerfile`, `docker-compose.production.yml`, `docker-compose.production.gpu.yml`, `DEPLOY.md` | Feiniu web/worker/adapter、Remotion Chrome、ffmpeg、volumes、GPU/network | KEEP | compose 明确 web/worker/adapter 与 Feiniu mounts、host network、GPU override；IndexTTS2 为独立 stack | 生产执行环境 | 复用镜像/adapter/network 事实；只在实现阶段补 CLI entrypoint，不重建部署拓扑 | 高 |

## Classification Counts

按上表的审计行计数（一个 row 是一个明确的迁移边界，不把同一职责重复计数）：

- KEEP: 12
- EXTRACT: 9
- RETIRE: 4
- UNKNOWN: 5

这些数量不是文件数量，也不是删除清单。

## Minimal Target Architecture

只保留当前已被证实需要的层，目录不强制移动：

```text
Codex
  ↓
Zhiying Skill（未来：SOP、artifact schema、review gates、失败修正规则）
  ↓
薄 CLI / 现有函数入口
  ↓
项目目录中的 scenes / script / narration plan / audio / subtitles /
reconciliation / asset manifest / render manifest
  ↓
现有确定性执行器
  ├─ IndexTTS2 adapter → Feiniu GPU IndexTTS2
  ├─ Remotion + Chrome Headless Shell
  └─ FFmpeg / ffprobe / visual + loudness gates
```

建议的物理复用边界：

- 保持现有 `src/remotion/`、`src/lib/subtitles/`、`src/lib/reconciliation/`、`src/lib/render/`、`src/lib/tts/`、`src/lib/assets/` 和 adapter 原路径，不因 Skill 化搬家。
- 继续使用当前 project artifact/file layout，优先复用现有 `data/projects/<projectId>/...`、artifact JSON、audio unit/master WAV、render manifest；不要现在新建另一套 `projects/` 真相目录。
- 新 CLI 可以放在 `cli/`，但只作为参数解析、调用现有函数、输出 machine-readable result 的薄层。它不应包含新的状态机、队列、provider、renderer 或 schema。
- 旧 Next.js/Worker/SQLite 作为兼容运行面暂时共存。Codex 新流程只依赖明确的 artifact references 和 manifest，不依赖 UI 内部的 stage transition。
- `services/indextts2-api-adapter` 与 Feiniu 外部 IndexTTS2 的调用方式保持不变；本阶段没有证据支持替换成 MCP 或新服务。

目标链路应是：

```text
Codex 写入/确认 scenes + script/narration plan + asset refs
  → inspect / input gates
  → tts
  → subtitle timing
  → reconcile
  → render
  → inspect final MP4 + render manifest
```

其中 research/evidence/script 的推理由 Codex/Skill 负责；当前仓库的 DeepSeek stage executor 不再是目标运行链。是否由 Skill 直接写入现有 artifact JSON，仍需在实现前确认字段 contract。

## Minimal CLI Contract

当前仓库没有 production CLI，因此以下是“最少新增胶水”的建议 contract，不是已实现接口。

### `zhiying tts`

```text
zhiying tts \
  --project <project-id> \
  --plan <narration-plan-artifact-or-path> \
  --voice <profile>@<revision> \
  --output <audio-manifest-path>
```

职责：读取已确认的 narration plan，调用现有 Node IndexTTS2 provider/adapter，复用 unit WAV 校验、ffprobe、master WAV、provider/voice snapshot、hash 和 manifest finalize。禁止让 CLI 自己实现音色注册、HTTP provider 或新的 TTS retry state machine。

### `zhiying reconcile`

```text
zhiying reconcile \
  --scenes <scenes-artifact> \
  --audio <narration-audio-manifest> \
  --subtitles <subtitle-timing-artifact> \
  --output <reconciliation-artifact>
```

职责：直接调用现有 reconciliation compiler/schema，输出 target frames、duration residual 和 source references。输入必须是明确版本/路径，不允许 CLI 内部静默解析“latest”。

### `zhiying render`

```text
zhiying render \
  --scenes <scenes-artifact> \
  --audio <narration-audio-manifest> \
  --subtitles <subtitle-timing-artifact> \
  --reconciliation <reconciliation-artifact> \
  --assets <asset-manifest> \
  --output <mp4-path>
```

职责：复用 Final Render source fence、visual gate、runtime asset/audio staging、Remotion bundle/renderMedia、FFmpeg/ffprobe、loudness gate、render manifest 和 atomic publish。CLI 不直接接受未校验的任意 props，也不跳过 assets/readiness gate。

### `zhiying inspect`

```text
zhiying inspect \
  --project <project-id-or-path> \
  [--artifact <path>] \
  [--media <mp4-or-wav>]
```

职责：只读输出 artifact schema/source refs、manifest consistency、WAV/MP4 ffprobe、visual/loudness gate 结果。它应复用现有 inspect/gate 函数；如果当前已有脚本足以覆盖某个检查，则 CLI 只包装该脚本，不另造检查引擎。

这四个命令是当前最小的可操作集合：`tts`、`reconcile`、`render` 是生产动作，`inspect` 是 Codex 需要的只读验收入口。暂不新增 `research`、`script`、`workflow`、`scheduler`、`queue` 或 `mcp` 命令。

## Data / Manifest Strategy

### 当前事实分类

| Category | Current data | Audit decision |
|---|---|---|
| A. 真实业务事实 | `projects` identity、`project_inputs`、scene/script/research/evidence 内容、asset file/license/binding、voice profile/revision/reference identity | KEEP/UNKNOWN by field；不能因为去平台化而删除 |
| B. artifact/provenance | `artifacts`、`render_artifacts`、narration audio manifest、final render source/attempt、source version、props snapshot、provider/voice/audio/media metadata | KEEP；作为 Codex 与 deterministic tools 的交界 |
| C. workflow engine state | `project_stages`、LLM job/dispatch/run/attempt、active/locked/stale stage pointer、stage capability checks | RETIRE candidate；由 Skill/agent 判断流程，过渡期只读兼容 |
| D. runtime lock/lease | `claimed_by`、heartbeat、attempt、cancel flags、`resource_group_leases`、dispatch lease | EXTRACT/UNKNOWN；只在确定仍需要后台执行时保留，不能当作业务 artifact |
| UNKNOWN | production DB exact rows、旧项目是否仍依赖 UI stage pointers、Codex usage 是否回写 usage tables | 实现前确认，不改表 |

### 推荐过渡策略

1. 不迁移、不重命名、不删除现有 DB 表。
2. 新流程以明确 artifact path/id + source version + manifest 为输入；“latest”只能由 Skill/CLI 明确解析后记录成 source snapshot，不能由 renderer 自行猜测。
3. 文件/artifact 是媒体内容和 provenance 的 canonical truth；SQLite 在过渡期继续承载旧 UI/job 兼容信息。
4. 新 CLI 首先可以只生成/读取现有 manifest；是否同时写 `render_jobs`/`tts_jobs` 只由旧 UI 兼容需求决定，不能为了迁移而新增另一套状态表。
5. 只有当旧项目、旧 UI、旧 worker 的读取路径均已证明不再需要时，才讨论 workflow 表和 runtime 表的清理；本阶段不做这个结论。

## TTS Strategy

当前最稳定且有代码/部署文档支持的方式是：

```text
Node TTS executor
  → http://127.0.0.1:9880/health
  → http://127.0.0.1:9880/v1/synthesize
  → indextts2-api-adapter
  → IndexTTS2 upstream :8002 / Feiniu GPU
```

必须保持的事实：

- production `TTS_PROVIDER=indextts2`；production 禁止 mock。
- request 发送 `voiceProfile`、`voiceRevision`、`useRandom=false`、`emotion=none`。
- adapter 负责 registry/reference 校验、speaker identity/reuse 与 upstream error mapping；不加载模型、不占 GPU。
- `runTtsJob` 当前还负责 cancel/shutdown/lease fence、WAV/ffprobe、临时文件、hash、atomic rename 和 job finalize。CLI 抽取时必须复用这些能力的实现，不只复制 HTTP call。
- `useRandom=false` 不等于同输入 WAV bytes 必然相同；adapter 文档已明确 upstream sampling 的限制，不应把 byte identity 误当成新的 gate。

未确认项：本轮没有 SSH 读取 Feiniu 当前 registry、reference WAV、adapter health 或 upstream `/speakers`；因此“调用方式稳定”是基于 frozen code、compose 和验收文档，不是本轮现场健康证明。

## Remotion / FFmpeg Strategy

- Remotion 全套精确 `4.0.492`、Chrome Headless Shell、现有 composition/template 和 props schema 原样复用。
- `render` CLI 只做 source snapshot → readiness/visual gate → runtime staging → bundle/renderMedia → ffprobe/loudnorm → manifest → atomic publish。
- FFmpeg 继续承担 master WAV、Final loudnorm 等确定性任务；ffprobe 继续是音频流、duration、frame、codec 的事实来源。
- 不引入新 render service、new queue、new scheduler、browser automation runtime 或第二套 media manifest。
- 现有 GPU/Feiniu compose 是生产环境事实；CLI 是否在同一 worker image 内运行，需在实施阶段根据部署约束确认，不能本阶段改 Docker。

## Old Platform Retirement Candidates

按风险和替代关系排序：

1. **第一候选：workflow UI 与 workflow-only API。** 它们主要把用户操作翻译成 stage enqueue/lock/cancel；目标中由 Codex + Skill 进行流程判断。
2. **第二候选：LLM provider/executor、LLM stage queue、prompt registry 的运行时部分。** provider/worker 调用可退出；prompt/SOP/schema 内容应先抽取到 Skill，不能直接丢弃。
3. **第三候选：M7 durable dispatch/DAG orchestration。** 当前本地项目均为 M6 且相关 rows 为 0，先保持 UNKNOWN，拿到 production consumer 证据后再决定。
4. **第四候选：通用 Scheduler/Worker。** 只有在 `tts`/`render` CLI 已经覆盖长任务、取消、stale recovery、GPU lease、atomic output 和重启恢复后，才可退休通用轮询层。当前不能直接删。
5. **最后候选：workflow/runtime DB 表。** 必须先确认旧项目与 UI 迁移完成，并证明 artifact/manifest 已覆盖审计与恢复需求；本阶段不执行。

## Critical Risks

1. **执行可靠性回归（高）：** 当前 Worker 的真实职责包含 GPU lease、heartbeat、cancel、stale recovery 和 SIGTERM requeue；只抽 HTTP/provider 或只调用 Remotion 都不足以替代它。
2. **source fence 被绕过（高）：** Final Render 依赖 scenes/audio/subtitle/reconciliation/assets 的 exact snapshot；CLI 若使用 latest 或直接接收自由 props，可能渲染错误版本或占位内容。
3. **artifact/DB 双真相（高）：** 现有 SQLite 混合业务事实、manifest、workflow state 和 runtime lock；没有字段级边界前，不能直接“去数据库化”。
4. **Feiniu TTS 现场漂移（高）：** registry、reference mount、adapter readiness、upstream speaker cache 未在本轮现场核验；compose 还要求 `ZHIYING_HOST_ASSETS_DIR`，而 `.env.example` 未展示该变量。
5. **完整生产链证据边界（中-高）：** 本 checkout 可直接验证的 MP4 是无旁白/无字幕 local Golden Case；完整 Final Render 依赖主要来自 M6 production acceptance report，原始 NAS MP4/DB 未现场复核。
6. **旧项目兼容（中-高）：** `project_versions` 同时保存内容事实和 workflow pointer 语义；不应整体迁移或删除。
7. **外部服务未知（中）：** 当前 checkout 未发现 STT 调用，但不能排除仓库外研究、翻译或 review 服务；如果它们仍是生产前置条件，CLI contract 会变化。

## Questions Still Blocking Implementation

以下问题不会改变本次分类，但会阻塞正式实现：

1. 新 CLI 运行在 Feiniu 宿主机、现有 `zhiying-worker` image，还是单独的受控执行环境？
2. 迁移期间是否必须让旧 Next.js UI 继续读取新生成的 project/artifact/render rows？如果必须，哪些旧表需要兼容写入？
3. Feiniu 当前 production 的 `ZHIYING_RELEASE_TAG`、TTS adapter health、registry JSON、voice reference root、IndexTTS2 upstream 地址和 GPU 状态分别是什么？
4. Codex/Skill 将直接产出哪些现有 artifact：scenes、research、evidence、script、narration plan，还是只产出 script？每种 artifact 的现有 schema 是否作为 migration contract？
5. 新项目的 canonical storage 是否继续使用现有 `data/projects/<projectId>/...`，以及 SQLite 是否只作兼容索引/运行记录？
6. 外部 Codex usage/cost 是否需要进入现有 `llm_usage`/`project_usage_events`，还是由 Codex 平台单独记录？
7. M7 durable dispatch/asset-generation 是否存在当前 Feiniu consumer？在没有现场证据前，不能把它们删除或强行迁移。

## Phase 1B Result

```text
VERDICT: PASS

KEEP: 12
EXTRACT: 9
RETIRE: 4
UNKNOWN: 5

PROPOSED_CLI:
zhiying tts
zhiying reconcile
zhiying render
zhiying inspect

CRITICAL_RISKS:
不要在未抽取并验证 Worker 的 cancel/lease/recovery 语义前退休 Worker；不要绕过现有 source/visual/media gates；Feiniu 当前 TTS registry 与生产 DB 尚未现场核验。

REPORT:
docs/skill_migration/02_MIGRATION_AUDIT.md
```

本阶段到此停止；未修改生产代码、配置、数据库、Docker/Compose、飞牛服务或目录结构，未创建 CLI/Skill，未部署，也未进入下一阶段。
