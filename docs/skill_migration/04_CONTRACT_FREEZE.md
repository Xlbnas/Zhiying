# Zhiying → Codex Skill Migration
# Phase 1D — Blocker Closure & Contract Freeze

审计日期：2026-08-22（Asia/Shanghai）  
仓库基线：`m7` @ `e44949595be221e05874be0e05224ee352328682`  
生产基线：Feiniu release `8e92ba58a28900509e542394858200b1731d7afd`  
性质：只读生产核验 + contract freeze；未修改任何生产代码、DB、Compose、registry 或服务。

## Verdict

**PARTIAL**

Phase 1C 的 8 个 blocker 中，artifact、TTS、executor、CLI chain、asset entry、Feiniu 现场、render commit 和 retirement parity gate 已有事实结论或冻结 contract。唯一未关闭项是父级架构文档：文件无法找到，但当前仓库指令仍把它定义为最高 Source of Truth，也没有已废止的授权性证据。

`IMPLEMENTATION_READY: NO`

## 1. Production Facts Verified

### 1.1 Runtime

2026-08-22 通过现有 SSH host `feiniu` 只读核验：

| Fact | Verified value |
|---|---|
| Host | `Xlbnas-Shelter` |
| Deploy root HEAD | `8e92ba58a28900509e542394858200b1731d7afd`（detached checkout） |
| `.env.production` release anchor | 与 deploy HEAD 一致 |
| Web | `zhiying-web`, image `zhiying:8e92ba5…`, running + healthy, host network, `GET /` = 200 |
| Worker | `zhiying-worker`, 同一 image, running + healthy, `WORKER_ROLE=all` |
| Adapter | `indextts2-adapter`, image `zhiying-indextts2-adapter:8e92ba5…`, running + healthy, `127.0.0.1:9880` |
| IndexTTS2 upstream | `neosun/indextts2:v2.2-performance-optimized`, running + healthy, `127.0.0.1:8002` |
| Adapter health | `ready=true`, `provider=indextts2`, `model=IndexTTS-2`, `degraded=false` |
| Upstream health | `status=healthy`, `cached_speakers=1`, `memory_cache_active=true` |
| GPU snapshot | NVIDIA GeForce RTX 2080 Ti, driver 580.142, 22528 MiB, 14261 MiB used, 0% utilization |

生产调用路径现场值为：

```text
zhiying-worker
  INDEXTTS2_BASE_URL=http://127.0.0.1:9880
  TTS_PROVIDER=indextts2
    → indextts2-adapter
      ADAPTER_UPSTREAM_BASE_URL=http://indextts2:8002
        → indextts2 GPU container
```

Worker 当前挂载 `/app/data` 可写、`/app/public/assets` 可写、`/voices` 只读、`/registry` 可写；adapter 将同一 host voice root 只读挂载到 `/voices`，将 registry root 只读挂载到 `/config`。

### 1.2 SQLite production facts

数据库以 SQLite URI `mode=ro` + `PRAGMA query_only=ON` 查询：

- `projects` 共 3 行，全部 `pipeline_version=m6`，无 `pipeline_version=m7`。
- 最近三个生产项目为 `31d45df7…`、`2fda54fb…`、`8fbe9cb6…`。
- M7 表不是全空：`generation_runs=2` 且有 1 个 `m7_visual_intent` succeeded，但它依附的项目仍是 M6；`generation_dispatch_jobs=0`。因此“无 M7 pipeline consumer”可确认，“M7 代码从未在生产使用”不成立。
- `asset_generation_jobs=1`，该行是 `provider_unavailable` / `confirmed_zero` 失败记录。
- `resource_group_leases=0` 是查询时点快照，不表示 lease 机制未被生产 Worker 使用。
- TTS-B/C v2 主要 runtime 表均为 0：`tts_audio_requests`、`tts_generation_attempts`、`sentence_audio_artifacts`、`voice_profiles`、`voice_profile_revisions`、voice assignment/materialization 相关表均无行。

### 1.3 Voice registry

现场 registry 为 `/vol1/1000/docker/zhiying/voice-registry/voice-registry.json`：

