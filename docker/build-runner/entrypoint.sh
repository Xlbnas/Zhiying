#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${ZHIYING_REPOSITORY:-https://github.com/Xlbnas/Zhiying.git}"
REQUESTED_SHA=""
SERVICE=""
PRODUCTION_COMPOSE_DIR="${ZHIYING_PRODUCTION_COMPOSE_DIR:-/production}"
BACKUP_HOST_DIR="${ZHIYING_BACKUP_HOST_DIR:-/vol1/1000/backups/zhiying}"
PROJECT_ID="${ZHIYING_LONG_VIDEO_PROJECT_ID:-8f955b4c-42dd-4a02-8e76-e721a37fab41}"
CHECKOUT=""
NETWORK_STARTED=0

log() { printf '[build-runner] %s\n' "$*"; }
die() { printf '[build-runner] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
Usage: zhiying-build-runner --sha <40-char-git-sha> --service zhiying-worker [--repository <url>]
EOF
  exit 2
}

cleanup() {
  local rc=$?
  if [ "$NETWORK_STARTED" -eq 1 ] && [ -n "$CHECKOUT" ] && [ -x "$CHECKOUT/scripts/production-build-network.sh" ]; then
    "$CHECKOUT/scripts/production-build-network.sh" stop >/dev/null 2>&1 || true
  fi
  [ -z "$CHECKOUT" ] || rm -rf -- "$CHECKOUT"
  exit "$rc"
}
trap cleanup EXIT INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repository) [ "$#" -ge 2 ] || usage; REPOSITORY="$2"; shift 2 ;;
    --sha) [ "$#" -ge 2 ] || usage; REQUESTED_SHA="$2"; shift 2 ;;
    --service) [ "$#" -ge 2 ] || usage; SERVICE="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$REQUESTED_SHA" =~ ^[0-9a-f]{40}$ ]] || die "--sha must be a full lowercase 40-character Git SHA"
[ "$SERVICE" = "zhiying-worker" ] || die "only zhiying-worker is authorized"

if [ "${ZHIYING_RUNNER_VALIDATE_ONLY:-0}" = "1" ]; then
  log "VALID requested_sha=$REQUESTED_SHA service=$SERVICE repository=$REPOSITORY"
  exit 0
fi

[ -S /var/run/docker.sock ] || die "Docker socket is unavailable"
[ -r "$PRODUCTION_COMPOSE_DIR/.env.production" ] || die "production env is not mounted read-only"
[ -f "$PRODUCTION_COMPOSE_DIR/docker-compose.production.yml" ] || die "production compose directory is invalid"
[ -d /backups ] || die "backup root is not mounted"

CHECKOUT=$(mktemp -d /workspace/Zhiying.XXXXXX)
log "checkout repository=$REPOSITORY"
git -C "$CHECKOUT" init -q
git -C "$CHECKOUT" remote add origin "$REPOSITORY"
git -C "$CHECKOUT" fetch -q --depth 1 origin "$REQUESTED_SHA"
git -C "$CHECKOUT" checkout -q --detach FETCH_HEAD
RESOLVED_SHA=$(git -C "$CHECKOUT" rev-parse HEAD)
[ "$REQUESTED_SHA" = "$RESOLVED_SHA" ] || die "requested/resolved SHA mismatch: $REQUESTED_SHA != $RESOLVED_SHA"
[ -z "$(git -C "$CHECKOUT" status --porcelain)" ] || die "isolated checkout is dirty"
log "source requested_sha=$REQUESTED_SHA resolved_sha=$RESOLVED_SHA"

cd "$CHECKOUT"
log "install pnpm=$(pnpm --version) node=$(node --version)"
pnpm config set store-dir "$PNPM_STORE_DIR"
pnpm install --frozen-lockfile

log "test production build-network contract"
bash scripts/test-production-build-network.sh
log "test memory-lab exact source and legacy renderer regression"
npx tsx scripts/test-m71-audio-subtitle-v2.ts
log "typecheck"
pnpm typecheck
log "production build"
pnpm build

if scripts/production-build-network.sh check >/dev/null 2>&1; then
  log "build network already running; runner will leave it running"
else
  scripts/production-build-network.sh start
  NETWORK_STARTED=1
fi
scripts/production-build-network.sh check

IMAGE_TAG="zhiying:${RESOLVED_SHA}"
log "docker build image=$IMAGE_TAG"
docker build --network=host \
  --add-host remotion.media:127.0.0.1 \
  --build-arg APT_MIRROR=mirrors.aliyun.com \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  -t "$IMAGE_TAG" .
