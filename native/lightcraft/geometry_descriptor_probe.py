"""Run a test-only descriptor investigation without changing managed Native runtime sources."""
import argparse
import importlib.util
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--input', type=Path, required=True, help='Private cached-source/settings input; never printed')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--target-dir', type=Path, required=True)
    parser.add_argument('--gpu-backend', choices=('off', 'dx12'), default='off')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location('managed_build', root / 'build.py')
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    manifest = build.manifest()
    if build.prepare(args.source, manifest) != 'patched':
        raise ValueError('the investigation requires the exact managed patched source')
    tests = args.source / 'crates/mcp/src/region/tests.rs'
    original = tests.read_bytes()
    include = (root / 'geometry_descriptor_probe.rs').as_posix()
    environment = {**os.environ, 'LIGHTCRAFT_GPU': '0' if args.gpu_backend == 'off' else '1',
        'LIGHTCRAFT_GPU_BACKEND': args.gpu_backend,
        'GENZOROOM_GEOMETRY_PROBE_INPUT': str(args.input.resolve()),
        'GENZOROOM_GEOMETRY_PROBE_OUTPUT': str(args.output.resolve())}
    try:
        # Only this test target sees the include; release sources and existing binaries stay intact.
        tests.write_bytes(original + f'\nmod descriptor_probe {{ include!(r"{include}"); }}\n'.encode())
        subprocess.run(['cargo', 'test', '--locked', '--target-dir', str(args.target_dir), '-p', 'lightcraft-mcp',
            'descriptor_probe', '--', '--test-threads=1'], cwd=args.source, env=environment, check=True)
    finally:
        tests.write_bytes(original)
        if build.prepare(args.source, manifest) != 'patched':
            raise ValueError('managed source restoration failed')


if __name__ == '__main__':
    main()