- registry schema `1.0`；
- 唯一 active identity：`default@1`；
- speaker：`zhiying-default-1-2d85800fe261`；
- reference：`/voices/default-v1.wav`；
- registry 声明 SHA 与实际文件 SHA 一致：`2d85800fe261d106c3274fa792cbb952458c4b0b2e1b908340a8cd0d63c73a30`；
- reference 文件大小 299052 bytes；
- registry 文件 SHA：`1dab4a313689736aad081b2b0367f9b036eeec0f9a751647192498ce9ee21827`。

本轮只调用 health endpoint，没有调用 synthesize、没有生成音频、没有修改 registry。

## 2. Artifact Contract V1

`ARTIFACT_CONTRACT_V1 = DB_BACKED_EXACT_IDENTITY`

### Canonical boundary

V1 不新建 file-native manifest 系统，也不将“某类 artifact 的 latest 文件”当作真相。Canonical interface 是：

```text
projectId
+ exact accepted/current source identity
+ explicit project_version/artifact id + version
+ source snapshot/hash recorded by existing artifacts
+ existing SQLite transactions and uniqueness/claim rules
+ existing media files referenced by contained relative path and content hash
```

### V1 必须保留

| Fact | Current carrier | V1 rule |
|---|---|---|
| Project identity/input | `projects`, `project_inputs` | 保留为业务输入事实 |
| Immutable authored/generated content | append-only `project_versions` | 以 row ID + stage + version 定位，不覆盖历史 |
| Accepted/current source | `project_stages.active_version/locked_version` → exact `project_versions` row | 在有等价 accepted pointer 前必须保留 |
| Derived artifacts | `artifacts.id/kind/version/content_json/file_path` | 消费 exact ID/version；manifest 必须带 source refs |
| Final render snapshot | `final_render_source` artifact | 保留 scenes/audio/subtitle/reconciliation exact refs、sourceKey、props SHA 和 frozen props |
| Attempt identity | `final_render_attempt` artifact | 保留 exact job → exact final source 映射 |
| Media identity | WAV/MP4 relative path + SHA/size/probe metadata | DB 与物理文件双重校验；不只信路径 |
| Atomic acceptance/runtime facts | SQLite transaction、job/lease/claim tables | 不用 Skill 或普通 JSON 文件代替 |

### 可退休的是控制体验，不是内容事实

以后可在 parity 通过后退休 generic stage progression、run/lock UI、LLM-specific capability/state 和只为旧 LLM workflow 服务的 stale propagation。不能连带退休 accepted pointer、append-only content、exact source refs 或 atomic acceptance fact。

File-native 导出/导入只记为 **FUTURE**，不是 V1 实施内容。

## 3. TTS Contract V1

`TTS_CONTRACT_V1 = M6_V1`

生产已闭合的链是：

```text
current M6 narration_plan
  → enqueueNarrationAudioJobs(projectId)
  → tts_jobs (provider=indextts2, voice=default@1)
  → existing Scheduler / Worker / IndexTTS2 adapter
  → narration-audio@1.0 manifest + 48kHz mono master WAV
  → subtitle-timing@1.0
  → timing-reconciliation@1.0
  → final-render-source@1.0
  → Final Render
```

选择 M6 v1 的直接证据：

1. Golden Case 最终 audio artifact `451fad55…` 是 `narration-audio@1.0`，source 是 narration plan `c9f4f20f…` v3。
2. 该 plan 的 50 个 speech unit 全部由 `tts_jobs` 生成，provider `indextts2`、voice `default@1`，`result_artifact_id` 和 `voice_profile_revision_id` 均为 null，这是 v1 执行面。
3. Subtitle artifact 精确引用该 audio artifact 和 master SHA；reconciliation 再精确引用 scenes/audio/subtitle；Final Render 精确引用该 reconciliation。
4. 生产 TTS-B/C v2 runtime rows 为 0，Final Render 的实际 consumer 仍 import/consume v1 audio contract。
5. Feiniu adapter/registry 已对 `default@1` 健康，不需要改成新 HTTP、MCP 或另一套 voice control plane。

