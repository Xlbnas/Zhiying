# Zhiying → Codex Skill Migration

## Phase 1A — Current System Inventory

调查日期：2026-08-22（Asia/Shanghai）  
调查范围：当前 checkout、仓库内 `data/`、SQLite 快照、现有生产验收文档、代码调用关系。  
调查性质：只读调查；本报告是本阶段唯一新写入文件。

本报告不做架构设计，也不对模块贴 KEEP / RETIRE 标签。所有“当前”结论只描述本次看到的事实；生产现场没有在本轮 SSH 登录或读取，因此生产文档证据与本地 checkout 证据分开标注。

## 1. Repository Baseline

| 项目 | 事实 |
|---|---|
| repo root | `/Users/xlbnas/Documents/GitHub/Zhiying` |
| branch | `m7` |
| HEAD | `e44949595be221e05874be0e05224ee352328682` |
| HEAD subject | `test(tts-c1b3): make activation recovery fault injection portable` |
| upstream state | `m7...origin/m7`；本次未执行 push、commit 或 reset |
| worktree | 启动调查时已有两项未提交修改：`package.json`、`pnpm-lock.yaml`；内容是 Next `^15.5.0` → `15.5.21` 的锁定升级；本阶段未改动它们 |
| root README | 不存在；可找到 `scripts/README.md` |
| project instructions | `AGENTS.md`；仓库级技术状态指向 `docs/M7_IMPLEMENTATION_STATUS.md` |
| required parent architecture doc | Skill 要求的上级 `视频生成器_架构设计文档.md` 在 `/Users/xlbnas/Documents` 下未找到；未据此补写或推断 |
| local runtime observed | Darwin arm64；Node `v22.22.2`；pnpm `11.9.0`；Python `3.14.6`；Docker `29.4.1`；ffmpeg/ffprobe `8.1.2` |
| package runtime | `package.json`：Next `15.5.21`（工作树版本）、React 19、Remotion 全套 `4.0.492`、better-sqlite3、zod、tsx；`pnpm-lock.yaml` 已提交但工作树有上述用户修改 |
| Python dependency scope | 根目录没有 `requirements.txt` / `pyproject.toml`；IndexTTS2 adapter 有独立 `services/indextts2-api-adapter/requirements.txt` |

## 2. Runtime Components

“Production Evidence”中的“本地”表示本 checkout 的源码 / DB / MP4 可直接复核；“文档”表示仓库内验收文档记录了 Feiniu 实际运行，但本轮没有重新连接现场。

