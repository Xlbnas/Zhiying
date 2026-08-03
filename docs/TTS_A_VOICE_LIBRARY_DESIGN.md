# TTS-A Voice Library 实施记录（Immutable Custom Voice Library Foundation）

> 本文件记录 TTS-A 前置审计结论与最终设计决策。运行时真相以代码为准；
> 若与官方 IndexTTS2 文档冲突，以当前 production adapter 代码为准并在此记录差异。

## 1. 现有 adapter 参考音频契约（运行时真相）

Node 侧（`src/lib/tts/indextts2.ts`）→ adapter（`services/indextts2-api-adapter/server.py`）
`POST /v1/synthesize`：

- 请求字段：`text`（必填）、`voiceProfile`（必填）、`voiceRevision`（可选）、
  `useRandom`（仅接受 false）、`emotion`（仅接受 "none"）。
- **Node ↔ adapter 契约不传输参考音频字节**。参考音频来自 adapter 服务端
  registry 文件（`ADAPTER_VOICE_REGISTRY_PATH`）：`voiceProfile@voiceRevision`
  → `{ speakerName, referenceAssetPath, referenceSha256 }`。
- `referenceAssetPath` 是 adapter 容器内绝对路径（realpath 必须在
  `ADAPTER_VOICE_ROOT` 内）；上传 upstream 时硬编码 `content-type: audio/wav`。
- adapter 对 reference 只做存在性 + SHA-256 校验（fail-closed
  `REFERENCE_SHA256_MISMATCH`）；**不做 sample rate / channel / duration 校验，
  不重采样**。无 transcript / language 字段，不支持多 reference。
- timeout：Node 侧默认 120s；adapter→upstream 90s。错误码见 server.py `_err`。
- 与官方 IndexTTS2 的差异：官方 `infer(spk_audio_prompt=...)` 支持任意 wav；
  本 production adapter 把 voice identity 收敛为 registry + SHA-256（M4-B frozen），
  文档与 example 均只提 `.wav`——因此 TTS-A canonical 采用 WAV 单格式。

## 2. Canonical audio 格式（冻结）

adapter 无明确硬要求 → 采用保守 canonical WAV：

- 容器：RIFF/WAVE；codec `pcm_s16le`（signed 16-bit little-endian）
- 声道：mono（`-ac 1`）
- sample rate：**48000 Hz 固定**（依据：项目既有音频纪律
  `MASTER_SAMPLE_RATE=48000`（`src/lib/narration/audio.ts`）、Mock provider 48k、
  adapter/bridge 均输出/透传 wav 且对 sr 无约束；48k 与 downstream narration
  master 一致，避免后续重采样）
- 不带视频流；canonical 生成参数全部由服务端固定，上传内容不能影响 ffmpeg 参数
- `duration_ms` 一律取 **canonical 文件**的 ffprobe 实测，不信任输入容器声明
- canonicalization 版本常量：`VOICE_CANONICALIZATION_VERSION = 'voice-canonical@1.0'`
- adapter 兼容键：`ADAPTER_COMPATIBILITY_KEY = 'indextts2-adapter-registry@1'`
  （语义：可被 api-adapter 以 registry `voiceProfile@voiceRevision` + sha256 方式引用）

时长限制（adapter 无明确限制 → 临时保守范围，集中常量）：

- `MIN_REFERENCE_AUDIO_MS = 1000`
- `MAX_REFERENCE_AUDIO_MS = 60000`
- `MAX_REFERENCE_UPLOAD_BYTES = 25 * 1024 * 1024`（上传 body/file 上限）
- subprocess timeout：ffprobe 15s、ffmpeg 60s（集中常量，参数数组 spawn，无 shell）

规范化在 Web 进程（或任何持有 /app/data 的进程）内完成，**不使用 production GPU，
不申请 `production_gpu` lease**。

## 3. 身份模型

- `Voice Profile`：稳定库实体。`id` 服务端 UUID；`provider` 仅允许 `indextts2`；
  `display_name` trim 后 1..80；`description` ≤ 500；`status: active|archived`。
  archive 只影响可见性与是否可新增 revision；不代表任何项目已选择；无 global
  default；不自动选择 latest revision。