V1 CLI 不提供任意 `--voice`；它固定复用当前 production `default@1` 与现有 registry identity。TTS-B/C v2 代码保留，但切换只能是未来的独立生产兼容项，不与 Skill migration V1 捆绑。

## 4. Executor Contract V1

`EXECUTOR_V1 = EXISTING_WORKER`

V1 执行语义：

```text
CLI
  → existing enqueue/build function
  → existing SQLite job/source/attempt rows
  → existing Scheduler / zhiying-worker
  → exact job identity and status
  → exact artifact resolution
  → CLI returns machine-readable terminal result
```

不抽取 direct single-run render/TTS executor，因为当前 Worker 不只是调用 provider：

- `BEGIN IMMEDIATE` claim；
- heartbeat/progress；
- retry/max-attempt；
- queued/running cancel；
- startup stale recovery；
- SIGTERM/SIGINT abort + requeue + settle；
- `production_gpu` lease/heartbeat/lost fence；
- runtime audio/assets staging；
- exact job result 与 fail-closed download/inspect。

生产 Worker 目前 `WORKER_ROLE=all`，代码也明确其他 role 尚未实现。V1 不新增 render-only Worker、queue、scheduler 或外部 execution framework。

## 5. CLI Contract V1

`CLI_CONTRACT_V1 = inspect, tts, subtitles, reconcile, render`

下列是待实施 contract，当前仓库还没有这些 CLI entrypoint。每个命令只能做参数解析、exact-source precondition、调用现有函数、等待/读取结果和 JSON 输出；不得重写算法。

### `zhiying inspect`

```text
zhiying inspect --project <projectId>
                 [--artifact <artifactId>@<version>]
                 [--job <jobId>]
                 [--media]
```

- Input identity：exact project/artifact/job ID；禁止无声取“最近成功 job”。
- Existing mapping：只读 project/stage/version/artifact queries，`getCurrentNarrationAudioArtifact`、`getCurrentSubtitleTiming`、`getCurrentTimingReconciliation`、Final Render readiness，`resolveJobArtifact`、ffprobe/loudness/visual gates。
- Execution：同步只读，不 enqueue Worker。
- Output：JSON 包含 exact IDs/source refs、schema/compiler versions、readiness、media hash/size/probe 和 gate result。
- Exit：只有所请 exact identity 存在、schema/source/file/manifest 一致且所选 gates 通过才为 0。

### `zhiying tts`

```text
zhiying tts --project <projectId>
             --plan <narrationPlanArtifactId>@<version>
             [--wait]
```

- Input identity：project + expected current narration plan ID/version；voice 固定为 production `default@1`。
- Existing mapping：`enqueueNarrationAudioJobs`、`getNarrationAudioOverview`、`tryFinalizeNarrationAudio`、existing `tts_jobs` + Worker。
- Execution：enqueue Worker；`--wait` 轮询 exact plan 对应 jobs/overview，不直接调 provider。
- Output：enqueued/reused job IDs，terminal narration audio artifact ID/version，master path/SHA/duration，provider/voice snapshot。
- Exit：当 expected plan 不再 current、任一 unit 失败/取消、manifest 无法 finalize 或 `--wait` 未达 ready 时非 0。

Expected plan 的比对必须在现有 enqueue transaction 内 fail-closed；不能只在 enqueue 后比较返回值。这是对现有函数的最小 precondition 扩展，不是新 workflow manager。

### `zhiying subtitles`

```text
zhiying subtitles --project <projectId>
                   --audio <narrationAudioArtifactId>@<version>
```

- Input identity：expected current M6 v1 audio artifact ID/version，其 manifest 自带 exact plan/master refs。
- Existing mapping：`buildSubtitleTiming(projectId)` + `checkSubtitleTimingReadiness`。
- Execution：同步 deterministic build，不 enqueue Worker。
- Output：exact subtitle artifact ID/version、source refs、cue count、unresolved IDs、timeline duration。
- Exit：expected audio 不 current，source/schema/compile 失败或 output readiness 不为 ready 时非 0。

