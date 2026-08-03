# TTS-C OSS 复用审计矩阵（TTS-C.0.R2 修订；只读）

> 状态：TTS-C.0.R2 architecture closure completed；**未复制任何代码**。
> 审计基线：inspection date **2026-08-03**；每个项目记录 **exact inspected commit SHA**（GitHub API 现场核验，非 `main+pushed_at`）。
> R2 修正：① OpenMontage（calesthio）按真实代码重新审计（lib/checkpoint.py / tests / schemas / tools/video / pipeline_defs / README），Reject 依据 = AGPL license/integration mismatch（不再错误声称代码不存在）；② Open-Montage/OpenMontage 修正为正确 SHA `50279751590dc639d847ae909c7d592cb207ec57`；③ AGPL/NC 措辞保持谨慎（license 判断，不构成法律意见）。
> R3 修正：license 边界措辞去绝对化（AGPL 表述为"可能产生网络交互源码提供义务及组合/衍生作品风险；知影基于商业与合规风险决定不引入；不构成法律意见"）。
> 决策维度：`Adopt（直接引入）/ Adapter（借鉴接口或概念，重写实现）/ Reimplement（重新实现）/ Reject（不采用）`。

---

## 1. linyqh/NarratoAI

| 项 | 值 |
|---|---|
| source repo | https://github.com/linyqh/NarratoAI |
| **exact inspected SHA** | `a9e17d0e36171ab604433abafd127f78eefbf350`（branch `main` HEAD） |
| inspection date | 2026-08-03 |
| license（exact SHA） | **MIT**（仓库 LICENSE 文件 @ exact SHA；spdx `MIT`） |
| relevant files（exact SHA） | `app/services/`（subtitle_merger.py / subtitle_corrector.py / subtitle_translator.py / script_subtitle.py）、`app/config/`（audio_config/ffmpeg_config）、`app/services/test_indextts2_tts_unittest.py`（IndexTTS2 接入存在）、SDP utils subtitle_analyzer |
| 覆盖估计 | IndexTTS-1.5/2 adapter：**有**（IndexTTS2 TTS 服务 + 单测）；short-script parsing：部分；subtitles：高；cache/cleanup：有（"one-click clear cache"）；Apple Silicon MLX：未在 tree 确认 |
| 决策 | **Adapter（借鉴概念，不复刻）** |
| reason | MIT 允许借鉴；集成形态不同（Python 应用内直接调用 vs 知影 Node Worker → HTTP sidecar）；subtitle 管线面向"短视频解说"非 narration master/timing reconciliation |
| integration boundary | 概念：IndexTTS2 请求参数形态、subtitle 文本处理顺序、config 分层。**不引入 Python 依赖、不复制代码** |
| exit/replacement | 无运行时依赖 |
| commercial/license risk | MIT 无风险 |

## 2. Agents365-ai/video-podcast-maker

| 项 | 值 |
|---|---|
| source repo | https://github.com/Agents365-ai/video-podcast-maker |
| **exact inspected SHA** | `73fcf16836aec2ae014fd68202f095e64c13fc4d`（branch `main` HEAD） |
| inspection date | 2026-08-03 |
| license（exact SHA） | **CC BY-NC 4.0**（仓库 LICENSE @ exact SHA：Creative Commons Attribution-NonCommercial 4.0 International；SPDX `NOASSERTION`） |
| relevant files（exact SHA） | `scripts/tts/backends/ttscn.py`（ttsCN bridge）、`scripts/tts/phonemes.py`（音素/发音）、`scripts/tts/srt.py` + `scripts/align_timing_from_srt.py`（timing 对齐）、`templates/components/Subtitles.tsx` + `useTiming.ts`（Remotion 字幕/时间轴）、manifest-based Asset Engine |
| 覆盖估计 | TTS provider bridge：高；pronunciation/polyphone：有（phonemes.py）；timing.json：高；subtitle pipeline：高；Remotion audio/component：有 |
| 决策 | **Reject（不采用/不复制）；仅概念参考** |
| reason | **CC BY-NC 4.0 非商业许可**：商业/生产项目复制或衍生即违约；改写法（Adapter）也受 NC 衍生条款约束。phonemes/timing 概念只读理解，不落代码 |
| integration boundary | 概念：发音词典数据结构、srt→timing 对齐思路、Remotion 字幕 props 设计。不引入代码/依赖 |
| exit/replacement | 无运行时依赖 |
| commercial/license risk | **高风险（NC）**：禁复制/衍生；如需要发音词典用自研 + MIT/公有领域数据源 |

## 3. harry0703/MoneyPrinterTurbo