- `Voice Profile Revision`：immutable 参考音频版本。append-only；
  `UNIQUE(voice_profile_id, revision_number)`、`UNIQUE(voice_profile_id, request_id)`；
  SQLite trigger 对 UPDATE/DELETE 执行 ABORT（数据库层不可变）。
  `revision_number` 从 1 起在 BEGIN IMMEDIATE 内 `MAX+1` 分配。
- schema 常量：`VOICE_PROFILE_SCHEMA_VERSION = 'voice-profile@1.0'`、
  `VOICE_PROFILE_REVISION_SCHEMA_VERSION = 'voice-profile-revision@1.0'`。
- exact validator 单一真相源（TTS-A.R1）：
  `validateVoiceProfileRevisionExact(voiceProfileId, voiceProfileRevisionId)` 是唯一内部
  校验入口，返回内部 descriptor `{row, profile, canonicalAudioRelativePath,
  canonicalAudioAbsolutePath, fileSize, actualSha256, metadata, usable, unusableReason}`
  （绝不含宿主路径序列化到 API）。校验内容：Profile 存在/schema/provider=indextts2；
  Revision 双 ID exact match/schema/provider/adapter_compatibility_key 精确/metadata_json
  可解析且通过 strict `revisionMetadataSchema` 且与行一致/codec=pcm_s16le/
  sample_rate=48000/channels=1/duration 在冻结范围/hash 字段格式；canonical_audio_path
  必须精确等于 `voice-library/<profileId>/<revisionId>/reference.wav`、lexical resolve 不越界、
  root realpath、所有中间目录不通过 symlink 越界、final 非 symlink 且为 regular file；
  文件 SHA256 与 DB 完全一致。Profile/Revision 不存在、跨 Profile、schema 非法、路径
  不合法/文件缺失 → null（identity 级 fail-closed）；内容级契约失败 / hash 漂移 →
  `usable=false` + 具体原因。`getVoiceProfileRevisionExact`（API 视图）、
  `readRevisionAudio`、requestId reused 检查全部复用同一 validator。archived Profile 的
  historical exact read 仍可读。**不提供** getLatestVoiceRevision 给业务调用；
  UI 显示建议一律命名 `suggestedLatestForDisplay`。
- 预留 `resolveVoiceRevisionForFutureTts(...)`（返回内部 descriptor，本轮不从现有 TTS
  enqueue 调用）。

## 4. 文件布局与 file/DB atomicity

数据根：`{getDataDir()}/voice-library/`（production 容器 `/app/data/voice-library/`
= 宿主 `/vol1/1000/docker/zhiying/data/voice-library/`，已现场确认）。

```
voice-library/
  .staging/<random-uuid>/           # 服务端 mkdtemp，mode 0700
    original.bin  canonical.wav
  <voiceProfileId>/
    <voiceProfileRevisionId>/
      reference.wav                 # canonical，final 名固定
      metadata.json
```

客户端不得提供 path/directory/filename/命令/ffmpeg 参数/adapter URL；
`original_filename_display` 仅清洗后 display metadata。

摄取顺序（fail-closed，任何一步失败清理 staging 并返回错误）——TTS-A.R1 起，
**durability-critical 的 rename/fsync 全部在 SQLite commit 之前完成**：

1. multipart streaming 解析（TTS-A.R1，见 §4.1）：单文件 + `requestId` 必填；
   单文件 > 25MB → 413 file_too_large；总 body 超限 → 413 body_too_large；
   字段严格白名单
2. requestId 快速预检（BEGIN IMMEDIATE；同 fingerprint → 候选 reused，需 §5 exact
   校验通过才返回 200；异 fingerprint → 409 REQUEST_ID_CONFLICT）——省掉重复 canonicalization
3. staging 已由 streaming parser 写入（`O_CREAT|O_EXCL|O_NOFOLLOW`，0600）；original SHA256
   由流式计算；ffprobe original（必须有 audio stream、无 video stream）→ 否则 415/422；
   时长在 [MIN, MAX] 之外 → 422