### `zhiying reconcile`

```text
zhiying reconcile --project <projectId>
                   --scenes <projectVersionId>@<version>
                   --audio <artifactId>@<version>
                   --subtitles <artifactId>@<version>
```

- Input identity：exact locked scenes row + current audio + current subtitle artifact。
- Existing mapping：`buildTimingReconciliation(projectId)` + `checkTimingReconciliationReadiness`。
- Execution：同步 deterministic build，不 enqueue Worker。
- Output：exact reconciliation artifact ID/version、all source refs、fps/frames/duration/residual/unresolved count。
- Exit：任一 expected source 不再 current，whole-generation/source check 失败或 readiness 不为 ready 时非 0。

### `zhiying render`

```text
zhiying render --project <projectId>
                --scenes <projectVersionId>@<version>
                --audio <artifactId>@<version>
                --subtitles <artifactId>@<version>
                --reconciliation <artifactId>@<version>
                [--wait]
```

- Input identity：project + four expected current sources；assets 由当前 binding/readiness 在 transaction/gates 内解析为 frozen `assetMap`。
- Existing mapping：`enqueueFinalRender(projectId)`，existing `render_jobs`/Scheduler/Worker，terminal `resolveJobArtifact`。
- Execution：enqueue Worker；禁止 CLI 直接调 `renderMedia`。
- Output：exact final source artifact ID/version、attempt artifact ID/version、job ID/status；成功时返回 MP4 relative path、manifest SHA/size/duration/frames/encoder/audit/loudness。
- Exit：source expectation、active guard、asset/visual/readiness、Worker terminal status 或 exact-job artifact resolution 任一失败时非 0。

`subtitles` 和 `reconcile` 保持两个命令，因为仓库已有两个独立的同步 builder/artifact identity；合并为 `timeline` 不会减少底层状态，反而需要新组合逻辑。

## 6. Asset Entry V1

`ASSET_ENTRY_V1 = A_EXISTING_ASSET_API_BACKEND`

V1 迁移期继续保留当前 asset API/backend，不为了 CLI 形状重包全部 asset 系统。Codex/Skill 只能通过这些入口或他们已有的底层函数操作素材：

- acquire/resolve：`GET/POST /api/projects/:id/assets` 与 `/assets/resolve`；
- upload + exact bind：`POST /assets/upload`；
- generated candidate：`GET/POST /assets/generate`，然后 `POST /assets/generated/:candidateId/bind`；
- MG override/revert：`/assets/switch-to-mg` 与 `/assets/revert-mg`；
- Final readiness/assetMap/visual gate：继续由 `evaluateVisualReadiness`、`buildAssetMap`、Final Render bridge 和 Worker 复核。

这保留了 magic-byte validation、license/provenance、exact scene+requirement binding、active uniqueness、source fence、physical-file check 和 visual gate。Codex 不得直接手写 `assetMap`/asset manifest 绕过这些门禁。

V1 CLI 只有在 assets 已 ready 后才能 `render`；不额外新增 `zhiying assets` 命令。旧 workflow UI 可与 Codex 分离，但 asset backend/API 在等价薄入口出现前不能跟随 UI 退休。

## 7. Render Commit Contract

`RENDER_COMMIT_CONTRACT = CONFIRMED`

### 7.1 Actual order

当前 checkout 与已部署 SHA 在 render commit 相关文件上无 diff。实际顺序是：

```text
renderMedia → <jobId>.tmp.mp4
  → Final Render 可选 two-pass loudnorm → <jobId>.loud.tmp.mp4
  → validateRenderOutput (video/audio/duration)
  → SHA-256 + stat
  → fs.renameSync(finalTmp, <jobId>.mp4)
  → persistRenderArtifact (INSERT OR REPLACE render_artifacts)
  → completeJob transaction:
       render_jobs.status=succeeded + output_path
       INSERT artifacts(kind=render_output)
  → compute usage/log
```

