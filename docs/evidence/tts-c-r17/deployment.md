# TTS-C.1A.R7 Production Deployment Evidence

- deployment UTC time: `2026-08-06T01:16Z`（compose up 完成）
- reviewed/deployed SHA: `37eaac6c8c8969239cab00848f6291454615a912`
  - runtime code 内容来自 `17d40787ce70c025d7daa012c04a76bc69c10a2b`（R7 runtime）
  - `37eaac6…` 仅额外包含 complexity-policy docs（AGENTS.md + 2 docs）
- previous runtime SHA: `a40085336bdada2f15d792d873ccecdaa08ffee5`（R3）
- backup path: `/vol1/1000/backups/zhiying/tts-c1a-r7-20260805T142306Z`（SHA256SUMS 42 项全 OK）

## Build
- `zhiying:37eaac6…` image ID `dd37ee1b7e56`（2.56GB），image code SHA（key file sha256）与宿主 checkout 一致
- `zhiying-indextts2-adapter:37eaac6…` image ID `0ad9789bb9bb`（135MB）
- build 网络：基础镜像 `node:22-bookworm` 经宿主机代理（127.0.0.1:7890）手动拉取并校验 8 层 digest 后 `docker load`；remotion.media CONNECT tunnel 用于构建内下载；构建后 tunnel 已清理（STOPPED）
- 镜像内普通 gate（不跑 mutation gate）：`QUALITY_GATE_RESULT=PASS`，`QUALITY_GATE_TOTAL_SUITES=52`
  （scripts/docs/compose 只读挂载来源同为 `37eaac6…`）

## Deployment
- `ZHIYING_RELEASE_TAG=37eaac6c8c8969239cab00848f6291454615a912`
- `docker compose --env-file .env.production -f docker-compose.production.yml -f docker-compose.production.gpu.yml up -d`
- 三容器 image/tag：`zhiying-web`、`zhiying-worker` = `zhiying:37eaac6…`；`indextts2-adapter` = `zhiying-indextts2-adapter:37eaac6…`
- 三容器 health：healthy（web/worker/adapter）
- 日志：三容器均无 error/exception/migration/recovery/heartbeat/lease/materialization 异常；adapter 无 reload/registry 活动

## Smoke（production）
- `GET /` → 200
- `GET /api/projects` → 200
- `POST /api/projects/<id>/voice-materializations` → **503** `MATERIALIZATION_NOT_ENABLED`
- `GET /api/projects/<id>/voice-materializations` → 200 `{"requests":[],"adapterReady":false}`
- 未创建任何 materialization；未调用 IndexTTS2

## DB / invariants（before/after）
| 项 | before | after |
|---|---|---|
| integrity_check | ok | ok |
| foreign_key_check | empty | empty |
| tts_jobs | 351 / hash 56a4baf0… | 351 / hash 56a4baf0… |
| 六张 TTS-C.1A 表 | 全 0 | 全 0 |
| projects | 3 | 3 |
| voice_profiles / revisions | 0 / 0 | 0 / 0 |
| materialization root files / symlinks | 0 / 0 | 0 / 0 |
| POST gate | disabled | **disabled（未设置）** |
| migration/schema | 无变化 | 无变化（§2 SQL SHA c88f64ac… 不变） |

## Final state
- TTS-C.1A.R7 deployed；production runtime = `37eaac6c8c8969239cab00848f6291454615a912`
- POST remains disabled（`TTS_C1A_MATERIALIZATION_POST_ENABLED` 未设置）
- TTS-C.1A：pending deployment-evidence Review；not yet declared FROZEN
- TTS-C.1B / 1C / C.2 not started