| Component | Path | Responsibility | Entrypoint | Calls / Dependencies | Called By | Production Evidence | Confidence |
|---|---|---|---|---|---|---|---|
| Next.js Web | `src/app/`, `next.config.ts`, `package.json` | UI、项目/工作流/API、Jobs、素材与 Final Render 控制面 | `pnpm start`；production compose 中 `node .../next start` | `getDb()`、workflow operations、render bridges、artifact readers；不直接执行 LLM | 浏览器、脚本、HTTP clients | `docs/M6_3_13_WORKFLOW_POLISH_REPORT.md:143-146` 记录 production homepage/API 200；`docker-compose.production.yml` 有 web service | 高 |
| API 路由层 | `src/app/api/` | 接收 import、stage run/lock、narration、subtitle、reconciliation、asset、render 请求 | Next Route Handlers | 主要是 DB/事务/入队函数；`run-stage` 明确只返回 202，不直接调用 LLM | UI、`scripts/import-sample.mjs` 等 | `src/app/api/workflow/run-stage/route.ts:1-48`、`src/app/api/projects/[id]/render/route.ts:1-72` | 高 |
| SQLite 数据层 | `src/lib/db.ts` | 打开 DB、PRAGMA、基础 schema、增量 migration | `getDb()` 首次调用 | better-sqlite3；`/app/data/zhiying.db`；调用 TTS-C migrations、表/索引/trigger 初始化 | Web、Worker、所有 domain modules | 当前 `data/zhiying.db` 只读探测：`journal_mode=wal`、`busy_timeout=5000`、`foreign_keys=1`、`synchronous=1(NORMAL)`；源码 `src/lib/db.ts:477-499` | 高 |
| Workflow stages / versions | `src/lib/workflow/`、`src/lib/llm-jobs.ts`、`src/lib/workflow/operations.ts` | 阶段状态、版本、锁定、stale 传播、上游快照与 LLM job | `POST /api/workflow/run-stage`、`POST /api/workflow/lock-stage` | `project_stages`、`project_versions`、`llm_jobs`、`llm_usage`；Worker 负责执行 | Web workflow UI；Worker | `docs/M2-D_实现说明.md:1-118`；当前 DB 有 `project_versions=80`、`llm_jobs=74`、`llm_usage=74` | 高 |
| LLM prompt / provider | `src/lib/prompts/`、`src/lib/llm/` | research/evidence/argument tree/script 及后续阶段的 prompt、模型配置、解析/修复、usage | Worker 的 `runLlmJob` / `runDispatchJob` | DeepSeek OpenAI-compatible HTTP provider；开发可 mock；生产 `DEEPSEEK_API_KEY` 只给 worker | `src/worker/llm-executor.ts`、`src/worker/dispatch-executor.ts` | `docker-compose.production.yml:107-132`；`docs/M2-D_实现说明.md:104-106` 记录真实 DeepSeek smoke 未运行（当时无 key） | 高（调用路径）；生产真实内容取决于现场配置 |
| Scheduler / Worker | `src/lib/scheduler.ts`、`src/worker/index.ts`、`src/worker/job-runner.ts` | claim、资源 lease、heartbeat、并行/互斥调度、stale recovery、cancel、SIGTERM requeue；执行 render/LLM/TTS/dispatch/assets | `pnpm worker`；production `node --import tsx src/worker/index.ts` | SQLite job tables；Remotion；ffmpeg/ffprobe；TTS adapter；DeepSeek/APIYi | Web 入队的各种 job | `src/worker/index.ts:67-82,671-808`；`docs/M7_IMPLEMENTATION_STATUS.md:719-735` 记录 production worker healthy | 高 |
| Legacy render enqueue / props builder | `src/app/api/projects/[id]/render/route.ts`、`src/app/api/_lib/shared.ts` | 从 latest `scenes` 与 `subtitles` artifact 组装 M1 props，入 `render_jobs` | `POST /api/projects/[id]/render` | `buildFullCutProps` → `enqueueRenderJob`；legacy 路径设置 `showPilotIntro=true` | M1 UI、sample scripts | 本地成功 job `647e61be-aeb4-4419-b121-506d81d32b7d` 的 payload 与 DB 行吻合 | 高 |
| Final Render Bridge | `src/lib/final-render/bridge.ts`、`src/lib/final-render/schema.ts`、`src/app/api/projects/[id]/final-render/route.ts` | 汇总 current scenes/audio/subtitle/reconciliation，构造 deterministic props，写 immutable `final_render_source` / `final_render_attempt`，再入 render job | `POST /api/projects/[id]/final-render` | `getCurrent*` source gates、asset readiness、visual gate、source key/props hash、`enqueueRenderJob` | Final Render UI / workflow | `docs/M6_3_13_WORKFLOW_POLISH_REPORT.md:68-73,146`；代码 `bridge.ts:362-457,467-520` | 高（生产运行由文档支持） |
| Remotion bundle / renderer | `src/remotion/index.ts`、`src/remotion/Root.tsx`、`src/remotion/compositions/`、`src/remotion/templates/` | 注册 composition、从 props 读取 timeline，渲染 MG/真实素材/字幕/音频 | `src/remotion/index.ts` 被 `@remotion/bundler` 打包 | `@remotion/bundler`、`@remotion/renderer`、Chrome Headless Shell；`selectComposition` + `renderMedia` | `src/worker/index.ts:136-208,374-481` | 本地 MP4 format tag 为 `Made with Remotion 4.0.492`；M1 与 M6 文档均记录成功 render | 高 |
| Runtime audio / asset staging | `src/worker/runtime-audio.ts`、`src/worker/runtime-assets.ts` | 在缓存 bundle 后、`renderMedia` 前把 immutable narration WAV 与 `assetMap` 文件复制进 bundle public；缺失 fail-closed | `runJob` 内部 | dataDir、public root、manifest/source/attempt、SHA 校验、path containment | Final Render Worker | `src/worker/index.ts:319-371`；`docs/M6_3_13_WORKFLOW_POLISH_REPORT.md:128` 记录 visual gate 通过 | 高 |
| Narration Plan / Audio | `src/lib/narration/plan.ts`、`compiler.ts`、`audio.ts`、`src/app/api/projects/[id]/narration-*` | locked script_v2 → narration units → TTS jobs → WAV units → ffmpeg master WAV → `narration_audio_manifest` | narration plan/audio/master API；TTS job 由 Worker 执行 | `project_versions`、`artifacts`、`tts_jobs`、ffmpeg、ffprobe | Workflow UI、subtitle/reconciliation/final bridge | `docs/M6_3_13_WORKFLOW_POLISH_REPORT.md:9-25,146`；当前 DB 有 3 个 mock audio manifest 项目 | 高 |
| TTS executor / provider selector | `src/worker/tts-executor.ts`、`src/lib/tts/index.ts`、`src/lib/tts/indextts2.ts` | 以 job provider 快照调用 TTS，校验 WAV/ffprobe，写盘、hash、原子终态 | Worker claim 的 TTS job | `mock` 或 `indextts2`；Abort/cancel/lease；音频写入 `data/projects/.../audio/units/...` | `src/worker/job-runner.ts` | 当前 DB `tts_jobs=6` 且都是 mock 成功；生产 compose 显式 `TTS_PROVIDER=indextts2`；生产真实 TTS 由 M6 文档记录 | 高 |
| IndexTTS2 adapter | `services/indextts2-api-adapter/server.py`、其 Dockerfile/requirements | 无模型、无 GPU 的 HTTP translation/control plane；registry/voice health；将 Node 请求转给上游 IndexTTS2 | Uvicorn，compose service `indextts2-adapter`，host port `127.0.0.1:9880` | HTTP `/health`、`/v1/synthesize`；upstream `indextts2:8002`；registry 与 voice mounts | Node `IndexTts2Provider` | `services/indextts2-api-adapter/README.md:7-24,132-151`；`docs/M7_IMPLEMENTATION_STATUS.md:1527-1548` | 高 |
| Subtitle timing | `src/lib/subtitles/compiler.ts`、`timing.ts`、`renderer.ts`、相关 API route | narration plan + measured audio → subtitle timing artifact → renderer cues/SRT | `POST /api/projects/[id]/subtitle-timing` | current narration plan/audio、确定性 compiler；不是外部 STT | reconciliation、Final Render Bridge、Remotion | M6 report `:146` 记录 subtitle-timing 201；代码 `src/lib/subtitles/timing.ts:109-230` | 高 |
| Timing reconciliation | `src/lib/reconciliation/compiler.ts`、`timing.ts`、`adapter.ts`、API route | scenes / narration master / subtitle timing 汇合，生成 target frames 与 source snapshot | `POST /api/projects/[id]/timing-reconciliation` | current scenes/audio/subtitle；确定性计算 | Final Render Bridge | `src/lib/reconciliation/timing.ts:284-390`；M6 report `:146` 记录重建 | 高 |
| Asset acquisition / binding | `src/lib/assets/`、`src/app/api/projects/[id]/assets/`、`src/lib/scene-schema.ts` | Wikimedia/上传/APIYi 生成候选，物理文件落盘，license/provenance，绑定到 scene requirement；Final gate 读取 `assetMap` | assets API；生成任务由 Worker 执行 | Wikimedia network、APIYi HTTP、public/assets、`assets`/`asset_bindings`/`asset_resolution_state` | Visual Assets UI、Final Render Bridge/Worker | M6 report `:27-75,128`；M7 status `:125-244`；本地当前 DB 这些表为 0 行 | 高（代码）；生产实例由文档支持 |
| Render validation / manifest | `src/lib/render/artifact.ts`、`src/lib/render/loudness.ts`、`src/lib/render/visual-gate.ts` | ffprobe output gate、SHA、size/duration/frame metadata、Final visual audit、Final loudness 两通、manifest 入库后原子 rename | `runJob` render success path | ffprobe、ffmpeg、`render_artifacts`、`artifacts`、`render_jobs` | Worker | `src/worker/index.ts:489-561`；M6 report `:128` 记录 ffprobe/visual/loudness/encoder gate | 高 |
| Storage / deployment | `data/`、`public/`、`Dockerfile`、`docker-compose*.yml`、`DEPLOY.md` | SQLite、bundle cache、render MP4、audio、public source/assets；web/worker/adapter 容器运行 | Docker Compose | Feiniu bind mounts、host network、external `zhiying-tts-net`、optional NVIDIA override | compose / operator | `DEPLOY.md:41-59`；`docker-compose.production.yml:30-187` | 高（配置）；现场当前 mount/data 未本轮复核 |
| Tests / operational scripts | `scripts/`、`.github/workflows/` | import/round-trip、M2-M7/TTS contract tests、render frame helper、deployment build network/gates | `npx tsx scripts/test-*.ts` 等 | 测试专用 data dirs、Docker/ffmpeg 视脚本而定 | 开发/CI/operator | `docs/M7_IMPLEMENTATION_STATUS.md:510-664`；`scripts/README.md` | 高 |