关键源码：`src/worker/index.ts:489-559`、`src/lib/render/artifact.ts:159-180`、`src/lib/jobs.ts:133-160`。源码中“manifest 落库后 rename”和“immutable manifest”的注释与实现不一致：实现是 rename 先于 manifest，manifest writer 是 `INSERT OR REPLACE`。

### 7.2 Failure windows

| Window | Current result | Recovery/retry semantics |
|---|---|---|
| A. rename 成功，manifest write 失败 | 正式 MP4 保留；无 `render_artifacts`；外层 catch 调 `failJob`，attempt 未用尽则 queued，否则 failed | exact download/inspect 因 job 未 succeeded 而拒绝；retry 重新渲染并可覆盖同名 final |
| B. manifest 成功，`completeJob` 失败 | final + manifest 保留；`completeJob` 的 status + `render_output` 在同一 transaction 回滚；随后 `failJob` queued/failed | retry 覆盖 final，`INSERT OR REPLACE` 替换同 job manifest，然后再 complete |
| C1. crash before rename | job 仍 running，可能留 tmp/loud tmp，无新 final/manifest/success | startup/periodic stale recovery 将 running 回 queued；残留 tmp 的清理/覆盖没有独立测试冻结，是已知运维风险 |
| C2. crash after rename, before manifest | final 已存在，job 仍 running，无 manifest | stale recovery 回 queued；retry 使用同 job/output identity |
| C3. crash after manifest, before complete | final + manifest 存在，job 仍 running | stale recovery 回 queued；retry replace final/manifest |
| C4. crash inside `completeJob` | SQLite transaction 要么全回滚，要么 status + `render_output` 一起 commit | 回滚时按 C3；commit 后 job 是 succeeded |
| C5. SIGTERM/SIGINT during active work | Worker abort controllers，catch 看到 `shuttingDown` 时 `requeueJob` | 新 Worker/重启后按原 job retry |
| D. same job retry with final already present | Feiniu/Linux 同文件系统 `renameSync` 替换已有 regular final；manifest 因 `INSERT OR REPLACE` 也被替换 | 最终成功后 exact job 只解析新 final/manifest identity |

如果是系统性 DB outage，导致 catch 中的 `failJob` 也失败，job 可继续留在 running；DB 恢复后依赖 stale recovery。当前实现不会在 Window A/B 补偿删除 final/manifest。

### 7.3 Verification evidence

- `scripts/test-m6311-artifact.ts`：32 PASS / 0 FAIL，证明 exact-job resolution、manifest/file/path mismatch fail-closed、无跨 job fallback。
- `scripts/test-workflow-resource-leases.ts`：87 PASS / 0 FAIL，证明 GPU 互斥、heartbeat、lease loss fence 和 bundle 期覆盖。
- 一次性 `/tmp` isolated DB/data fault injection：
  - A = `finalExists=true, manifestExists=false, jobStatus=queued`；
  - B = `finalExists=true, manifestExists=true, renderOutputRows=0, jobStatus=queued`；
  - D = `existingFinalReplaced=true, manifestShaReplaced=true, jobStatus=succeeded`。

本阶段只冻结当前 contract 和风险，没有修复 publish 顺序或 manifest mutability。

## 8. Golden Case

`GOLDEN_CASE_VERIFIED = YES`

### Identity and final media

| Item | Production value |
|---|---|
| Project | `2fda54fb-e5fa-4237-bda3-265fe1d7978d` |
| Title | `为什么我们总在最后一刻才开始` |
| Pipeline | `m6` |
| Composition/template | `ZhiyingFullCut` / `freud-mg-v1.0` |
| Render job | `c030ac47-b9e4-44ab-b8b9-77041c14150f`, `succeeded`, attempt 1 |
| MP4 relative path | `projects/2fda54fb-e5fa-4237-bda3-265fe1d7978d/renders/c030ac47-b9e4-44ab-b8b9-77041c14150f.mp4` |
| MP4 SHA-256 | `5812442c3032cf23911380300bfeb7b6c46708f5e911c9fa93a4774594f4ba5d` |
| Size/duration | 181359796 bytes / 304.491 s |
| Video | H.264, 1920×1080, 30 fps, 9133 frames |
| Audio | AAC, 96000 Hz, stereo |
| Encoder/gates | `h264_nvenc`; visual audit 26 scenes, placeholder 0; loudnorm output I -16.04, TP -1.36 |

