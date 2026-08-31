#!/usr/bin/env bash
set -euo pipefail

ENTRY="docker/build-runner/entrypoint.sh"
COMPOSE="docker-compose.build-runner.yml"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $1"; }

if bash -n "$ENTRY"; then ok "entrypoint syntax"; else bad "entrypoint syntax"; fi

if ZHIYING_RUNNER_VALIDATE_ONLY=1 bash "$ENTRY" --sha 1234 --service zhiying-worker >/dev/null 2>&1; then
  bad "short SHA must fail closed"
else
  ok "short SHA fails closed"
fi

SHA=0123456789abcdef0123456789abcdef01234567
if ZHIYING_RUNNER_VALIDATE_ONLY=1 bash "$ENTRY" --sha "$SHA" --service zhiying-web >/dev/null 2>&1; then
  bad "non-worker service must fail closed"
else
  ok "non-worker service fails closed"
fi

OUT=$(ZHIYING_RUNNER_VALIDATE_ONLY=1 bash "$ENTRY" --sha "$SHA" --service zhiying-worker)
if [[ "$OUT" == *"requested_sha=$SHA"* && "$OUT" == *"service=zhiying-worker"* ]]; then
  ok "exact SHA worker plan accepted"
else
  bad "valid plan output"
fi

if grep -q '/var/run/docker.sock:/var/run/docker.sock' "$COMPOSE" \
  && grep -q '/vol1/1000/docker/zhiying:/production:ro' "$COMPOSE" \
  && ! grep -qE 'ports:|restart: unless-stopped' "$COMPOSE"; then
  ok "ephemeral socket boundary has no ports or persistent restart"
else
  bad "compose privilege/lifecycle boundary"
fi

if grep -q 'pnpm install --frozen-lockfile' "$ENTRY" \
  && grep -q 'requested/resolved SHA mismatch' "$ENTRY" \
  && grep -q -- '--no-deps "$SERVICE"' "$ENTRY"; then
  ok "deterministic install, source fence, scoped deploy"
else
  bad "runner deterministic contract"
fi

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
