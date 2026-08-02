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
- exact reader：`getVoiceProfileRevisionExact(voiceProfileId, voiceProfileRevisionId)`，
  只按双 ID 精确读取；Profile/Revision 不存在、跨 Profile、schema 非法 → null；
  文件缺失 → null；文件 hash 漂移 → `unusable`（fail-closed）；archived Profile 的
  historical exact read 仍可读。**不提供** getLatestVoiceRevision 给业务调用；
  UI 显示建议一律命名 `suggestedLatestForDisplay`。
- 预留 `resolveVoiceRevisionForFutureTts(...)`（本轮不从现有 TTS enqueue 调用）。

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

摄取顺序（fail-closed，任何一步失败清理 staging 并返回错误）：

1. multipart 单文件 + `requestId` 必填；`file.size > MAX_REFERENCE_UPLOAD_BYTES` → 413
2. BEGIN IMMEDIATE 快速预检 requestId（same fingerprint → 200 reused；
   different → 409 REQUEST_ID_CONFLICT）——省掉重复 canonicalization
3. staging 写入（`O_CREAT|O_EXCL|O_NOFOLLOW`，0600）；original sha256
4. ffprobe original（必须有 audio stream、无 video stream）→ 否则 415/422；
   时长在 [MIN, MAX] 之外 → 422
5. ffmpeg → canonical staging（固定参数 `-ac 1 -ar 48000 -acodec pcm_s16le -vn`）
6. ffprobe canonical（codec/sr/channels/duration 复核）→ canonical sha256
7. fsync canonical 文件
8. BEGIN IMMEDIATE：复查 Profile active（archived → 409）；复查 requestId
   （并发兜底）；同 Profile canonical hash 重复 → 409 DUPLICATE_AUDIO；
   分配 revision_number；INSERT revision 行；
   然后**在同一事务提交前**把 staging canonical rename 到 final 路径
   （rename 失败 → 事务回滚，无 DB 行）；
9. commit；fsync 各 parent directory；写 metadata.json（best-effort，非权威；
   权威永远是 DB + reference.wav）

Crash model（显式承认 SQLite 事务不能回滚 filesystem rename）：

- rename 在 commit 之前执行 → **committed revision 行必然有对应 final 文件**
  （除文件被外部删除，此时 exact reader fail-closed 返回 null/unusable）。
- crash 窗口只会产生「final 文件存在但无 DB 行」的 orphan —— 永远不被视为 usable；
  orphan 只读审计、人工清理；自动清理逻辑**不删除**任何被 DB 引用的文件。
- API 无 pending 状态：只有 commit 成功才返回 201；不返回虚假 success。

## 5. 幂等与并发

幂等键：`voiceProfileId + requestId`（DB UNIQUE 强制）。

fingerprint（length-prefixed sha256，复用 `src/lib/tts/fingerprint.ts` 风格）：

- voiceProfileId / provider / originalAudioSha256 / transcript（NFC+空白折叠+trim 归一）
- language / canonicalization version / adapter compatibility key

行为：

- same requestId + same fingerprint → 200 reused（同 revisionId，不新增文件/行）
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
  `transcript`（可选）、`language`（可选，BCP-47-ish 1..35）
- 状态码：201 新建 / 200 reused / 409 conflict·duplicate·archived /
  413 过大 / 415 非音频 / 422 契约不合法 / 404 不存在

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
