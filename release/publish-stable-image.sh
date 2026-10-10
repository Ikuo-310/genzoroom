#!/usr/bin/env bash
set -Eeuo pipefail

: "${IMAGE_REF:?Set IMAGE_REF}"
: "${LATEST_REF:?Set LATEST_REF}"
: "${EXPECTED_REVISION:?Set EXPECTED_REVISION}"
: "${GENZOROOM_VERSION:?Set GENZOROOM_VERSION}"
: "${RUNNER_TEMP:?Set RUNNER_TEMP}"
: "${GITHUB_STEP_SUMMARY:?Set GITHUB_STEP_SUMMARY}"
: "${GITHUB_OUTPUT:?Set GITHUB_OUTPUT}"

[[ "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid source revision.' >&2; exit 2; }
[[ "$GENZOROOM_VERSION" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
  echo 'Invalid stable image version.' >&2
  exit 2
}

candidate_ref="ghcr.io/ikuo-310/genzoroom:release-candidate-${EXPECTED_REVISION}"
fixed_status=not_published
latest_status=not_updated
fixed_digest=unknown
latest_digest=unknown

summary_failure() {
  local code=$?
  printf 'Stable publish failed (exit %s). Fixed tag: `%s` (%s, %s). latest: `%s` (%s, %s).\n' \
    "$code" "$IMAGE_REF" "$fixed_status" "$fixed_digest" "$LATEST_REF" "$latest_status" "$latest_digest" \
    >> "$GITHUB_STEP_SUMMARY"
}
trap summary_failure ERR
trap 'docker image rm "$candidate_ref" >/dev/null 2>&1 || true' EXIT

docker image tag "$IMAGE_REF" "$candidate_ref"
candidate_id=$(docker image inspect "$candidate_ref" --format '{{.Id}}')

inspect_manifest() {
  local ref=$1 output=$2 error=$3
  if docker buildx imagetools inspect --raw "$ref" >"$output" 2>"$error"; then
    return 0
  fi
  if grep -Eqi 'manifest unknown|not found|404' "$error"; then
    return 1
  fi
  cat "$error" >&2
  return 2
}

manifest_digest() {
  local ref=$1 manifest error digest
  manifest=$(mktemp "$RUNNER_TEMP/genzoroom-manifest.XXXXXX")
  error=$(mktemp "$RUNNER_TEMP/genzoroom-error.XXXXXX")
  if ! inspect_manifest "$ref" "$manifest" "$error"; then
    cat "$error" >&2
    rm -f "$manifest" "$error"
    return 1
  fi
  digest="sha256:$(sha256sum "$manifest" | cut -d ' ' -f1)"
  rm -f "$manifest" "$error"
  printf '%s' "$digest"
}

remote_manifest=$(mktemp "$RUNNER_TEMP/genzoroom-fixed.XXXXXX")
remote_error=$(mktemp "$RUNNER_TEMP/genzoroom-fixed-error.XXXXXX")
if inspect_manifest "$IMAGE_REF" "$remote_manifest" "$remote_error"; then
  # A stable version tag is immutable; retries may continue only with the tested same image.
  fixed_status=present_unverified
  docker pull "$IMAGE_REF"
  existing_id=$(docker image inspect "$IMAGE_REF" --format '{{.Id}}')
  if [[ "$existing_id" != "$candidate_id" ]]; then
    existing_revision=$(docker image inspect "$IMAGE_REF" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
    existing_version=$(docker image inspect "$IMAGE_REF" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
    [[ "$existing_revision" == "$EXPECTED_REVISION" && "$existing_version" == "$GENZOROOM_VERSION" ]] || {
      fixed_status=existing_conflict
      echo "Refusing to reuse or overwrite immutable image tag $IMAGE_REF with different source metadata." >&2
      exit 1
    }
    # Rebuilt base layers may drift; re-test the already-published immutable image before resuming.
    bash release/smoke-test.sh
    fixed_status=reused_after_smoke
  else
    fixed_status=reused
  fi
else
  inspect_status=$?
  [[ $inspect_status -eq 1 ]] || { cat "$remote_error" >&2; exit 1; }
  docker image tag "$candidate_ref" "$IMAGE_REF"
  fixed_status=publishing
  docker push "$IMAGE_REF"
  fixed_status=published
fi
rm -f "$remote_manifest" "$remote_error"
fixed_digest=$(manifest_digest "$IMAGE_REF")

latest_manifest=$(mktemp "$RUNNER_TEMP/genzoroom-latest.XXXXXX")
latest_error=$(mktemp "$RUNNER_TEMP/genzoroom-latest-error.XXXXXX")
if inspect_manifest "$LATEST_REF" "$latest_manifest" "$latest_error"; then
  latest_status=existing_unchecked
  docker pull "$LATEST_REF"
  latest_version=$(docker image inspect "$LATEST_REF" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
  # Compare SemVer before moving the mutable alias so historical reruns cannot roll it back.
  comparison=$(python3 release/compare-release-versions.py "$latest_version" "$GENZOROOM_VERSION")
  case "$comparison" in
    newer)
      docker image tag "$IMAGE_REF" "$LATEST_REF"
      latest_status=updating
      docker push "$LATEST_REF"
      latest_status=updated
      ;;
    same)
      latest_status=already_current
      ;;
    older)
      latest_status=retained_newer_release
      ;;
    *) echo "Unexpected release comparison: $comparison" >&2; exit 1 ;;
  esac
else
  inspect_status=$?
  [[ $inspect_status -eq 1 ]] || { cat "$latest_error" >&2; exit 1; }
  docker image tag "$IMAGE_REF" "$LATEST_REF"
  latest_status=creating
  docker push "$LATEST_REF"
  latest_status=created
fi
rm -f "$latest_manifest" "$latest_error"

latest_digest=$(manifest_digest "$LATEST_REF")
if [[ "$latest_status" == updated || "$latest_status" == created || "$latest_status" == already_current ]]; then
  [[ "$latest_digest" == "$fixed_digest" ]] || {
    echo 'The latest tag digest does not match the fixed version image.' >&2
    exit 1
  }
fi

{
  printf 'fixed_status=%s\n' "$fixed_status"
  printf 'fixed_digest=%s\n' "$fixed_digest"
  printf 'latest_status=%s\n' "$latest_status"
  printf 'latest_digest=%s\n' "$latest_digest"
} >> "$GITHUB_OUTPUT"
{
  printf 'Fixed version tag: `%s` (%s, `%s`).\n\n' "$IMAGE_REF" "$fixed_status" "$fixed_digest"
  printf '`latest`: `%s` (%s, `%s`).\n\n' "$LATEST_REF" "$latest_status" "$latest_digest"
  printf 'The fixed version and `latest` digests match when `latest` points to this release. Platform: `linux/amd64`.\n'
} >> "$GITHUB_STEP_SUMMARY"
trap - ERR
