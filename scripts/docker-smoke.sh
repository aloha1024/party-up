#!/usr/bin/env bash
# Dedicated CI project and anonymous test port. Never reuses the deployment project.
set -Eeuo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
scratch="$(mktemp -d)"
project="party-ci-$(date +%s)-$$"
compose_file=compose.yaml
startup_flags=(--build)
if [[ -n "${PARTY_IMAGE:-}" ]]; then
  compose_file=compose.image.yaml
  startup_flags=(--no-build)
fi
compose=(docker compose --env-file "$scratch/env" -p "$project" -f "$compose_file")
printf '%s\n' "$project" > "$scratch/docker-ci-project"
printf 'APP_PORT=0\nADMIN_USERNAME=\nADMIN_PASSWORD_HASH=\nADMIN_SESSION_SECRET=\nTRUST_PROXY=0\n' > "$scratch/env"
unset APP_PORT ADMIN_USERNAME ADMIN_PASSWORD_HASH ADMIN_SESSION_SECRET TRUST_PROXY
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES COMPOSE_PROFILES
cleanup() { "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf -- "$scratch"; }
trap cleanup EXIT
# Docker may allocate a different anonymous host port when the container restarts.
# Resolve it on every probe, including probes while networking is still starting.
resolve_origin() {
  local address port
  address="$("${compose[@]}" port web 3000 2>/dev/null)" || return 1
  address="${address%%$'\n'*}"
  port="${address##*:}"
  [[ "$port" =~ ^[0-9]{1,5}$ ]] && (( 10#$port > 0 && 10#$port <= 65535 )) || return 1
  origin="http://127.0.0.1:$port"
}
diagnose() {
  local container
  # Do not dump application logs or the full inspect result: startup logs contain
  # the temporary administrator password and inspect includes environment values.
  container="$("${compose[@]}" ps -a -q web 2>/dev/null)" || return 0
  if [[ -n "$container" ]]; then
    docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" >&2 || true
  fi
}
wait_for_health() {
  local stage="$1" attempt
  for attempt in {1..60}; do
    if resolve_origin && curl --fail --silent --connect-timeout 1 --max-time 2 "$origin/api/health" >/dev/null; then
      printf 'Docker %s healthy at %s\n' "$stage" "$origin"
      return 0
    fi
    sleep 1
  done
  printf 'Docker %s health check failed after 60 attempts (last address: %s)\n' "$stage" "${origin:-unavailable}" >&2
  diagnose
  return 1
}
if ! "${compose[@]}" up -d "${startup_flags[@]}" --wait --wait-timeout 120; then
  diagnose
  exit 1
fi
wait_for_health startup
curl --fail --silent --show-error --connect-timeout 3 --max-time 15 -X POST -H "Origin: $origin" -c "$scratch/cookies" "$origin/api/identity" >/dev/null
future="$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ)"
printf '{"gameName":"Container smoke","hostName":"Host","scheduledAt":"%s","maxPlayers":3}' "$future" > "$scratch/create.json"
curl --fail --silent --show-error --connect-timeout 3 --max-time 15 -H "Origin: $origin" -H 'Content-Type: application/json' -H 'Idempotency-Key: docker-smoke-test-key' -b "$scratch/cookies" --data-binary "@$scratch/create.json" "$origin/api/reservations" > "$scratch/first.json"
"${compose[@]}" restart web >/dev/null
wait_for_health restart
curl --fail --silent --show-error --connect-timeout 3 --max-time 15 -H "Origin: $origin" -H 'Content-Type: application/json' -H 'Idempotency-Key: docker-smoke-test-key' -b "$scratch/cookies" --data-binary "@$scratch/create.json" "$origin/api/reservations" > "$scratch/repeated.json"
python3 - "$scratch" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1])
first=json.loads((p/'first.json').read_text())['data']
again=json.loads((p/'repeated.json').read_text())['data']
assert first['id']==again['id'] and again['isHost'] and len(again['participants'])==1
print('Docker health, migrations, persistent identity and replay passed')
PY
"${compose[@]}" exec -T web node -e "require('@prisma/client'); for (const name of ['@playwright/test', 'playwright', 'playwright-core']) { try { require.resolve(name); } catch (e) { if(e.code==='MODULE_NOT_FOUND') continue; throw e; } console.error('Unexpected test dependency in production image: ' + name); process.exit(1); } console.log('Production runtime dependencies verified');"
# Prisma is a CLI package; its root export is not the executable entry point.
"${compose[@]}" exec -T web node node_modules/prisma/build/index.js --version
bash scripts/docker-backup-smoke.sh "$project" "$scratch" "$compose_file"
docker image inspect "$("${compose[@]}" images -q web)" --format 'Image bytes: {{.Size}}'
