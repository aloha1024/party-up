#!/usr/bin/env bash
# Run the orchestration against fake Docker/curl commands; never contacts Docker.
set -Eeuo pipefail
sandbox="$(mktemp -d)"
trap 'rm -rf -- "$sandbox"' EXIT
mkdir -p "$sandbox/project/scripts" "$sandbox/bin"
cp scripts/docker-smoke.sh "$sandbox/project/scripts/docker-smoke.sh"
cat > "$sandbox/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'docker %s\n' "$*" >> "$MOCK_STATE/commands"
if [[ "$1" == compose ]]; then
  shift
  while [[ "$1" == --env-file || "$1" == -p || "$1" == -f ]]; do shift 2; done
  case "$*" in
    'up -d --build --wait --wait-timeout 120') exit 0 ;;
    'port web 3000')
      if [[ ! -f "$MOCK_STATE/restarted" ]]; then echo '0.0.0.0:31001'; exit 0; fi
      count=0
      [[ ! -f "$MOCK_STATE/discoveries" ]] || read -r count < "$MOCK_STATE/discoveries"
      count=$((count + 1))
      echo "$count" > "$MOCK_STATE/discoveries"
      [[ "$MOCK_MODE" != missing-port ]] || { echo '0.0.0.0:0'; exit 0; }
      [[ "$MOCK_MODE" != delayed || "$count" -gt 2 ]] || exit 1
      printf '0.0.0.0:32002\n[::]:32002\n'
      ;;
    'restart web') touch "$MOCK_STATE/restarted" ;;
    'ps -a -q web') echo fake-container ;;
    'down -v --remove-orphans') touch "$MOCK_STATE/cleaned" ;;
    'images -q web') echo fake-image ;;
    'exec -T web node -e '*) touch "$MOCK_STATE/runtime-check" ;;
    'exec -T web node node_modules/prisma/build/index.js --version')
      touch "$MOCK_STATE/cli-check"
      [[ "$MOCK_MODE" != cli-failure ]] || exit 1
      echo 'prisma : 6.19.0'
      ;;
    *) echo "Unexpected Docker Compose command" >&2; exit 99 ;;
  esac
elif [[ "$1 $2" == 'inspect --format' ]]; then
  # Explicitly restricted status fields; never accept full inspect or app logs.
  [[ "$3" == 'status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ]] || exit 99
  echo 'status=running exit=0 restarts=0 health=unhealthy'
  touch "$MOCK_STATE/diagnosed"
elif [[ "$1 $2 $3" == 'image inspect fake-image' ]]; then
  touch "$MOCK_STATE/image-check"
  echo 'Image bytes: 12345'
else
  echo 'SECRET-DO-NOT-PRINT' >&2
  exit 99
fi
MOCK
cat > "$sandbox/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'curl %s\n' "$*" >> "$MOCK_STATE/commands"
url="${!#}"
expected='http://127.0.0.1:31001'
[[ ! -f "$MOCK_STATE/restarted" ]] || expected='http://127.0.0.1:32002'
[[ "$url" == "$expected/"* ]] || exit 7
[[ " $* " == *' --connect-timeout '* && " $* " == *' --max-time '* ]] || exit 99
case "$url" in
  */api/health)
    if [[ -f "$MOCK_STATE/restarted" ]]; then
      [[ "$MOCK_MODE" != unhealthy ]] || exit 7
      if [[ "$MOCK_MODE" == delayed && ! -f "$MOCK_STATE/probed" ]]; then
        touch "$MOCK_STATE/probed"
        exit 22
      fi
    fi
    echo '{"status":"ok"}' ;;
  */api/identity)
    [[ " $* " == *" Origin: $expected "* ]] || exit 99
    echo '{"data":{"ready":true}}' ;;
  */api/reservations)
    [[ " $* " == *" Origin: $expected "* ]] || exit 99
    if [[ -f "$MOCK_STATE/restarted" ]]; then touch "$MOCK_STATE/replayed"; fi
    echo '{"data":{"id":"same-reservation","isHost":true,"participants":[{"id":"host"}]}}' ;;
  *) exit 99 ;;
esac
MOCK
cat > "$sandbox/bin/sleep" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$sandbox/bin/"*
export PATH="$sandbox/bin:$PATH"
export MOCK_STATE MOCK_MODE
run_case() {
  MOCK_MODE="$1"
  MOCK_STATE="$sandbox/$MOCK_MODE"
  mkdir -p "$MOCK_STATE"
  local expected="$2" result=0
  bash "$sandbox/project/scripts/docker-smoke.sh" > "$MOCK_STATE/output" 2>&1 || result=$?
  if [[ "$expected" == success && "$result" -ne 0 ]] || [[ "$expected" == failure && "$result" -eq 0 ]]; then
    cat "$MOCK_STATE/output"
    echo "Unexpected result for $MOCK_MODE: $result" >&2
    exit 1
  fi
  test -f "$MOCK_STATE/cleaned"
  if grep -q 'SECRET-DO-NOT-PRINT' "$MOCK_STATE/output"; then echo 'Unsafe diagnostics' >&2; exit 1; fi
}
run_case port-change success
test -f "$MOCK_STATE/replayed"
test -f "$MOCK_STATE/runtime-check"
test -f "$MOCK_STATE/cli-check"
test -f "$MOCK_STATE/image-check"
grep -q 'Docker restart healthy at http://127.0.0.1:32002' "$MOCK_STATE/output"
run_case delayed success
test -f "$MOCK_STATE/replayed"
test "$(cat "$MOCK_STATE/discoveries")" -ge 4
run_case unhealthy failure
test ! -f "$MOCK_STATE/replayed"
test ! -f "$MOCK_STATE/runtime-check"
test -f "$MOCK_STATE/diagnosed"
grep -q 'Docker restart health check failed after 60 attempts' "$MOCK_STATE/output"
run_case missing-port failure
test ! -f "$MOCK_STATE/replayed"
test -f "$MOCK_STATE/diagnosed"
if grep -q 'curl .*http://127.0.0.1:0/' "$MOCK_STATE/commands"; then exit 1; fi
run_case cli-failure failure
test -f "$MOCK_STATE/replayed"
test -f "$MOCK_STATE/cli-check"
test ! -f "$MOCK_STATE/image-check"
echo 'Docker smoke orchestration: 5 scenarios passed (mocked Docker/curl)'