4. ffmpeg → canonical staging（固定参数 `-ac 1 -ar 48000 -acodec pcm_s16le -vn`）
5. ffprobe canonical（codec/sr/channels/duration 复核）→ canonical sha256
6. BEGIN IMMEDIATE：复查 Profile active（archived → 409）；复查 requestId（并发兜底）；
   同 Profile canonical hash 重复 → 409 DUPLICATE_AUDIO；分配 revision_number；INSERT revision 行；
   然后**在同一事务、commit 之前**依次执行（全部成功才允许 commit）：
   a. 安全建立 `voice-library/<profileId>/` 与 `voice-library/<profileId>/<revisionId>/`
      （`ensureSafeDir`：已存在 symlink/非目录 → fail-closed；非递归 mkdir；
      realpath 必须位于 voice-library root 内）；
   b. final 路径不存在断言（拒绝覆盖既有文件）；
   c. rename staging canonical → final `reference.wav`；
   d. fsync final 文件；
   e. fsync revisionDir → fsync profileDir → fsync voice-library root → fsync staging 源目录；
   f. callback 正常返回 → better-sqlite3 提交事务。
   任一 rename/fsync 失败 → 事务回滚（无 revision 行）；rename 已生效时 final 只是 orphan。
7. commit 之后**不再执行**会把成功响应转成 500 的关键 fsync/rename；只写 best-effort
   metadata.json（非权威；权威永远是 DB + reference.wav；失败不影响结果）。

Crash model（TTS-A.R1 修正；显式承认 SQLite 事务不能回滚 filesystem rename）：

- durability-critical rename/fsync 全部在 SQLite commit 前完成；**不得**再写
  「committed 行必然有文件，因为 rename 在 commit 前」——正确表述是：committed 行对应的
  final 文件在 commit 前已经 rename 且 fsync 持久化。
- crash window 与允许状态（只允许以下三种）：
  - canonicalization 前 → 无 DB、无文件（仅 transient staging，可能被下次清理）；
  - staging 完成后 / rename 前 → 无 DB、无文件（staging 目录可能残留为 transient）；
  - rename 后 DB commit 前 → 无 DB、orphan 文件（final 存在但无 DB 行，永不视为 revision）；
  - DB commit 后 → DB + durable 文件（commit 前已 fsync，崩溃后文件仍在）。
  - 禁止：DB + missing/non-durable 文件（committed 行对应文件必须已 durable）。
- orphan 永远不被视为 usable；exact reader 只按 DB 行读取；自动清理逻辑**不删除**
  任何被 DB 引用的文件（staging 清理只触碰 `.staging/` 下 transient 文件）。
- API 无 pending 状态：只有 commit 成功才返回 201；不返回虚假 success。

## 4.1 multipart streaming contract（TTS-A.R1）

上传主路径为 bounded multipart streaming（`@fastify/busboy` 3.2.0，固定版本，
见 package.json；不把完整 body/音频读入内存）：

- 固定限制（集中常量）：
  - `MAX_REFERENCE_UPLOAD_BYTES = 25MB`（单文件 audio 上限；busboy fileSize limit 流式中断）
  - `MAX_REFERENCE_MULTIPART_BODY_BYTES = 30MB`（总 body 上限，略高于文件上限：
    Content-Length 预检 + 流式实测双保险）
  - `MAX_MULTIPART_FIELDS = 4`（字段白名单总数：requestId/audio/transcript/language）
  - `MAX_MULTIPART_FIELD_BYTES = 16KB`（单文本字段上限）
- Content-Length 存在且超过总限制 → **读取 body 前**返回 413 body_too_large；
- Content-Length 缺失（chunked）或伪造偏小 → 流式累计真实读取字节，超限立即中止
  （不消费剩余 body）→ 413 body_too_large；
- audio 恰好一个、流式写入安全 staging（O_EXCL|O_NOFOLLOW，0600）并同步计算 original
  SHA256；file 超 25MB → 413 file_too_large；
- 严格字段：仅 requestId（必填）、audio（必填 File）、transcript/language（可选）；
  拒绝：unknown field、多 audio、多 requestId/transcript/language、缺 audio/requestId、
  文件字段伪装成文本字段、文本字段伪装成文件、超限字段；违规 → 422 invalid_request；
  畸形 multipart / 客户端断连 → 400 invalid_formdata（无 DB 行、staging 安全清理）；
