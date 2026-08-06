# TTS-C.1B.2 Production Deployment Evidence

- deployment UTC time: `2026-08-06T12:21Z`（compose up -d --no-deps web/worker 完成）
- deployed target SHA: `6874f51c717ebab1c282ee29e9301f27627deaf7`
- previous production runtime: `01f8536b4bac1661aa86ad57f90985ec56c8aaa5`（TTS-C.1B.1/1C.1）
- 审计链：TTS-C.1B.2 initial Independent Review = FAIL `08be813…` → TTS-C.1B.2.R1 blocker-specific
  Review = PASS `bcfd29b…` → **Integrated exact-SHA Review = PASS** → production deployment gate
- backup path: `/vol1/1000/backups/zhiying/tts-c1b2-20260806T121853Z-01f8536b4bac1661aa86ad57f90985ec56c8aaa5`
  （27 文件，SHA256SUMS 25 项全 OK；DB online backup integrity=ok、FK empty）

## 部署策略（惰性 library/runtime 更新）

- 只替换 web/worker（应用代码镜像）；**adapter 不重建不重启**（container id / image id /
  startedAt 全部不变）；不修改 compose topology / registry mounts / Dockerfile / secrets / proxy。
- 唯一 env 变更：`ZHIYING_RELEASE_TAG` `01f8536b…` → `6874f51c…`（env 文件 before SHA
  `aa8f85cc…` → after `5a4e825b…`；`grep -v ZHIYING_RELEASE_TAG` 逐行 diff 与 backup 副本一致 =
  仅此一行变化）。
- production checkout：`git fetch github` → `git switch m7 && git reset --hard 6874f51…`
  （HEAD == TARGET，worktree clean）。

## Build（exact SHA；adapter 镜像未构建）

```
bash scripts/production-build-network.sh start   → RUNNING
docker build --network=host \
  --add-host remotion.media:127.0.0.1 \
  --build-arg APT_MIRROR=mirrors.aliyun.com \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t zhiying:6874f51c717ebab1c282ee29e9301f27627deaf7 -f Dockerfile .
BUILD_EXIT=0
new image: zhiying:6874f51…  image ID c215821a21bc  2.56GB
```
构建后 `production-build-network.sh stop` → STOPPED（tunnel 容器已清理）。Node image 无 Python
变更（Dockerfile 未改；`node:22-bookworm` 基础未动）。

## Up（仅替换 web/worker）

```
docker compose -f docker-compose.production.yml -f docker-compose.production.gpu.yml \
  --env-file .env.production up -d --no-deps zhiying-web zhiying-worker
UP_EXIT=0
```

| 容器 | 部署前 | 部署后 |
|---|---|---|
| zhiying-web | id `ad6a94b7b54d` / image `a5e20cfed36f` @01f8536 | id `df10f37d6f9f` / image `c215821a21bc` @6874f51；healthy |
| zhiying-worker | id `bb719195f48c` / image `a5e20cfed36f` | id `7be41e1db531` / image `c215821a21bc`；healthy |
| indextts2-adapter | id `bf6a70e3d25d` / image `4e8379d9ca31` @01f8536，started `2026-08-06T06:46:48Z` | **unchanged**（id/image/startedAt 相同；restartCount 不可读——此 docker 版本模板不支持，以 id/startedAt 不变证明未重启） |

restartCount 注：Feiniu 宿主 docker inspect 模板不支持 `.State.RestartCount`（1B.1 部署同况），
以 container id + StartedAt 不变/新建来证明未重启/无 crash-loop（web/worker 新 id + healthy，
adapter id 完全不变）。

## Smoke（production，只读 + 既有 voice）

- `GET /api/projects` → 200；`GET /` → 200 text/html
- adapter `GET /health` → 200 `{ready:true, provider:"indextts2", model:"IndexTTS-2", degraded:false}`（unchanged）
- adapter `GET /registry-status` → 200 `{ready:true, degraded:false, schemaVersion:"1.0",
  loadedRegistrySha256:"1dab4a313689736aad081b2b0367f9b036eeec0f9a751647192498ce9ee21827",
  loadedRegistryGeneration:null, publisherSchemaVersion:null, speakerCount:1, detail:null,
  lastReloadError:null}`（**与 preflight 逐字节一致**；adapter 未被 reload）