IMAGE_ID=$(docker image inspect "$IMAGE_TAG" --format '{{.Id}}')
log "image tag=$IMAGE_TAG id=$IMAGE_ID"

if [ "$NETWORK_STARTED" -eq 1 ]; then
  scripts/production-build-network.sh stop
  NETWORK_STARTED=0
fi

WORKER_BEFORE=$(docker inspect zhiying-worker --format '{{.Config.Image}}|{{.Image}}|{{.State.Health.Status}}')
WEB_BEFORE=$(docker inspect zhiying-web --format '{{.Config.Image}}|{{.Image}}|{{.State.Health.Status}}')
INDEXTTS_BEFORE=$(docker inspect indextts2 --format '{{.Config.Image}}|{{.Image}}|{{.State.Health.Status}}')
DATA_SOURCE=$(docker inspect zhiying-worker --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}')
[ -n "$DATA_SOURCE" ] || die "cannot resolve production data bind mount"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_NAME="build-runner-${STAMP}-${RESOLVED_SHA}"
mkdir -p "/backups/$BACKUP_NAME"
chown 1000:1000 "/backups/$BACKUP_NAME"
BACKUP_HOST_PATH="$BACKUP_HOST_DIR/$BACKUP_NAME"
CURRENT_WORKER_IMAGE="${WORKER_BEFORE%%|*}"
log "online backup destination=$BACKUP_HOST_PATH"
docker run --rm \
  -v "$DATA_SOURCE:/app/data:ro" \
  -v "$BACKUP_HOST_PATH:/backup:rw" \
  "$CURRENT_WORKER_IMAGE" \
  node -e "const D=require('better-sqlite3');const db=new D('/app/data/zhiying.db',{readonly:true});db.backup('/backup/zhiying.db').then(()=>{const r=new D('/backup/zhiying.db',{readonly:true}).pragma('integrity_check');console.log('DB_BACKUP_INTEGRITY='+r[0].integrity_check)}).catch(e=>{console.error(e);process.exit(1)})"

log "before worker=$WORKER_BEFORE web=$WEB_BEFORE indextts2=$INDEXTTS_BEFORE project=$PROJECT_ID"
log "deploy service=$SERVICE exact_sha=$RESOLVED_SHA"
ZHIYING_RELEASE_TAG="$RESOLVED_SHA" docker compose \
  -p zhiying-production \
  -f docker-compose.production.yml \
  -f docker-compose.production.gpu.yml \
  --env-file "$PRODUCTION_COMPOSE_DIR/.env.production" \
  up -d --no-build --pull never --no-deps "$SERVICE"

for _ in $(seq 1 60); do
  STATUS=$(docker inspect zhiying-worker --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
  [ "$STATUS" = "healthy" ] && break
  sleep 5
done
[ "${STATUS:-}" = "healthy" ] || die "worker health did not become healthy"

WORKER_AFTER=$(docker inspect zhiying-worker --format '{{.Config.Image}}|{{.Image}}|{{.State.Health.Status}}')
WEB_AFTER=$(docker inspect zhiying-web --format '{{.Config.Image}}|{{.Image}}|{{.State.Health.Status}}')
INDEXTTS_AFTER=$(docker inspect indextts2 --format '{{.Config.Image}}|{{.Image}}|{{.State.Health.Status}}')
[ "$WEB_BEFORE" = "$WEB_AFTER" ] || die "web container changed during worker-only deploy"
[ "$INDEXTTS_BEFORE" = "$INDEXTTS_AFTER" ] || die "IndexTTS2 container changed during worker-only deploy"

docker exec zhiying-worker node --import tsx --input-type=module -e \
  "const m=await import('./src/remotion/templates/production/MemoryLabEditorialScene.tsx'); const legacy=await import('./src/remotion/templates/production/V2VisualR2Scene.tsx'); const remotion=await import('remotion/package.json',{with:{type:'json'}}); if(m.MEMORY_LAB_EDITORIAL_VERSION!=='memory-lab-editorial@1'||typeof legacy.isV2VisualR2Scene!=='function'||remotion.default.version!=='4.0.492') process.exit(1); console.log('RENDERER_SMOKE=memory-lab-editorial@1 legacy=PASS remotion='+remotion.default.version)"

log "result requested_sha=$REQUESTED_SHA resolved_sha=$RESOLVED_SHA image_id=$IMAGE_ID"
log "result worker_before=$WORKER_BEFORE worker_after=$WORKER_AFTER"
log "result web_unchanged=YES indextts2_unchanged=YES backup=$BACKUP_HOST_PATH status=PASS"
