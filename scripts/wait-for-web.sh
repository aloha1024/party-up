#!/usr/bin/env bash
# Run in the deployment directory; optional arguments are Compose global flags.
set -Eeuo pipefail
compose=(docker compose "$@")
seconds="${WEB_HEALTH_TIMEOUT:-120}"
if [[ ! "$seconds" =~ ^[1-9][0-9]{0,2}$ ]] || (( seconds > 600 )); then
  echo "WEB_HEALTH_TIMEOUT 必须为 1 到 600 秒" >&2
  exit 1
fi
container="$("${compose[@]}" ps -a -q web)"
if [[ -z "$container" || "$container" == *$'\n'* ]]; then
  echo "无法找到唯一的网站容器，健康检查失败" >&2
  exit 1
fi
state="unknown"
for ((attempt=0; attempt<seconds; attempt++)); do
  # Restrict inspection to statuses; never print environment or initialization logs.
  state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")" || {
    echo "读取网站容器状态失败" >&2
    exit 1
  }
  case "$state" in
    'running healthy') echo "网站健康检查通过"; exit 0 ;;
    *' unhealthy'|*' none'|exited*|dead*|paused*)
      printf '网站健康检查失败（状态：%s）\n' "$state" >&2
      exit 1 ;;
  esac
  sleep 1
done
printf '网站健康检查等待超时（%s 秒，状态：%s）\n' "$seconds" "$state" >&2
exit 1
