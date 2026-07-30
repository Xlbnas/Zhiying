# M6.3.13 — Workflow Polish 验收报告

> 基线：M6.3.12 PASS（11853f1）。本轮部署 SHA：`7125004`（branch `m6-ds-handoff`）。
> 环境：飞牛 NAS（192.168.31.56）· RTX 2080 Ti 22GB · network_mode: host · web:3210 · adapter:127.0.0.1:9880 · NVENC。
> 冻结未动：requirementId / asset_bindings / candidate-first / artifact integrity / FinalMode placeholder hard kill / usage accounting / loudnorm / NVENC contract。

（本报告在各项 E2E 完成后定稿。）

## 1. NARRATION —— `---` 不再进入 TTS

**根因**：LLM 的 Script V2 Markdown 章节间输出 horizontal rule（`---`）。`src/lib/narration/compiler.ts` 只剥离标题 / blockquote / HTML 注释，`---` 落入正文 → `splitSentences`（SENTENCE 正则允许零终止符）→ `emitSpeechRun` 生成 `text='---'` 的 speech unit → TTS job → IndexTTS 朗读为噪音。全链路唯一防线是"非空"（schema.ts / tts-jobs.ts / adapter server.py 三处均只查 trim 非空）。

**修复（canonical + 纵深防御）**：
- `src/lib/narration/speech-text.ts`（新）：`sanitizeSpeechText()` / `isSpeakableText()` / `containsMeaningfulSpeechCharacters()`。只识别整段 Markdown separator（`---`/`***`/`___` 及含空白变体）、HTML 注释、纯标点/空白；不暴力删标点（`2026-07-30`、`AI-driven 工作流` 保留）。
- 接入 `compiler.ts emitSpeechRun`：sentence 级过滤，段内 `---` 不误伤同段合法句；`audio.ts` 入队守卫（防旧脏 plan）；`NARRATION_COMPILER_VERSION` 1.1 → 1.2（旧 plan 自动失效，artifact 历史保留）。
- 附带修复预存 bug：M6.2 起真空行不再切段（flush 死代码），已恢复并回归 test-m3a H-E3。

**存量修复（不重跑 Stage 1-10）**：POST narration-plan 重建（compiler 1.2，新 artifact，旧保留）→ POST narration-audio 重新入队 → finalize 重拼 master + 新 manifest → subtitle-timing / reconciliation 重建。

**Production 实证**：
- 项目 `8fbe9cb6`（弗洛伊德，用户报告项目）：旧 plan v1 含 N004/N011/N041/N064/N078/N090 = `---` 共 6 个脏 unit → 新 plan v2（compiler 1.2）73 个 speech unit，**0 个不可朗读 unit**，新 plan 的 TTS job 中 `unitText='---'` **0 条**。
- 项目 `2fda54fb`（拖延）：旧 plan v2 含 N011/N023/N054=`---`、N059=`”` → 新 plan v3 50 个 speech unit，0 脏。
- TTS 重建期间 22 个 job 因 adapter 容器重启瞬断报 PROVIDER_UNAVAILABLE，重新 POST 后全部回队列恢复（retry 语义符合既有幂等设计）。

**测试**：`scripts/test-m6313-narration.ts` 39/39（separator/HTML 注释/纯标点不可朗读；正常口播/日期/英文 compound 保留；compiler 端到端无脏 unit 且同段合法句保留）；`test-m3a` 50/50、`test-m3b`（至 ffprobe 环境段）回归通过。

## 2. PNG UPLOAD

**根因**：服务端 100% 信任浏览器自报 `File.type`（upload/route.ts 旧 :49），无 magic bytes / 扩展名兜底。浏览器对无法判型的 PNG 自报 `application/octet-stream` → 400 `invalid_mime`。accept 属性与白名单本身都含 png（旧 contract 纸面正确、实现脆弱）。

