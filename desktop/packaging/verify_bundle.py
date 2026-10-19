"""Fail closed on incomplete copies, mismatched resources, or the wrong PE subsystem."""
import argparse
import hashlib
import json
from pathlib import Path
import struct


def pe_identity(path):
    with path.open('rb') as stream:
        if stream.read(2) != b'MZ':
            raise RuntimeError('invalid_executable')
        stream.seek(0x3c)
        offset = struct.unpack('<I', stream.read(4))[0]
        stream.seek(offset)
        if stream.read(4) != b'PE\0\0':
            raise RuntimeError('invalid_executable')
        machine = struct.unpack('<H', stream.read(2))[0]
        stream.seek(offset + 24 + 68)
        subsystem = struct.unpack('<H', stream.read(2))[0]
    return machine, subsystem


def verify(bundle, frontend=None):
    if pe_identity(bundle / 'genzoroom-backend.exe') != (0x8664, 3):
        raise RuntimeError('backend_requires_x64_console_subsystem')
    inventory = json.loads((bundle / 'inventory.json').read_text(encoding='utf-8'))
    expected = {entry['path'] for entry in inventory['files']} | {'inventory.json'}
    actual = {path.relative_to(bundle).as_posix() for path in bundle.rglob('*') if path.is_file()}
    if actual != expected:
        raise RuntimeError('bundle_inventory_file_set_mismatch')
    for entry in inventory['files']:
        relative = Path(entry['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('invalid_inventory_path')
        path = bundle / relative
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if path.stat().st_size != entry['bytes'] or digest != entry['sha256']:
            raise RuntimeError('bundle_inventory_mismatch')
    embedded = bundle / '_internal/frontend/dist'
    if not (embedded / 'index.html').is_file():
        raise RuntimeError('frontend_build_missing')
    if frontend:
        for original in frontend.rglob('*'):
            if original.is_file() and original.read_bytes() != (embedded / original.relative_to(frontend)).read_bytes():
                raise RuntimeError('frontend_resource_mismatch')
    if (bundle / 'build-manifest.json').read_bytes() != (bundle / '_internal/build-manifest.json').read_bytes():
        raise RuntimeError('build_manifest_mismatch')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--frontend', type=Path)
    parser.add_argument('--host', type=Path)
    args = parser.parse_args()
    verify(args.bundle, args.frontend)
    if args.host and pe_identity(args.host) != (0x8664, 2):
        raise RuntimeError('host_requires_x64_windows_subsystem')
