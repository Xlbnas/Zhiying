# M7.0 — Editorial Pipeline Architecture Audit and Redesign Report

## 审计基线（Audit Baseline）

- **Repository**: `github.com/Xlbnas/Zhiying`（origin）
- **Branch**: `m6-ds-handoff`（审计时存在于 origin，`ba29016`）
- **Code baseline（被审计的 production 代码）**: commit `712500488e91a156fff3053911d22c3c154a6bfa`（`feat(m6.3.13)`，2026-07-30 05:54 UTC）
- **Audit HEAD（审计工作区实际 HEAD）**: `ba29016258e66aa0e38e3e0c18490029c5f27745`（docs-only 提交，`7125004` 的直系子提交，不含代码变更）
- **Production snapshot**: production DB 脱敏只读副本，快照时间 2026-07-30（审计会话日）；库内最新业务记录 2026-07-29（Freud scenes v2 repair）。DB 文件本身不随本报告发布。
- **项目标识（脱敏稳定 ID）**: Freud 项目 `8fbe9cb6-ed5f-41e9-b748-b52e156ba314`；拖延项目 `2fda54fb-e5fa-4237-bda3-265fe1d7978d`
- **审计方式**: 5 个只读审计域（Narration/TTS、Editorial Planning、Asset/Render、Production Artifacts 取证、Workflow/基础设施），所有结论附 file:line 与真实 DB 记录；本轮为架构审计与设计，未修改 production code、未做 DB migration、未重跑任何项目。
- **证据标注约定**: 所有未由代码执行或 DB 记录直接验证的判断标注为 **INFERENCE**；未标注的陈述均有代码行或 DB 记录支撑。

---

## EXECUTIVE CONCLUSION

M6.3.13 的技术完整性基础设施（artifact 不可变性、whole-generation invariant、三道渲染门禁、SHA/幂等、usage 计量）是高质量的，M7 应整体继承。但 editorial 层存在四个结构性根因，都不是 regex 能修的：

1. **导演指令是 Script V2 输出契约的一部分**（`src/lib/prompts/script-v2.ts:24` 明确要求内联 `（停顿 1s）`/`（放慢）`），而 narration compiler 只识别 4 条精确 regex（`src/lib/narration/compiler.ts:79-82`），失配文本被静默吞进 speech unit.text，并**守恒地**传播到 TTS、字幕、MG 显示文本。这是类型系统缺失，不是词表不够长。
2. **narration 轨与视觉轨全程无结构绑定**。两条独立时间轴只在 reconciliation 做整体比例缩放；scene 由 LLM 自由提案，无 beat/intent/sequence/continuity 概念，「一句旁白一个画面」与「MG 反复重 mount」都是这一缺失的症状。
3. **title card 是合法 category + prompt 级配额 + 零机器约束**的产物。Freud 成片 Minimal+MG 占 scene 数 47.1%，与审片抽样 47% 纯黑卡完全吻合。
4. **渲染层对所有图片统一 `objectFit:'cover'` + 哈希随机 Ken Burns**（`ProductionSceneRenderer.tsx:154,117-136`），素材宽高比已入库但从不被消费。

M7 的核心动作：建立 **Typed Narration → Narrative Beat → Visual Intent → Sequence/Shot → Storyboard → Animatic → Final** 的 editorial 主链，全部落在已验证的 artifact 版本/门禁/幂等机制之上；不重跑 Stage 1–6；旧 artifact 全部保留。

---

## CURRENT DATA FLOW

真实代码确认的两条平行轨（审计前「一句 narration → 一个 scene」的假设需修正——实际更糟：两轨根本没有绑定）：

```
轨 A（听觉，deterministic）：
script_v2 (markdown, project_versions)
  → narration compiler (compiler.ts, 4 条指令 regex) → narration_plan artifact
  → tts_jobs (unitText = unit.text verbatim) → IndexTTS2 → narration_audio_manifest (ffprobe 时长=唯一真相)
  → subtitle_timing (cue.text = unit.text verbatim, text-conservation invariant)

轨 B（视觉，LLM 主导）：
script_v2 原文 ─verbatim 注入→ narration_beat_map (markdown, 无 schema)
                             → visual_breakdown (markdown, 无 schema)
                             → shot_list (JSON+zod, 唯一看不到 script_v2 的层)
                             → scenes (JSON+zod+normalize+语义校验; script_v2 第三次注入)
  → asset requirements (requirementId) → resolver → asset_bindings
  → timing_reconciliation (按 scene 权重把全片等比拉伸到 master 音频时长)
  → final_render_source (immutable + sourceKey/SHA) → Remotion FullCutV1
      每 scene 一个独立 <Sequence>，8 帧 crossfade 写死
```

逐层契约现状：

| 层 | 输入 | 输出 | authoritative 字段 | 自由文本字段 | 版本机制 | validator/normalizer |
|---|---|---|---|---|---|---|
| script_v2 | script_v1+evidence | markdown | 无 | 全文（含契约要求的内联指令） | `script-v2@1.0` prompt 版本 | **无** |
| narration_plan | script_v2 locked | units N001… | id/kind/pauseMs | `text`（唯一文本字段，TTS+字幕+间接视觉三用） | `narration-plan@1.0` + compiler 1.2 | zod 结构校验（不查 text 内容） |
| beat_map / visual_breakdown | script_v2 原文 | markdown | 无 | 全文 | prompt 版本 | **无（纯散文，无机器出口）** |
| shot_list | 两份 markdown | JSON | id/chapter/visualType(5 enum)/durationSec | purpose/transition/assetNeeds/notes | `shot-list@1.0` | 仅 zod |
| scenes | shot_list+breakdown+script_v2 原文 | JSON | id/时间轴/template | **narrationSummary**/description/notes/transitionIn·Out/templateProps(`z.record(z.unknown())`) | `scenes@1.3` + schema 1.0 | zod + normalize + 语义校验（不查文本内容/配比/转场） |
| reconciliation | scenes+audio+subtitle | 帧分配 | 帧字段 | 无 | `timing-reconciliation@1.0` | superRefine 重推导 |
| final props | 四源 current | ZhiyingFullCutProps | timing/template | narrationSummary 直通上屏 | `final-render-source@1.0` + sourceKey/SHA | render-input gate（不查文本） |

**导演指令第一次进入 spoken content 的位置：`compiler.ts:257-282 emitSpeechRun`**——不能被 4 条 regex 匹配的文本原样成为 speech unit.text。根源在 prompt 层（契约鼓励指令变体）+ compiler 层（封闭词表，失配静默吞并，无「未知指令」兜底）。

---

## PRODUCTION ARTIFACT EVIDENCE

数据源：production DB 脱敏只读副本（查询方法：整库复制后以 SQLite `mode=ro` 查询，未改动原库；仅抽取支持结论所需字段）。两项目均 10 stage 全 locked。

**传播链 1（复合指令 → TTS → 字幕 → 成片，Freud）**：
script_v2 v1 原文 `（停顿 0.5s，放缓） 真正庞大的部分…` → plan v1 N015 speech text 原样携带（`放缓` 不在词表、复合括号不匹配任何 regex）→ tts_jobs N015 succeeded，unitText 同一串 → audio manifest N015 durationMs=11413（指令被实际朗读）→ subtitle cue 19（77030–83552ms）逐字显示 → render job `96c6459d` payload cue[18] → 成片上屏。

**传播链 2（`---` 被朗读 1.6 秒，Freud）**：script_v2 章间 `---` → N004 text=`"---"` → TTS 合成 durationMs=1637 → cue 4 上屏。110 条字幕中 **13 条污染**（N004/N011/N041/N049/N064/N077/N088/N093 等）。M6.3.13 的 sanitizer 只堵 `---` 类不可朗读字符，链 1 的指令文本至今仍然 speakable。

