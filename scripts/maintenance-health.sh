#!/usr/bin/env bash
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
umask 077
exec 9>.backup.lock
# Backup/restore owns this lock through its final health check.
flock -n 9 || exit 0
source scripts/maintenance-state.sh
previous="$(state_read health status)"
status=unavailable
container="$(timeout 15s docker compose ps -a -q web 2>/dev/null)" || container=""
if [[ -n "$container" && "$container" != *$'\n'* ]]; then
  actual="$(timeout 15s docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null)" || actual=""
  case "$actual" in
    'running healthy') status=healthy ;;
    'running starting') status=starting ;;
    'running unhealthy') status=unhealthy ;;
    exited*|dead*|paused*|created*) status=stopped ;;
  esac
fi
state_write health "checked_at=$(date -u +%FT%TZ)" "status=$status"
if [[ "$status" != "$previous" ]]; then
  printf 'health status=%s previous=%s\n' "$status" "${previous:-unknown}"
fi
# A recorded fault is a successful check; Docker errors must not leak credentials.