- `POST /api/projects/<id>/voice-materializations` → **503** `MATERIALIZATION_NOT_ENABLED`
  （POST remains disabled；web/worker env 无 `TTS_C1A_MATERIALIZATION_*`）
- synthesis smoke（既有 SOP 先例；`default@1` + 最小固定文本 `smoke`）→ 200 audio/wav PCM mono
  22050Hz 75342 B；不写 DB / 不创建 publication / 不创建 candidate / 不 reload registry
- 日志：web/worker 近 150 行扫描无 migration error / SQLite constraint / publisher 自动启动 /
  legacy import 自动启动 / candidate creation / reload 请求 / unhandled rejection；
  adapter 日志仅 GET /health 与 GET /registry-status（无 reload 活动）

## Zero-change evidence

**DB 逻辑快照（preflight vs post，权威比较 = 逻辑导出与表级 evidence，不比 DB 文件 SHA）**：

| 表 | count pre | count post | export dump（.mode insert）|
|---|---|---|---|
| voice_materialization_requests | 0 | 0 | byte-identical |
| voice_materialization_jobs | 0 | 0 | byte-identical |
| voice_materializations | 0 | 0 | byte-identical |
| legacy_adapter_voice_entries | 0 | 0 | byte-identical |
| voice_registry_publications | 0 | 0 | byte-identical |
| voice_registry_publication_activations | 0 | 0 | byte-identical |
| tts_jobs | 351 | 351 | byte-identical（hash `780b024f…`）|

preflight export hashes：`10f136bb…` / `ece729fc…` / `95e9a55f…` / `c2d90d38…` /
`cee106aa…` / `086bc0ba…`；tts_jobs `780b024f…`。integrity_check ok → ok；
foreign_key_check empty → empty。

**registry/reference（size/mtime/inode/SHA 全不变）**：
- `voice-registry.json`：322B / 2026-07-25 22:18:19 +0800 / inode 71982 / SHA
  `1dab4a313689736aad081b2b0367f9b036eeec0f9a751647192498ce9ee21827`
- `voices/default-v1.wav`：299052B / 2026-07-25 09:02:39 +0800 / inode 68221 / SHA
  `2d85800fe261d106c3274fa792cbb952458c4b0b2e1b908340a8cd0d63c73a30`
- adapter `loadedRegistrySha256` == registry 文件 SHA（unchanged）

**candidate root**：`<data>/voice-registries` preflight **ABSENT** → post **ABSENT**
（本轮部署前后均无 candidate-<generation>.json；无任何 candidate 文件创建）。

## Scope audit（本轮未执行）

```
legacy import not executed
publisher not executed
candidate creation not executed
POST /reload not called
activation not executed
active registry not modified
production business data not modified
TTS-C.1B.3 not started
TTS-C.1C.2 not started
TTS-C.2 not authorized
production POST remains disabled
```

## Evidence 边界

- **deployment gate 在 Feiniu production 执行**（现场命令，证据持久化到 backup dir）。
- **development tests 与 55-suite gate 在 agentvm 执行**：集成 exact-HEAD gate
  `QUALITY_GATE_RESULT=PASS`、`QUALITY_GATE_TOTAL_SUITES=55`、
  `QUALITY_GATE_SHA=6874f51c717ebab1c282ee29e9301f27627deaf7`（== deployed SHA）。
- **该 SHA 没有 GitHub-hosted CI run/status**——agentvm gate 不得写成 GitHub Actions
  independent CI evidence。
- production 证据 OPS-AUDIT-BRIDGE 不可用，非 independently verified（与历次部署同口径）。

## Rollback

未执行。失败条件均未触发；无需回滚。

## Final state

- deployed runtime = `6874f51c717ebab1c282ee29e9301f27627deaf7`
- production POST remains disabled
- adapter active registry unchanged；DB zero-change；candidate root absent
- **pending Deployment Evidence Review**
- TTS-C.1B.3 / 1C.2 not started；TTS-C.2 not authorized
