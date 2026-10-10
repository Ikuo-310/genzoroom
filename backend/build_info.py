"""Validated, build-time application identity for the release runtime."""

import os
import re


_VERSION = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")


def read_build_info() -> dict:
    channel = os.getenv("GENZOROOM_CHANNEL", "development")
    version = os.getenv("GENZOROOM_VERSION", "0.0.0-development")
    commit = os.getenv("GENZOROOM_COMMIT") or None
    if channel == "development":
        if version != "0.0.0-development" or commit is not None:
            raise RuntimeError("Invalid development build metadata")
    elif channel == "validation":
        if version != "0.0.0-validation" or not commit or not _COMMIT.fullmatch(commit):
            raise RuntimeError("Invalid validation build metadata")
    elif channel == "stable":
        if not _VERSION.fullmatch(version) or not commit or not _COMMIT.fullmatch(commit):
            raise RuntimeError("Invalid stable build metadata")
    else:
        raise RuntimeError("Invalid GenzoRoom build channel")
    return {"name": "GenzoRoom", "version": version, "channel": channel, "commit": commit}


BUILD_INFO = read_build_info()