- MIME/扩展名只作 display，音频真实性由 ffprobe/ffmpeg 判定；
- 摄取核心接收：已安全写入的 staged input path + original SHA256 + 实测 byte length +
  cleaned display filename；Buffer 输入仅保留为测试 wrapper，走同一核心函数
  `ingestVoiceProfileRevisionFromStaged`（单一语义）。

## 5. 幂等与并发

幂等键：`voiceProfileId + requestId`（DB UNIQUE 强制）。

fingerprint（length-prefixed sha256，复用 `src/lib/tts/fingerprint.ts` 风格）：

- voiceProfileId / provider / originalAudioSha256 / transcript（NFC+空白折叠+trim 归一）
- language / canonicalization version / adapter compatibility key

行为：

- same requestId + same fingerprint → **候选 reused**：必须经
  `validateVoiceProfileRevisionExact` 确认 `usable=true` 才返回 200 reused
  （同 revisionId，不新增文件/行）；**损坏/不可用（文件缺失、hash 漂移、中间目录
  symlink、metadata_json 损坏/未知字段、provider/adapter/codec/sr/channels/duration
  契约不符）→ 409 `REVISION_UNUSABLE`（fail-closed，绝不返回 200）**
- same requestId + different fingerprint → 409 `REQUEST_ID_CONFLICT`
- 不同 requestId + 同 Profile 相同 canonical hash → 409 `DUPLICATE_AUDIO`
- 跨 Profile 相同音频允许（文件独立复制，不共享可变引用）
- 并发同 requestId：恰好一个 revision（UNIQUE 冲突者走 reused/409 分支）；
  revision_number 无重复（事务内 MAX+1）

## 6. API（沿用现有 jsonError/snake_case 风格；无认证机制，与现有一致）

- `GET/POST /api/voice-profiles`；`GET/PATCH /api/voice-profiles/[profileId]`
- `GET/POST /api/voice-profiles/[profileId]/revisions`
- `GET /api/voice-profiles/[profileId]/revisions/[revisionId]`
- `GET .../revisions/[revisionId]/audio`（DB exact lookup 后按存储路径读；
  固定 `Content-Type: audio/wav`；支持单 Range → 206；不暴露宿主路径；
  文件缺失/hash 异常 fail-closed 404/409；不返回目录列表）
- POST Profile `{displayName, description?}`（strict，未知字段 422）
- PATCH Profile 仅 `{status: 'active'|'archived'}`
- POST revision multipart：`requestId`（必填）、`audio`（必填）、
  `transcript`（可选）、`language`（可选，BCP-47-ish 1..35）——streaming contract 见 §4.1
- 状态码：201 新建 / 200 reused（仅 usable）/ 409 conflict·duplicate·archived·**revision_unusable** /
  413 文件过大（file_too_large）·body 超限（body_too_large）/ 415 非音频 / 422 契约不合法 /
  400 非法 multipart / 404 不存在

## 7. 与现有 tts_jobs 的兼容边界

- 不改写历史行、不重算 fingerprint、不改 dedupe/manifest/provider/adapter 请求。
- 现有 `default@1` env/registry voice 不自动导入新库。
- `tts_jobs.voice_profile_id/voice_profile_revision` 保持现有写入路径不变。
- 新表与 tts_jobs 无外键耦合（revision 未来被 TTS-B/C 以 `voiceProfileId +
  voiceProfileRevisionId` 精确引用）。
- `fingerprint.ts` 已预留 `referenceAudioHash` 字段（当前恒 'none'）——TTS-C 接
  exact revision 时填充 `canonicalAudioSha256`，本轮不动。

## 8. 明确不做

Voice Selection / Project Assignment、Narration Performance Plan、
pace/energy/emotion/delivery、批量/增量 TTS、narration master、subtitle timing、
timing-reconciliation@2.0、Freud pilot、Storyboard/Animatic/Final Render、
真实 IndexTTS2 调用、GPU lease。
adapter `/voices`（registry）集成：**留给 TTS-C**；本轮不接入 adapter registry、
不修改 compose voice mount、不把 revision 注册进 adapter 的 registry 文件。
