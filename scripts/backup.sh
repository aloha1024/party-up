#!/usr/bin/env bash
# Run from the project directory. Uses Docker only; no host Node.js is required.
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
umask 077
command -v flock >/dev/null || { echo "请安装 util-linux（提供 flock）" >&2; exit 1; }
exec 9>.backup.lock
flock -n 9 || { echo "另一项备份/恢复任务正在运行" >&2; exit 1; }
action="${1:-}"
root="${BACKUP_DIR:-$PWD/backups}"
mkdir -p -- "$root"
root="$(cd -- "$root" && pwd -P)"
case "$action" in
  backup) ;;
  verify|restore)
    [ -n "${2:-}" ] && [ -d "$2" ] || { echo "请提供备份目录" >&2; exit 1; }
    snapshot="$(cd -- "$2" && pwd -P)"
    if [ "$action" = restore ] && [ "${3:-}" != --confirm ]; then
      echo "恢复会覆盖当前预约和管理员数据。请确认备份路径后追加 --confirm。" >&2
      exit 1
    fi ;;
  *) echo "用法：bash scripts/backup.sh backup | verify 备份目录 | restore 备份目录 --confirm"; exit 1 ;;
esac
[ -f .env ] || { echo "缺少项目 .env 配置" >&2; exit 1; }
helper=(docker compose run --rm --no-deps -T --user 0:0 --entrypoint node)
if [ "$action" != backup ]; then
  "${helper[@]}" -v "$snapshot:/snapshot:ro" web scripts/backup-data.mjs verify /snapshot
  [ "$action" = verify ] && exit 0
fi
running="$(docker compose ps --status running -q web)"
resume=0
restore_started=0
env_tmp=""
cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" != 0 ] && [ "$restore_started" = 1 ]; then
    echo "恢复未完成，网站保持停止。请检查错误，并使用 pre-restore-* 快照恢复后再启动。" >&2
  fi
  if [ -n "$env_tmp" ] && [ -f "$env_tmp" ]; then rm -f -- "$env_tmp"; fi
  if [ "$resume" = 1 ]; then
    docker compose start web || { echo "服务重启失败，请检查 docker compose logs web" >&2; status=1; }
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -n "$running" ]; then
  resume=1
  docker compose stop web
fi
if [ "$action" = restore ]; then prefix=pre-restore; else prefix=""; fi
"${helper[@]}" -e BACKUP_UID="$(id -u)" -e BACKUP_GID="$(id -g)" -e KEEP_BACKUPS="${KEEP_BACKUPS:-7}" \
  -v "$root:/backups" -v "$PWD/.env:/server.env:ro" \
  web scripts/backup-data.mjs backup /app/data /backups /server.env ${prefix:+"$prefix"}
if [ "$action" = restore ]; then
  # Prepare replacement configuration before touching the database.
  env_tmp="$(mktemp "$PWD/.env.restore.XXXXXX")"
  cp -- "$snapshot/server.env" "$env_tmp"
  chmod 600 "$env_tmp"
  was_running="$resume"
  resume=0
  restore_started=1
  "${helper[@]}" -v "$snapshot:/snapshot:ro" web scripts/backup-data.mjs restore /snapshot /app/data --confirm
  mv -- "$env_tmp" .env
  env_tmp=""
  restore_started=0
  if [ "$was_running" = 1 ]; then
    docker compose up -d --force-recreate web
    resume=0
  fi
  echo "已恢复预约、报名、管理员和 .env；恢复前快照保存在 $root/pre-restore-*"
fi
