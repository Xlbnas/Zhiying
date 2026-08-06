# TTS-C.1B.1 + TTS-C.1C.1 Production Deployment Evidence

- deployment UTC time: `2026-08-06T06:50:01Z`（compose up 完成）
- reviewed/deployed SHA: `01f8536b4bac1661aa86ad57f90985ec56c8aaa5`
  - runtime code 内容来自本 commit（12 commits since previous runtime `37eaac6…`：adapter
    registry/status/reload contract + R1 reference 文件前置验证修复（1B.1）+ provider capability
    snapshot v1 + pure compiler（1C.1）+ tests + gate + docs；详见 `git log --no-patch`）
- previous runtime SHA: `37eaac6c8c8969239cab00848f6291454615a912`（TTS-C.1A.R7）
- backup path: `/vol1/1000/backups/zhiying/tts-c1b1-c1c1-20260806T063951Z-37eaac6c8c8969239cab00848f6291454615a912`
  （50 文件，SHA256SUMS 47 项全 OK）
- compose invocation（保持既有项目约定，不改 compose 文件、不改 Dockerfile、不改 env 文件）：
  ```
  docker compose \
    -f docker-compose.production.yml \
    -f docker-compose.production.gpu.yml \
    --env-file .env.production \
    up -d
  ```

## Build（exact-SHA，节点 image 不安装 Python）
- 基础 compose **零变更**（`git diff 37eaac6..01f8536 -- docker-compose.production.yml
  docker-compose.production.gpu.yml docker-compose.yml Dockerfile` 空输出；root Dockerfile
  仍为 `node:22-bookworm` 仅 web/worker，adapter Dockerfile 仍为 `python:3.12-slim` 仅 adapter；
  web/worker image 内零 Python 安装）。
- `ZHIYING_RELEASE_TAG` 在 `.env.production` 写入 `01f8536b4bac1661aa86ad57f90985ec56c8aaa5`。
- `zhiying:01f8536…` image ID `a5e20cfed36f`（2.56GB），BUILD_EXIT=0，多层 CACHED，仅末层 COPY 新代码后写镜像。
- `zhiying-indextts2-adapter:01f8536…` image ID `4e8379d9ca31`（135MB），BUILD_EXIT=0；
  Python 依赖与 `37eaac6…` 一致（fastapi 0.115.6 + uvicorn 0.32.1 + pydantic 2.13.4，仅 server.py
  内容更新）。
- 构建网络：`scripts/production-build-network.sh start/check` → RUNNING（build 前），
  `docker build --network=host --add-host remotion.media:127.0.0.1 --build-arg
  APT_MIRROR=mirrors.aliyun.com --build-arg NPM_REGISTRY=https://registry.npmmirror.com` 完成；
  build 后 `stop` → STOPPED（已清理 tunnel-remotion-build 容器；7890 host proxy 保留）。
- 容器内 gate 不在 production 跑（per project rule：production 只做 build/up/health/smoke，
  完整 M7 gate 在 agentvm 跑）。

## Deployment
- production checkout：`git switch m7 && git reset --hard 01f8536…`（worktree clean，
  `git status --porcelain` 空）。
- `git rev-parse github/m7 == 01f8536b4bac1661aa86ad57f90985ec56c8aaa5`（fetch 后）✓。
- 三容器 image/tag：
  - `zhiying-web` / `zhiying-worker` = `zhiying:01f8536…`（image ID `a5e20cfed36f`）
  - `indextts2-adapter` = `zhiying-indextts2-adapter:01f8536…`（image ID `4e8379d9ca31`）
- `up -d` 退出码 0；三容器 health 全部 healthy（web/worker/adapter），restartCount 全部 0。
- worker `depends_on: adapter condition: service_healthy` 解析通过，启动序列正常。
- 日志：三容器均无 error/exception/migration/recovery/heartbeat/lease/materialization 异常；
  adapter 启动后首次 `GET /health` 200 即视为 ready（无 reload 活动）。

