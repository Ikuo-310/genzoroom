"""Build a frozen backend and retain a reviewable, non-secret distribution inventory."""
import argparse
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--channel', choices=('validation', 'stable'), required=True)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 14) or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise RuntimeError('unsupported_build_environment')
    backend_source = ROOT.parent / 'backend'
    sys.path.insert(0, str(backend_source))
    os.environ.update({
        'GENZOROOM_CHANNEL': args.channel,
        'GENZOROOM_VERSION': args.version,
        'GENZOROOM_COMMIT': args.commit,
    })
    try:
        from build_info import read_build_info
        build_info = read_build_info()
        if (build_info['channel'], build_info['version'], build_info['commit']) != (
                args.channel, args.version, args.commit):
            raise ValueError()
    except (ImportError, RuntimeError, ValueError):
        raise RuntimeError('invalid_build_metadata') from None
    output = args.output.resolve()
    # A new output directory prevents an interrupted build from looking like a completed package.
    output.mkdir(parents=True, exist_ok=False)
    manifest_path = output / 'build-manifest.json'
    packages = []
    runtime_names = re.findall(r'^([\w-]+)==', (ROOT / 'packaging/runtime.lock').read_text(), re.M)
    for name in runtime_names:
        distribution = metadata.distribution(name)
        packages.append({'name': distribution.metadata['Name'], 'version': distribution.version,
                         'license': distribution.metadata.get('License-Expression') or distribution.metadata.get('License', 'review required')})
    manifest = {'formatVersion': 1, 'channel': args.channel, 'version': args.version, 'commit': args.commit,
                'target': 'x86_64-pc-windows-msvc', 'python': platform.python_version(), 'runtime': packages,
                'tools': {name: metadata.version(name) for name in ('pyinstaller', 'pyinstaller-hooks-contrib')},
                'licenseReview': 'pending-public-distribution-review'}
    sources = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=ROOT.parent, text=True).splitlines()
    source_hash = hashlib.sha256()
    for name in sorted(set(sources)):
        path = ROOT.parent / name
        if path.is_file():
            source_hash.update(name.encode('utf-8') + b'\0' + path.read_bytes())
    manifest['sourceDigest'] = source_hash.hexdigest()
    manifest['dirty'] = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT.parent))
    write_json(manifest_path, manifest)
    env = {**os.environ, 'GENZOROOM_PACKAGE_MANIFEST': str(manifest_path)}
    subprocess.run([sys.executable, '-m', 'PyInstaller', '--clean', '--noconfirm', '--distpath', str(output / 'dist'),
                    '--workpath', str(output / 'work'), str(ROOT / 'packaging/backend.spec')], check=True, env=env)
    bundle = output / 'dist/genzoroom-backend'
    licenses = bundle / 'licenses'
    licenses.mkdir()
    shutil.copyfile(ROOT.parent / 'LICENSE', licenses / 'GenzoRoom-AGPL-3.0-only.txt')
    python_license = Path(sys.base_prefix) / 'LICENSE.txt'
    if not python_license.is_file():
        raise RuntimeError('python_license_missing')
    shutil.copyfile(python_license, licenses / 'Python-LICENSE.txt')
    # The bootloader is redistributed too; keep its exception text for license review.
    for name in [*runtime_names, 'pyinstaller', 'pyinstaller-hooks-contrib']:
        distribution = metadata.distribution(name)
        for file in distribution.files or []:
            if any(token in str(file).lower() for token in ('license', 'copying', 'notice')) and ('.dist-info/' in str(file).replace('\\', '/') or name == 'pyinstaller'):
                destination = licenses / name / str(file)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(distribution.locate_file(file), destination)
    shutil.copyfile(manifest_path, bundle / 'build-manifest.json')
    files = []
    for file in sorted(bundle.rglob('*')):
        if file.is_file():
            with file.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            files.append({'path': file.relative_to(bundle).as_posix(), 'bytes': file.stat().st_size, 'sha256': digest})
    write_json(bundle / 'inventory.json', {'files': files, 'licenseReview': {
        'notices': 'Original license files collected; completeness requires final artifact review.',
        'sourceReviewRequired': ['GenzoRoom corresponding source and build scripts', 'NumPy bundled GCC runtime source',
                                 'certifi MPL source', 'Pillow bundled components'],
        'otherReviewRequired': ['Microsoft runtime redistribution', 'Rust and frontend dependency notices']}})
    write_json(output / 'complete.json', {'backend': str(bundle.relative_to(output)), 'manifest': manifest})


if __name__ == '__main__':
    main()
