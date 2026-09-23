#!/usr/bin/env bash
# CI authenticates to GHCR and loads the tested artifact before calling this script.
set +x
set -Eeuo pipefail
umask 077
fail() { printf 'Image publication failed: %s\n' "$1" >&2; exit 1; }
[[ "$#" -le 1 ]] || fail 'usage: GITHUB_SHA=<commit> bash scripts/publish-image.sh [artifact-directory]'
revision="${GITHUB_SHA:-}"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || fail 'GITHUB_SHA must be a full 40-character commit SHA'
artifact_directory="${1:-.}"
id_file="$artifact_directory/candidate-image-id.txt"
[[ -f "$id_file" && ! -L "$id_file" ]] || fail 'the tested image ID artifact is missing or invalid'
expected_id="$(cat -- "$id_file")"
[[ "$expected_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'the tested image ID artifact is malformed'
source="party-up-ci:$revision"
repository=ghcr.io/aloha1024/party-up
tag="$repository:sha-$revision"
candidate_id="$(docker image inspect --format '{{.Id}}' "$source" 2>/dev/null)" || fail 'the tested candidate image is not loaded'
[[ "$candidate_id" == "$expected_id" ]] || fail 'loaded candidate ID does not match the tested artifact'
candidate_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$source" 2>/dev/null)" || fail 'cannot inspect the candidate revision'
[[ "$candidate_revision" == "$revision" ]] || fail 'candidate OCI revision does not match GITHUB_SHA'
candidate_version="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$source" 2>/dev/null | sed -n 's/^APP_VERSION=//p')" || fail 'cannot inspect the candidate application version'
[[ "$candidate_version" == "$revision" ]] || fail 'candidate APP_VERSION does not match GITHUB_SHA'

scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
# Capture CLI output privately. Print only validated identifiers, never auth/server logs.
docker tag "$source" "$tag" > "$scratch/tag.log" 2>&1 || fail 'could not tag the verified candidate'
docker push "$tag" > "$scratch/push.log" 2>&1 || fail 'GHCR rejected the image push; check the authenticated CI step and package permissions'
digest="$(awk -v tag="sha-$revision:" '$1 == tag && $2 == "digest:" {print $3}' "$scratch/push.log")"
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'push completed without one valid registry digest'
image="$repository@$digest"
docker pull "$image" > "$scratch/pull.log" 2>&1 || fail 'could not pull the published image by its registry digest'
published_id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null)" || fail 'could not inspect the image pulled by digest'
[[ "$published_id" == "$expected_id" ]] || fail 'published image ID differs from the tested artifact'

printf 'Published and verified: %s\nCommit: %s\nImage ID: %s\n' "$image" "$revision" "$expected_id"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '\n## Published container\n\n- Commit: `%s`\n- SHA tag: `%s`\n- Immutable image: `%s`\n- Verified image ID: `%s`\n' \
    "$revision" "$tag" "$image" "$expected_id" >> "$GITHUB_STEP_SUMMARY"
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'image=%s\ndigest=%s\ntag=%s\nimage_id=%s\nrevision=%s\n' \
    "$image" "$digest" "$tag" "$expected_id" "$revision" >> "$GITHUB_OUTPUT"
fi
