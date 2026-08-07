# TTS-C.1B.3 Production Deployment Evidence

Date: 2026-08-07（UTC）

## Identity

```text
approved deployment SHA:      cd367f6c3b24b3fe3a3b450e188be7c2cd0eb8d3
deployed production runtime:  cd367f6c3b24b3fe3a3b450e188be7c2cd0eb8d3
previous production runtime:  6874f51c717ebab1c282ee29e9301f27627deaf7
origin/m7 at deployment:      cd367f6c3b24b3fe3a3b450e188be7c2cd0eb8d3
host checkout during build:   cd367f6c3b24b3fe3a3b450e188be7c2cd0eb8d3（detached，tracked clean）
release tag:                  cd367f6c3b24b3fe3a3b450e188be7c2cd0eb8d3
image IDs:
  zhiying:cd367f6…                    ead89ff3b4a3（web/worker 共用）
  zhiying-indextts2-adapter:cd367f6…  6e6c504bf5af
container IDs（deployed）:
  zhiying-web        b8823d3c4ef3（started 2026-08-07T10:51:35Z, restart=0）
  zhiying-worker     702ac792c979（started 2026-08-07T10:51:36Z, restart=0）
  indextts2-adapter  5b5d7563c673（started 2026-08-07T10:51:17Z, restart=0）
```

## Backup

```text
backup ID/path: /vol1/1000/backups/zhiying/tts-c1b3-20260807T081005Z-cd367f6
compose backup: docker-compose.production.yml + docker-compose.production.gpu.yml（SHA 见 manifest）
env backup:     env.production.backup（chmod 600；SHA 5a4e825b3db944de06c5bc6e3d2bd42446f5974a28958ceaeab6289cea0c4fb0；不记录 secret 内容）
release tag:    6874f51c717ebab1c282ee29e9301f27627deaf7（backup 文件）
container/mount inspect: container-*.txt / mounts-*.txt（三容器）
registry backup: voice-registry.json（SHA 1dab4a313689736aad081b2b0367f9b036eeec0f9a751647192498ce9ee21827）
DB backup:      zhiying.db（quiesce 后一致复制；SHA 9201fd6ae012e7e0533e5d191aa2774e60b5ed05e7c3fc231dd6986ec5341ec3；无 WAL 残留——SQLite 已 checkpoint，writer 已停）
materialization inventory: 空（0 文件；stop 前后一致）
```

## Migration

```text
Materialization（forward relocation）:
  OLD_MAT_ROOT = /vol1/1000/docker/zhiying/data/voice-materializations（空目录，root:root 755，inode 81019）
  NEW_MAT_ROOT = /vol1/1000/docker/zhiying/voices/tts-a（same-fs mv，inode 81019 保留）
  inventory: before=0 files / after=0 files（相等）
  OLD 路径已不存在（mv 原子完成）
Registry（directory migration）:
  OLD_REGISTRY_FILE = /vol1/1000/docker/zhiying/voice-registry.json（保留为 rollback 输入）
  NEW_REGISTRY_DIR  = /vol1/1000/docker/zhiying/voice-registry（lstat 目录非 symlink；inode 84390）
  NEW_REGISTRY_FILE = /vol1/1000/docker/zhiying/voice-registry/voice-registry.json
  SHA(OLD) == SHA(NEW) == 1dab4a313689736aad081b2b0367f9b036eeec0f9a751647192498ce9ee21827
  fsync file + fsync dir 完成；realpath 无 symlink；regular file
```

## Resolved topology（deployed，docker inspect 实证）

| container | host source | target | RW/RO |
|---|---|---|---|
| zhiying-worker | /vol1/1000/docker/zhiying/data | /app/data | rw |
| zhiying-worker | /vol1/1000/docker/zhiying/public | /app/public | ro |
| zhiying-worker | /vol1/1000/docker/zhiying/public/assets | /app/public/assets | rw |
| zhiying-worker | /vol1/1000/docker/zhiying/voices/tts-a | /app/data/voice-materializations | rw |
| zhiying-worker | /vol1/1000/docker/zhiying/voice-registry | /registry | rw |
| zhiying-worker | /vol1/1000/docker/zhiying/voices | /voices | ro |
| zhiying-web | /vol1/1000/docker/zhiying/data | /app/data | rw |
| zhiying-web | /vol1/1000/docker/zhiying/voices/tts-a | /app/data/voice-materializations | ro |
| indextts2-adapter | /vol1/1000/docker/zhiying/voice-registry | /config | ro |
| indextts2-adapter | /vol1/1000/docker/zhiying/voices | /voices | ro（恰好 1 个 /voices mount，无 child） |

Source identity（docker inspect 实证）:

```text
worker /registry source == adapter /config source == /vol1/1000/docker/zhiying/voice-registry
worker /voices source == adapter /voices source == /vol1/1000/docker/zhiying/voices
worker /app/data/voice-materializations source == web source == /vol1/1000/docker/zhiying/voices/tts-a
```

## Build

```text
build command:
  docker build --network=host --add-host remotion.media:127.0.0.1 \
    --build-arg APT_MIRROR=mirrors.aliyun.com \
    --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
    -t zhiying:cd367f6c3b24b3fe3a3b450e188be7c2cd0eb8d3 .
  （web/worker image；adapter image 经 compose build 构建 zhiying-indextts2-adapter:cd367f6…）
  build 网络加速：scripts/production-build-network.sh start/check/stop（remotion.media:443 →
  host 127.0.0.1:7890 代理隧道，M7.3A.3 既有机制；build 后已 stop）
build exit: 0
```

## Runtime（deployed）

```text
web:      healthy（/api/projects 200）
worker:   running（liveness PASS；restart=0）
adapter:  healthy（/health ready=true；/registry-status loadedRegistrySha256
          1dab4a31… == host registry SHA；schemaVersion 1.0；speakerCount 1）
container restart counts: 全部 0
```

## DB（deployed 后只读）

```text
PRAGMA integrity_check: ok
PRAGMA foreign_key_check: 0 行
voice_registry_publications: 0
voice_registry_publication_activations: 0
legacy_adapter_voice_entries: 0
```

## Zero unintended mutation

```text
registry before SHA: 1dab4a313689736aad081b2b0367f9b036eeec0f9a751647192498ce9ee21827
registry after SHA:  1dab4a313689736aad081b2b0367f9b036eeec0f9a751647192498ce9ee21827（相等）
candidate/snapshot files: 无（worker /app/data/voice-registries 不存在）
reload evidence: adapter logs 无 reload（未调用 POST /reload）
recovery controller evidence: worker log "tts-c1b3 registry recovery controller started"
zero publication → zero registry mutation：实证（publications=0；无 candidate/snapshot；registry SHA 不变）
```

## Stage

```text
production POST remains disabled（POST /voice-materializations → 503；TTS_C1A_MATERIALIZATION_POST_ENABLED 未设置/未注入）
TTS-C.1C.2 not started
TTS-C.2 not authorized
未调用真实 synthesis；未创建 publication；未执行 legacy import
其他宿主容器（indextts2、temu-image-factory、cloudflared 等）未受影响
```

## Note

```text
deployed production runtime SHA = cd367f6c3b24b3fe3a3b450e188be7c2cd0eb8d3
本 evidence 文档 commit SHA ≠ production runtime SHA（docs-only commit）
rollback 依据 docs/TTS_C_1B_1C_EXECUTION_PLAN.md §M2.6（含 materialization reverse relocation）
```
