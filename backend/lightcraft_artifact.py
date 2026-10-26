"""Managed identity comes from the same manifest used by the native build gate."""

import json
from pathlib import Path
import re
import sys


def managed_manifest():
    root = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[1]))
    path = root / 'native/lightcraft/manifest.json'
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        # Docker has no native engine; do not invent an installed version there.
        return {}
    if not isinstance(value, dict) or not re.fullmatch(r'\d+\.\d+\.\d+', str(value.get('version', ''))) \
            or not re.fullmatch(r'[a-f0-9]{40}', str(value.get('commit', ''))) \
            or type(value.get('geometryDescriptorContract')) is not int or value['geometryDescriptorContract'] != 2 \
            or not isinstance(value.get('patches'), list) or not value['patches']:
        raise ValueError('invalid managed LightCraft manifest')
    return value


MANAGED = managed_manifest()
ENGINE_VERSION = MANAGED.get('version')
ENGINE_COMMIT = MANAGED.get('commit')


def resolve_managed_executable(environment, platform, *, project_root=None, frozen=None):
    """Prefer an explicit override; discover only the current managed build in a dev checkout."""
    if 'GENZOROOM_LIGHTCRAFT_EXE' in environment:
        return str(environment.get('GENZOROOM_LIGHTCRAFT_EXE') or '').strip()
    if platform != 'win32':
        return ''
    if frozen is None:
        frozen = bool(getattr(sys, 'frozen', False) or hasattr(sys, '_MEIPASS'))
    if frozen:
        return ''
    root = Path(project_root or Path(__file__).resolve().parents[1]).resolve()
    if not (root / '.git').exists():
        return ''
    manifest_path = root / 'native' / 'lightcraft' / 'manifest.json'
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        version = manifest.get('version') if isinstance(manifest, dict) else None
        if manifest != MANAGED or not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version):
            return ''
    except (OSError, ValueError, TypeError):
        return ''
    major_minor = '.'.join(version.split('.')[:2])
    candidate = root / '.tmp' / f'lightcraft-{major_minor}' / 'target' / 'release' / 'lightcraft-cli.exe'
    return str(candidate) if candidate.is_file() else ''


def verified_artifact(executable, digest, version):
    """A receipt identifies this process only when its complete managed tuple matches."""
    try:
        path = Path(executable).with_suffix('.genzoroom.json')
        if path.stat().st_size > 64 * 1024:
            return None
        value = json.loads(path.read_text(encoding='utf-8'))
        expected = {**{key: MANAGED[key] for key in ('version', 'commit', 'patches', 'geometryDescriptorContract')},
                    'binarySha256': digest, 'beforeContract': 1, 'previewContract': 1, 'regionContract': 1}
        if not isinstance(value, dict) or any(type(value.get(key)) is not int for key in
                ('beforeContract', 'previewContract', 'regionContract', 'geometryDescriptorContract')) \
                or value != expected or version != expected['version'] or not re.fullmatch(r'[a-f0-9]{64}', digest):
            return None
        return {'version': version, 'upstreamCommit': expected['commit'], 'managedPatch': True,
                'geometryDescriptorContract': expected['geometryDescriptorContract']}
    except (OSError, ValueError, KeyError, TypeError):
        return None
