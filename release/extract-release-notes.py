#!/usr/bin/env python3
"""Build release notes only from the exact version section in CHANGELOG.md."""

import argparse
import re
import sys
from pathlib import Path


VERSION = re.compile(r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
HEADING = re.compile(r"^## \[(v?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\](?:\s+-\s+.+)?\s*$")
IMAGE = "ghcr.io/ikuo-310/genzoroom"
DEPLOYMENT = "docs/deployment.md#install-the-ghcr-distribution-without-cloning-source"


def extract(changelog: str, tag: str) -> str:
    match = VERSION.fullmatch(tag)
    if not match:
        raise ValueError("Release tag must be vMAJOR.MINOR.PATCH.")
    wanted = ".".join(match.groups())
    lines = changelog.splitlines()
    starts = [index for index, line in enumerate(lines)
              if (heading := HEADING.fullmatch(line)) and heading.group(1).removeprefix("v") == wanted]
    if not starts:
        raise ValueError(f"No CHANGELOG section exists for {tag}; finalize its version section before tagging.")
    if len(starts) != 1:
        raise ValueError(f"CHANGELOG has multiple sections for {tag}.")
    start = starts[0] + 1
    end = next((index for index in range(start, len(lines)) if lines[index].startswith("## ")), len(lines))
    body = "\n".join(lines[start:end]).strip()
    if not body:
        raise ValueError(f"CHANGELOG section for {tag} is empty.")
    deployment_url = f"https://github.com/Ikuo-310/genzoroom/blob/{tag}/{DEPLOYMENT}"
    return (f"{body}\n\n---\n\n**Container image:** `{IMAGE}:{tag}`\n\n"
            f"Install using the [deployment guide]({deployment_url}).\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--changelog", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        notes = extract(args.changelog.read_text(encoding="utf-8"), args.tag)
    except (OSError, ValueError) as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    args.output.write_text(notes, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
