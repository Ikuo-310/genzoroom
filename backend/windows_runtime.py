"""Windows deployment paths; frozen and PoC data never discover or migrate one another."""
import json
import os
from pathlib import Path
import sys


def packaged():
    return bool(getattr(sys, 'frozen', False))


def data_root():
    base = Path(os.environ.get('LOCALAPPDATA', ''))
    if not base.is_absolute() or base.drive.startswith('\\\\'):
        raise ValueError('invalid_local_data')
    root = base / 'GenzoRoom'
    if not packaged():
        root /= 'WindowsPoC'
    if root.resolve().drive.startswith('\\\\'):
        raise ValueError('invalid_local_data')
    return root


def credential_namespace():
    return 'GenzoRoom/Immich/' if packaged() else 'GenzoRoom/WindowsPoC/Immich/'


def apply_build_info():
    if not packaged():
        return
    try:
        path = Path(__file__).resolve().parent / 'build-manifest.json'
        if path.stat().st_size > 65536:
            raise ValueError()
        info = json.loads(path.read_text(encoding='utf-8'))
        for field in ('channel', 'version', 'commit'):
            if not isinstance(info[field], str):
                raise ValueError()
        # A frozen child must not report identity inherited from a developer shell.
        for field in ('channel', 'version', 'commit'):
            os.environ['GENZOROOM_' + field.upper()] = info[field]
        from build_info import read_build_info
        read_build_info()
    except (OSError, ValueError, KeyError, RuntimeError):
        raise RuntimeError('backend_build_info_invalid') from None