直接 `stat`、`sha256sum` 和 `ffprobe` 的值与 `render_jobs`/`render_artifacts` 完整匹配，不再只依赖 M6 报告中的 SHA 前缀。

### Exact dependency chain

```text
locked script_v2 project_version
  655358b5-9017-4ea8-8d60-3064dc305372 @ version 3
    → narration plan artifact
      c9f4f20f-bb90-440c-8591-6aa911efd31c @ artifact version 3
      narration-plan@1.0, 62 units / 50 speech jobs
        → narration audio artifact
          451fad55-e449-46f1-be77-2241a7a6788e @ artifact version 2
          narration-audio@1.0, IndexTTS2 default@1
          master SHA e58612ef928bfe0f7c1485ca0439c13d76f37e432c72a9054ae99b7b69000741
          master duration 304448 ms
            → subtitle timing artifact
              86c02966-e337-450f-a480-fb4bb5baa0a4 @ artifact version 2
              subtitle-timing@1.0, 77 cues, unresolved unit IDs 3
                → timing reconciliation artifact
                  8833b708-6f67-4121-80a1-131a5af90e39 @ artifact version 2
                  timing-reconciliation@1.0, scenes version row dbd6102d… @ 2
                  target 9133 frames / 304433.333 ms
                    → final render source artifact
                      d4b89ad5-334b-4924-9d90-1df26afaefb6 @ artifact version 2
                      sourceKey c7be222c…, props SHA e497ce0d…
                      → final render attempt artifact
                        e41f87f2-f9ee-4bc2-b71f-ef074393481a @ artifact version 7
                        → job c030ac47…
                          → render_artifacts manifest + final MP4
```

Master WAV 在现场存在，SHA 与 audio/subtitle/reconciliation/final source 都一致；ffprobe 为 PCM s16le、48 kHz、mono、304.448208 s。

素材侧有 11 个 asset rows、9 个 active exact requirement bindings，9 个被 active binding 引用的物理文件全部存在；Final source 的 `assetMap` 引用同一批 exact asset IDs/paths，visual audit 中没有 placeholder。

## 9. Parent Architecture Status

`PARENT_ARCHITECTURE = UNKNOWN`

分类：**UNKNOWN — still required by current instructions, content unavailable**。

有界搜索范围与结果：

- 当前 repo：无 `视频生成器_架构设计文档.md`；
- 当前 repo 的所有 Git history path：无该文件，无同名 rename/delete 记录；
- parent/reasonable docs locations：`/Users/xlbnas/Documents` 最深 6 层的精确/近似文件名搜索无结果。

但当前指令仍有冲突：

- `.agents/skills/zhiying-architecture/SKILL.md:11-17` 明确要求开发前读取它，并称其为“当前架构 Source of Truth”；
- `CONTRACT.md:3-5` 称其版本为 v0.2.1，且冲突时以它为准；
- `docs/M1_已知限制.md:20` 仍引用其 §10；
- `docs/M2-B_实现说明.md:117` 只记录“不在本机/Git，M2-B 以 M2 实施计划 + 官方文档为准”，不是对总架构文档的正式 deprecation。

因此无法事实判定 MOVED、DELETED 或 OBSOLETE，也无法校验本报告与其内容是否冲突。这是明确的 **instruction inconsistency**，且是唯一剩余 implementation blocker。本轮未自行重建或宣布废止该文档。

## 10. Retirement Parity Gate

下列 gate 是未来允许退休旧 UI/LLM orchestration 入口的必要条件，不是本轮已执行的测试。破坏性项必须在隔离或明确授权的 production-like 环境执行，不得直接杀当前 Feiniu production Worker。

### Gate A — Golden production path

以 Golden Case 的 schema/source topology 为 fixture，从 Codex entrypoint 完成：

