# Extreme Long Video — Archive Visual Usefulness Audit V1

Date: 2026-09-02

Project: `8f955b4c-42dd-4a02-8e76-e721a37fab41`

Input QC: V2.2.2

Verdict: **PASS_WITH_MINOR_NOTES**

## Scope and frozen boundaries

This audit checks whether the seven already-approved archive bindings communicate useful information after rendering. It does not reopen research, script, narration, TTS, audio, subtitle content/timing, 111 scene boundaries, visual thesis, visual families, sequence worlds, animation logic, archive rights/provenance classification, schema, or Remotion `4.0.492`.

The frozen narration master remains SHA-256 `658235d97a94f67feb9bc50d0849e7b15c2edf85f95b8db229b40b12a2460997`. Subtitle Timing V2 remains SHA-256 `dfab1dab6b1ef7707b9d6173b44455428ec6e59b74c81c528a6ed8a3ea29237b`.

## Scene decisions

| Scene | Timestamp | Narration claim | Asset | Binding class | Visual job | What the viewer can inspect | Why now | Weight | Disclosure | Mobile readability | Verdict | Required fix |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S015 | 01:51.4–01:58.5 | 《幽灵之战》的材料来自不同文化传统 | `20-kathlamet-texts.jpg` | `EXACT_EVIDENCE` | `EXACT_EVIDENCE` supporting provenance thumbnail | `Kathlamet 文本传统 → 故事材料 → 跨文化复述 → Bartlett 实验` 的来源链；缩略图只证明来源卷存在 | 旁白第一次交代故事材料的文化来源 | Editorial primary; image supporting | `来源卷 · 不是《幽灵之战》的故事原页` | Four-step chain and disclosure readable at 480×270; source-page text intentionally not claimed readable | `KEEP_WITH_ANNOTATION` | Completed: removed contentless cover from primary weight and replaced it with the source-chain editorial diagram |
| S022 | 03:02.4–03:13.3 | Loftus 与 Palmer 的 1974 实验只改变提问动词 | `03-elizabeth-loftus.jpg` | `EXACT_EVIDENCE` | `IDENTITY` | Elizabeth Loftus 的人物身份 | 命名研究者第一次出现 | Supporting identity image | `研究者肖像 · 非 1974 实验现场` | Face, title, and disclosure readable | `KEEP_WITH_ANNOTATION` | None |
| S067 | 09:46.0–10:01.3 | 闪光灯记忆是得知重大消息时的鲜明情境，不等于照片般准确 | `11-radio-listeners.jpg` | `CONTEXTUAL_ARCHIVE` | `CONTEXT` | 人们共同接收广播消息的时代环境 | 解释“在哪里、做什么、身边有谁”的接收情境 | Supporting context | `背景资料 · 非研究参与者或事件` | Subject and context label readable | `KEEP_WITH_ANNOTATION` | None |
| S078 | 11:19.1–11:32.4 | 司法辨认常只有一次起点，首次询问格外重要 | `05-lineup-room-a.jpg` | `CONTEXTUAL_ARCHIVE` | `CONTEXT` | 历史列队空间与一次性辨认程序环境 | 司法应用段第一次进入现场语境 | Supporting context | `背景资料 · 非引用研究或案件` | Room, subject, and scope label readable | `KEEP_WITH_ANNOTATION` | Completed: public attribution now reads `St. Louis Police Lantern Slides / DPLA · 无已知版权限制` |
| S079 | 11:32.4–11:40.7 | 早期记录提供外部基线，才可与后来版本比较 | Bound `06-lineup-room-b.jpg`, intentionally not rendered | `CONTEXTUAL_ARCHIVE` | Editorial relationship, no visible image | `同一起点 → 外部基线 / 后来版本` 的比较结构 | Immediately follows the one-time forensic setting and changes the task from context to comparison | Editorial primary | Not applicable; no archive image is shown | Relationship labels readable | `EDITORIAL_REPLACEMENT` | Completed: removed the second similar lineup image and restored the existing `VERSION_DIFF` composition |
| S098 | 14:32.2–14:42.4 | 想象低概率童年事件会抬高后来“发生过”的评分 | `07-indiana-family.jpg` | `CONTEXTUAL_ARCHIVE` | `CONTEXT` | 家庭故事/童年相册语境，以及真实材料与研究者加入虚构事件的区别 | 自传体记忆段进入想象膨胀机制 | Supporting context | `背景资料 · 非实验参与者或结果` | Main annotation and scope label readable | `KEEP_WITH_ANNOTATION` | Completed: added `真实家庭故事 → 研究者加入的虚构事件` |
| S106 | 15:47.1–16:02.2 | 高风险记忆应尽早记录，并寻找照片、文字、时间戳和独立证人 | `15-notebook-page-37.jpg` | `CONTEXTUAL_ARCHIVE` | `CONTENT_BEARING_DOCUMENT` supporting record | `尽早写下 / 保留时间戳 / 保护原始版本`；1880–1893 的书面记录具有时间范围 | 结论段把抽象怀疑转为可执行的外部校验 | Editorial primary; document supporting | `1880–1893 讲义笔记` and `非具体案件证据` | Record purpose and date range readable; full handwriting is not claimed readable | `KEEP_WITH_ANNOTATION` | Completed: made the evidence-chain labels primary and the notebook supporting |

## Rendered pixel gate

- Clean reel: `outputs/extreme-long-video/archive-usefulness-v1/archive-reel-clean.mp4`
- Burned reel: `outputs/extreme-long-video/archive-usefulness-v1/archive-reel-burned.mp4`
- Maximum-information frames: `outputs/extreme-long-video/archive-usefulness-v1/archive-max-information-contact-sheet.png`
- Mobile frames: `outputs/extreme-long-video/archive-usefulness-v1/archive-mobile-contact-sheet.png`
- Both reels: H.264, 1280×720, 30 fps, AAC stereo 48 kHz, `108.629 s`; full FFmpeg decode PASS.
- Clean SHA-256: `3f744327b0e73132ad298bb7dac41e72645695f077b6d205bef71675a3da79fd`
- Burned SHA-256: `b4e56b686a51298d1b99f3908f985cbcf457885846e2283ae7adf8a547c497b9`

Independent GPT-5.6 review watched the actual clean/burned MP4 and inspected the contact sheet. It did not claim subjective audio listening; narration continuity was established technically and the burned copy was used for subtitle/visual relationship checks.

| Gate | Result |
| --- | --- |
| P0 | 0 |
| P1 | 0 |
| P2 | 2 minor readability notes: S015 source-page text and S106 full handwriting are not readable at mobile size; neither is presented as primary readable content |
| Retained archive images | 6 |
| Editorial replacements | 1 (`S079`) |
| Decorative primary images | 0 |
| Contentless document surfaces used as primary | 0 |
| Misleading archive | 0 |
| Disclosure | PASS |

## Decision

The archive usefulness gate is **PASS_WITH_MINOR_NOTES**. S015 no longer uses a large contentless red cover as its main visual; S078 and S079 now have different jobs; S106 communicates why an early written record matters. No further local full-length QC render is authorized or needed. Proceed to the single remaining formal full render only after reading the exact production runtime identities and deploying the exact approved renderer SHA.