## Smoke（production，只读）
- `GET http://127.0.0.1:3210/` → **200** text/html
- `GET http://127.0.0.1:3210/api/projects` → **200** JSON（3 个项目）
- `GET http://127.0.0.1:9880/health` → **200** `{ready:true, provider:indextts2, model:IndexTTS-2,
  degraded:false}`（1B.1 在 `/health` 上加 `degraded` 字段以兼容 LKG degraded；本部署
  loaded registry 完整正确 → degraded=false）
- `GET http://127.0.0.1:9880/registry-status` → **200**
  `{ready:true, degraded:false, schemaVersion:"1.0", loadedRegistrySha256:"1dab4a313689736aad081b2b0367f9b036eeec0f9a751647192498ce9ee21827", loadedRegistryGeneration:null, publisherSchemaVersion:null, speakerCount:1, detail:null, lastReloadError:null}`
  - adapter 启动后 cold-load 完整加载既有 production `voice-registry.json`（legacy 1.0 schema）；`generation` / `publisherSchemaVersion` 为 null（1.0 内部表示，1B.1 双 schema 兼容）；`loadedRegistrySha256` 是文件原始 bytes 的单一 SHA-256，与生产 registry 文件 SHA-256 **逐字节一致**。
  - `lastReloadError:null`、`degraded:false`、`detail:null` ⇒ 加载零错误零降级。
  - `POST /reload` **未调用**；registry 文件未修改、未替换、未新增。
- 既有 synthesis smoke：`POST http://127.0.0.1:9880/v1/synthesize {text:"smoke",
  voiceProfile:"default", voiceRevision:"1", useRandom:false, emotion:"none"}` → **200** `audio/wav`
  PCM mono 22050Hz **59470 B**；沿用既有 production voice（`/voices/default-v1.wav`），text
  最短固定，仅验证合成链路未变、adapter 未阻拒；未触发任何 IndexTTS2 重写、未改 registry。
- `POST /api/projects/<id>/voice-materializations` → **503** `MATERIALIZATION_NOT_ENABLED`
  （POST gate 仍 disabled）
- `GET /api/projects/<id>/voice-materializations` → **200** `{"requests":[],"adapterReady":false}`
  （GET 不受影响；`adapterReady:false` 为 1A placeholder 尚未被 1B 改变 shape）

## Reference validation（每个 voice 单独 verify）
- production registry `default-v1`：
  - path `/voices/default-v1.wav` ⊂ `/voices` containment root：contained=true
  - 文件类型：RIFF WAVE PCM 16-bit mono 24000Hz
  - 普通文件：`test -f voices/default-v1.wav` OK；`test -r` OK
  - 实际 SHA-256：`2d85800fe261d106c3274fa792cbb952458c4b0b2e1b908340a8cd0d63c73a30`
  - registry `referenceSha256`：`2d85800fe261d106c3274fa792cbb952458c4b0b2e1b908340a8cd0d63c73a30`
  - **`actual == expected`** ⇒ 1B.1.R1 reference 文件验证前置通过
  - 文件**未修改**：mtime 不变、size 不变、inode 不变
- adapter `/registry-status.loadedRegistrySha256` == production registry 文件原始 bytes SHA-256 (`1dab4a31…`)
  ⇒ adapter cold-start 完整识别既有 registry。

## DB / invariants（before / after zero-change）

| 项 | before (37eaac6) | after (01f8536) | 备注 |
|---|---|---|---|
| integrity_check | ok | ok | 全程一致 |
| foreign_key_check | empty | empty | 全程一致 |
| tts_jobs 行数 / INSERT dump hash | 351 / `780b024f…` | 351 / `780b024f…` | INSERT dump 字节相同 |
| voice_materialization_requests | 0 | 0 | 未触发 POST |
| voice_materialization_jobs | 0 | 0 | |
| voice_materializations | 0 | 0 | |
| legacy_adapter_voice_entries | 0 | 0 | 1B.2 import not started |
| voice_registry_publications | 0 | 0 | 1B publisher not started |
| voice_registry_publication_activations | 0 | 0 | 1B activation not started |
| voice_profiles / revisions | 0 / 0 | 0 / 0 | TTS-A 未触动 |
| resource_group_leases | 0 | 0 | 无活跃租约 |
| 其他 29 表 | 与 baseline 一致 | 与 baseline 一致 | per-table CSV byte-compare all pass |
| materialization root files / symlinks | 0 / 0 | 0 / 0 | |
| POST gate | not-set (disabled) | not-set (**disabled**) | 503 实证 |
| migration / schema | 无变化 | 无变化 | §2 SQL SHA `c88f64ac…` 不变（1B/1C 零 schema 迁移） |