### 2.1 当前存在但未接入最终生产时间线的路径

仓库已经包含 M7 candidate 相关代码（narrative beats、visual intent、visual sequences、shots、dispatch、DAG、asset generation 等），但本次读取的 DB 中全部 17 个项目 `pipeline_version=m6`，`m7_pipeline_snapshot_id` 全为 `NULL`，且 `docs/M7_IMPLEMENTATION_STATUS.md:355-364,376` 明确记录 M7 snapshot/asset migration/final render 等边界未完成或未授权。因此本报告只把这些列为现有代码组件，不把它们画进“当前已证实成功的 M6 Final Render 链”中。

## 3. Current Video Production Chain

### 3.1 仓库内可直接复核的 Legacy/M1 成功链

以下链路由本地 SQLite 行、payload、artifact 和现存 MP4 直接互证：

```text
POST /api/projects/[id]/render
  └─ buildFullCutProps()
       ├─ artifacts(kind=scenes, v1)
       └─ artifacts(kind=subtitles, v1; 本例为空)
  └─ enqueueRenderJob(projectId, kind=no-subtitles, payload)
       └─ render_jobs(id=647e61be..., status=queued)
            └─ scheduler claim（status=running, attempt=1）
                 └─ Worker ensureBundle()
                      └─ selectComposition(ZhiyingFullCutNoSubtitles)
                           └─ renderMedia()
                                └─ ffprobe output validation
                                     └─ persist render artifact + completeJob()
                                          └─ data/projects/22b5.../renders/647e...mp4
```