| 项 | 值 |
|---|---|
| source repo | https://github.com/harry0703/MoneyPrinterTurbo |
| **exact inspected SHA** | `254cd028906ee657eab844dc94087cdbea2a7aa8`（branch `main` HEAD） |
| inspection date | 2026-08-03 |
| license（exact SHA） | **MIT**（LICENSE @ exact SHA；spdx `MIT`） |
| relevant files（exact SHA） | `app/services/voice.py`（provider 抽象：edge-tts/azure/本地）、`app/services/data/azure_voices.json`（voice 目录）、`docs/voice-list.txt`、SubMaker（edge-tts word-level subtitle timing）、Docker 部署 |
| 覆盖估计 | provider clients：高；TTS/subtitle error handling：高；Docker/GPU：有；cache：部分 |
| 决策 | **Adapter（概念）/ Reject（直接依赖）** |
| reason | MIT 允许借鉴；但主力 TTS 是 edge-tts（微软在线服务），不适合知影"本地 IndexTTS2 + 零在线依赖"；SubMaker word-level timing 概念可参考，但知影时长真相 = ffprobe 实测（已冻结），不引入估算 |
| integration boundary | 概念：provider 抽象接口形态（知影已有 TtsProvider 不替换）、voice 目录 schema、错误归一模式。不引 edge-tts |
| exit/replacement | 无运行时依赖 |
| commercial/license risk | MIT 无风险 |

## 4. remotion-dev/template-prompt-to-video

| 项 | 值 |
|---|---|
| source repo | https://github.com/remotion-dev/template-prompt-to-video |
| **exact inspected SHA** | `27ecd9762a47aa177a5e83c6974e4c4e5e0d3876`（branch `main` HEAD） |
| inspection date | 2026-08-03 |
| license（exact SHA） | 仓库 **无独立 LICENSE 文件**（API `license=null`）；使用 Remotion 生态 license 条款（Remotion 公司 license / MIT 混合需逐文件确认） |
| relevant files（exact SHA） | `public/content/<video>/descriptor.json`（scene/audio 描述）、`cli/timeline.ts`（timeline 构建）、`cli/service.ts`、`public/content/<video>/audio/*.mp3`、composition props |
| 覆盖估计 | timeline JSON：高；audio track inputs：有；composition props：高；element identity：有（descriptor 引用） |
| 决策 | **Adapter（结构参考，不复制代码）** |
| reason | 知影已有自己的 `final-render/bridge.ts` + scene-schema + runtime-audio（M7.3A/B frozen），不替换；descriptor/timeline 模式仅交叉验证 |
| integration boundary | 概念：content descriptor 结构、timeline 派生方式。**不引入模板代码** |
| exit/replacement | 无运行时依赖 |
| commercial/license risk | **Remotion 公司 license**：知影按现有 Remotion 授权使用则无新增风险；模板无 LICENSE 文件——不复制代码，仅参考结构；保留 Remotion 授权证据 |

## 5. calesthio/OpenMontage（任务指定目标仓库）