**修复**：
- `src/lib/assets/image-sniff.ts`（新）：magic bytes 嗅探（PNG `89 50 4E 47 0D 0A 1A 0A` / JPEG `FF D8 FF` / WebP `RIFF…WEBP`）。
- upload route：magic 可识别 ∈ {jpeg,png,webp} → 以内容为 canonical（纠正 octet-stream 误报，落盘扩展名与 DB mimeType 用 canonical 值）；magic 不可识别 → 400 `invalid_content`。不信 declared MIME / 文件名纸面信息。20MB 上限、realpath 防穿越、exact binding、replace 语义不动。
- 前端 accept 补扩展名：`.jpg,.jpeg,.png,.webp`。

**Production E2E**（项目 2fda54fb · S002-R01 · 真实 800×450 PNG）：
- UI file picker → POST `/assets/upload` → **201 Created**；UI 即时显示"已替换该需求的素材"。
- DB：新 active binding → asset `mime_type=image/png`、`source_type=upload`、`license_status=user_provided`；旧 generated binding 保留 active=0。
- Preview 读取：`GET /assets/.../2bb6911b-….png` → **200，Content-Type image/png，2114B**（与源文件一致）。
- F5 刷新后：S002 仍显示"用户上传 / e2e-test.png / ✓ 已准备" —— 持久化确认。
- （测试结束后原 generated binding 已还原，见 §9。）

**测试**：`scripts/test-m6313-upload.ts` 22/22（真实 PNG、octet-stream 误报纠正、JPEG 改名 .png 按 magic 落盘、伪造内容 400、JPEG/WebP 回归）；`test-m638` 49/49 回归。

## 3. REACTIVE READINESS —— asset mutation 后无刷新自动更新

**根因**：asset mutation 只改 `asset_bindings`，不改 `project_stages` → 前端指纹 key（sourceStageKey/scenesStageKey）不变 → FinalRenderPanel/VisualPreview 不 refetch；`onAssetsChanged` 仅 AI 生成一个 mutation 调用且只喂 UsageSummaryPanel；FinalRenderPanel 的 10s discovery 轮询在存在终态 job 后永久停止。

**修复**（复用既有 refreshKey 惯例，无状态库，~30 行）：
- WorkflowWorkspace：`assetsRefreshKey` 计数器，传入 FinalRenderPanel / VisualPreview，回调接 VisualAssetsPanel。
- VisualAssetsPanel：全部 5 个 mutation（acquire/search/generate/bind/upload）成功路径统一 `onAssetsChanged`。
- FinalRenderPanel discovery 轮询放宽为"无 active job 即 10s"。

**Production E2E**（项目 2fda54fb，真实浏览器，全程未按 F5）：
1. 基线：TTS/字幕/校准重建完成后 F5 一次，按钮 enabled「可渲染」。
2. UI mutation 方向：点「改回素材」（revert MG）→ **无刷新**即时：按钮变 [disabled]「待上游」、素材需求 8→9 项、S006 回 pending。
3. backend mutation 方向：DB 直接重新激活 S006 原 binding（模拟带外变更）→ **无刷新** ≤12s（10s discovery 轮询）：按钮自动回到 enabled「可渲染」。
4. MG switch（§4）与 PNG upload（§2）的 UI 即时更新亦全程无刷新。

## 4. MG FALLBACK —— scene-level authoritative override

**模型**：新表 `scene_visual_overrides(project_id, scene_id, scenes_version_id, strategy, template, template_props, created_at)`。`applyVisualOverrides()` 纯函数在 readiness / resolver / buildFinalRenderProps / preview bridge 四处注入点生效；不改 scenes artifact（whole-generation invariant 不破）；scenes_version_id 漂移即失效。不 fake 任何 requirement binding——override scene 的 bindings 真实 deactivate（历史保留），requirement 从 readiness denominator 真实移除。

**Eligibility**：`canSwitchToMg()`——任一 requirement `authenticityOf()=authentic_required` → 禁止（Archive category 默认命中）。resolver 剔除 `switch_to_mg` 并返回原因。

**API**：`POST /assets/mg-preview`（deterministic 模板选择 + props 构建，过 `validateTemplateProps` 才返回）→ `POST /assets/switch-to-mg`（服务端重跑 eligibility + zod，单事务落库）→ `POST /assets/revert-mg`。