证据：

- DB project：`22b5dfad-bb46-4158-80aa-2df0e466127a`，title=`我们为什么会拖延`，`pipeline_version=m6`，但实际是 legacy render 数据。
- DB job：`647e61be-aeb4-4419-b121-506d81d32b7d`，`kind=no-subtitles`、`status=succeeded`、`progress=100`，输出相对路径与文件一致。
- payload：2 个 scene、435 frames、14.5 sec；`subtitles=[]`、`audio.narration=null`、`audio.bgm=null`、`audio.sfx=null`、`showSubtitles=false`。
- artifact：同 project 有 `render_source` v1 与 `render_output` v1；`render_output.file_path` 指向同一 MP4。
- MP4：H.264 1920×1080、30 fps、435 frames、AAC 音轨、Remotion 4.0.492；文件大小 1,043,729 bytes；本次读取 SHA-256 为 `0fccf2dd302b85e4fc585d8a5d4dbed045a437f2a0ee91bf415181bdcad8ca0c`。

这个本地案例没有经过 research、evidence、script、TTS、subtitle timing、reconciliation 或外部素材 acquisition；这些分支在该 job 的实际 payload/DB 中不存在。不能把它描述成完整生产内容链，只能描述成已成功产出的真实 MP4 及其实际依赖。

### 3.2 生产文档记录的完整 M6 Final Render 链

仓库内 `docs/M6_3_13_WORKFLOW_POLISH_REPORT.md` 记录了 Feiniu 上的实际项目 `2fda54fb`、render job `c030ac47`。沿代码入口和该报告，能闭合如下已被文档证实的链路：