| 项 | 值 |
|---|---|
| source repo | https://github.com/calesthio/OpenMontage |
| **exact inspected SHA** | `4eab34c5cfcccaa4f1970554928feccce73ee930`（branch `main` HEAD） |
| inspection date | 2026-08-03 |
| license（exact SHA） | **AGPL-3.0**（LICENSE @ exact SHA：GNU AFFERO GENERAL PUBLIC LICENSE v3，2007-11-19；spdx `AGPL-3.0`） |
| relevant files（exact SHA，真实代码读取） | `lib/checkpoint.py`（checkpoint writer/reader：stage 完成写 checkpoint、orchestrator resume、human checkpoints）、`lib/pipeline_loader.py` + `pipeline_defs/*.yaml`（13 个 pipeline manifests，get_pipeline_stages 确定性 stage 顺序）、`schemas/artifacts/*.schema.json`（20+ artifact JSON Schema：research_brief/proposal_packet/brief/script/scene_plan/asset_manifest/edit_decisions/render_report/publish_log/final_review/review/source_media_review 等）、`tools/video/video_compose.py`（VideoCompose：FFmpeg+Remotion+HyperFrames 运行时路由，governance 禁止 silent runtime swap）、`tests/lib/test_checkpoint_prerequisites.py`、`tests/lib/test_checkpoint_noncanonical_stage.py`、`tests/backlot/test_gate_scenarios.py`、`lib/delivery_promise.py`（delivery promise verification）、`lib/source_media_review.py`、`README.md` |
| 覆盖估计（按任务指定能力，基于真实代码） | **checkpoint persistence**：高（checkpoint_{stage}.json + init_project + resume）；**canonical artifact validation**：高（`_validate_artifacts_for_stage`：status completed/awaiting_human 必须含 canonical artifact）；**JSON Schema validation**：高（jsonschema.validate + validate_artifact，20+ schemas）；**stage prerequisite enforcement**：高（valid stage 来自 pipeline manifest，非法 stage fail-closed `CheckpointValidationError`）；**human approval gates**：高（`awaiting_human` 状态 + backlot storyboard/script gates + gate scenarios 测试）；**pipeline manifests**：高（pipeline_defs/*.yaml + get_stage_order）；**pre-compose/render validation**：中（video_compose 结构化 blocker、delivery_promise 校验）；**post-render/final review**：中（render_report/publish_log/final_review artifacts）；**ffprobe/audio/subtitle 检查**：低-中（README 宣称 self-review 含 "ffprobe validation, frame sampling, audio level analysis, delivery promise verification, subtitle checks"——以指南/管线断言形式存在，未见独立 ffprobe 工具模块） |
| 决策 | **Reject（AGPL，不引入代码）** |
| reason | 该仓库是 **AGPL-3.0 的 agentic video production 系统**（pipeline 编排 + checkpoint/governance 体系），其 checkpoint/prerequisite/JSON Schema/gate 概念与知影的 artifacts 状态机 + commit-time fence 体系在**概念上同构**（这是有价值的交叉验证），但：① AGPL-3.0 引入任何代码（含脚本）可能带来网络服务源码提供义务及组合/衍生作品风险，知影为商业项目，决定**不引入**；② 集成形态差异大（Python pipeline orchestrator vs 知影 Node + better-sqlite3 + artifacts 表）；③ ffprobe/audio/subtitle QA 在其 README 中以 self-review 概念存在，无独立可复用实现。Reject 依据 = license/integration mismatch（**非**"代码不存在"——checkpoint.py 等真实存在） |
| integration boundary | **无**（不引入任何代码/脚本）；概念参考：stage prerequisite + human gate + checkpoint 持久化思路（与知影 generation_runs lease/indeterminate 模式对照），全部以自研实现落地 |
| exit/replacement | 无运行时依赖 |
| commercial/license risk | **AGPL-3.0 高风险**：可能触发网络服务源码提供义务（AGPL §13）及组合/衍生作品传染；知影不引入其任何代码/脚本。本结论为谨慎的 license 判断，不构成法律意见；如需正式采用任何 AGPL 组件，须经法律审查 |

### 5.1 附加记录：Open-Montage/OpenMontage（非任务指定，仅澄清）

| 项 | 值 |
|---|---|
| source repo | https://github.com/Open-Montage/OpenMontage |
| **exact inspected SHA** | `50279751590dc639d847ae909c7d592cb207ec57`（2026-08-03 核验；**非 calesthio 的 SHA**） |
| license | **MIT** |
| relevant files | `lib/checkpoint.py` 等（结构与 calesthio 版本相似——疑似同源/镜像；以各自 exact SHA 为准） |
| 说明 | 因与任务指定能力（pre-compose/ffprobe/QA/gates）匹配度低且为避免双来源混淆，**不引入**（Reject）；其 checkpoint 概念与知影既有 lease/indeterminate 模式不冲突，仅参考思路。不替代任务指定仓库 |

---

## 汇总表

| 项目 | exact SHA | license | 决策 | 商业风险 |
|---|---|---|---|---|
| NarratoAI | `a9e17d0…` | MIT | Adapter（概念） | 无 |
| Video Podcast Maker | `73fcf168…` | CC BY-NC 4.0 | **Reject** | **高（NC）** |
| MoneyPrinterTurbo | `254cd028…` | MIT | Adapter（概念） | 无 |
| Remotion template | `27ecd976…` | 无独立 LICENSE（Remotion 条款） | Adapter（结构） | 需保留 Remotion 授权证据 |
| calesthio/OpenMontage | `4eab34c5…` | **AGPL-3.0** | **Reject** | **高（AGPL 传染）** |

## AGPL/LGPL/Remotion license 边界（谨慎表述）

- **calesthio/OpenMontage（AGPL-3.0）**：AGPL 可能产生网络交互源码提供义务（AGPL §13）及组合/衍生作品风险；知影基于商业与合规风险决定**不引入**其任何代码/脚本；概念参考（checkpoint/prerequisite/gate 思路）不产生衍生作品，不触发传染。本结论为 license 风险判断，**不构成法律意见**；若未来需正式采用任何 AGPL 组件，须经法律审查。
- **Video Podcast Maker（CC BY-NC 4.0）**：复制/衍生受非商业限制（NC 条款覆盖衍生作品）；知影不复制/不衍生；仅阅读理解。同样不构成法律意见。
- **Remotion 模板**：仓库无 LICENSE 文件；不复制模板代码；Remotion 使用以现有授权为准（授权证据保留）。
- 5 项目中无 LGPL 采用。

## 未做 / 边界

- 未对任一项目执行逐文件 diff 或引入任何文件；未安装/执行第三方代码（仅 GitHub API 只读核验 + 关键文件内容 base64 解码查看）。
- exact SHA 为 2026-08-03 inspection 时点的 branch HEAD（官方 tag 不存在于这些仓库的本次审计路径）；如后续需要锁定更老版本，需按新 SHA 重新核验 license。