**Production E2E**（项目 2fda54fb · S006 B-roll）：
- resolver：S006 `availableActions` 含 `switch_to_mg`、`switchToMgEligible=true`；S007（Archive）`switchToMgEligible=false`，原因"该镜头需要真实历史素材，不能改用 MG 模板画面" ✓（PASS 条件 5）。
- UI：改用 MG → 确认区显示模板 `MG_MessageFocus` + props JSON（message 取自 scene narrationSummary，context 取自章标题）→ 确认切换 → **无刷新**即时更新：素材需求 9 → **8 项**，S006 显示 MG 徽标"已改用 MG 模板（MG_MessageFocus），无需外部素材" + "改回素材"。
- DB：override 行含 `scenes_version_id=dbd6102d…`、strategy=mg、templateProps 过 zod；S006 binding active=0（历史保留）。
- render-preview props：S006 实际渲染输入为 `category:'MG', visualType:'MG', template:'MG_MessageFocus', templateProps:{…}`（authoritative render mutation，非 READY 伪装）；visualReadiness `ready:true, needAssets:8, pendingAssets:0, missing:[]`。
- final-render readiness：无 VISUAL_READINESS_FAILED（唯一 blocker 是重建中的 NARRATION_AUDIO_NOT_READY）→ MG override 被 Final gate 正确认可。

**测试**：`scripts/test-m6313-mg.ts` 49/49（eligibility/authentic 409/不 fake binding/denominator/render props 走 MG/visual-gate/version 漂移失效/revert/4 路守卫）；`test-m639` 61/61、`test-m6312` 41/41 回归。

## 5. PROGRESS —— frame/percent 单一数据源

**根因**：`render_jobs.progress` 是 Remotion 加权值 `(70·rendered + 30·encoded)/total`，UI label 显示 `encodedFrames` —— 两个字段度量不同东西（截图 856/18013=4.75% 显示 6%、1287/18013=7.14% 显示 8% 与此完全吻合）。

**修复**：`detailFromRemotionProgress` 增加 `percent`（同一 snapshot 的 encodedFrames/totalFrames，一位小数；muxing=100）；FinalRenderPanel 与 Jobs 页改用 `detail.percent`（detail 缺失才 fallback job.progress）。

**Production 实证**（render job `c030ac47`，9133 帧）：
- UI 截图实证：`编码视频 3900/9133 帧（42.7%）` —— 3900/9133 = 42.70%，帧数与百分比**数学一致**；blocker 摘要行同口径。
- 用户截图场景对照：旧口径 1287/18013 显示 8%（加权），新口径恒为 encodedFrames/totalFrames。

**测试**：`test-m5-render-progress.ts` 19/19（含 856/18013→4.8 断言）、`scripts/test-m6313-progress.ts` 21/21。

## 6. ETA

- worker 心跳新增 `fps`（相邻心跳 renderedFrames 增量 ÷ 实际间隔）与 `phaseStartedAt`；loudnorm 进入前补 `finalize` 阶段心跳（消除 100% 假完成窗口）。
- 前端 `src/lib/render/eta.ts`：EMA（alpha 0.25），仅 encode/render 阶段估算；fps≤0 / NaN / 帧回退丢弃；样本不足显示"正在估算…"；服务端 fps 先验保证 F5 后立即有估值。
- UI：`编码视频 1287 / 18013 帧（7.1%）` + `速度 X fps · 预计剩余 约 X 分钟 · 预计完成 HH:mm`。

**Production 实证**（render job `c030ac47` UI 截图）：`编码视频 3900/9133 帧（42.7%）` + `速度 12.9 fps · 预计剩余 约 7 分钟 · 预计完成 07:17`；worker 心跳 fps 序列 13.5→19.5 滚动，etaMs 从 636s 单调收敛到 12.8s；loudnorm 期间 UI 显示「响度归一化」（finalize 心跳 07:14:43 起），不再停在 100% 假完成。

## 7. PERFORMANCE