```text
项目输入 / 用户确认
  └─ project_definition → research → evidence → argument_tree
       → script_v1 → script_v2
            （project_versions；LLM worker + DeepSeek 或 mock）
  └─ locked script_v2
       └─ narration plan compiler
            └─ tts_jobs（每个 speech unit）
                 └─ Worker TTS executor
                      └─ Node IndexTTS2 provider
                           └─ HTTP :9880 adapter
                                └─ IndexTTS2 upstream :8002 / GPU
                                     └─ unit WAV + ffprobe metadata
                                          └─ ffmpeg master WAV
                                               └─ narration_audio_manifest
  └─ narration plan + measured audio
       └─ subtitle timing compiler → subtitle_timing artifact
  └─ scenes + narration audio + subtitle timing
       └─ timing reconciliation compiler → timing_reconciliation artifact
  └─ scenes locked + asset requirements
       └─ acquire/upload/generate/bind
            └─ public/assets + assets/asset_bindings provenance
  └─ Final Render Bridge
       └─ current source fence + visual gate
            └─ final_render_source + final_render_attempt
                 └─ render_jobs
                      └─ Scheduler → Worker
                           ├─ bundle Remotion entry
                           ├─ stage runtime narration/assets
                           ├─ selectComposition + renderMedia (H.264)
                           ├─ Final-only ffmpeg loudnorm
                           ├─ ffprobe + visual audit + manifest
                           └─ atomic rename → final MP4
```

实际生产证据：

- M6 report `:20-25`：两个生产项目的 narration plan/TTS 清理；`2fda54fb` 新 plan 50 speech units、0 个脏 unit。
- M6 report `:54-75`：`2fda54fb` 的真实浏览器 asset upload、binding、MG override 与 Final readiness。
- M6 report `:83-128`：job `c030ac47`，9133 frames、视频时长 304.491s、端到端 676.4s；通过 ffprobe、视觉质量门、loudnorm，使用 `h264_nvenc`。
- M6 report `:139-146`：Feiniu 三容器部署成功，并明确记录 `8fbe9cb6` 的 TTS、audio finalize、subtitle-timing、timing-reconciliation 与 `final-render ready:true`。

边界：该生产 MP4 的原始文件不在本 checkout 的 `data/` 中，报告没有给出可从仓库直接拼出的完整输出文件路径；因此“生产完整链”是代码 + 仓库验收文档证据，不是本轮重新从 NAS 文件系统读取的证据。

## 4. Successful Golden Case

### Golden Case A — repository-local, file + DB directly reverified

| Field | Value |
|---|---|
| status | identified |
| project | `22b5dfad-bb46-4158-80aa-2df0e466127a` / `我们为什么会拖延` |
| render job | `647e61be-aeb4-4419-b121-506d81d32b7d` |
| job kind/status | `no-subtitles / succeeded` |
| source timeline | `artifacts(kind=render_source, v1)` 指向 `scenesVersion=1`；实际 payload 含 S001/S002，共 435 frames |
| subtitle | 无：payload `subtitles=[]` 且 `showSubtitles=false` |
| narration/TTS | 无：payload `audio.narration=null`；该 project 的 TTS rows 为 0 |
| assets | 无：payload `assetIds=[]`；当前 DB 的 assets/bindings 为 0 |
| output | `data/projects/22b5dfad-bb46-4158-80aa-2df0e466127a/renders/647e61be-aeb4-4419-b121-506d81d32b7d.mp4` |
| output verification | H.264 1920×1080@30、435 frames、14.5s、AAC；Remotion 4.0.492；存在 `render_output` artifact |
| chain confidence | 高；文件、DB job、DB artifact、payload、ffprobe 结果同一份本地快照直接吻合 |

### Golden Case B — production full Final Render, document-backed