```text
Codex + Zhiying Skill
  → DB_BACKED_EXACT_IDENTITY
  → zhiying tts
  → zhiying subtitles
  → zhiying reconcile
  → existing asset API/backend + readiness
  → zhiying render
  → zhiying inspect
```

必须同时满足：

1. 全程没有调用 old `run-stage`、DeepSeek workflow executor 或旧 stage UI。
2. 每个命令输出 exact input/output IDs/versions，后一步 source refs 与前一步完全相等，无“latest”漂移。
3. TTS 为 M6 v1 + production-compatible `default@1`；master WAV 通过现有 probe/hash/manifest gates。
4. Subtitle/reconciliation 由现有 deterministic builders 生成，不由 Skill 计算 cue/frame。
5. Assets 通过现有 API/backend 进入，active binding、provenance、physical file、assetMap 和 visual gate 全通过；不手写 manifest。
6. Final Render 使用 existing Worker，产生 exact source/attempt/job/manifest/MP4；ffprobe、SHA、visual audit、loudness 和 exact-job resolution 全通过。
7. 该路径不新增 `llm_jobs`/generation run，不发生 DeepSeek 请求。

### Gate B — Runtime reliability

在隔离环境中用真实 Worker/process 验证：

1. **Kill/restart**：在 TTS 和 render 的 running 期分别强制终止 Worker；heartbeat 过期后 stale recovery 将 exact job 回 queued，重启后最终只有一个可解析 terminal result。
2. **Graceful shutdown**：SIGTERM 必须 abort active work、requeue、release lease 并 settle，不提前 succeeded。
3. **Cancel**：queued/running TTS 与 render 取消都必须进入 cancelled，不生成可下载的新 result。
4. **GPU contention**：并发放入 TTS + render/local GPU job；任一时刻 `production_gpu` 只有一个 owner，lose/expiry/release 后另一 job 才能 claim。
5. **Retry/stale**：可重试错误在 `max_attempts` 内 queued 并最终成功；不可重试或用尽次数则 failed；无跨 job fallback。
6. **Commit windows**：对 A/B/C/D 故障点做隔离 fault injection，结果与本报告冻结的当前 contract 一致，特别是任何 orphan 都不能被当成 succeeded/downloadable result。

### Gate C — Retirement decision

只有 A/B 全部通过，且旧入口保持可回滚到稳定版本，才能分项退休：

- 先退休 stage UI / workflow-only API；
- 再退休 DeepSeek LLM executor/queue；
- asset backend/API、existing Worker、SQLite accepted/artifact/job/lease facts 不因前两项通过而自动退休；
- 任一 parity 失败都停止 retirement，不以新状态机或新执行框架补洞。

## 11. Remaining Unknowns

1. `视频生成器_架构设计文档.md` v0.2.1 的真实内容、保管位置与是否已正式废止。
2. M7 `m7_visual_intent` 曾在 M6 项目上成功执行，但无 M7 pipeline project；其未来 consumer/保留责任本阶段不裁决。
3. Render 在 crash-before-rename 后残留 tmp/loud tmp 的长期清理策略没有专门测试；这不改变 terminal exact-job fail-closed contract，但是已知运维风险。
4. Retirement parity gate 的 kill/cancel/contention 组合尚未执行；本轮的任务是定义 gate，且明确禁止对 production 做破坏性验证。

## 12. Implementation Gate

| Ready condition | Result |
|---|---|
| Artifact V1 contract frozen | YES |
| TTS production path selected | YES — M6_V1 |
| Executor V1 frozen | YES — EXISTING_WORKER |
| CLI chain closed | YES — inspect/tts/subtitles/reconcile/render |
| Asset transition entry defined | YES — existing asset API/backend |
| Feiniu key production facts verified | YES |
| Golden Case directly verified | YES |
| Render commit contract confirmed | YES |
| Parent architecture resolved or explicitly deprecated | **NO** |
| Retirement parity gate defined | YES |

`IMPLEMENTATION_READY: NO`

解除该 gate 只需一个权威动作：找回并审阅 v0.2.1，或由有权决策者明确废止/替换它并修正当前指令引用。本报告不自行执行该决策，也不进入 Phase 2。
