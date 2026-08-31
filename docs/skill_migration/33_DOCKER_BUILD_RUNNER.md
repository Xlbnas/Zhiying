# Docker Build Runner

## Decision

Zhiying deployment no longer requires `agentvm`. The approved path is:

`Mac / Codex → GitHub exact commit → NAS ephemeral Docker runner → exact tests/build → Worker-only deploy`.

`agentvm` may continue to exist for unrelated services. This change does not stop, delete, modify, or migrate it.

## Lifecycle and source authority

- Service: `zhiying-build-runner`.
- Lifecycle: ephemeral, invoked with `docker compose run --rm`; it has no port and no restart policy.
- Source: a full 40-character Git SHA. The runner fetches that object into a fresh temporary checkout, resolves `HEAD`, and requires `REQUESTED_SHA == RESOLVED_SHA`.
- Dirty working trees, branch heads, `latest`, and implicit current versions are not accepted.
- The checkout is removed after the run. The NAS production source directory is mounted read-only and is not used as build input.

## Fixed runtime

- Node: `22.22.2` (`node:22.22.2-bookworm`).
- pnpm: `11.9.0`.
- Docker CLI: `28.5.2`, matching the NAS Docker Server major/minor line used for this deployment.
- Project Remotion remains exactly `4.0.492` from the repository lockfile.

## Capabilities and command

The runner performs only checkout, install, relevant tests, typecheck, Next production build, Docker image build, image ID capture, SQLite online backup, scoped Worker deploy, and health/renderer smoke checks.

```bash
docker compose -f docker-compose.build-runner.yml build zhiying-build-runner
docker compose -f docker-compose.build-runner.yml run --rm \
  zhiying-build-runner \
  --sha <full-exact-sha> \
  --service zhiying-worker
```

Any failed step stops the command before subsequent deployment steps. Only `zhiying-worker` is accepted. The deployment uses the existing production and GPU compose definitions with `--no-build --pull never --no-deps`; Web and IndexTTS2 image identities are checked before and after.

## Production access and security boundary

The ephemeral runner receives `/var/run/docker.sock`. This is privileged deployment capability equivalent to Docker-host root and is the explicit security boundary. It is confined to this non-persistent runner; Web, Worker, adapter, and TTS containers do not receive the socket. The runner exposes no network port.

The production compose directory and `.env.production` are mounted read-only. Secrets are not printed. The backup root is the only explicit writable production mount. Before the Worker switch, the runner uses the existing Worker image and SQLite online-backup API to write a timestamped backup under `/vol1/1000/backups/zhiying/`, then verifies `integrity_check=ok`.

The existing `scripts/production-build-network.sh` remains the sole Remotion download acceleration path. The runner starts it only if absent and stops only a tunnel it started.

## Scope boundary

- `AGENTVM_REQUIRED_FOR_ZHIYING_DEPLOY = NO`
- no daemon, scheduler, workflow engine, deployment database, state machine, UI, Kubernetes, or DinD cluster;
- no database schema change;
- no Web, IndexTTS2, or adapter restart;
- no Remotion or general dependency upgrade.