| Field | Value |
|---|---|
| status | identified by production acceptance record |
| project | `2fda54fb`（拖延） |
| render job | `c030ac47` |
| final output evidence | 9133 frames / 304.491s；Final visual audit 26 scenes 通过；loudnorm 通过；encoder=`h264_nvenc`；output SHA 前缀 `5812442c…` |
| upstream artifacts | narration/TTS、subtitle timing、timing reconciliation、asset bindings、Final Render readiness 均被 M6 report 记录 |
| production services | Feiniu RTX 2080 Ti；web:3210；IndexTTS2 adapter:127.0.0.1:9880；三容器 healthy |
| direct file availability here | 未找到；本 checkout 只有上述 Golden Case A 的 MP4 与测试目录 MP4 |
| chain confidence | 中-高；代码与仓库内生产验收报告闭合，原始 NAS MP4/DB 本轮未重新读取 |

结论：Golden Case 已找到。若“真实成功视频”必须限定为本 checkout 中可直接打开的文件，则使用 Case A；若要求完整生产 Final Render 依赖，则使用 Case B，同时保留其“生产文档证据、原始文件未在本地”的边界。

## 5. Database Usage

本次对 `data/zhiying.db` 只读查询得到 27 张表（含 TTS-C 增量表）。当前行数是本地测试/开发快照，不代表 Feiniu 生产行数。

### 5.1 真正的业务数据 / artifact data

| Table / data | 事实用途 | 当前本地行数 |
|---|---|---:|
| `projects` | 项目身份、标题、template/composition、当前阶段、pipeline pointer | 17 |
| `project_inputs` | 项目生产参数（topic、core question、duration、language 等） | 16 |
| `project_versions` | 各 workflow stage 的实际内容版本；包括 research/evidence/script 等 | 80 |
| `artifacts` | scenes、subtitles、narration plan/audio manifest、render source/output、M7 candidate 等不可变或版本化产物 | 15 |
| `assets` / `asset_bindings` / `asset_resolution_state` | 素材文件元数据、来源/license/provenance、scene requirement 的当前绑定与解析状态 | 0 / 0 / 0 |
| `scene_visual_overrides` | scene 级 MG override 的持久事实 | 0 |
| `voice_profiles` / `voice_profile_revisions` / `voice_assignment_requests` | 声音库身份、不可变参考音频版本、项目声音分配请求 | 0 / 0 / 0 |
| `render_artifacts` | 成功 Final Render 的输出 manifest，包含 output hash/size/duration/encoder/audit/loudness | 0 |
| `project_usage_events` / `llm_usage` | LLM/TTS/render/image 等 usage/cost 记账事实 | 0 / 74 |

### 5.2 Workflow / orchestration state

| Table | 事实用途 | 当前本地行数 |
|---|---|---:|
| `project_stages` | 每项目每 stage 的 not_started/generated/locked/stale 等状态及 active/locked version pointer | 160 |
| `llm_jobs` | LLM stage queue、claim、heartbeat、retry、cancel、terminal state | 74 |
| `render_jobs` | render queue、payload snapshot、claim/heartbeat/progress、output path、终态 | 1 |
| `tts_jobs` | 每个 narration speech unit 的 provider snapshot、claim、音频结果/终态 | 6 |
| `generation_runs` / `generation_attempts` / `generation_dispatch_jobs` | M7 durable LLM dispatch/single-flight/run/attempt journal | 0 / 0 / 0 |
| `asset_generation_jobs` | M7 durable image generation job、billing/retry/source fence | 0 |
| `resource_group_leases` | 跨 Worker 的 production GPU lease | 0 |
| `voice_materialization_*` | TTS-C voice materialization 的请求/job/结果状态 | 0 |
| `tts_synthesis_claims`、`tts_audio_requests`、`tts_generation_attempts`、`sentence_audio_artifacts`、`tts_job_execution_transitions`、`tts_claim_generation_dispatches` | TTS-C.2 synthesis orchestration 的 claim、provider request、attempt、sentence artifact、execution transition | 全部 0 |
| `voice_registry_publications` / `voice_registry_publication_activations` | TTS-C.1B registry publication/activation 状态 | 0 / 0 |

### 5.3 Cache / runtime state

