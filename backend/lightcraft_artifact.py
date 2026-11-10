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
            or not isinstance(value.get('patches'), list) or not value['patches']:
        raise ValueError('invalid managed LightCraft manifest')
    if value.get('wholeFrameContract') == 1 and type(value['wholeFrameContract']) is int:
        if 'cropEditContract' in value and (type(value['cropEditContract']) is not int or value['cropEditContract'] != 1):
            raise ValueError('invalid managed LightCraft manifest')
        for key in ('beforeAfterContract', 'draftContract'):
            if key in value and (type(value[key]) is not int or value[key] != 1):
                raise ValueError('invalid managed LightCraft manifest')
        return value
    if type(value.get('geometryDescriptorContract')) is not int or value['geometryDescriptorContract'] != 2 \
            or value.get('contracts') != {'before': 1, 'preview': 1, 'region': 1, 'wb': 1} \
            or any(type(version) is not int for version in value.get('contracts', {}).values()) \
            or ('cropEditContract' in value and (type(value['cropEditContract']) is not int or value['cropEditContract'] != 1)) \
            or ('lensProfileInfoContract' in value and (type(value['lensProfileInfoContract']) is not int or value['lensProfileInfoContract'] != 1)):
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
    target = manifest.get('developmentTargetDir', 'target')
    if not isinstance(target, str) or not re.fullmatch(r'target(?:-[a-z0-9]+)*', target):
        return ''
    # Patch-version checkouts keep the previous verified executable available for comparisons.
    suffixes = ((f'{version}-p3', f'{version}-p1', version, major_minor) if manifest.get('cropEditContract') == 1
                else (f'{version}-p1', version, major_minor) if manifest.get('wholeFrameContract') == 1 else (version, major_minor))
    for suffix in suffixes:
        candidate = root / '.tmp' / f'lightcraft-{suffix}' / target / 'release' / 'lightcraft-cli.exe'
        if candidate.is_file():
            return str(candidate)
    return ''


def verified_artifact(executable, digest, version):
    """A receipt identifies this process only when its complete managed tuple matches."""
    try:
        path = Path(executable).with_suffix('.genzoroom.json')
        if path.stat().st_size > 64 * 1024:
            return None
        value = json.loads(path.read_text(encoding='utf-8'))
        if MANAGED.get('wholeFrameContract') == 1:
            expected = {**{key: MANAGED[key] for key in ('version', 'commit', 'patches')},
                        'binarySha256': digest, 'wholeFrameContract': 1,
                        **({'cropEditContract': 1} if MANAGED.get('cropEditContract') == 1 else {}),
                        **({'beforeAfterContract': 1} if MANAGED.get('beforeAfterContract') == 1 else {}),
                        **({'draftContract': 1} if MANAGED.get('draftContract') == 1 else {})}
            if not isinstance(value, dict) or type(value.get('wholeFrameContract')) is not int \
                or any(type(value.get(key)) is not int for key in ('cropEditContract', 'beforeAfterContract', 'draftContract') if key in expected) or value != expected \
                    or version != expected['version'] or not re.fullmatch(r'[a-f0-9]{64}', digest):
                return None
            return {'version': version, 'upstreamCommit': expected['commit'], 'managedPatch': True,
                    'wholeFrameContract': 1,
                    **({'beforeAfterContract': 1} if 'beforeAfterContract' in expected else {}),
                    **({'draftContract': 1} if 'draftContract' in expected else {})}
        expected = {**{key: MANAGED[key] for key in ('version', 'commit', 'patches', 'geometryDescriptorContract')},
                    'binarySha256': digest, 'beforeContract': 1, 'previewContract': 1, 'regionContract': 1,
                    **({'cropEditContract': 1} if MANAGED.get('cropEditContract') == 1 else {}),
                    **({'wbContract': 1} if MANAGED.get('contracts', {}).get('wb') == 1 else {}),
                    **({'lensProfileInfoContract': 1} if MANAGED.get('lensProfileInfoContract') == 1 else {})}
        if not isinstance(value, dict) or any(type(value.get(key)) is not int for key in
                ('beforeContract', 'previewContract', 'regionContract', 'geometryDescriptorContract',
                 *(['cropEditContract'] if 'cropEditContract' in expected else []),
                *(['wbContract'] if 'wbContract' in expected else []),
                *(['lensProfileInfoContract'] if 'lensProfileInfoContract' in expected else []))) \
                or value != expected or version != expected['version'] or not re.fullmatch(r'[a-f0-9]{64}', digest):
            return None
        return {'version': version, 'upstreamCommit': expected['commit'], 'managedPatch': True,
                'geometryDescriptorContract': expected['geometryDescriptorContract'],
                **({'lensProfileInfoContract': expected['lensProfileInfoContract']}
                   if 'lensProfileInfoContract' in expected else {})}
    except (OSError, ValueError, KeyError, TypeError):
        return None