**Baseline（用户实测，旧 build 11853f1）**：8fbe9cb6 项目 18013 帧，33s 推进 431 帧 = 13.06 fps ≈ 0.44× realtime；2fda54fb 上一轮完整 render 9227/979.7s = 9.42 fps。

**本轮实测（7125004，2fda54fb，render job c030ac47，9133 帧 / 304.5s 视频）**：
- encode 阶段（07:05:34→07:14:43 心跳窗口）：renderedFrames 153→8891，**≈17.0 fps 持续**；端到端（started→finished 676.4s，含 loudnorm 两通 ~104s + 校验 + rename）：9133/676.4 = **13.5 fps**。
- 对比同项目上一轮 9.42 fps（端到端口径）：**+43%**。（注：两轮内容有 narration 差异，口径为端到端；encode 相口径 17.0 fps 为当前稳定吞吐。）

**Phase profiling（render 全程 30s 间隔采样）**：
- `nvidia-smi`：GPU util **0-1%**，power ~79W（近 idle），dmon enc **0-6%** → **NVENC/FFmpeg 不是瓶颈**。
- `docker stats zhiying-worker`：CPU **295%-436%**（上限 800%）→ Chromium frame production 是 CPU-bound，且 concurrency=6 时 CPU 只用了一半。
- loudnorm finalize 阶段 CPU 峰值 816%（ffmpeg 两通，~104s），GPU 24-28W 完全 idle。
- **结论：瓶颈在 Remotion/Chromium 帧生产（CPU），不在 NVENC；提并发是直接杠杆。**

**Concurrency benchmark**（`scripts/bench-render.ts`，450 帧，同 job payload，worker 容器内实测）：

| concurrency | libx264(crf:18) fps | NVENC fps |
|---|---|---|
| 2 | 4.43 | — |
| 4 | 5.82 | — |
| 6 | 5.86 | 5.98 |
| 8 | 5.60 | 5.62 |
| 10 | — | 不可用（Remotion 上限 = 容器 8 核） |

- libx264 路径 c=4→6 已到平台（5.8 fps），c=8 反降 —— x264 编码本身吃 CPU，与帧生产争抢。
- NVENC bench 与 libx264 bench 同判：**c=6 即平台，c=8 略降**；c>8 被 Remotion 核心数上限（容器 cpus:8）直接拒绝。
- bench 绝对 fps（~6）低于真实 render（17 fps）：450 帧短区间无法摊薄每 tab 的 Chromium 启动成本，真实 9133 帧 render 才接近稳态吞吐；benchmark 只用于横向比较，不作为绝对吞吐。
- **结论：REMOTION_CONCURRENCY=6 已是该硬件最优点，本轮不改配置。** 进一步提速（>8 并发）需要先抬容器 cpus 上限，但 bench 曲线显示收益为零甚至为负——瓶颈不在可用核数，而在 Chromium 帧生产管线的内部串行段（tab 启动/合成/截图序列化），GPU compositing（REMOTION_GPU_ENABLED 已开）在 headless Docker 下利用率仍 ~0，属 Remotion/Chromium 已知限制。

**与 ≥18 fps 目标的关系（如实报告）**：encode 相稳态 17.0 fps（2fda54fb，0.57× realtime）接近但未达 18；端到端 13.5 fps（含 loudnorm 两通 ~15% 时间）。对比用户实测旧 build 13.06 fps（8fbe9cb6，encode 相口径）与同项目上一轮端到端 9.42 fps，本轮无回归且略有改善（+43% 端到端同项目口径，部分来自 bundle cache 稳定与负载条件）。**真实瓶颈 = CPU 侧 Chromium 帧生产，非 NVENC；并发杠杆已打满。** 不造假提速承诺。

**正确性保持**：c030ac47 产物通过全部既有 gate——M6.3.11 succeeded gate（ffprobe + `output_sha256=5812442c…`）、M6.3.12 质量门（audit_json 26 scenes 全过）、loudnorm 两通（inputI -21.96 → target -16 LUFS，`loudness_json` 落库）、encoder=h264_nvenc、9133 帧 / 304.491s。无任何为性能牺牲正确性的改动。

## 8. TESTS

