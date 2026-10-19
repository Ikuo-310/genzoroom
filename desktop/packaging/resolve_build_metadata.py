"""Resolve Windows build identity from an exact, clean release tag or validation commit."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess


STABLE_TAG = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
VALIDATION_VERSION = "0.0.0-validation"


def git(repository: Path, *arguments: str) -> str:
    return subprocess.check_output(
        ["git", *arguments], cwd=repository, text=True, encoding="utf-8"
    ).strip()


def resolve_build_metadata(repository: Path, require_release: bool = False) -> dict[str, str]:
    commit = git(repository, "rev-parse", "HEAD")
    if not COMMIT.fullmatch(commit):
        raise ValueError("release_commit_invalid")

    dirty = bool(git(repository, "status", "--porcelain", "--untracked-files=all"))
    tags = [
        tag
        for tag in git(repository, "tag", "--points-at", commit).splitlines()
        if STABLE_TAG.fullmatch(tag)
    ]
    if require_release and dirty:
        raise ValueError("release_worktree_dirty")
    if require_release and len(tags) != 1:
        raise ValueError("release_tag_required")

    if not dirty and len(tags) == 1:
        version = tags[0]
        result = {
            "channel": "stable",
            "version": version,
            "packageVersion": version[1:],
            "commit": commit,
        }
        return result
    result = {
        "channel": "validation",
        "version": VALIDATION_VERSION,
        "packageVersion": VALIDATION_VERSION,
        "commit": commit,
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", type=Path, required=True)
    parser.add_argument("--require-release", action="store_true")
    arguments = parser.parse_args()
    try:
        metadata = resolve_build_metadata(arguments.repository.resolve(), arguments.require_release)
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        code = str(error) if isinstance(error, ValueError) else "release_metadata_unavailable"
        parser.error(code)
    print(json.dumps(metadata, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
