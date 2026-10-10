#!/usr/bin/env bash
set -Eeuo pipefail

: "${GENZOROOM_VERSION:?Set GENZOROOM_VERSION}"
: "${RELEASE_NOTES_FILE:?Set RELEASE_NOTES_FILE}"
: "${GITHUB_STEP_SUMMARY:?Set GITHUB_STEP_SUMMARY}"
: "${GH_TOKEN:?Set GH_TOKEN}"
: "${GH_REPO:?Set GH_REPO}"
: "${FIXED_DIGEST:?Set FIXED_DIGEST}"
: "${LATEST_STATUS:?Set LATEST_STATUS}"
: "${LATEST_DIGEST:?Set LATEST_DIGEST}"

release_status=not_created
summary_failure() {
  local code=$?
  printf 'GitHub Release failed (exit %s); GHCR fixed image `ghcr.io/ikuo-310/genzoroom:%s` is `%s`, latest is `%s` (`%s`).\n' \
    "$code" "$GENZOROOM_VERSION" "$FIXED_DIGEST" "$LATEST_STATUS" "$LATEST_DIGEST" \
    >> "$GITHUB_STEP_SUMMARY"
}
trap summary_failure ERR

[[ "$GENZOROOM_VERSION" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
  echo 'Invalid stable release tag.' >&2
  exit 2
}
[[ -s "$RELEASE_NOTES_FILE" ]] || { echo 'Release notes are missing or empty.' >&2; exit 2; }

release_url="${GITHUB_SERVER_URL:?}/$GH_REPO/releases/tag/$GENZOROOM_VERSION"
error_file=$(mktemp)
if release_json=$(gh release view "$GENZOROOM_VERSION" --repo "$GH_REPO" \
    --json tagName,name,isDraft,isPrerelease 2>"$error_file"); then
  python3 -c 'import json,sys; r=json.load(sys.stdin); expected=sys.argv[1];
assert r.get("tagName") == expected, "existing release tag mismatch";
assert r.get("name") == f"GenzoRoom {expected}", "existing release title mismatch";
assert r.get("isDraft") is False, "existing release is draft";
assert r.get("isPrerelease") is False, "existing release is prerelease"' "$GENZOROOM_VERSION" <<<"$release_json" || {
    rm -f "$error_file"
    echo 'An existing GitHub Release has unexpected metadata; it was left unchanged.' >&2
    exit 1
  }
  release_status=reused
else
  if ! grep -Eqi 'release not found|HTTP 404|404 Not Found' "$error_file"; then
    cat "$error_file" >&2
    rm -f "$error_file"
    exit 1
  fi
  rm -f "$error_file"
  # --verify-tag prevents gh from creating a Git tag; the pushed stable tag must already exist.
  gh release create "$GENZOROOM_VERSION" --repo "$GH_REPO" --verify-tag \
    --title "GenzoRoom $GENZOROOM_VERSION" --notes-file "$RELEASE_NOTES_FILE"
  release_status=created
fi
rm -f "$error_file"

{
  printf 'GitHub Release: [%s](%s) (%s, public, non-draft, non-prerelease).\n\n' \
    "$GENZOROOM_VERSION" "$release_url" "$release_status"
  printf 'GHCR fixed image: `ghcr.io/ikuo-310/genzoroom:%s` (`%s`).\n\n' \
    "$GENZOROOM_VERSION" "$FIXED_DIGEST"
  printf 'GHCR `latest`: %s (`%s`).\n' "$LATEST_STATUS" "$LATEST_DIGEST"
} >> "$GITHUB_STEP_SUMMARY"
trap - ERR
