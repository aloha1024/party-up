#!/usr/bin/env bash
# Exercise Linux orchestration with a fake Docker command; never contacts Docker.
set -Eeuo pipefail
source_script="$PWD/scripts/backup.sh"
sandbox="$(mktemp -d)"
trap 'rm -rf -- "$sandbox"' EXIT
mkdir -p "$sandbox/project/scripts" "$sandbox/bin" "$sandbox/project/snapshot"
cp "$source_script" "$sandbox/project/scripts/backup.sh"
printf 'APP_PORT=3001\n' > "$sandbox/project/.env"
printf 'APP_PORT=8080\n' > "$sandbox/project/snapshot/server.env"
cat > "$sandbox/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_LOG"
case "$*" in
  *"ps --status running"*) [ "${MOCK_RUNNING:-1}" = 1 ] && echo fake-container; exit 0 ;;
  *" verify "*) [ "${MOCK_FAIL:-}" != verify ]; exit $? ;;
  *" backup "*) [ "${MOCK_FAIL:-}" != backup ]; exit $? ;;
  *" restore "*) [ "${MOCK_FAIL:-}" != restore ]; exit $? ;;
esac
exit 0
MOCK
chmod +x "$sandbox/bin/docker"
export PATH="$sandbox/bin:$PATH"
export MOCK_LOG="$sandbox/docker.log"
run() { bash "$sandbox/project/scripts/backup.sh" "$@" >/dev/null 2>&1; }
: > "$MOCK_LOG"
run backup
grep -q 'compose stop web' "$MOCK_LOG"
grep -q 'compose start web' "$MOCK_LOG"
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
echo "Linux 备份脚本的 7 个流程场景通过（使用模拟 Docker）"