**传播链 3（脚本结束标记被朗读，拖延）**：`--- *【脚本结束】*` → N062 text 原样 → tts succeeded → 进音频（该项目 render job 为 no-subtitles，未上屏但已进入音频）。

**传播链 4（指令 → MG/title card 显示文本，Freud）**：scenes `narrationSummary` = 「停顿后旁白：不是被证实的科学事实。」「停顿0.5s，旁白无。」等（S020/S021/S025/S031/S044）→ render payload 原样 → `ProductionMinimal` 黑底大字逐字上屏 + 图片左下角解说框 + `buildMgPreviewProps` MG fallback 文案。全链路无任何内容校验。

**比例实证（Freud v1，实际成片版本）**：Minimal 14（20.6%）+ MG 10（21.6%）+ Editorial Graphic 9（24.9%）→ **Minimal+MG = 24/51 = 47.1%**，与人工审片 120 采样点 47% 纯黑卡吻合（审片数据来自人工抽帧，非机器统计）。更糟：v1 的 10 个 MG scene **templateProps 全部 null（10/10）**，且其中 7 个使用的模板（MG_TimePass×3、MG_IntentConflict×3、MG_WorthQuestioning×1）**不在 production 渲染器注册表**（`ProductionSceneRenderer.tsx:30-37` 的 6 个模板）→ 线上成片中这 10 个 MG scene 全部走 `ProductionPlaceholder` 黑底占位（v1 渲染于 M6.3.12 placeholder hard-fail 之前，属 Gate 缺口的历史窗口）；S047–S051 五个结尾填充 scene（4 Minimal + 1 Archive）。

**MG 重 mount 实证**：S011+S012+S013 同一冰山 MG_LayeredDiagram（90–125s 连续 35s）被切成 3 个 scene → 入场动画重播 3 次；S014–S016、S017–S018 同理。

**跨代事故实证（完整引用链）**：Freud final_render_source artifact 的 source snapshot 记录 `scenesVersionId = v1 行 id / scenesVersion: 1`（scenes v1 生成 2026-07-28 05:11 UTC，render 入队同日 05:16 UTC）；scenes v2（repair）直到 2026-07-29 03:25 UTC 才产生并 lock（当前 locked_version=2）。即线上成片渲染于 repair 之前约 22 小时，使用的是未修复的 v1。whole-generation invariant（`final-render/bridge.ts:157-184`）只保证「单次 render 的四源自洽」，不阻止「render 后上游继续修复而不重渲染」——这是流程缺口而非 invariant 失效。

---

## FINDINGS REGISTER（关键发现登记）

| ID | severity | 发现 | 代码证据 (file:line) | DB 证据 | 复核/复现方法 | root cause | downstream impact |
|---|---|---|---|---|---|---|---|
| F-1 | Critical | narration 轨与视觉轨无结构绑定 | `reconciliation/compiler.ts:50-77`（仅整体比例缩放）；scene/narration schema 中无 unitId↔sceneId 字段 | 两项目 scenes 与 narration_plan 无任何交叉引用列 | grep `unitId`/`beatId` on `src/lib/scene-schema.ts`、`src/lib/reconciliation/schema.ts` → 无匹配 | 两轨独立设计，从未建立对齐键 | scene 切点不对齐旁白；视觉无法按叙事节拍分组；P0-4/P0-5 的总根因 |
| F-2 | Critical | 导演指令经 `emitSpeechRun` 进入 spoken content | `compiler.ts:257-282`（失配文本落入 speech）；`compiler.ts:79-82`（4 条封闭 regex）；`prompts/script-v2.ts:24`（契约鼓励内联指令） | Freud N015 等 13 个 speech unit 含指令/`---`；Proc 5 个 | 用真实 compiler 对 `（停顿0.5秒，放慢）`/`旁白无`/`画面：` 直跑（node），输出即为 speech text | 指令无类型、词表封闭、失配静默吞并、无 hard error | 污染 TTS/字幕/视觉规划/MG 文案四路 |
| F-3 | Critical | 四条端到端污染传播链 | `audio.ts:198`（TTS verbatim）；`subtitles/compiler.ts:174`（字幕 verbatim + text-conservation）；`ProductionSceneRenderer.tsx:97-111,163-165`（上屏） | 见 PRODUCTION ARTIFACT EVIDENCE 链 1–4 | 按链中 artifact ID/unitId/cue 序号在 DB 逐跳核对 | 全链路无 display/spoken 文本类型分离与内容校验 | 指令被朗读、上字幕、上画面 |
| F-4 | High | Freud 成片使用旧 scenes generation | `final-render/bridge.ts:157-184`（invariant 只管单次自洽） | final_render_source.scenesVersion=1 vs locked_version=2（时间差 22h） | 比对 final_render_source source snapshot 与 project_stages.locked_version | render 后上游可继续修复，无「成片版本 = 最新 locked」提示或门禁 | 线上视频不包含已完成的修复 |
| F-5 | High | MG templateProps null + 未注册模板 → 黑底 placeholder | `scene-schema.ts:71`（templateProps optional）；`ProductionSceneRenderer.tsx:30-37`（6 模板注册表）；M6.3.12 前 placeholder 不 hard-fail | Freud v1：10/10 MG scene props null；7/10 模板未注册 | 统计 scenes v1 JSON 中 category=MG 的 templateProps/template 字段 | schema 允许缺 props + LLM 发明模板名 + 历史 Gate 缺口 | 10 个 scene 纯黑底，计入 47% 黑卡 |
| F-6 | High | title card 合法 filler 路径 | `ProductionSceneRenderer.tsx:97-111`（Minimal 大字卡）；`visual-gate.ts:38-40`（Minimal 直接放行）；`visual-overrides.ts:237-263`（MG fallback 文案=narrationSummary clip） | Freud v1 Minimal+MG=24/51=47.1%；S047–S051 填充 scene | 按 category 统计 scenes v1；对照 render payload | category 合法 + 配额仅在 prompt + gate 不查信息量 | 观感=旁白+字幕+大量黑卡 |
| F-7 | Medium | 统一 cover + 哈希 Ken Burns 裁切 | `ProductionSceneRenderer.tsx:154`（objectFit cover 唯一点）、`:117-136`（kenBurnsTransform）；`scene-schema.ts:115-116`（width/height 存在但不消费） | assets 表 width/height 已落库（acquire.ts:67-79） | 检查 `ProductionAssetImage` props 不接收宽高；竖图素材渲染必然裁切 | 无 contentType/fitPolicy 概念，元数据不入渲染决策 | 竖图头部裁切、文档/图表内容丢失 |
| F-8 | Medium | MG 相邻 scene 重 mount 重播入场 | `FullCutV1.tsx:191-201`（1 scene=1 Sequence）；各 MG 模板动画以 Sequence 相对帧 0 起插值 | Freud v2 S011–S013 冰山同模板连续 35s 切 3 段 | 查 scenes 中相邻同 template MG scene 分组 | 无 sequence/continuity 抽象，渲染层 1:1 机械映射 | 视觉像网页组件反复刷新 |
| F-9 | Medium | 转场字段名存实亡 | `scene-schema.ts:80-81`（自由 string）；`FullCutV1.tsx:39,153-154`（写死 8 帧 crossfade，不消费字段） | shot_list/scenes 中 transition 为自由文本 | grep `transitionIn` 于 `src/remotion/**` → 仅结构拷贝 | 字段无枚举、渲染层不消费 | 转场设计意图完全不生效 |
| F-10 | Low | sanitizer 覆盖面与泄漏面不相交 | `narration/speech-text.ts:18-29`（只管 `---`/HTML 注释）；消费点仅 `compiler.ts:262-263`、`audio.ts:175` | M6.3.13 后 `---` 已堵，指令文本仍 speakable | 对 speech-text 输入指令变体，输出原样 | sanitizer 定位为 `---` 防线，非指令防线 | 兼容安全网有效但不应被视为终态 |

