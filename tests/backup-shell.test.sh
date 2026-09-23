#!/usr/bin/env bash
# Exercise Linux orchestration with a fake Docker command; never contacts Docker.
set -Eeuo pipefail
source_script="$PWD/scripts/backup.sh"
sandbox="$(mktemp -d)"
trap 'rm -rf -- "$sandbox"' EXIT
mkdir -p "$sandbox/project/scripts" "$sandbox/bin" "$sandbox/project/snapshot"
cp "$source_script" "$sandbox/project/scripts/backup.sh"
cp scripts/wait-for-web.sh "$sandbox/project/scripts/wait-for-web.sh"
printf 'APP_PORT=3001\n' > "$sandbox/project/.env"
printf 'APP_PORT=8080\n' > "$sandbox/project/snapshot/server.env"
cat > "$sandbox/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_LOG"
case "$*" in
  *"ps -a -q web"*) [ "${MOCK_FAIL:-}" != missing-container ] && echo fake-container; exit 0 ;;
  'inspect --format '*)
    case "${MOCK_FAIL:-}" in
      unhealthy) echo 'running unhealthy' ;;
      timeout) echo 'running starting' ;;
      no-health) echo 'running none' ;;
      delayed)
        count=0
        [ ! -f "$MOCK_LOG.count" ] || read -r count < "$MOCK_LOG.count"
        count=$((count + 1))
        echo "$count" > "$MOCK_LOG.count"
        if [ "$count" -lt 3 ]; then echo 'running starting'; else echo 'running healthy'; fi ;;
      *) echo 'running healthy' ;;
    esac
    exit 0 ;;
  'compose start web') [ "${MOCK_FAIL:-}" != start ]; exit $? ;;
  'compose up -d --force-recreate web') [ "${MOCK_FAIL:-}" != up ]; exit $? ;;
  *"ps --status running"*) [ "${MOCK_RUNNING:-1}" = 1 ] && echo fake-container; exit 0 ;;
  *" verify "*) [ "${MOCK_FAIL:-}" != verify ]; exit $? ;;
  *" backup "*) [ "${MOCK_FAIL:-}" != backup ]; exit $? ;;
  *" restore "*) [ "${MOCK_FAIL:-}" != restore ]; exit $? ;;
esac
exit 0
MOCK
cat > "$sandbox/bin/sleep" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$sandbox/bin/docker" "$sandbox/bin/sleep"
export PATH="$sandbox/bin:$PATH"
export MOCK_LOG="$sandbox/docker.log"
export WEB_HEALTH_TIMEOUT=4
run() { bash "$sandbox/project/scripts/backup.sh" "$@" >"$sandbox/output" 2>&1; }
: > "$MOCK_LOG"
run backup
grep -q 'compose stop web' "$MOCK_LOG"
grep -q 'compose start web' "$MOCK_LOG"
grep -q 'inspect --format' "$MOCK_LOG"
: > "$MOCK_LOG"
export MOCK_FAIL=backup
if run backup; then echo "备份失败应返回错误"; exit 1; fi
grep -q 'compose start web' "$MOCK_LOG"
: > "$MOCK_LOG"
export MOCK_FAIL=verify
if run restore "$sandbox/project/snapshot" --confirm; then exit 1; fi
if grep -q 'compose stop web' "$MOCK_LOG"; then echo "校验失败不应停止网站"; exit 1; fi
: > "$MOCK_LOG"
export MOCK_FAIL=restore
if run restore "$sandbox/project/snapshot" --confirm; then exit 1; fi
grep -q 'pre-restore' "$MOCK_LOG"
if grep -q 'compose up ' "$MOCK_LOG"; then echo "恢复中断不应启动网站"; exit 1; fi
grep -q 'APP_PORT=3001' "$sandbox/project/.env"
: > "$MOCK_LOG"
unset MOCK_FAIL
run restore "$sandbox/project/snapshot" --confirm
grep -q 'compose up -d --force-recreate web' "$MOCK_LOG"
grep -q 'APP_PORT=8080' "$sandbox/project/.env"
: > "$MOCK_LOG"
export MOCK_RUNNING=0
run backup
if grep -Eq 'compose (stop|start|up) ' "$MOCK_LOG"; then echo "原本停止的网站不应改变状态"; exit 1; fi
: > "$MOCK_LOG"
if run restore "$sandbox/project/snapshot"; then echo "缺少确认参数应拒绝恢复"; exit 1; fi
if [ -s "$MOCK_LOG" ]; then echo "缺少确认时不应操作 Docker"; exit 1; fi
# Restoring a stopped site must preserve its stopped state.
: > "$MOCK_LOG"
run restore "$sandbox/project/snapshot" --confirm
if grep -Eq 'compose (stop|start|up) |inspect --format' "$MOCK_LOG"; then exit 1; fi
grep -q 'pre-restore' "$MOCK_LOG"
# Startup/health failures after backup must fail, retain backups, and stop the site.
export MOCK_RUNNING=1
for failure in start unhealthy timeout missing-container no-health; do
  : > "$MOCK_LOG"
  export MOCK_FAIL="$failure"
  if run backup; then echo "重启/健康检查失败必须返回错误：$failure"; exit 1; fi
  grep -q '备份文件保留' "$sandbox/output"
  grep -q 'compose stop web' "$MOCK_LOG"
  if grep -q '网站已恢复运行并通过健康检查' "$sandbox/output"; then exit 1; fi
done
# After data restoration, distinguish unavailable service from failed data restore.
for failure in up unhealthy; do
  : > "$MOCK_LOG"
  export MOCK_FAIL="$failure"
  if run restore "$sandbox/project/snapshot" --confirm; then exit 1; fi
  grep -q 'pre-restore' "$MOCK_LOG"
  grep -q '数据和 .env 已恢复，但网站启动或健康检查失败' "$sandbox/output"
  if grep -q '^已恢复预约' "$sandbox/output"; then exit 1; fi
  test "$(grep -c 'compose stop web' "$MOCK_LOG")" -eq 2
done
: > "$MOCK_LOG"
export MOCK_FAIL=delayed
run restore "$sandbox/project/snapshot" --confirm
test "$(cat "$MOCK_LOG.count")" -eq 3
grep -q '网站健康检查通过' "$sandbox/output"
grep -q '^已恢复预约' "$sandbox/output"
echo "Linux 备份脚本的 16 个流程场景通过（使用模拟 Docker）"
