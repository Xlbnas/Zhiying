# TTS-C OSS 复用审计矩阵（只读；TTS-C.0）

> 状态：TTS-C.0 architecture audit completed；**未复制任何代码**。
> 审计基线：2026-08-03 通过 GitHub API 现场核验（repo 元数据/license/文件树/关键文件内容）。
> 决策维度：`Adopt（直接引入）/ Adapter（借鉴接口或概念，重写实现）/ Reimplement（重新实现）/ Reject（不采用）`。
> 知影约束：商业项目、本地 IndexTTS2 部署、Node.js + Python adapter、零真实 provider 测试门禁、Remotion 渲染。

---

## 1. NarratoAI

| 项 | 值 |
|---|---|
| source repo | https://github.com/linyqh/NarratoAI |
| exact inspected | branch `main`，pushed_at 2026-07-23；stars ≈ 10.5k |
| license | **MIT**（spdx `MIT`，仓库含 LICENSE 文件） |
| relevant files/modules | `app/services/`（subtitle_merger.py / subtitle_corrector.py / subtitle_translator.py / script_subtitle.py / fun_asr_subtitle.py）、`app/config/*`（audio_config/ffmpeg_config）、`app/services/test_indextts2_tts_unittest.py`（IndexTTS2 接入存在）、SDP utils step1_subtitle_analyzer |
| 覆盖估计 | IndexTTS-1.5/2 adapter：**有**（IndexTTS2 TTS 服务与测试存在）；short-script parsing：部分（script_subtitle）；subtitles：高（多级 subtitle 管线）；cache/cleanup：有（"one-click clear cache"）；Apple Silicon MLX 路径：未在本次 tree 中确认（无 MLX 特征文件） |
| 决策 | **Adapter（借鉴，不复刻）** |
| reason | MIT 允许借鉴；但其 TTS 集成是 Python 应用内直接调用 IndexTTS 模型/API，知影架构是 Node Worker → HTTP sidecar adapter（frozen contract），两者集成形态不同；subtitle 管线针对"短视频解说"业务，非 narration master/timing reconciliation 语义 |
| integration boundary | 概念参考：IndexTTS2 请求参数形态、subtitle 文本切分/合并/纠错的处理顺序、config 分层（audio/ffmpeg 独立 config）。**不引入 Python 依赖，不复制代码** |
| exit/replacement | 无运行时依赖，零退出成本 |
| commercial/license risk | MIT，无商业风险 |

## 2. Video Podcast Maker

| 项 | 值 |
|---|---|
| source repo | https://github.com/Agents365-ai/video-podcast-maker |
| exact inspected | branch `main`，pushed_at 2026-08-01；stars ≈ 1.5k |
| license | **CC BY-NC 4.0**（`NOASSERTION` SPDX；仓库 LICENSE 文件为 Creative Commons Attribution-NonCommercial 4.0 International） |
| relevant files/modules | `skills/video-podcast-maker/scripts/tts/backends/ttscn.py`（ttsCN bridge）、`scripts/tts/phonemes.py`（音素/发音）、`scripts/tts/srt.py` + `scripts/align_timing_from_srt.py`（timing.json 对齐）、`templates/components/Subtitles.tsx` + `useTiming.ts`（Remotion 字幕/时间轴组件）、`manifest-based Asset Engine` |
| 覆盖估计 | TTS provider bridge：高（ttsCN 多平台抽象）；pronunciation dictionary/polyphone：有（phonemes.py）；timing.json：高（srt→timing 对齐）；subtitle pipeline：高；Remotion audio/component input：有（Subtitles.tsx） |
| 决策 | **Reject（不采用/不复制）**；仅概念参考 |
| reason | **CC BY-NC 4.0 非商业许可**：知影是商业/生产项目，复制或衍生即违反许可条款；即便 Adapter（改写法）也需谨慎（NC 条款覆盖衍生作品）。其 phonemes（polyphone 校正）与 timing 对齐概念有参考价值，但**只读理解、不落实现代码** |
| integration boundary | 概念：发音词典数据结构、srt→timing 对齐思路、Remotion 字幕组件 props 设计。不引入其代码/依赖 |
| exit/replacement | 无运行时依赖 |
| commercial/license risk | **高风险（NC 条款）**：禁止复制/衍生；如未来需要发音词典，用自研实现（数据源采用 MIT/公有领域词典或自建） |

## 3. MoneyPrinterTurbo

| 项 | 值 |
|---|---|
| source repo | https://github.com/harry0703/MoneyPrinterTurbo |
| exact inspected | branch `main`，pushed_at 2026-08-02；stars ≈ 101k |
| license | **MIT** |
| relevant files/modules | `app/services/voice.py`（provider 抽象：edge-tts / azure / 本地）、`app/services/data/azure_voices.json`（voice 目录）、`docs/voice-list.txt`、SubMaker（edge-tts word-level subtitle timing）、Docker 部署 |
| 覆盖估计 | provider clients：高（多 provider 抽象 + voice 目录）；TTS/subtitle error handling：高（重试/超时/异常归一）；Docker/GPU compatibility：有（Docker 部署）；cache：部分 |
| 决策 | **Adapter（概念借鉴）/ Reject（直接依赖）** |
| reason | MIT 允许借鉴；但**其主力 TTS 是 edge-tts（微软在线服务）**，不适合知影"本地 IndexTTS2 + 零在线依赖"的生产约束；SubMaker 的 **word-level subtitle timing** 概念有参考价值（与 IndexTTS-2 的 duration 精确控制方向一致），但知影时长真相是 ffprobe 实测（已冻结），不引入 word-level 估算 |
| integration boundary | 概念：provider 抽象接口形态（知影已有 `TtsProvider`，不替换）、voice 目录 schema、错误码归一模式。不引入 edge-tts 依赖 |
| exit/replacement | 无运行时依赖 |
| commercial/license risk | MIT 无风险 |