---

## ROOT CAUSES

1. **RC-1 指令无类型**（对应 F-2/F-3）：script_v2 契约（script-v2.ts:24）鼓励内联指令，compiler 词表封闭（compiler.ts:79-82，不认「秒」、复合指令、`放缓`、`旁白无`、`画面：`），失配静默吞并，无 hard error 路径。
2. **RC-2 文本字段一物三用**（F-3/F-10）：speech unit `text` 同时喂 TTS（audio.ts:198）、字幕（subtitles/compiler.ts:174，text-conservation 把脏文本锁死）、间接喂视觉（scenes prompt 注入原文）。sanitizer 仅 2 个消费点、只管 `---`/HTML 注释。
3. **RC-3 编辑意图无机器出口**（F-1）：beat_map/visual_breakdown 是纯 markdown，停顿/情绪/画面呼吸意图「写在纸上，系统看不见」；visual_breath unit 在时间轴上占 0ms 且永久 unresolved。
4. **RC-4 视觉轨无结构模型**（F-1/F-8）：scene 是扁平时间轴原子（S001…S00N 严格序列），无 beat/intent/sequence/shot/continuity；两轨只在 reconciliation 整体比例缩放，scene 切点与 narration 边界不对齐。
5. **RC-5 filler 是合法路径**（F-5/F-6）：Minimal category + prompt 级配额（「Minimal 停顿 ≥10%」）+ typography 兜底（narrationSummary 大字上屏）+ switch_to_mg 官方通道 + 配比约束零机器执行。gate 只查「有无视觉输入」，不查「视觉是否有信息量」。
6. **RC-6 渲染不读素材元数据**（F-7）：width/height 已探测入库（acquire.ts:67-79）且进 props（scene-schema.ts:115-116），renderer 不接收；统一 cover + 哈希 Ken Burns。
7. **RC-7 转场名存实亡**（F-9）：shot.transition/scene.transitionIn·Out 是自由 string 且渲染层完全不消费，统一 8 帧 crossfade。

---

## SCHEMA PROBLEMS

- `narration-plan@1.0`：单 `text` 字段；无 spokenText/subtitleText 分离、无 delivery/emotion、prosody 是死字段（appliedToTts 恒 false，`audio.ts:30-31`）；validator 不查 text 内容。
- `sceneSchema`（schema 1.0）：`narrationSummary`/`description`/`transitionIn·Out` 自由 string；`templateProps: z.record(z.unknown())` 不透明直通；无 unitId/beatId/intent/sequenceId/fitPolicy；MG propsSchema 只查 `min(1)`（`mg-templates.ts:102-120`）。
- beat_map/visual_breakdown：无 schema 可言。
- shot_list：purpose/transition 自由文本，无 narration/beat 引用。
- 版本机制缺口：shot_list/scenes JSON 内容内**无自身 schemaVersion 字段**（只有表列版本+prompt 版本）；scene_visual_overrides 无 schemaVersion 列；preview 的 render_source artifact 只记 {jobId, scenesVersion}，与 final 的 sourceKey 机制不对称。

---

## TYPED NARRATION MODEL

新契约 `narration-plan@2.0`（compilerVersion `2.0`），unit 结构：

```jsonc
{
  "id": "N015",
  "kind": "speech | pause | visual_beat",
  "spokenText": "真正庞大的部分，沉在黑暗海底的，是潜意识。",   // string | null；null = 旁白无
  "subtitleText": "真正庞大的部分，沉在黑暗海底的，是潜意识。", // string | null；可独立于 spokenText 省略
  "pauseBeforeMs": 500,
  "pauseAfterMs": null,
  "delivery": "slow",          // normal|slow|fast|soft|firm|emphasis
  "editorialNotes": "冰山比喻核心句",  // 永不进 TTS/字幕/画面
  "visualCue": { "intent": "SHOW_ARCHIVE", "ref": "Freud 肖像" }, // 结构化，非自由文本
  "evidenceIds": ["E01"],
  "sourceText": "（停顿 0.5s，放缓）真正庞大的部分…"  // trace only，永不消费
}
```

- **validator**（zod + superRefine）：speech 必须 spokenText 非空；spokenText/subtitleText 禁止匹配指令模式（typed origin + pattern/context 双重判断，见 Editorial Gate A）；kind=pause 禁止 spokenText；id 连续；chapter 引用完整。
- **compiler v2**：正式 directive grammar——复合指令（逗号分隔）、`秒`/`s` 双单位、命名指令（`旁白无` → spokenText=null；`画面：`/`停顿后旁白：` 前缀剥离归类）；**未识别的括号指令 = 编译硬错误**（fail-closed，列出原文与位置，禁止静默吞并）。
- **legacy parser**：compiler 1.x 路径保留只读，用于打开旧 artifact；旧 plan 不迁移，由 v2 recompile 取代（输入 script_v2 locked 原文仍在）。
- **fallback**：script_v2 中无法机器归类的指令段落 → unit 标记 `needsReview: true`，进人工 review 队列，review 前 narration_plan 不可置 current（fail-closed）。
- **version migration**：recompile 幂等键 = (projectId, scriptV2 locked_version, compilerVersion 2.0)；旧 artifact 全部保留。
- **TTS consumer**：只读 spokenText；delivery 映射为 TTS style/emotion 参数（`TtsRequest.style.directive` 字段已存在但从未接线，本次接通，prosody 不再是死字段）；pauseBefore/AfterMs 落 master 时间轴静音段。
- **subtitle consumer**：只读 subtitleText；text-conservation invariant 改为「基于 subtitleText 守恒」而非原文守恒。

---

## NARRATIVE BEAT MODEL

新结构化 artifact `narrative-beats@1.0`（取代 markdown beat_map 的机器职能）：

```jsonc
{
  "beatId": "B007",
  "chapter": 2,
  "role": "question",        // hook|question|context|claim|explanation|example|evidence|contrast|transition|summary|quote|pause
  "spokenUnitIds": ["N014","N015","N016"],  // 一个 beat 跨多个 speech units
  "durationIntentMs": 9000,  // 意图时长，最终由 TTS 实测校正
  "sequenceId": "Q003",      // 多个 beat 可共用一个 visual sequence
  "payoff": "引出潜意识冰山"   // 编辑备注，不上屏
}
```

- beat 边界由 LLM 提案 + deterministic 校验（unitIds 全覆盖、不重叠、顺序连续）。
- `role: pause` 的 beat 对应视觉呼吸窗口——从此「画面呼吸」是机器可读时间窗，不再是 markdown 散文。
- beat 是 narration 轨与视觉轨的**第一个正式连接点**：visual sequence 引用 beatId，beat 引用 unitIds，两轨对齐有了结构载体。

---

## VISUAL INTENT MODEL

每个 sequence/shot 必须声明 intent（enum，拒绝自由文本）：

| intent | 允许策略 | 真实性要求 | 素材需求 | MG eligibility | 可延续上一 shot |
|---|---|---|---|---|---|
| SHOW_PERSON | photo/portrait MG 不允许替代面部 | authentic_preferred | portrait 类素材 | 否 | 是 |
| SHOW_PLACE / SHOW_ARCHIVE | archive photo/footage | authentic_required | 档案素材 | 否 | 是 |
| SHOW_DOCUMENT / SHOW_EVIDENCE | document_frame 布局 | authentic_required | 文档/截图 | 否 | 是 |
| SHOW_EXAMPLE | 素材或示意 MG | synthetic_allowed | 可选 | 有限 | 是 |
| SHOW_PROCESS / SHOW_RELATIONSHIP / SHOW_COMPARISON / SHOW_DATA | MG 优先 | synthetic_allowed | 无 | **是（正当用途）** | 状态推进 |
| EMPHASIZE_TEXT | 受控 title card | — | 无 | 有限（仅有意强调） | 否 |
| CONTINUE_PREVIOUS_VISUAL / NO_VISUAL_CHANGE | 继承上一 shot 视觉体 | 继承 | 无 | 继承 | **定义即延续** |