| Data | 事实 |
|---|---|
| `data/bundle-cache/` | Remotion bundle 输出；`ensureBundle()` 按 template/source key 复用，缺失可重建；当前存在 `freud-mg-v1.0` bundle |
| `data/dbg/`、`data/test-*` | 本地调试/测试隔离 DB、bundle、音频、MP4；不是 production project 记录的唯一来源 |
| `render_jobs.payload_json` | 不是 cache，而是 render 输入快照；用于复现该 job 的 timeline/props |
| `render_artifacts` | 不是普通 cache；它是成功渲染 manifest/provenance。当前本地历史 M1 job 没有对应 row，只有 `artifacts(kind=render_output)` |
| `public/` | 运行时静态素材根；开发/生产由 volume 提供，不打进 Docker image（Dockerfile 注释与 compose mounts） |

### 5.4 UNKNOWN / 未在本地快照确认的 DB 事实

- Feiniu 当前 production DB 的完整表计数、project rows、Final Render artifact rows、render manifest rows 未在本轮 SSH 读取。
- 生产实际 voice profile/revision、registry JSON、reference WAV 以及 TTS-C production rows 不在仓库；文档明确要求现场核实。
- M6 production job `c030ac47` 对应的原始 `render_jobs` / `render_artifacts` row 不在本地 `data/zhiying.db`。

## 6. External Dependencies

| Dependency | Current fact | Evidence / boundary |
|---|---|---|
| IndexTTS2 | 真实模型服务不在 repo；Node Worker → adapter HTTP → IndexTTS2 REST API；upstream 运行在 GPU 上 | `services/indextts2-api-adapter/README.md:7-24`；production adapter `indextts2:8002`，Node base URL `127.0.0.1:9880` |
| Feiniu / NAS | 生产宿主记录为 `192.168.31.56`，web 端口 3210；data/public/voices/registry 通过 bind mounts；production compose 使用 host network | `AGENTS.md`、`DEPLOY.md`、`docker-compose.production.yml`；本轮未操作宿主机 |
| GPU | M6 文档记录 Feiniu RTX 2080 Ti 22GB；GPU override 只给 worker，开启 Chromium hardware GL 与 NVENC；IndexTTS2 与 worker 共享宿主 GPU 资源 | `docs/M6_3_13_WORKFLOW_POLISH_REPORT.md:3-4,105-128`；`docker-compose.production.gpu.yml:1-37` |
| Remotion | `remotion`, `@remotion/bundler`, `@remotion/player`, `@remotion/renderer`, CLI 全部精确 `4.0.492`；需要 Chrome Headless Shell | `package.json`、`Dockerfile:58-72` |
| FFmpeg / ffprobe | Docker image 安装 ffmpeg；Node 用 `execFile`/`execFileSync` 做 TTS master、voice canonicalization、loudnorm、probe、NVENC probe；不是单独 HTTP service | `Dockerfile:23-56`、`src/lib/narration/audio.ts:468-500`、`src/worker/index.ts:489-558` |
| LLM / DeepSeek | Worker 侧 DeepSeek OpenAI-compatible HTTP provider；生产 `DEEPSEEK_API_KEY` 只注入 worker；dev/test 可 mock | `src/lib/llm/deepseek.ts`、`src/worker/llm-executor.ts`、`docker-compose.production.yml:107-132` |
| Image API / Wikimedia | APIYi 用于 M6 image generation；Wikimedia provider 用于可获取的真实素材；均依赖 network；asset 文件落到 public/assets | `src/lib/assets/providers/wikimedia.ts`、`src/lib/assets/generation-jobs.ts`、`.env.example:38-47` |
| Storage | SQLite/data、bundle cache、project audio/renders、public 静态媒体、host voice root、registry directory；生产 assets mount 由 `ZHIYING_HOST_ASSETS_DIR` 提供 | `DEPLOY.md:47-59`、`docker-compose.production.yml:30-98` |
| Network | 生产 web/worker 使用 host network；adapter 连接 `zhiying-tts-net` 与 app network，并发布 localhost:9880；Wikimedia/APIYi/DeepSeek/build downloads 需要外部网络 | `docker-compose.production.yml:56,99,173-187`、`docs/PRODUCTION_BUILD_NETWORK.md` |
| STT | 未找到 STT provider、STT endpoint、STT dependency 或 STT artifact 调用；当前字幕 timing 是从 narration/audio timing 确定性编译，不是仓库内 STT 链 | `src/lib/subtitles/` 与 `src/app/api/projects/[id]/subtitle-timing/` 的 imports/calls；结论为“未发现”，不是断言外部系统绝不存在 |
| Subtitle external service | 未发现；subtitle compiler/renderer 在 Node 代码内完成，输出 artifact/cues/SRT | `src/lib/subtitles/compiler.ts`、`renderer.ts`、`timing.ts` |
| Browser / UI automation | `scripts/README.md` 与历史验收提到 agent-browser 进行 UI 截图/Player 检查；它不是成片 runtime dependency | `scripts/README.md`、`docs/M1_最终验收报告.md:20-30` |

