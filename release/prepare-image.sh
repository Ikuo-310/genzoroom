#!/usr/bin/env bash
set -euo pipefail

reject() { printf '::error::%s\n' "$1" >&2; exit 1; }
automation_commit=$(git rev-parse HEAD)

case "$GITHUB_EVENT_NAME" in
  workflow_dispatch)
    [[ "$GITHUB_REF" == refs/heads/main ]] || reject 'Dispatch must use the main workflow.'
    source_sha=$REQUESTED_COMMIT
    ;;
  push)
    [[ "$GITHUB_REF" =~ ^refs/tags/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
      reject 'Only stable vMAJOR.MINOR.PATCH tags can publish versioned images.'
    source_sha=$GITHUB_SHA
    ;;
  *) reject 'Unsupported publishing event.' ;;
esac

# A full SHA prevents option/ref injection and ambiguous short-SHA resolution.
[[ "$source_sha" =~ ^[0-9a-fA-F]{40}$ ]] || reject 'Supply a full 40-character commit SHA.'
commit=$(git rev-parse --verify "${source_sha}^{commit}") || reject 'Commit was not found.'
git merge-base --is-ancestor "$commit" "$automation_commit" || reject 'Commit must already belong to main history.'

if [[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]]; then
  [[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]] || reject 'Invalid run identity.'
  # Rebuilding one commit must not overwrite an earlier validation image.
  image_tag="sha-${commit}-run${GITHUB_RUN_ID}-attempt${GITHUB_RUN_ATTEMPT}"
  channel=validation
  version=0.0.0-validation
else
  tag_commit=$(git rev-parse --verify "${GITHUB_REF}^{commit}") || reject 'Stable tag was not found.'
  [[ "$tag_commit" == "$commit" ]] || reject 'Tag no longer identifies the triggering commit.'
  image_tag=${GITHUB_REF#refs/tags/}
  channel=stable
  version=$image_tag
fi

# No latest alias is created, even for stable releases.
{
  printf 'commit=%s\n' "$commit"
  printf 'automation_commit=%s\n' "$automation_commit"
  printf 'image_tag=%s\n' "$image_tag"
  printf 'channel=%s\n' "$channel"
  printf 'version=%s\n' "$version"
} >> "$GITHUB_OUTPUT"