- CONTINUE_PREVIOUS_VISUAL / NO_VISUAL_CHANGE 是一等状态：「这句旁白不换画面」是显式决策，不是缺失。
- **VISUAL_UNRESOLVED**：无视觉方案时的唯一合法状态，必须在 Storyboard 暴露并由人工或规划器解决；**禁止自动编译为 MG_READY**。
- 每个 sequence 无明确 intent = semantic validation hard fail（淘汰 generic fallback）。

---

## SEQUENCE / SHOT MODEL

五层概念正式分离：

```
Narration Unit (N001…)  ← 被引用
Narrative Beat (B001…)  ← 引用 units，归属 sequence
Visual Sequence (Q001…) ← 一个连续视觉体；跨 1..n beats；MG sequence 含 states[]
Shot (H001…)            ← sequence 内的时间切片；1..n 个；各自 intent/strategy/asset/fit/transition
Scene / Render Segment  ← 渲染层输出单元，由 sequence 编译产生，不再是编辑原子
```

MG sequence 示例（冰山 35s，单 sequence Q003，5 个 state）：

```
0–7s   state 1: 出现本我        ← entrance 只播一次
7–14s  state 2: 加入自我        ← props 插值过渡，不 remount
14–21s state 3: 加入超我
21–28s state 4: 连接关系
28–35s state 5: 突出冲突
```

- **continuity**：sequenceId 相同 = 同一视觉体；shot 间只允许状态推进，不允许重新入场。
- **transition**：枚举化（cut/crossfade/fade_black/hold/state_morph），渲染层必须真实消费（取代写死的 8 帧 crossfade）。
- **timeline**：shot 时间轴先由 beat durationIntent 推导，reconciliation 升级为「unit 边界对齐 + sequence 内按比例」，取代全片等比拉伸。
- **authoritative timing**：最终编辑时间线只承认一个权威时长源——TTS 实测 narration audio manifest（ffprobe 时长），sequence/shot/render 全部从其派生（与现状「ffprobe 时长=唯一真相」一致，`tts-executor.ts:62-84`）。
- **Remotion composition mapping**：**1 sequence = 1 个 `<Sequence>` 容器**；MG 组件动画基准从 Sequence 相对帧改为注入的 sequence 全局帧；entrance 仅在 sequence 首帧触发；shot 切换走 props 驱动（state_morph）或容器内淡入（asset 更换），组件不 unmount。asset shot 的 Ken Burns 同样以 sequence 帧为基准连续推进。

---

## MG CONTRACT

保留：production MG registry（6 模板 + zod propsSchema）、scene_visual_overrides 的「版本绑定 override、不改 artifact」模式、render-input visual gate。

重设计上层 eligibility：

- **允许**：relationship / process / timeline / comparison / hierarchy / data / concept model / intentional text emphasis。
- **禁止**：missing-asset fallback（switch_to_mg 通道重新定位为「人工显式重规划」，不再是 resolver 推荐动作）、generic filler、任意旁白摘句标题卡。
- **Title card 仅允许**：章节卡、重大转场、有意强调（EMPHASIZE_TEXT intent + 人工或规划器显式声明）。
- **MG sequence runtime**：一个 MG sequence 编译为单个 Remotion Sequence + states[]；state transition 由 props 插值驱动；entrance 一次；duration budget 由 beats 累计并由 reconciliation 校正。
- templateProps 文案源：从 narrationSummary（自由文本直通）改为 **displayText 字段**——由 typed narration 的 subtitleText/编辑摘要经统一 display-text 校验后产生，指令模式 hard fail。

---

## ASSET LAYOUT CONTRACT

`resolvedAsset` 扩展（元数据在 acquisition 时提取，ffprobe 已有 width/height 基础）：

```jsonc
{
  "width": 768, "height": 1024, "aspectRatio": 0.75,
  "contentType": "portrait",     // landscape_photo|portrait|document|chart|screenshot|illustration
  "fitPolicy": "portrait_frame", // cover|contain|portrait_frame|document_frame|split_layout
  "focalPoint": { "x": 0.5, "y": 0.3 },  // 可选，人工/检测设置
  "cropSafe": false              // Ken Burns 许可证据
}
```

- **默认规则**：landscape_photo → cover；portrait → contain/portrait_frame（带氛围背景填充）；document/chart/screenshot → contain。**禁止统一 cover**。
- **Ken Burns 仅在 cropSafe 可证明时允许**（cover 裁切区域不含 focal 内容；否则静态 contain + 轻微推近）。
- contentType 分类：启发式（宽高比 + 来源 provider + requirement.subject 关键词）初判，storyboard 展示，人工可 override。
- **manual override**：复用 scene_visual_overrides 模式，fitPolicy/focalPoint 进 override 表，版本绑定失效。
- **storyboard preview**：每个 shot 按 fitPolicy 渲染 keyframe 预览，裁切问题在渲染前可见。

---

## STORYBOARD

新 artifact `storyboard@1.0`（deterministic 编译自 sequences+shots+typed narration+asset bindings），Final Render 前的正式人工关卡。每 shot 展示：

- timestamp / duration / keyframe 缩略图（按 fitPolicy 实际布局渲染）
- spokenText / visual intent / visual strategy / asset source / fitPolicy / transition
- quality warnings（静态 >8s、MG 连续、素材复用、裁切风险、指令残留嫌疑、VISUAL_UNRESOLVED）

- **API**：`GET/POST /api/projects/[id]/storyboard`（build/读取）、`POST .../storyboard/approve`（lock）。
- **UI**：时间轴网格视图，warnings 分组置顶，VISUAL_UNRESOLVED 必须逐条解决或显式豁免。
- **version/lock**：幂等键 = (sequencesVersion, narrationPlanId, bindingsFingerprint)；approve 绑定 exact storyboard artifact id。
- **downstream invalidation**：shots/assets/narration 任一变化 → storyboard 自动 stale（lazy provenance 模式，沿用现有机制），approved 状态失效，禁止带 stale storyboard 进 Animatic。

---

## ANIMATIC

Storyboard approved 后生成低成本 Animatic：

- **render mode**：`renderMode: 'animatic'`——540p、10–15fps、低码率、完整 narration master 音频 + 真实 timing + 字幕 + 简化 motion（禁用 Ken Burns/复杂 MG 动画，保留 state 切换与转场骨架）。
- **artifact identity**：复用 final-render 的 immutable source/attempt + sourceKey/SHA 机制（`animatic_source` / `animatic_attempt`）。
- **approval state**：`animatic_approvals`（或 storyboard 表扩展）记录 approved artifact id；**Animatic PASS 是 Final Render 的硬前置**（enqueue 时校验，fail-closed）。
- **成本**：NVENC 540p 低帧率，单分钟成本预计 < final 的 1/10（**INFERENCE**：未经 benchmark，M7.7 验收时必须实测）；usage events 记 `kind=render, mode=animatic`。
- **invalidation**：任一上游 source 漂移 → approval 失效，需重新 animatic + approve。

---

## EDITORIAL QUALITY GATE

保留 Technical Integrity Gate（binding/file/props/duration/codec/SHA）不动。新增独立 Editorial Gate，在 Storyboard build、Animatic enqueue、Final enqueue 三点执行：

