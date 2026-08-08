# TTS-C.2 Phase 1 + TTS-C.1C.2 Production Deployment Evidence

Date: 2026-08-08（UTC）

## Verdict

```text
TTS-C.2 Phase 1 + TTS-C.1C.2
R2 Final Blocker-Specific Review = PASS（P0=0，P1=0；ALL IDENTIFIED PHASE-1 BLOCKERS CLOSED）
FAST-FORWARD INTEGRATED TO m7 = PASS
PRODUCTION DEPLOYMENT = PASS

PENDING DEPLOYMENT EVIDENCE REVIEW
NOT FROZEN
```

## Exact Identity

```text
previous production runtime:  cd367f6c3b24b3fe3a3b450e188be7c2cd0eb8d3
reviewed / integrated / deployed runtime: 8e92ba58a28900509e542394858200b1731d7afd
origin/m7 before integration: 8094885ebc2d81a2bdb57b7fb816bfa2bb683852
origin/m7 after integration:  8e92ba58a28900509e542394858200b1731d7afd
host checkout during build:   8e92ba58a28900509e542394858200b1731d7afd（detached，tracked clean）
release tag:                  8e92ba58a28900509e542394858200b1731d7afd
```

## Integration（fast-forward）

```text
merge-base origin/m7 origin/work/tts-c2-phase1 = 8094885ebc2d81a2bdb57b7fb816bfa2bb683852
ahead/behind: origin/m7..origin/work/tts-c2-phase1 = 0 10（ahead=10，behind=0）
ff-only merge: 8094885..8e92ba5（Fast-forward）
reviewed SHA preserved: YES（HEAD == reviewed SHA == pushed origin/m7）
git diff --check 8094885..8e92ba5: clean（无 whitespace / conflict marker）
本部署轮未重跑：57-suite quality gate / 225 assertions ×8 / 全量 typecheck
（同一 exact reviewed SHA 的既有执行记录：QUALITY_GATE_RESULT=PASS
 QUALITY_GATE_SHA=8e92ba58a28900509e542394858200b1731d7afd
 QUALITY_GATE_TOTAL_SUITES=57；fast-forward 无新 SHA 无新代码）
```

## Backup

```text
backup path: /vol1/1000/backups/zhiying/tts-c2-phase1-20260808T142118Z-8e92ba5
DB SHA-256:  9201fd6ae012e7e0533e5d191aa2774e60b5ed05e7c3fc231dd6986ec5341ec3
             （quiesce 后一致复制；source DB SHA == backup copy SHA；WAL checkpoint 无残留）
DB size:     3338240 bytes
manifest:    MANIFEST.txt（含全部文件 SHA / 容器 / image ID / preflight 基线）
compose:     docker-compose.production.yml / .gpu.yml / docker-compose.yml（SHA 见 manifest）
env:         env.production.backup（chmod 600；SHA 74fd75c1…；release tag cd367f6 存档；不记录 secret 内容）
registry:    voice-registry.json（SHA 1dab4a31…）
containers:  container-{zhiying-web,zhiying-worker,indextts2-adapter}.txt（docker inspect 快照）
```

## Docker Build

```text
build mechanism: scripts/production-build-network.sh（CONNECT tunnel remotion.media:443 →
                 127.0.0.1:7890，仅 loopback）+ --network=host --add-host remotion.media:127.0.0.1
                 + APT_MIRROR=mirrors.aliyun.com + NPM_REGISTRY=https://registry.npmmirror.com
                 （复用 C.1B.2 / 1B.3 已验证机制；未发明新脚本/patch/长直连重试）
web/worker build: docker build ... -t zhiying:8e92ba58a28900509e542394858200b1731d7afd .
                  BUILD_EXIT=0 → image ID sha256:150502bbcb43d478c8d650889593dd54eeab76e57c7bcaf38a8e448e4e5099cc（2.56GB）
adapter build:    docker build -t zhiying-indextts2-adapter:8e92ba58a28900509e542394858200b1731d7afd
                  services/indextts2-api-adapter（独立上下文）→ image ID sha256:a70eb64f79513d344a912ebba4575ae84d0643e78b6d92fd148198e8d59bb86a（135MB）
                  全层 CACHED；in-image server.py SHA 00936a54… == host server.py SHA；
                  services/ cd367f6..8e92ba5 diff = 空（内容与上一 runtime 一致）
tunnel: start → RUNNING（build 期间）→ stop → STOPPED（构建后清理）
```

## DB Migration（代码入口应用，无手工 SQL）

