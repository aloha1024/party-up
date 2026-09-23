#!/usr/bin/env bash
# Publish orchestration regression tests. Docker is mocked; no registry is contacted.
set -Eeuo pipefail
sandbox="$(mktemp -d)"
trap 'rm -rf -- "$sandbox"' EXIT
mkdir -p "$sandbox/bin"
script="$PWD/scripts/publish-image.sh"
export MOCK_SHA="$(printf '1%.0s' {1..40})"
export MOCK_IMAGE_ID="sha256:$(printf 'a%.0s' {1..64})"
export MOCK_DIGEST="sha256:$(printf 'b%.0s' {1..64})"
export MOCK_DIFFERENT_ID="sha256:$(printf 'c%.0s' {1..64})"
export MOCK_LOG MOCK_MODE GITHUB_SHA GITHUB_OUTPUT GITHUB_STEP_SUMMARY
cat > "$sandbox/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$MOCK_LOG"
source="party-up-ci:$MOCK_SHA"
tag="ghcr.io/aloha1024/party-up:sha-$MOCK_SHA"
image="ghcr.io/aloha1024/party-up@$MOCK_DIGEST"
case "$1 $2" in
  'image inspect')
    [[ "$3" == --format ]]
    if [[ "$5" == "$source" ]]; then
      case "$4" in
        '{{.Id}}')
          if [[ "$MOCK_MODE" == wrong-id ]]; then echo "$MOCK_DIFFERENT_ID"; else echo "$MOCK_IMAGE_ID"; fi ;;
        '{{index .Config.Labels "org.opencontainers.image.revision"}}')
          if [[ "$MOCK_MODE" == wrong-revision ]]; then echo development; else echo "$MOCK_SHA"; fi ;;
        '{{range .Config.Env}}{{println .}}{{end}}')
          echo 'UNRELATED_SETTING=MOCKSECRET'
          if [[ "$MOCK_MODE" == wrong-version ]]; then echo APP_VERSION=development; else echo "APP_VERSION=$MOCK_SHA"; fi ;;
        *) exit 99 ;;
      esac
    elif [[ "$5" == "$image" && "$4" == '{{.Id}}' ]]; then
      if [[ "$MOCK_MODE" == wrong-published-id ]]; then echo "$MOCK_DIFFERENT_ID"; else echo "$MOCK_IMAGE_ID"; fi
    else exit 99; fi
    ;;
  *)
    case "$1" in
      tag)
        [[ "$2" == "$source" && "$3" == "$tag" ]]
        if [[ "$MOCK_MODE" == tag-failure ]]; then echo MOCKSECRET >&2; exit 1; fi ;;
      push)
        [[ "$2" == "$tag" ]]
        if [[ "$MOCK_MODE" == push-failure ]]; then echo MOCKSECRET >&2; exit 1; fi
        echo 'Layer already exists'
        if [[ "$MOCK_MODE" != missing-digest ]]; then printf 'sha-%s: digest: %s size: 1234\n' "$MOCK_SHA" "$MOCK_DIGEST"; fi ;;
      pull)
        [[ "$2" == "$image" ]]
        if [[ "$MOCK_MODE" == pull-failure ]]; then echo MOCKSECRET >&2; exit 1; fi ;;
      *) echo 'Unexpected Docker command' >&2; exit 99 ;;
    esac
    ;;
esac
MOCK
chmod +x "$sandbox/bin/docker"
export PATH="$sandbox/bin:$PATH"
run_case() {
  MOCK_MODE="$1"
  local expected="$2" result=0
  local directory="$sandbox/$MOCK_MODE"
  mkdir -p "$directory"
  MOCK_LOG="$directory/commands"
  GITHUB_SHA="$MOCK_SHA"
  GITHUB_OUTPUT="$directory/github-output"
  GITHUB_STEP_SUMMARY="$directory/summary"
  : > "$MOCK_LOG"
  printf '%s\n' "$MOCK_IMAGE_ID" > "$directory/candidate-image-id.txt"
  if [[ "$MOCK_MODE" == wrong-sha ]]; then GITHUB_SHA=short; fi
  if [[ "$MOCK_MODE" == malformed-id ]]; then echo invalid > "$directory/candidate-image-id.txt"; fi
  if [[ "$MOCK_MODE" == success-default ]]; then
    (cd "$directory"; bash "$script") > "$directory/output" 2>&1 || result=$?
  else
    bash "$script" "$directory" > "$directory/output" 2>&1 || result=$?
  fi
  if [[ "$expected" == success && "$result" -ne 0 ]] || [[ "$expected" == failure && "$result" -eq 0 ]]; then
    cat "$directory/output"
    echo "Unexpected result for $MOCK_MODE: $result" >&2
    exit 1
  fi
  if grep -q 'MOCKSECRET' "$directory/output"; then echo 'CLI secrets leaked' >&2; exit 1; fi
  if grep -Eq '^build |:latest' "$MOCK_LOG"; then echo 'Unexpected rebuild or latest publication' >&2; exit 1; fi
  if [[ "$expected" == failure ]]; then
    test ! -s "$GITHUB_OUTPUT"
    test ! -s "$GITHUB_STEP_SUMMARY"
  fi
}
run_case success success
grep -q "^push ghcr.io/aloha1024/party-up:sha-$MOCK_SHA$" "$MOCK_LOG"
grep -q "^pull ghcr.io/aloha1024/party-up@$MOCK_DIGEST$" "$MOCK_LOG"
grep -q "^image=ghcr.io/aloha1024/party-up@$MOCK_DIGEST$" "$GITHUB_OUTPUT"
grep -q "$MOCK_IMAGE_ID" "$GITHUB_STEP_SUMMARY"
run_case success-default success
for scenario in wrong-sha malformed-id wrong-id wrong-revision wrong-version; do
  run_case "$scenario" failure
  if grep -Eq '^(tag|push|pull) ' "$MOCK_LOG"; then echo 'Invalid candidate reached registry steps' >&2; exit 1; fi
done
run_case tag-failure failure
if grep -Eq '^(push|pull) ' "$MOCK_LOG"; then exit 1; fi
run_case push-failure failure
if grep -q '^pull ' "$MOCK_LOG"; then exit 1; fi
run_case missing-digest failure
if grep -q '^pull ' "$MOCK_LOG"; then exit 1; fi
run_case pull-failure failure
run_case wrong-published-id failure
echo 'Image publication: 12 scenarios passed (mocked Docker, no registry access)'