- `pnpm typecheck`：PASS（tsc --noEmit 无错误）
- `pnpm build`：PASS（next build 全路由编译成功）
- 测试脚本（scripts/test-*.ts，逐个执行）：
  - 本轮新增：test-m6313-narration 39/39 · test-m6313-upload 22/22 · test-m6313-progress 21/21 · test-m6313-mg 49/49（**131/131**）
  - 直接相关回归：test-m3a 50/50 · test-m5-render-progress 19/19 · test-m638 49/49 · test-m639 61/61 · test-m6310 54/54 · test-m6311 32/32 · test-m6312 41/41 · test-m2e-scenes-semantic 47/47 · test-m5-ui-logic 35/35
  - 全量扫描其余套件全绿；仅 test-m3b(W24+)/test-m4b/test-m4c1(D00) 失败，均为本机无 ffmpeg/docker 的环境性失败，干净 HEAD 同败（已 stash 实证）。

## 9. DEPLOYMENT

- SHA：`7125004`（`feat(m6.3.13): …`，36 files, +2002/-60）→ push `m6-ds-handoff`。
- 备份：`zhiying-backup-2026-07-30-1354.tar.gz`（1.1G，data/ 全量，排除 bundle-cache；本次含新表 scene_visual_overrides）。
- 交付通道：NAS 从本地 frozen bundle 同步（GitHub → bundle → scp → fetch/reset），`ZHIYING_RELEASE_TAG=7125004`，`docker compose -f docker-compose.production.yml -f docker-compose.production.gpu.yml build && up -d`。
- 容器：zhiying-web / zhiying-worker / indextts2-adapter 均 healthy（image `zhiying:7125004`）；homepage 200；`/api/projects` 200。
- E2E 临时改动还原：S002（PNG replace→原 generated binding 重新激活，PNG binding 保留为 active=0 历史）、S006（revert-mg→原 generated binding 重新激活，override 已删除）——两项目 resolver 终态全 ready、无 override 残留。
- 8fbe9cb6（弗洛伊德，N004 原项目）：TTS 73/73 完成后 audio finalize + subtitle-timing（201）+ timing-reconciliation（201）重建，final-render `ready:true, blockers:[]`。

## 10. PASS 判定

| # | 条件 | 结果 | 证据 |
|---|---|---|---|
| 1 | `---` / Markdown separator 不进入 TTS | PASS | 双项目新 plan 0 脏 unit；新 plan TTS job `unitText='---'` 0 条；123/123 全成功 |
| 2 | production PNG upload E2E | PASS | UI file picker→201→user_provided→READY→preview 200 image/png→F5 持久 |
| 3 | asset mutation 后 Final Render 无刷新自动更新 | PASS | revert-MG 即时 disable；DB 变更 ≤12s 自动 enable；全程无 F5 |
| 4 | MG fallback 是真实 authoritative render mutation | PASS | scene_visual_overrides + render-preview props 实走 MG_MessageFocus |
| 5 | authentic-required 不允许错误 MG fallback | PASS | S007(Archive) switchToMgEligible=false + 原因文案；49/49 单测含 409 |
| 6 | frame count / percent 完全一致 | PASS | 3900/9133=42.70% 与 UI 42.7% 数学一致（截图） |
| 7 | running render 有稳定 ETA | PASS | UI 显示 12.9 fps · 剩余 7 分钟 · 完成 07:17；etaMs 636s→12.8s 单调收敛 |
| 8 | performance profiling 给出真实 bottleneck | PASS | GPU 0-1% / enc 0-6% / CPU 300-436%：Chromium 帧生产 CPU-bound，并发已打满 |
| 9 | 优化不破坏 visual correctness | PASS | 未采纳破坏性变更；产物过 M6.3.11/12 全部 gate |
| 10 | tests/build/typecheck PASS | PASS | 新增 131/131；相关回归 388/388；typecheck/build 全绿（仅环境性套件除外，HEAD 同败） |
| 11 | 已 production Docker 部署 | PASS | zhiying:7125004 三容器 healthy；homepage 200 |

**M6_3_13_PASS**