## 4. Remotion official prompt-to-video template

| 项 | 值 |
|---|---|
| source repo | https://github.com/remotion-dev/template-prompt-to-video |
| exact inspected | branch `main`，pushed_at 2026-07-31；stars ≈ 129 |
| license | 仓库**无独立 LICENSE 文件**；使用 Remotion 生态 license 条款（Remotion 公司 license / MIT 混合需逐文件确认） |
| relevant files/modules | `public/content/<video>/descriptor.json`（scene/audio 描述）、`cli/timeline.ts`（timeline 构建）、`cli/service.ts`、`public/content/<video>/audio/*.mp3`（音频输入）、composition props |
| 覆盖估计 | timeline JSON：高（descriptor 描述 scene + audio 顺序）；audio track inputs：有（audio 目录 + 引用）；composition props：高；element identity：有（descriptor 引用） |
| 决策 | **Adapter（概念借鉴）** |
| reason | 知影已有自己的 `final-render/bridge.ts` + `scene-schema` + runtime-audio 体系（M7.3A/B frozen），不替换；descriptor/timeline 的"content 目录 + JSON 描述 + 音频引用"模式与知影 artifacts+props 模式同构，仅作交叉验证 |
| integration boundary | 概念：content descriptor 结构、timeline 派生方式。**不引入模板代码**（知影渲染契约已冻结） |
| exit/replacement | 无运行时依赖 |
| commercial/license risk | **Remotion 公司 license**：知影如已按 Remotion 授权使用则无新增风险；模板本身无 LICENSE 文件——**不得复制模板代码**，仅参考结构；需在采购/授权记录中保留 Remotion 条款证据 |

## 5. OpenMontage

| 项 | 值 |
|---|---|
| source repo | https://github.com/Open-Montage/OpenMontage |
| exact inspected | branch `main`，pushed_at 2026-06-26；stars ≈ 91（小规模） |
| license | **MIT** |
| relevant files/modules | `lib/checkpoint.py`（checkpoint 机制）；pre-compose validation / ffprobe / audio-subtitle QA / post-render gates：仓库规模小，本次 tree 未发现完整 QA/gate 模块（仅 checkpoint 确认存在） |
| 覆盖估计 | pre-compose validation：低（未见独立模块）；ffprobe：未确认；audio/subtitle QA：未确认；checkpoints：有（checkpoint.py）；post-render gates：未确认 |
| 决策 | **Reject / Reimplement（自研）** |
| reason | 项目规模小、与知影管线（Node + better-sqlite3 + artifacts 状态机）架构差异大；知影的 pre-compose validation / 语义校验 / commit-time fence 已有自研体系（M7.3A/B 冻结），无需外部 checkpoint 概念 |
| integration boundary | 无（不引入） |
| exit/replacement | 无运行时依赖 |
| commercial/license risk | MIT 无风险 |

---

## 汇总表

| 项目 | license | 决策 | 引入依赖 | 商业风险 |
|---|---|---|---|---|
| NarratoAI | MIT | Adapter（概念） | 无 | 无 |
| Video Podcast Maker | CC BY-NC 4.0 | **Reject** | 无 | **高（NC，禁复制/衍生）** |
| MoneyPrinterTurbo | MIT | Adapter（概念） | 无（不引 edge-tts） | 无 |
| Remotion template-prompt-to-video | 无独立 LICENSE（Remotion 条款） | Adapter（概念） | 无 | 需保留 Remotion 授权证据 |
| OpenMontage | MIT | Reject | 无 | 无 |

## AGPL/LGPL/Remotion license 边界（明确）

- 上述 5 项目中**无 AGPL/LGPL 采用**；OpenMontage 的另一个同名仓库（`calesthio/OpenMontage`，AGPL-3.0，44.8k★）与任务描述的 OpenMontage 能力不符，**未采用**（AGPL 若引入将强制整个服务端源码开放，知影不满足）。
- Video Podcast Maker 的 CC BY-NC 4.0：任何代码/数据复制或衍生均受非商业限制——**仅阅读理解，不落代码**。
- Remotion 模板：模板仓库无 LICENSE 文件，复制模板代码有 license 不确定性；知影 Remotion 使用以现有授权为准，模板仅作结构参考。

## 未做 / 边界

- 未对任一项目执行逐文件 diff 或引入任何文件到仓库。
- 各项目"相关模块"为 GitHub API tree/文件内容现场核验；未做运行时验证（不安装、不执行第三方代码）。
- 决策矩阵仅约束"引入代码"层面；概念层面的设计参考已分别记录在 `docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md` 对应章节。