- **A. Directive leakage（HARD FAIL）**：spokenText/subtitleText/displayText 出现 `（停顿…）`、`旁白：`、`旁白无`、`画面：`、`放慢` 指令位、`悬念` 指令位、`---`、`<!-- -->` → fail。双重判断：typed origin（字段必须来自 compiler v2 的净化输出）+ pattern/context（「停顿」作为正常语义词汇出现在句中不误杀——只匹配指令语法位：括号包裹、行首前缀、独立 token）。
- **B. Title-card ratio**：title-only 时长占比 → 初设 warning >15%、review >25%（**INFERENCE**：阈值为占位初值，待 M7.9 pilot 用真实分布校准，见 D-1；当前不硬编码 fail）。
- **C. MG ratio**：MG 总时长占比、连续 MG 时长、同模板重复 mount 次数 → warning/review。
- **D. Static duration**：无变化镜头 >8s warning、>12s review。
- **E. Destructive crop**：portrait/document contentType + cover fit → fail（有 focalPoint+cropSafe 证明时降级 warning）。
- **F. Asset reuse**：同一 asset 跨不同语义 shot 复用 → warning（同 sequence 内复用合法）。
- **G. Visual intent coverage**：每个 sequence 必须有显式 intent；VISUAL_UNRESOLVED 未豁免 → hard fail。

---

## MIGRATION PLAN

目标：不重跑 Stage 1–6（research/evidence/argument tree/script V1/V2 全部保留为输入）。

1. **typed narration 重建**：compiler v2 从 script_v2 locked 原文 recompile（Freud: v2 locked、拖延： v3 locked）。无法归类的指令段 → needsReview 人工队列。
2. **TTS 增量重生**：spokenText 与旧 unit.text 逐字相同的 unit 复用旧音频（按文本 hash 匹配旧 manifest），仅文本变化的 unit 重新合成；master 重新拼接 + ffprobe 校准。Freud 79 speech units 中预计仅 13 条污染 unit 需重合成（**INFERENCE**：13 条为 DB 实测污染 unit 数，但 v2 compiler 的指令剥离可能改变更多 unit 的文本，实际重合成比例以 recompile 后 diff 为准）。
3. **beats/sequences/shots 重建**：新 LLM 阶段消费 typed narration（结构化，不再是 raw markdown）+ 旧 shot_list/scenes 作为参考输入；产出 narrative-beats → visual-sequences → shots 三个新 artifact（各带 schemaVersion + compiler 校验）。
4. **asset bindings 迁移**：requirementId 锚点从 sceneId 改为 shotId；迁移工具按 subject/query 快照深等匹配旧 binding（沿用 migrate-bindings.ts 的 bind_exact/bind_single/ambiguous_unbound 纪律，宁可 unbound 不猜测）。
5. **Stage 7–10 处置**：
   - beat_map（markdown）→ **废弃为契约**，职能由 narrative-beats@1.0 取代；
   - visual_breakdown（markdown）→ **废弃为契约**，配比约束进 semantic validation；
   - shot_list → **被 shots artifact 取代**（旧数据作参考输入保留）；
   - scenes → **被 sequences/shots 取代**；scene-schema 的 zod 契约族作为渲染传输层升级保留。
6. 旧 artifact 全部保留（append-only 纪律不变），新 artifact 走新 kind，无 destructive overwrite。

---

## M6 COMPONENTS DISPOSITION

逐项处置（全部经代码核实），分四类：