## 7. Review / Inspect / Provenance Facts

- Final Render 有两层 readiness/quality gate：domain source/readiness 在 `src/lib/final-render/bridge.ts`，Worker 侧再次执行 `validateFinalVisualProps`、asset staging、`auditFinalVisuals`。
- MP4 成功发布顺序是：渲染到 `.tmp.mp4` → ffprobe/时长/音轨 gate → Final loudnorm（Final path）→ SHA/size → `render_artifacts` manifest → rename 到 `.mp4` → `completeJob` 写 succeeded。源码入口为 `src/worker/index.ts:383-395,489-561`。
- 旁白链的内容 provenance 在 `narration_audio_manifest`：source narration plan artifact/version、provider/model/voice snapshot、每个 unit 的 WAV path/duration/hash、master path/duration/hash。
- Final Render provenance 在 `final_render_source` / `final_render_attempt`：source artifact IDs/versions、props snapshot、source key、props SHA、历史 audio manifest path；Worker 消费前会重新校验 persisted source 与 payload。
- Render output 的 hash/codec/duration/encoder/audit/loudness 由 `render_artifacts` 承载；Legacy M1 成功样例仍以 `artifacts(kind=render_output)` 为主。
- LLM usage 先记录于收到 provider response 之后，再 parse/validate；project version 通过 workflow operations 原子提交。这里属于当前代码事实，不是本报告对迁移后的建议。

## 8. Unknowns

以下内容通过本仓库事实无法可靠确认，保留 UNKNOWN，不猜：

1. 上级 `视频生成器_架构设计文档.md` 的真实内容与是否存在于其他未访问位置。
2. Feiniu 当前 production DB 中真实活跃项目、完整 Final Render artifact、原始 MP4 文件的当前路径与当前 hash；本轮未 SSH 读取。
3. Production `voice-registry.json`、voice reference WAV、IndexTTS2 upstream 当前模型容器/volume/实际 GPU 进程状态。
4. M6 report 中 `2fda54fb / c030ac47` 的完整 MP4 文件名、完整 output SHA、对应 NAS 目录；仓库只有 SHA 前缀与验收指标。
5. `ZHIYING_HOST_ASSETS_DIR` 在 production compose 中被要求，但 `.env.example` 未提供同名变量；现场 `.env.production` 是否存在并正确配置 UNKNOWN。
6. 当前 checkout 是否代表 production 运行的 exact SHA：文档记录的 production SHA（例如 M6 `7125004`、后续 M7/TTS deployment SHAs）与当前 HEAD `e449495…` 不同；未把历史文档 SHA 当作当前现场状态。
7. 是否存在仓库外的 STT、研究资料抓取、字幕翻译或外部 review 服务；当前 checkout 内没有找到对应调用入口。
8. `data/` 内的本地 DB/MP4/测试目录是历史开发快照；不能由它们推出 Feiniu 数据的完整性或当前状态。

## 9. Phase 1A Result

```text
VERDICT: PASS

REPORT:
docs/skill_migration/01_CURRENT_SYSTEM_INVENTORY.md

GOLDEN_CASE:
identified

FILES_CHANGED:
docs/skill_migration/01_CURRENT_SYSTEM_INVENTORY.md

UNKNOWN:
Feiniu 当前现场未重新读取；上级架构文档未找到；生产完整 Final MP4 原始文件不在本 checkout；production voice registry/assets mount 与 STT/外部服务现场状态未知。
```

本阶段到此停止；未创建 Skill、CLI 或迁移代码，未修改生产代码/配置/数据库，未启动/停止/重启服务，也未进入 Phase 1B。