## 边界（per task contract）
- ✅ production POST remains disabled（`TTS_C1A_MATERIALIZATION_POST_ENABLED` 未设置；
   POST 503 `MATERIALIZATION_NOT_ENABLED`）
- ✅ production `POST /reload` was not called（adapter 未触发 reload；cold-load 1.0
   registry 直接成功）
- ✅ production registry was not modified（`voice-registry.json`/`voices/default-v1.wav`
   mtime/size/inode 不变；file SHA-256 不变）
- ✅ reference voice file 未修改（实际 SHA-256 == registry reference）
- ✅ migration / schema / trigger 未变化（frozen §2 SQL SHA 不变）
- ✅ production DB 数据未变化（per-table CSV byte-compare zero diff；tables/triggers/index counts 不变）
- ✅ publication / activation / legacy 表保持 0 行
- ✅ TTS-C.1B.2 / 1B.3 not started
- ✅ TTS-C.1C.2 not started
- ✅ TTS-C.2 not authorized
- ✅ compose / Dockerfile / production env 文件未修改（git diff 旧 → 新空；
  唯一改 env：`ZHIYING_RELEASE_TAG` 由 `37eaac6…` → `01f8536…`）
- ✅ Node web/worker image 未安装 Python（基础镜像 `node:22-bookworm`，未改 Dockerfile）
- ✅ 完整 M7 gate 未在 production Node image 内运行（已在 agentvm 完成）

## Final state
- **TTS-C.1B.1 = FROZEN**（Independent Review PASS + R1 blocker-specific Review PASS +
  Integrated exact-SHA Review PASS；production 部署验证 PASS；Deployment Evidence Review PASS）
- **TTS-C.1C.1 = FROZEN**（Independent Review PASS + Integrated exact-SHA Review PASS；
  production 部署验证 PASS；Deployment Evidence Review PASS）
- production runtime = `01f8536b4bac1661aa86ad57f90985ec56c8aaa5`
- POST remains disabled；registry unchanged；DB zero-change
- Deployment Evidence Review **PASS**
- TTS-C.1B.2 / 1B.3 not started
- TTS-C.1C.2 not started
- TTS-C.2 not authorized

## 证据口径（Evidence boundary）
- branch-specific suites 与 integrated full gate 由 agentvm 本地执行；Integrated exact-SHA
  Review 已核对两个 reviewed 分支（`work/tts-c1b1-adapter-contract`、
  `work/tts-c1c1-capability-compiler`）的核心 blob identity、集成范围、gate 接线及本地
  54/54 执行报告。
- exact runtime SHA `01f8536b4bac1661aa86ad57f90985ec56c8aaa5` 未产生新的 GitHub Actions
  workflow run 或 commit status，因此上述 gate 证据**不得**表述为 GitHub-hosted
  independent CI evidence。
- production evidence 由 Agent 现场命令采集并持久化到
  `/vol1/1000/backups/zhiying/tts-c1b1-c1c1-20260806T063951Z-37eaac6c8c8969239cab00848f6291454615a912`。
  OPS-AUDIT-BRIDGE 不可用，production 状态**不是** independently verified。
- 与之前 1A.R7 部署相同口径：production 状态不是 independently verified（无
  OPS-AUDIT-BRIDGE）。

## Deployment Evidence Review closure

- Initial Review: FAIL — evidence provenance wording only.
- R1 docs SHA:
  `b5b97805a90d1a80b4f42e597fd1ba76aa4480de`
- R1 blocker-specific Review: PASS.
- Production runtime was not accessed, rolled back, rebuilt, or redeployed during R1.
- Final production runtime remains:
  `01f8536b4bac1661aa86ad57f90985ec56c8aaa5`
- Production POST remains disabled.
