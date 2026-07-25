# Zhiying IndexTTS2 API Adapter（M3-F）

知影 frozen `src/lib/tts/indextts2.ts` 与现有 Feiniu IndexTTS2 REST API
（`neosun/indextts2:v2.2-performance-optimized`，127.0.0.1:8002）之间的
**极薄 HTTP 翻译层**。

```
Zhiying Node Worker ──HTTP──▶ 本 Adapter ──HTTP──▶ IndexTTS2 API (8002, GPU)
```

- 无 torch / 无 CUDA / 不加载模型 / 不占 GPU（真实 GPU 只由 8002 进程使用）
- 不修改 frozen M3-B/M3-C/M3-D/M3-E 任何代码
- 控制面 only：health 探测、voice whitelist、speaker 注册/复用、错误映射

## 契约（与 frozen Provider 对齐）

- `GET /health` → `{ready, provider:'indextts2', model:'IndexTTS-2', fp16:null}`
  `ready` 需要 upstream `GET /speakers` 可达；`repoCommit` 省略（无法取得真实
  upstream Git commit，绝不伪造）。
- `POST /v1/synthesize` `{text, voiceProfile, voiceRevision, useRandom, emotion}`
  → `audio/wav` bytes。严格验证：text 非空、profile/revision 白名单、
  `useRandom===false`、`emotion==='none'`，否则 4xx。

## useRandom=false 的诚实语义

- adapter 不请求任何 emotion randomization（不传 emo_vector/emo_alpha/emotion text）。
- 现有 8002 API **不暴露** `use_random` flag；官方 IndexTTS2 `use_random` 默认 false
  （控制 emotion random sampling）。
- GPT acoustic generation 仍可能使用 sampling（top_p/top_k/temperature），
  **同输入不保证 byte-identical WAV**——这 不违反 useRandom=false，
  不是 implementation failure，也不是 release gate。

## Voice 映射（当前最小 whitelist）

| voiceProfile | voiceRevision | speakerName | reference |
|---|---|---|---|
| `default` | `1`（frozen DEFAULT_VOICE_PROFILE） | `zhiying-m3f-test` | `ADAPTER_REFERENCE_VOICE_PATH` |

speaker identity 以 reference file + speaker_name 为 source of truth
（不硬编码 `spk_xxx`）：请求时先 `GET /speakers` 查名，缺失才
`POST /upload_speaker`，per-voice 进程内 single-flight 防重复注册。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADAPTER_UPSTREAM_BASE_URL` | `http://127.0.0.1:18002` | 8002 可达地址（Mac 测试经 SSH tunnel） |
| `ADAPTER_UPSTREAM_TIMEOUT_SEC` | `90` | upstream 请求超时（实测单次 ~39s；Node 外层 120s 为最终边界） |
| `ADAPTER_HEALTH_TIMEOUT_SEC` | `10` | health 探测超时 |
| `ADAPTER_REFERENCE_VOICE_PATH` | 空 | speaker 缺失时 upload 用的 reference WAV（runtime，不入 Git） |

## 运行

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 9880
```

## 部署记录（非 repoCommit）

- upstreamApiVersion = 2.2.0（8002 swagger 自报）
- deploymentImage = neosun/indextts2:v2.2-performance-optimized

## 已知限制

- Cancel：Node 断连后 adapter 尽量终止 upstream 等待，但 8002 是否中断
  GPU 计算未承诺；frozen contract 只保证 job 不提交 WAV、不记 succeeded。
- 8002 当前监听 0.0.0.0：DEPLOYMENT_SECURITY_TODO，M4 Docker deployment 收口。
