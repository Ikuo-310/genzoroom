#!/usr/bin/env python3
"""Compare a published image version with a stable release version."""

import re
import sys


STABLE = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")


def parts(value: str) -> tuple[int, int, int] | None:
    match = STABLE.fullmatch(value)
    return tuple(map(int, match.groups())) if match else None


def main(current: str, target: str) -> int:
    target_version = parts(target)
    if target_version is None:
        print("Target must be a stable vMAJOR.MINOR.PATCH version.", file=sys.stderr)
        return 2
    if current == "0.0.0-validation":
        print("newer")
        return 0
    current_version = parts(current)
    if current_version is None:
        print("Current latest image has an unknown release version.", file=sys.stderr)
        return 2
    print("newer" if target_version > current_version else "same" if target_version == current_version else "older")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: compare-release-versions.py CURRENT TARGET")
    raise SystemExit(main(sys.argv[1], sys.argv[2]))