```text
migration entry: 新 runtime 首次打开 DB → getDb() → applyTtsC1aMigration → applyTtsC2Migration
                 （BEGIN IMMEDIATE 幂等；无 sqlite3 手工 ALTER / 无复制粘贴 frozen SQL / 无直接编辑 DB）
pre-migration:   PRAGMA integrity_check = ok；foreign_key_check = 0 行
                 tts_jobs = 351（succeeded 308 / failed 22 / cancelled 21）；26 列
                 C.2 6 表：全部 absent（preflight 实证）
post-migration:  6 新表存在：
                 tts_audio_requests / tts_synthesis_claims / tts_claim_generation_dispatches /
                 tts_job_execution_transitions / tts_generation_attempts / sentence_audio_artifacts
                 tts_jobs 10 additive 列全在（26 → 36 列）：
                 claim_id / originating_request_id / exact_source_fingerprint /
                 synthesis_payload_fingerprint / final_tts_input_fingerprint /
                 generation_variant_id / result_artifact_id / voice_profile_revision_id /
                 last_execution_command_id / execution_command_seq
                 generated indexes（4）：
                 uq_tts_jobs_id_claim / uq_tts_jobs_active_synthesis / uq_tts_jobs_claim /
                 uq_tts_synthesis_claim_active
                 generated triggers：frozen C.2 集合精确计数 65（migration generated authority；
                 未手工重枚举 SQL 文本）
                 PRAGMA integrity_check = ok；foreign_key_check = 0 行
note: migration 写入 WAL（主 DB 文件 SHA 不变仍 9201fd6a…）——备份即 pre-migration 精确快照，可作 rollback
```

## Legacy Compatibility

```text
tts_jobs before = 351 → after = 351（相等）
historical legacy rows: claim_id IS NULL = 351 / 351（100%）
claim_id IS NOT NULL = 0
C.2 identity/result/head 字段非空历史行 = 0（9 字段全 NULL/默认兼容）
未 requeue / 未改动任何 production job（仅 DB read-only proof）
```

## Zero New Runtime Data（部署后）

```text
tts_audio_requests:              0
tts_synthesis_claims:            0
tts_claim_generation_dispatches: 0
tts_job_execution_transitions:   0
tts_generation_attempts:         0
sentence_audio_artifacts:        0
voice_registry_publications:            0
voice_registry_publication_activations: 0
未人工 INSERT C.2 rows；未做 synthesis smoke 写库
```

## Runtime（deployed）

```text
web:      zhiying:8e92ba5…  container 6cfd7180a139…  restart=0  healthy
worker:   zhiying:8e92ba5…  container 3e5fb66af403…  restart=0  healthy
adapter:  zhiying-indextts2-adapter:8e92ba5…  container 5545b80ccb2e…  restart=0  healthy
image IDs: web/worker sha256:150502bbcb43…；adapter sha256:a70eb64f7951…
Release identity: 三容器统一 8e92ba5 exact tag（无 mixed/mutable tag）
```

## Safety

```text
production POST = DISABLED（POST /api/projects/<id>/voice-materializations → 503
  MATERIALIZATION_NOT_ENABLED；TTS_C1A_MATERIALIZATION_POST_ENABLED 未设置）
real synthesis: 未调用（无 provider 请求；worker 日志无 synthesis 活动）
historical backfill: 未执行
自动 convert legacy tts_jobs: 未执行（claim_id 全 NULL 实证）
TTS-C.1B.3 registry publication/recovery 既有行为：不变（worker log
  "tts-c1b3 registry recovery controller started"；registry SHA 1dab4a31… 不变）
TTS-C.3 / C.4 / C.5: not authorized / not started
```

## Smoke（production，只读）

```text
GET /api/projects → 200（web healthy；既有项目读路径正常）
GET /            → 200
adapter GET /health          → {"ready":true,"provider":"indextts2","model":"IndexTTS-2","degraded":false}
adapter GET /registry-status → ready=true；loadedRegistrySha256 1dab4a31…（== preflight，未被 reload）
worker liveness              → healthy；restart=0
DB open/read                 → integrity ok；FK 0
日志扫描（web/worker/adapter）：无 migration error / FK error / trigger error /
  database is locked loop / worker crash loop / 意外 C.2 synthesis execution / 意外 POST
  （web 仅 Node SQLite ExperimentalWarning——良性）
```

## Evidence Files

```text
docs/evidence/tts-c2/phase1-deployment.md   （本文档）
docs/M7_IMPLEMENTATION_STATUS.md            （§1 元信息 + §5 + §15.18 状态更新）
production runtime SHA   = 8e92ba58a28900509e542394858200b1731d7afd
deployment evidence docs SHA = （见 docs commit；与 runtime SHA 严格区分）
```

## Capability Provenance Phase-2 Note

R2 Review 未因此阻塞 Phase 1；后续真实 Worker/Scheduler wiring 必须遵守：
`capability_snapshot_json` / `compiled_payload_json` / `capability_compiler_version`
必须直接来源于**创建该 job 的同一次** `buildCompiledSynthesisPayload(...)`，不得在 terminal
finalize 时重新读取 latest capability 或重新拼 JSON。本轮未因该 note 修改 Phase-1 code。

## Final State

```text
TTS-C.2 Phase 1:    PENDING DEPLOYMENT EVIDENCE REVIEW；NOT FROZEN
TTS-C.1C.2:         PENDING DEPLOYMENT EVIDENCE REVIEW；NOT FROZEN
Production POST:    DISABLED
```
