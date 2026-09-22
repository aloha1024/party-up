#!/usr/bin/env bash
# Dedicated CI project and anonymous test port. Never reuses the deployment project.
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
scratch="$(mktemp -d)"
project="party-ci-$(date +%s)-$$"
compose=(docker compose --env-file "$scratch/env" -p "$project" -f compose.yaml)
printf 'APP_PORT=0\nADMIN_USERNAME=\nADMIN_PASSWORD_HASH=\nADMIN_SESSION_SECRET=\nTRUST_PROXY=0\n' > "$scratch/env"
unset APP_PORT ADMIN_USERNAME ADMIN_PASSWORD_HASH ADMIN_SESSION_SECRET TRUST_PROXY
cleanup() { "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf -- "$scratch"; }
trap cleanup EXIT
"${compose[@]}" up -d --build --wait --wait-timeout 120
address="$("${compose[@]}" port web 3000 | head -1)"
port="${address##*:}"
origin="http://127.0.0.1:$port"
curl --fail --silent "$origin/api/health" >/dev/null
curl --fail --silent -X POST -H "Origin: $origin" -c "$scratch/cookies" "$origin/api/identity" >/dev/null
future="$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ)"
printf '{"gameName":"Container smoke","hostName":"Host","scheduledAt":"%s","maxPlayers":3}' "$future" > "$scratch/create.json"
curl --fail --silent -H "Origin: $origin" -H 'Content-Type: application/json' -H 'Idempotency-Key: docker-smoke-test-key' -b "$scratch/cookies" --data-binary "@$scratch/create.json" "$origin/api/reservations" > "$scratch/first.json"
"${compose[@]}" restart web >/dev/null
for attempt in {1..60}; do if curl --fail --silent "$origin/api/health" >/dev/null; then break; fi; sleep 1; done
curl --fail --silent -H "Origin: $origin" -H 'Content-Type: application/json' -H 'Idempotency-Key: docker-smoke-test-key' -b "$scratch/cookies" --data-binary "@$scratch/create.json" "$origin/api/reservations" > "$scratch/repeated.json"
python3 - "$scratch" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1])
first=json.loads((p/'first.json').read_text())['data']
again=json.loads((p/'repeated.json').read_text())['data']
assert first['id']==again['id'] and again['isHost'] and len(again['participants'])==1
print('Docker health, migrations, persistent identity and replay passed')
PY
"${compose[@]}" exec -T web node -e "require('@prisma/client'); require.resolve('prisma'); try { require.resolve('@playwright/test'); process.exit(1); } catch (e) { if(e.code!=='MODULE_NOT_FOUND') throw e; }"
docker image inspect "$("${compose[@]}" images -q web)" --format 'Image bytes: {{.Size}}'
