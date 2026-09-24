#!/usr/bin/env bash
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
project="$PWD"
action="${1:-status}"
units=(party-up-backup.service party-up-backup.timer party-up-health.service party-up-health.timer)
command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || {
  echo '需要运行 systemd 的 Linux 服务器' >&2; exit 1;
}
if [[ "$action" == status ]]; then
  systemctl list-timers --all party-up-backup.timer party-up-health.timer
  for name in backup health; do
    if [[ -f ".maintenance/$name" ]]; then cat ".maintenance/$name"; else echo "$name: 尚无记录"; fi
  done
  exit 0
fi
[[ "$action" == install || "$action" == uninstall ]] || { echo '用法：sudo bash scripts/maintenance-systemd.sh install 部署用户 | uninstall；bash scripts/maintenance-systemd.sh status'; exit 1; }
[[ "$EUID" == 0 ]] || { echo '安装和卸载需要 sudo' >&2; exit 1; }
# WorkingDirectory takes a literal path (not a quoted command argument).
# Escape specifiers; reject trailing whitespace/backslash interpreted by unit parsing.
[[ "$project" != *$'\n'* && "$project" != *$'\r'* && "$project" != *$'\t'* && "$project" != *' ' && "$project" != *'\' ]] || exit 1
escaped="${project//%/%%}"
for unit in "${units[@]}"; do
  file="/etc/systemd/system/$unit"
  if [[ -e "$file" ]] && ! grep -Fxq "# party-up project $escaped" "$file"; then
    echo "已有其他项目或非本工具管理的单元：$unit；拒绝覆盖或卸载" >&2; exit 1
  fi
done
if [[ "$action" == uninstall ]]; then
  # Stop timers only: an active backup must finish its recovery/health checks.
  systemctl disable --now party-up-backup.timer party-up-health.timer
  for unit in "${units[@]}"; do rm -f -- "/etc/systemd/system/$unit"; done
  systemctl daemon-reload
  echo '已卸载定时任务；运行中的维护会完成，配置、状态和备份保留'
  exit 0
fi
user="${2:-${SUDO_USER:-}}"
[[ "$user" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*\$?$ ]] && id "$user" >/dev/null || { echo '请指定有效的部署用户' >&2; exit 1; }
for tool in docker flock timeout runuser systemd-analyze; do command -v "$tool" >/dev/null || { echo "缺少依赖：$tool" >&2; exit 1; }; done
[[ -f .env ]] || { echo '缺少项目 .env' >&2; exit 1; }
runuser -u "$user" -- test -r "$project/.env"
runuser -u "$user" -- test -w "$project"
for existing in .backup.lock .maintenance; do
  if [[ -e "$existing" ]]; then runuser -u "$user" -- test -w "$project/$existing"; fi
done
runuser -u "$user" -- docker compose version >/dev/null
runuser -u "$user" -- docker info >/dev/null 2>&1 || { echo '部署用户无法连接 Docker' >&2; exit 1; }
runuser -u "$user" -- docker compose config --quiet
systemd-analyze calendar '*-*-* 04:00:00 Asia/Shanghai' >/dev/null
umask 077
staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT
source scripts/maintenance-units.sh
render_maintenance_units "$staging" "$user" "$escaped"
systemd-analyze verify "$staging"/*.service "$staging"/*.timer
for unit in "${units[@]}"; do install -m 600 "$staging/$unit" "/etc/systemd/system/$unit"; done
systemctl daemon-reload
systemctl enable --now party-up-backup.timer party-up-health.timer
echo '已启用每日北京时间 04:00 备份和每分钟健康检查'
