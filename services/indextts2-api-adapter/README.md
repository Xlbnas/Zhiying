# Zhiying IndexTTS2 API Adapter（M4-B production）

知影 frozen `src/lib/tts/indextts2.ts` 与现有 Feiniu IndexTTS2 REST API
（`neosun/indextts2:v2.2-performance-optimized`，8002）之间的
**极薄 HTTP 翻译层**。

```
Zhiying Node Worker ──HTTP──▶ 本 Adapter ──HTTP──▶ IndexTTS2 API (8002, GPU)
```

- 无 torch / 无 CUDA / 不加载模型 / 不占 GPU（真实 GPU 只由 8002 进程使用）
- 不修改 frozen M3-B/M3-C/M3-D/M3-E 任何代码
- 控制面 only：health 探测、production voice registry、speaker 注册/复用、错误映射
- M4-B：voice 一律来自 **registry 文件**，无任何硬编码 fallback

## 契约（与 frozen Provider 对齐）

- `GET /health` → `{ready, provider:'indextts2', model:'IndexTTS-2'}`
  `ready` 需要 upstream `GET /speakers` 可达；`fp16` 与 `repoCommit` 字段**省略**
  （无法取得真实值，绝不返回 null 占位、绝不伪造）。
  `ready=false` 时附带 `detail` 错误码（见下「readiness 语义」）。
- `POST /v1/synthesize` `{text, voiceProfile, voiceRevision, useRandom, emotion}`
  → `audio/wav` bytes。严格验证：text 非空、profile/revision 白名单（registry）、
  `useRandom===false`、`emotion==='none'`，否则 4xx。

## Production Voice Registry（M4-B）

registry 是可版本控制的 JSON（**无音频内容**）， schema 见
`voice-registry.example.json`：

```json
{
  "schemaVersion": "1.0",
  "voices": [
    {
      "voiceProfile": "default",
      "voiceRevision": "1",
      "speakerName": "zhiying-default-1-<sha256前12位>",
      "referenceAssetPath": "/voices/default-v1.wav",
      "referenceSha256": "<64 位小写 hex>"
    }
  ]
}
```

严格验证（启动时加载；任何非法 → `ready=false`，进程不退出以便
Docker healthcheck 表达 unready）：

- `schemaVersion == "1.0"`；`voices` 非空数组
- `voiceProfile`/`voiceRevision`/`speakerName` 非空；`profile@revision` 组合唯一
- `referenceAssetPath` 必须绝对路径；realpath 后必须位于
  `ADAPTER_VOICE_ROOT` 之内（`../` 与 symlink 逃逸一律拒绝）
- `referenceSha256` 必须 64 位小写 hex

### hash 职责（M4-A frozen）

| 标识 | 职责 |
|---|---|
| **SHA-256** | Zhiying immutable reference identity = production source of truth |
| **MD5** | upstream speaker cache compatibility identifier（非密码学 SoT） |
| `speakerName` | readable deterministic label（不作内容证明） |
| `speaker_id` | runtime upstream cache handle（不进入 Zhiying contract） |

### Reference 文件校验（fail-closed）

每次 health / synthesize 前按 `mtime+size` 缓存失效重算：

- 文件缺失 → `REFERENCE_VOICE_MISSING`
- SHA-256 与 registry 不符 → `REFERENCE_SHA256_MISMATCH`
- 绝不静默接受新文件、绝不自动更新 registry hash

### Upstream speaker 解析（内容 identity）

1. `GET /speakers`，按 `speaker.md5 == md5(reference)` 查找（**绝不**按
   `speaker_name` 作为首要 identity）
2. 命中 → reuse 其 `speaker_id`（同名不同 MD5 不复用；同 MD5 不同名可
   reuse 并记录 provenance warning）
3. 未命中 → `POST /upload_speaker(reference, speakerName)`，校验响应
   `md5 == md5(reference)`，不符 → `502 UPSTREAM_CACHE_CONFLICT`
   （绝不覆盖/删除任何既有 speaker）
4. per-voice 进程内 single-flight 防重复注册

## readiness 语义（M4-B frozen）

`ready=true` 当且仅当：

- upstream `GET /speakers` 可达
- registry 加载/验证通过
- 每个 voice 的 reference 文件存在且 SHA-256 与 registry 一致

`ready=false` 时 `detail` 为机器可读错误码：

```
VOICE_REGISTRY_NOT_CONFIGURED / VOICE_REGISTRY_UNREADABLE /
VOICE_REGISTRY_INVALID / VOICE_REGISTRY_UNSUPPORTED_SCHEMA /
REFERENCE_VOICE_MISSING / REFERENCE_SHA256_MISMATCH / UPSTREAM_UNAVAILABLE
```

Docker HEALTHCHECK 必须断言 `ready == true`（HTTP 200 不够——上游故障时
adapter 故意 200 + ready:false），镜像内已实现 stdlib 版本。

## useRandom=false 的诚实语义

- adapter 不请求任何 emotion randomization（不传 emo_vector/emo_alpha/emotion text）。
- 现有 8002 API **不暴露** `use_random` flag；官方 IndexTTS2 `use_random` 默认 false
  （控制 emotion random sampling）。
- GPT acoustic generation 仍可能使用 sampling（top_p/top_k/temperature），
  **同输入不保证 byte-identical WAV**——这 不违反 useRandom=false，
  不是 implementation failure，也不是 release gate。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADAPTER_UPSTREAM_BASE_URL` | `http://127.0.0.1:18002` | 8002 可达地址（生产 = `http://indextts2:8002`） |
| `ADAPTER_UPSTREAM_TIMEOUT_SEC` | `90` | upstream 请求超时（实测单次 ~39s；Node 外层 120s 为最终边界） |
| `ADAPTER_HEALTH_TIMEOUT_SEC` | `10` | health 探测超时 |
| `ADAPTER_VOICE_REGISTRY_PATH` | 空 | production voice registry JSON（未配置 → ready=false） |
| `ADAPTER_VOICE_ROOT` | `/voices` | reference WAV containment 根目录 |

## 运行

开发（本地 venv）：

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
ADAPTER_VOICE_REGISTRY_PATH=/path/to/voice-registry.json \
ADAPTER_VOICE_ROOT=/path/to/voices \
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 9880
```

生产（Docker，见仓库根 `docker-compose.production.yml`）：

```bash
docker build -t zhiying-indextts2-adapter:latest services/indextts2-api-adapter
```

容器：python:3.12-slim、non-root（uid 1000）、read-only rootfs、无 GPU、
无 privileged、无 docker.sock、不发布宿主端口。

## 部署记录（非 repoCommit）

- upstreamApiVersion = 2.2.0（8002 swagger 自报）
- deploymentImage = neosun/indextts2:v2.2-performance-optimized

## 已知限制

- Cancel：Node 断连后 adapter 尽量终止 upstream 等待，但 8002 是否中断
  GPU 计算未承诺；frozen contract 只保证 job 不提交 WAV、不记 succeeded。
- 8002 当前监听 0.0.0.0：M4-C 迁移 indextts2 至 `zhiying-tts-net` bridge 后
  仅 `127.0.0.1:8002` + 内部网络可达（M4-A frozen，见 docs/M4_生产部署.md）。