**A. reuse unchanged（原样复用，机制成熟）**：
- TTS 队列/executor/ffprobe 时长真相/原子写/cancel 语义（tts-jobs.ts、tts-executor.ts、runtime-audio.ts）——与文本内容解耦。
- Artifact integrity 全套：immutable source/attempt、sourceKey/propsSha256、whole-generation invariant、render_artifacts manifest、下载 fail-closed（final-render/*、render/artifact.ts）。
- Usage/cost accounting：llm_usage 快照计价、usage events 幂等、cgroup 归属（usage-events.ts、usage/*）。
- Loudness normalization 两通 loudnorm（render/loudness.ts、worker/index.ts:466-493）。
- NVENC 与 realtime render progress。
- project_versions 不可变模型 + active/locked 双指针、单事务原子操作、上游快照 + preflight/commit 双 fence、compilerVersion lazy provenance 失效。
- Candidate-first 生成候选 + 跨目标绑定拒绝（bind.ts）；Manual upload magic-bytes sniff（image-sniff.ts）。
- Asset resolver 核心：exact-binding READY 判定、authenticity 闸门、decideActions（resolver.ts）。

**B. reuse with adapter（复用机制，适配新锚点/新字段）**：
- Stable requirement binding：requirementId 身份规则 + asset_bindings replace 语义——锚点 sceneId→shotId 平移。
- MG registry：6 模板 + validateTemplateProps——增加 displayText 内容校验与 states 扩展。
- scene_visual_overrides：模式推广为通用 editorial override（fitPolicy/focalPoint/MG），加 schemaVersion 列。
- Render bridge：locked-only 读取、双校验链保留——输入从 scenes 换为 sequences/shots 编译产物。
- FullCutV1：外壳（音频轨/字幕轨/crossfade 插值）保留——FullVisualTrack 映射替换。
- Final visual gate：三点同口径执行保留——增加 Editorial Gate 检查项。
- reconciliation：帧分配基础设施保留——升级为 unit 边界对齐（timing-reconciliation@2.0）。
- Preview/Final fail-closed 区分：扩展出 animatic 第三档。

**C. rewrite（重写）**：
- narration compiler → compiler v2（directive grammar + typed units + hard-fail 未知指令）。
- subtitle compiler 文本源：unit.text → subtitleText（守恒对象变更）。
- scenes LLM 阶段 → beats/sequences/shots 三层编译（LLM 提案 + deterministic 校验分工保留）。
- FullVisualTrack 的 1 scene=1 Sequence 映射 → sequence 容器 + states。

**D. deprecate（废弃）**：
- script_v2 内联指令语法（`（停顿 Ns）`/`（放慢）`/`[画面留白]` 混排正文）——泄漏总根源（旧脚本由 legacy parser 兼容，契约形态见 D-4）。
- narration_beat_map / visual_breakdown 的纯 markdown artifact 形态（无 schema、无机器出口）。
- `narrationSummary` 作为上屏文本源（MG props/Minimal 卡/图片解说框三处）——由 displayText 契约取代。
- Minimal category 的 typography 兜底渲染（`ProductionMinimal` narrationSummary 大字卡）——title-card-as-filler 源头。
- shot→scene 靠 LLM 自觉对应的隐式映射；scene.transitionIn/Out 自由文本（渲染层从不消费）。
- preview `render_source` artifact 的无 schema 形态（与 final 不对称，统一为 sourceKey 机制）。
- `src/remotion/templates/` 12 个 M1 demo 模板 + Root.tsx 8 个 demo composition（隔离/移除出 production 路径）。
- `SCENE_ASSET_FILES` Freud 遗留映射（render-bridge.ts:83-85）与 PREVIEW_AUDIO 残留。

---

## IMPLEMENTATION PHASES

| 阶段 | inputs | outputs / artifacts | schema / compiler versions | migration | tests | release gate | rollback |
|---|---|---|---|---|---|---|---|
| **M7.1 Typed Narration** | script_v2 locked 原文 | narration_plan v2 artifact；needsReview 队列 | `narration-plan@2.0` / compiler `2.0`；tts payload `1.1` | 从 script_v2 recompile；TTS 按文本 hash 增量 | 指令语料库单测（含两项目全部真实指令样本）；未知指令 hard-fail 测试；语义「停顿」不误杀测试 | recompile 0 指令残留；增量 TTS ≤20% units；旧 plan 可读 | 旧 compiler 1.x artifact 保留，renderer 按 plan schemaVersion 分流 |
| **M7.2 Editorial Beat Compiler** | narration_plan v2 | narrative-beats artifact | `narrative-beats@1.0` | 新 artifact，无迁移 | unit 覆盖/不重叠/顺序连续校验测试 | 两项目 beats 全覆盖；role 枚举闭集校验通过 | artifact 独立 kind，删除即回退（不删库，仅不再 current） |
| **M7.3 Sequence/Shot Timeline** | beats + 旧 shot_list/scenes 参考 | visual-sequences、shots artifact；bindings 迁移 | `visual-sequences@1.0`、`shots@1.0`、`timing-reconciliation@2.0` | bindings 锚点 sceneId→shotId 迁移工具 | intent 覆盖 hard-fail；unit 边界对齐测试；迁移深等匹配测试 | 冰山类连续 MG 合并为单 sequence；scene 切点对齐 unit 边界 | 旧 bindings 历史行永留；迁移工具幂等可重跑 |
| **M7.4 Asset Layout** | shots + assets 元数据 | resolvedAsset 扩展；override 表加列 | resolvedAsset 扩展字段（向后兼容 optional） | 存量素材元数据回填脚本（contentType 启发式初判） | 竖图/文档/横图布局快照测试；cropSafe 判定测试 | portrait/document 不再 cover 裁切 | fitPolicy 缺省回退现状行为（cover），逐 shot 灰度 |
| **M7.5 MG Sequence Runtime** | sequences + MG registry | sequence 容器渲染；templateProps states 扩展 | templateProps +states；render props 扩展 | 旧 MG scene → sequence 编译 | 多 state 不重 mount 帧对比测试；最长 sequence benchmark | 35s 冰山单 mount，entrance 一次；性能不低于现状 | render 入口按 props schemaVersion 分流回 M6 映射 |
| **M7.6 Storyboard** | shots + bindings + typed narration | storyboard artifact + API + UI | `storyboard@1.0` | 无 | 编译正确性 + invalidation 测试 | 不渲染视频即可发现黑卡比例/裁切/复用/UNRESOLVED | 纯新增层，关闭入口即回退 |
| **M7.7 Animatic** | approved storyboard | animatic_source/attempt + approval | `animatic-source@1.0` | 无 | 低分辨率渲染冒烟；前置门禁测试；成本实测 | animatic 单分钟成本实测 < final 1/10；未 approve 不可 final | 门禁开关可回退为「建议而非强制」（仅限灰度期） |
| **M7.8 Editorial Gate** | 全链 artifact | gate 结果 artifact；三点执行 | gate ruleset 版本化 | 无 | 污染语料 100% fail + 正常语义 0 误杀；阈值 dry-run 统计 | A/E/G hard fail 生效；B/C/D/F warning 数据收集完成 | gate 分级可降级（hard→warning），配置化非代码 |
| **M7.9 Freud Pilot** | Freud 项目全链 | pilot 成片 + 对照报告 | 沿用以上 | 本报告 MIGRATION PLAN | 与 M6.3.13 成片 120 点抽样对照 | title card <15%；指令泄漏 0；MG 连续性人工审片通过 | 只读 pilot，不动 production 库；M6 链路始终可渲染 |

---

## RISKS（fail-closed 对策）

- **schema version explosion**：每阶段新 artifact kind。对策：沿用 compilerVersion lazy provenance（旧 artifact 自动非 current 但保留），禁止并行维护两套 current 判定。
- **old project compatibility**：compiler 1.x 保留只读；旧项目打开时走 legacy parser 展示，编辑即触发 v2 recompile（fail-closed：recompile 失败不覆盖旧 artifact）。
- **timing drift**：beat durationIntent 与 TTS 实测冲突。对策：TTS 实测为唯一真相，reconciliation 校正 sequence 内分配，偏差 >15% 进 storyboard warning（阈值 **INFERENCE**，待 pilot 校准）。
- **subtitle/TTS regeneration**：文本变化 unit 必须重合成。对策：文本 hash 增量复用；master 重拼后 ffprobe 全长校验。
- **visual asset rebinding**：shotId 锚点迁移产生孤儿 binding。对策：migrate 工具深等匹配 + ambiguous_unbound 宁缺毋猜 + resolver 暴露重绑入口。
- **user edits invalidation**：storyboard/animatic approve 后上游任何漂移 → approval 失效（fail-closed，禁止带 stale approval 渲染）。
- **LLM nondeterminism**：beats/sequences 提案不稳定。对策：LLM 只提案，deterministic 校验收口（覆盖/连续性/enum），repair 循环沿用现有 ≤2 次机制；artifact 落库即锁定。
- **sequence duration reconciliation**：多 beat 共享 sequence 的时长分配。对策：sequence 总时长 = 所含 beats 的 unit 实测总和，shot 在 sequence 内按 intent 权重分配，superRefine 重推导校验。
- **Remotion performance**：sequence 容器长时段 mount 大组件树。对策：M7.5 用 Freud 最长 sequence 做 benchmark；超长 sequence（>60s）允许显式切分（阈值 **INFERENCE**）。
- **migration rollback**：新链任何阶段失败。对策：旧链 artifact 全程保留，render 入口按 artifact kind 分流，可瞬时切回 M6 路径渲染。
- **partial project states**：项目处于新旧混合态。对策：project 级 pipelineVersion 字段（'m6'|'m7'），门禁按版本分流，禁止混用两链 artifact（whole-generation invariant 扩展）。

---

## OPEN DECISIONS — 决策表

> 每个决策含：精确问题 / 选项 / 推荐 / 推荐理由 / 不选后果 / 是否阻断 M7.1 / 最晚拍板 milestone / 默认 fallback / 可逆性 / 数据需求。

### D-1 Editorial Gate 阈值如何校准

- **问题**：title-card ratio、MG ratio、static duration 等阈值用什么数值、以什么依据定？
- **Option A**：凭经验硬编码（如 title card >25% hard fail）。**Option B**：M7.8 先全 warning 收集分布，M7.9 pilot 后用真实数据校准，再逐项决定是否升 hard fail。**Option C**：永远只做 warning，不做硬门禁。
- **推荐**：B。理由：当前只有单项目单视频的人工抽样（120 点），样本不足以定硬阈值；硬编码误伤正常片子会引发 gate 绕过压力。
- **不选后果**：选 A → 阈值无数据支撑，误杀/漏杀不可控；选 C → Editorial Gate 形同虚设，P0 问题可再现。
- **阻断 M7.1**：否。**最晚拍板**：M7.8 开始前必须决定「先 warning」的执行方式；M7.9 验收前必须定稿阈值。
- **默认 fallback**：全部 warning-only + 人工 review 队列。**可逆**：是（阈值配置化）。**数据需求**：M7.8 dry-run 对 Freud/拖延两项目统计分布；pilot 后人工审片对照。

### D-2 哪些检查项是 hard blocker，哪些是 warning

- **问题**：Editorial Gate A–G 的定级。
- **Option A**：A（指令泄漏）/E（破坏性裁切）/G（intent 覆盖）hard fail，B/C/D/F warning 起步。**Option B**：全部 hard fail。**Option C**：仅 A hard，其余 warning。
- **推荐**：A。理由：A/E/G 对应已被 production 实证的 P0（指令泄漏、裁切、filler），且判定客观可机器化；B/C/D/F 涉及美学判断，需要数据校准（依赖 D-1）。
- **不选后果**：选 B → 未经校准的阈值直接阻断渲染，pipeline 不可用；选 C → 裁切与 filler 两个 P0 继续漏。
- **阻断 M7.1**：否。**最晚拍板**：M7.8。**默认 fallback**：同推荐 A。**可逆**：是。**数据需求**：同 D-1。

### D-3 Pilot TTS 覆盖范围与成功标准

- **问题**：Freud pilot 重合成仅污染 unit（实测 13 条）还是全量重录？成功标准是什么？
- **Option A**：按文本 hash 增量，仅重合成文本变化 unit。**Option B**：全量重录。**Option C**：增量 + 污染集中章节全录。
- **推荐**：A。理由：79 条中约 13 条污染（**INFERENCE**：实际数以 recompile diff 为准），增量成本最低；但需接受新旧 unit 之间可能存在 TTS 声学微差。
- **不选后果**：选 B → 成本约 6 倍且全片声音微变，与旧成片不可比；选 C → 复杂度上升、收益不明确。
- **成功标准**：recompile 后 0 指令残留（机器校验）；增量 unit 与保留 unit 交界处人工抽听无明显音色跳变；master 时长与字幕重新对齐（ffprobe 校验）。
- **阻断 M7.1**：部分（增量机制是 M7.1 的 migration 组成部分）。**最晚拍板**：M7.9 启动前。**默认 fallback**：若抽听不通过 → 升级 Option B 全量重录。**可逆**：是（重录总是可行）。**数据需求**：recompile diff 清单；抽听记录。

### D-4 script_v2 新契约形态

- **问题**：导演指令与口播正文如何结构化分离？
- **Option A（inline markup）**：保留 markdown 正文，指令走独立行语法（如 `@pause 500ms`、`@delivery slow` 独占一行），compiler v2 按行解析，legacy 脚本由 v2 grammar 兼容。**Option B（parallel metadata）**：script_v2 正文纯净，指令放 sidecar JSON（按段落锚点引用）。**Option C（structured discriminated-union nodes）**：script_v2 直接产出 JSON AST（`{type:'speech'|'pause'|'direction', ...}` 节点数组），markdown 仅作展示导出。
- **推荐**：A 为 M7.1 落地形态，C 为终态方向。理由：A 保留人工可读/可编辑性、与现有 markdown 编辑 UI 兼容、迁移成本最低；B 的双源同步（锚点漂移）是已知的编辑痛点；C 最干净但要求重写 Stage 6 prompt + 编辑 UI，不适合作为 M7.1 前置。
- **不选后果**：选 B → 用户编辑正文后 sidecar 锚点失配，指令错位；选 C → M7.1 范围爆炸，阻塞后续所有阶段。
- **阻断 M7.1**：**是**（compiler v2 的输入契约必须先定）。**最晚拍板**：M7.1 启动前。**默认 fallback**：Option A。**可逆**：A→C 可逆（compiler 增加 AST 导出即可）；C→A 不可逆（信息已结构化，回退损失小但 UI 沉没成本大）。**数据需求**：用 Freud/拖延 script_v2 真实指令样本验证 grammar 覆盖率 100%。

### D-5 谁拥有 authoritative timing

- **问题**：Typed Narration / Beat / Visual Intent / Sequence / Shot 中谁是最终编辑时间线的唯一权威？
- **Option A**：TTS 实测 narration audio manifest（ffprobe 时长）为唯一真相，beat/sequence/shot 全部派生。**Option B**：beat 层（durationIntent）为权威，TTS 适配。**Option C**：sequence 层为权威。
- **推荐**：A。理由：现状已验证（`tts-executor.ts:62-84` ffprobe 时长=唯一真相，reconciliation target=master 帧数）；音频是物理现实，视觉是弹性适配；B/C 会让渲染时长与实际音频漂移。
- **不选后果**：选 B/C → 音画不同步风险，且推翻已验证的 reconciliation 基础设施。
- **阻断 M7.1**：否。**最晚拍板**：M7.3（reconciliation@2.0 设计前）。**默认 fallback**：Option A（即现状）。**可逆**：否（一旦下游按某权威编译，切换成本极高——因此必须先拍板）。**数据需求**：无，架构决策。

### D-6 历史 artifact 如何迁移且不重跑 Stage 1–6

- **问题**：Freud/拖延及未来旧项目如何进入 M7 链？
- **Option A**：逐项目 recompile——typed narration 从 script_v2 locked 重建，beats/sequences/shots 由新 LLM 阶段以旧 shot_list/scenes 为参考输入重建。**Option B**：旧项目冻结只读，仅新项目走 M7 链。**Option C**：project 级 pipelineVersion（'m6'|'m7'）分流 + 按需逐项目迁移。
- **推荐**：C + 迁移路径采用 A。理由：B 放弃存量项目（Freud 恰是最需要修复的）；纯 A 无分流机制则新旧混态无法门禁（见 partial project states 风险）。
- **不选后果**：选 B → production 已有的两片 editorial 失败品永远无法修复；无 C → 混合态项目可能混用两链 artifact，whole-generation invariant 被破坏。
- **阻断 M7.1**：部分（pipelineVersion 字段需在 M7.1 落 schema）。**最晚拍板**：M7.1。**默认 fallback**：Option C。**可逆**：是（旧链保留）。**数据需求**：无。

### D-7 旧 pipeline 生命周期（停写/只读/删除）

- **问题**：M6 链（scenes/shot_list/markdown beat_map）何时停止写入、何时只读、何时删除？
- **Option A**：M7.9 pilot 通过后停止新写入 → 保留只读 1 个 milestone 周期 → 评估删除 demo 残留与废弃代码路径（DB artifact 永不删）。**Option B**：永久只读不删。**Option C**：M7.1 起立即弃用。
- **推荐**：A。理由：DB artifact append-only 纪律不变（永不 DELETE）；代码路径在 pilot 验证前必须可回退（migration rollback 风险对策依赖它）；立即弃用（C）等于烧掉退路。
- **不选后果**：选 B → 双链代码永久并存，维护面翻倍；选 C → pilot 失败无退路。
- **阻断 M7.1**：否。**最晚拍板**：M7.9 验收时。**默认 fallback**：Option B（只读冻结总是安全的）。**可逆**：停写可逆（重开入口）；删除代码不可逆（但 git 历史保留）。**数据需求**：M7.9 验收报告。

---

## APPENDIX — MACHINE-CHECKABLE ARTIFACT DEPENDENCY GRAPH

> **PROPOSED — NOT IMPLEMENTED**：以下是 M7 拟议的 artifact 依赖图示例，用于 Review 校验依赖拓扑与 provenance 规则；不代表任何已实现或已部署的 schema。所有 ID/hash 为占位示例。
>
> 规则：(1) 每个下游 artifact 引用精确上游 artifact ID，禁止 "latest" 隐式解析（沿用现有 source snapshot 模式）；(2) 每个 artifact 标明 schema、compilerVersion、content hash、generation；(3) **authoritativeTimingSource 唯一**——最终编辑时间线只从 narrationAudioManifest（TTS 实测）派生。

```json
{
  "_status": "PROPOSED — NOT IMPLEMENTED",
  "projectId": "8fbe9cb6-ed5f-41e9-b748-b52e156ba314",
  "pipelineVersion": "m7",
  "authoritativeTimingSource": "narrationAudioManifest",
  "artifacts": {
    "scriptV2": {
      "artifactId": "pv_script_v2_v2",
      "kind": "project_versions",
      "stage": "script_v2",
      "generation": 2,
      "promptVersion": "script-v2@2.0",
      "contentHash": "sha256:EXAMPLE_scriptv2"
    },
    "typedNarration": {
      "artifactId": "art_narration_plan_v3",
      "kind": "narration_plan",
      "schema": "narration-plan@2.0",
      "compilerVersion": "2.0",
      "generation": 3,
      "contentHash": "sha256:EXAMPLE_typednarr",
      "source": { "scriptV2ArtifactId": "pv_script_v2_v2" }
    },
    "narrationAudioManifest": {
      "artifactId": "art_audio_manifest_v2",
      "kind": "narration_audio_manifest",
      "schema": "narration-audio@2.0",
      "generation": 2,
      "contentHash": "sha256:EXAMPLE_masterwav",
      "masterDurationMs": 610420,
      "source": { "typedNarrationArtifactId": "art_narration_plan_v3" }
    },
    "subtitleTiming": {
      "artifactId": "art_subtitle_timing_v2",
      "kind": "subtitle_timing",
      "schema": "subtitle-timing@2.0",
      "compilerVersion": "2.0",
      "generation": 2,
      "contentHash": "sha256:EXAMPLE_subs",
      "source": {
        "typedNarrationArtifactId": "art_narration_plan_v3",
        "narrationAudioManifestArtifactId": "art_audio_manifest_v2"
      }
    },
    "narrativeBeats": {
      "artifactId": "art_narrative_beats_v1",
      "kind": "narrative_beats",
      "schema": "narrative-beats@1.0",
      "compilerVersion": "1.0",
      "generation": 1,
      "contentHash": "sha256:EXAMPLE_beats",
      "source": { "typedNarrationArtifactId": "art_narration_plan_v3" }
    },
    "visualIntentPlan": {
      "artifactId": "art_visual_intent_v1",
      "kind": "visual_intent_plan",
      "schema": "visual-intent@1.0",
      "compilerVersion": "1.0",
      "generation": 1,
      "contentHash": "sha256:EXAMPLE_intent",
      "source": {
        "narrativeBeatArtifactId": "art_narrative_beats_v1",
        "typedNarrationArtifactId": "art_narration_plan_v3"
      }
    },
    "sequencePlan": {
      "artifactId": "art_sequence_plan_v1",
      "kind": "visual_sequences",
      "schema": "visual-sequences@1.0",
      "compilerVersion": "1.0",
      "generation": 1,
      "contentHash": "sha256:EXAMPLE_seq",
      "source": { "visualIntentArtifactId": "art_visual_intent_v1" }
    },
    "shotPlan": {
      "artifactId": "art_shot_plan_v1",
      "kind": "shots",
      "schema": "shots@1.0",
      "compilerVersion": "1.0",
      "generation": 1,
      "contentHash": "sha256:EXAMPLE_shots",
      "timingDerivedFrom": "art_audio_manifest_v2",
      "source": { "sequencePlanArtifactId": "art_sequence_plan_v1" }
    },
    "storyboard": {
      "artifactId": "art_storyboard_v1",
      "kind": "storyboard",
      "schema": "storyboard@1.0",
      "compilerVersion": "1.0",
      "generation": 1,
      "contentHash": "sha256:EXAMPLE_storyboard",
      "approved": true,
      "source": {
        "shotPlanArtifactId": "art_shot_plan_v1",
        "typedNarrationArtifactId": "art_narration_plan_v3",
        "bindingsFingerprint": "sha256:EXAMPLE_bindings"
      }
    },
    "animatic": {
      "artifactId": "art_animatic_source_v1",
      "kind": "animatic_source",
      "schema": "animatic-source@1.0",
      "compilerVersion": "1.0",
      "generation": 1,
      "contentHash": "sha256:EXAMPLE_animatic",
      "approvalState": "passed",
      "source": {
        "storyboardArtifactId": "art_storyboard_v1",
        "narrationAudioManifestArtifactId": "art_audio_manifest_v2",
        "subtitleTimingArtifactId": "art_subtitle_timing_v2"
      }
    },
    "editorialGate": {
      "artifactId": "art_editorial_gate_v1",
      "kind": "editorial_gate_result",
      "schema": "editorial-gate@1.0",
      "rulesetVersion": "1.0",
      "generation": 1,
      "contentHash": "sha256:EXAMPLE_gate",
      "verdict": "pass",
      "source": {
        "shotPlanArtifactId": "art_shot_plan_v1",
        "typedNarrationArtifactId": "art_narration_plan_v3",
        "storyboardArtifactId": "art_storyboard_v1"
      }
    },
    "finalRenderSource": {
      "artifactId": "art_final_render_source_v2",
      "kind": "final_render_source",
      "schema": "final-render-source@2.0",
      "compilerVersion": "2.0",
      "generation": 2,
      "contentHash": "sha256:EXAMPLE_finalsrc",
      "source": {
        "shotPlanArtifactId": "art_shot_plan_v1",
        "narrationAudioManifestArtifactId": "art_audio_manifest_v2",
        "subtitleTimingArtifactId": "art_subtitle_timing_v2",
        "animaticArtifactId": "art_animatic_source_v1",
        "editorialGateArtifactId": "art_editorial_gate_v1"
      }
    }
  }
}
```

---

## REVIEW DECISIONS — 2026-07-30

> M7.0 Review 冻结决策。本节内容优先级高于报告前文任何冲突表述。实施基线：`9bd1abc079f75c5ba4aa2c132bd17ecefaa7a1b7`，实施分支 `m7-typed-narration`。

### 1.1 Narration unit 使用真正的 discriminated union

废止前文的 `kind: "speech" | "pause" | "visual_beat"` + `spokenText: string | null` + `pauseBeforeMs/pauseAfterMs` 设计。冻结为：

```ts
type NarrationUnit = SpeechUnit | SilenceUnit;

interface SpeechUnit {
  id: string;
  kind: "speech";
  chapter: number;
  spokenText: string;        // 必须非空
  subtitleText: string | null;
  delivery: Delivery;
  evidenceIds: string[];
  sourceText: string;
}

interface SilenceUnit {
  id: string;
  kind: "silence";
  chapter: number;
  durationMs: number;        // 有限正整数，有上限
  reason: "pause" | "visual_breath";
  sourceText: string;
}
```

约束：speech.spokenText 必须非空；silence 不允许 spokenText/subtitleText/delivery；所有有时长停顿必须是显式 silence unit；禁止 pause unit 与 pauseBefore/pauseAfter 双重表示；「旁白无」无明确时长时必须 needsReview/hard stop；visual cue 只允许作为非权威 editorial hint，不得成为 Visual Intent 真相。

### 1.2 Beat 不得引用下游 Sequence

从 `narrative-beats@1.0` 删除 `sequenceId`。依赖方向固定：Narrative Beat → refs Narration Units；Visual Sequence → refs Beat IDs。禁止双向引用。

### 1.3 TTS 复用使用完整输入 fingerprint

禁止只按文本 hash 复用。冻结为：

```
ttsInputFingerprint = sha256(
  normalizedSpokenText + voiceIdentity + referenceAudioHash
  + ttsModelVersion + delivery + speed + synthesisParameters
  + normalizationVersion
)
```

只有 fingerprint 完全一致才允许复用旧 unit audio。

### 1.4 Timing authority 分层

固定为：`narrationAudioManifest` = authoritative temporal coordinate system；`timing-reconciliation@2.0` output = authoritative visual shot timeline。Beat/Intent/Sequence 只保存 intent/weight，不保存独立最终时间线。

### 1.5 Visual Intent 单一所有者

`visual_intent_plan` 是唯一 intent 权威。Sequence/Shot 只引用 `visualIntentId`，不得复制独立 intent 字段。

### 1.6 Approval 是独立 append-only record

Storyboard/Animatic artifact 内不得保存可变的 approved/pass 布尔状态。Final source 将来必须精确引用 approval record ID。

### 1.7 修正阶段验收指标

- 「增量 TTS ≤20%」降为 observation，不是 hard gate。
- 「title card <15%」降为 candidate target，不是未校准的硬阈值。
