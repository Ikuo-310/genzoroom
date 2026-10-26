"""Focused Windows RAW Viewer smoke. Run from any directory with repository Python."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import platform
import re
import statistics
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
STAGES = ('readiness', 'open', 'wholeDraft', 'wholeFull', 'geometryStability', 'mutation',
          'region', 'pan', 'zoomOut', 'beforeAfter', 'recipeRestore', 'rawReset', 'close')


def new_report():
    from lightcraft_artifact import MANAGED
    return {'schemaVersion': 1, 'result': 'fail', 'lightcraft': {
        'version': MANAGED['version'], 'commit': MANAGED['commit'],
        'previewContract': 1, 'regionContract': 1, 'geometryDescriptor': 2, 'attested': False},
        'environment': {'os': platform.system(), 'osRelease': platform.release()},
        'stages': dict.fromkeys(STAGES, 'not_run'), 'geometry': {}, 'finalState': None, 'failure': None,
        'benchmark': {'enabled': False}}


def failure(report, stage, code):
    report['stages'][stage] = 'fail'
    if report['failure'] is None:
        report['failure'] = {'stage': stage, 'code': code,
                             'expected': 'stage_completed', 'actual': 'operation_failed'}


async def ready_manager():
    from lightcraft_runtime import LightCraftManager
    manager = LightCraftManager()
    try:
        await manager.start()
        async with asyncio.timeout(60):
            while manager.status().state in ('starting', 'initializing'):
                await asyncio.sleep(.05)
        artifact = manager.artifact_info()
        generation = manager.status().generation
        if not artifact or not await manager._raw_preview_supported(generation) \
                or not await manager._raw_region_supported(generation) or not await manager._raw_before_supported(generation):
            raise RuntimeError('readiness_failed')
        tools = await manager._ready_client().request('tools/list', timeout=30)
        region = [t for t in tools['tools'] if t.get('name') == 'render_region_preview']
        if len(region) != 1 or region[0].get('_meta', {}).get('genzoroom.geometryDescriptorContract') != 2:
            raise RuntimeError('geometry_contract_failed')
        return manager
    except BaseException:
        await manager.close()
        raise


async def readiness(report):
    manager = await ready_manager()
    try:
        report['lightcraft']['binarySha256'] = manager.status().executable_sha256
        report['lightcraft']['attested'] = True
        report['stages']['readiness'] = 'pass'
    finally:
        await manager.close()


def run_child(args, cwd, timeout=180):
    # Child output can contain assertions with private fixture/path data; never forward it.
    try:
        return subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding='utf-8',
                              errors='replace', timeout=timeout, creationflags=0x08000000 if os.name == 'nt' else 0)
    except (OSError, subprocess.TimeoutExpired):
        return None


def frontend(report):
    pattern = '|'.join(('RAW Viewer smoke representative lifecycle',
        'keeps After editing usable when Before fails',
        'refuses a native Before pair with a different geometry',
        'cancels and rejects a running ACK Draft from the previous view',
        'discards a delayed Full after an edit',
        'rejects a decoded result from a former view'))
    with tempfile.TemporaryDirectory(prefix='raw-viewer-') as temporary:
        output = Path(temporary) / 'tests.json'
        child = run_child(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/useRawDocument.test.tsx',
            'src/rawRegionAuto.test.ts', '-t', pattern, '--reporter=dot', '--reporter=json',
            f'--outputFile.json={output}', '--testTimeout=30000'], ROOT / 'frontend')
        try:
            results = json.loads(output.read_text(encoding='utf-8'))
            assertions = [test for suite in results['testResults'] for test in suite['assertionResults'] if test['status'] not in ('pending', 'skipped')]
        except (OSError, ValueError, KeyError, TypeError):
            assertions = []
    match = re.search(r'RAW_SMOKE_JSON:(\{[^\r\n]+\})', child.stdout) if child else None
    if not match:
        failure(report, 'open', 'frontend_harness_failed')
        return
    try:
        result = json.loads(match[1])
    except ValueError:
        failure(report, 'open', 'frontend_report_invalid')
        return
    for stage, state in result['stages'].items():
        if stage in STAGES and state in ('pass', 'fail'):
            report['stages'][stage] = state
    report['geometry'], report['finalState'] = result['geometry'], result['finalState']
    if result['failure']:
        report['failure'] = result['failure']
    if not report['failure']:
        for test in assertions:
            if test['status'] == 'passed':
                continue
            title = test.get('title', '')
            stage = 'beforeAfter' if 'Before' in title else 'region' if 'former view' in title else 'mutation'
            failure(report, stage, 'stale_or_before_boundary_failed')
        if len(assertions) != 6 or child.returncode and not report['failure']:
            failure(report, 'open', 'focused_tests_incomplete')


def backend(report):
    cases = {
        'recipeRestore': ['test_windows_opens_v010_recipe_then_saves_current_tuple'],
        'rawReset': ['test_failed_restore_can_be_reset_and_reopened_with_defaults',
                     'test_raw_reset_clears_recipe_history_reopens_defaults_and_saves_current_tuple'],
    }
    with tempfile.TemporaryDirectory(prefix='raw-smoke-') as temporary:
        for stage, tests in cases.items():
            output = Path(temporary) / f'{stage}.xml'
            child = run_child([sys.executable, '-m', 'pytest', '-q', '--tb=no',
                *[f'tests/test_raw_recipe_restore.py::{name}' for name in tests], f'--junitxml={output}'], ROOT / 'backend')
            try:
                suites = ET.parse(output).getroot()
                passed = len(suites.findall('.//testcase')) == len(tests) and not any(
                    suites.findall(f'.//{tag}') for tag in ('failure', 'error', 'skipped'))
            except (OSError, ET.ParseError):
                passed = False
            if child and child.returncode == 0 and passed:
                report['stages'][stage] = 'pass'
            else:
                failure(report, stage, 'recipe_restore_failed' if stage == 'recipeRestore' else 'raw_reset_failed')


async def benchmark(raw_file):
    from time import monotonic
    from uuid import uuid4
    from lightcraft_raw import LightCraftRawSession
    from raw_preview_sequence import RawPreviewSequence, sequence_plan
    samples = []
    engine = None
    binary = None
    for repeat in range(4):
        manager = await ready_manager()
        raw = LightCraftRawSession(manager, stage_cache='off', diagnostics=True)
        try:
            if binary is not None and binary != manager.status().executable_sha256:
                raise RuntimeError('benchmark_binary_changed')
            binary = manager.status().executable_sha256
            opened = monotonic()
            handle, _ = await raw.open_raw(str(uuid4()), str(Path(raw_file).resolve()))
            sequence = RawPreviewSequence(raw, handle, (monotonic() - opened) * 1000)
            for trial in [t for t in sequence_plan(3) if t['repeat'] == repeat]:
                _, metadata = await sequence.step(trial)
                samples.append(metadata)
            gpu = await manager.get_gpu_info()
            artifact = manager.artifact_info()
            engine = {'version': artifact['version'], 'commit': artifact['upstreamCommit'],
                'binarySha256': manager.status().executable_sha256, 'gpuBackend': 'dx12',
                'gpuAdapter': gpu.adapter[:200] if gpu.adapter else None,
                'previewContract': 1, 'regionContract': 1, 'geometryDescriptor': 2}
        finally:
            await raw.close()
            await manager.close()
    stats = {}
    for operation in dict.fromkeys(row['operation'] for row in samples):
        values = [row['timing']['backendOperationMs'] for row in samples if row['operation'] == operation and not row['warmup']]
        stats[operation] = {'min': min(values), 'median': statistics.median(values), 'max': max(values)}
    return {'enabled': True, 'iterations': 3, 'warmups': 1, 'status': 'complete',
        'rawPreview': {'backendSequence': {'engine': engine, 'trials': samples, 'statistics': stats}, 'viewer': None},
        'limitations': ['backendAdapterOnlyNoFrontendDecodeOrViewerAdopt', 'useDeveloperDiagnosticsForViewerMeasurements',
                         'noPerformanceVerdict', 'rssAndVramNotCollected']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='JSON on stdout; concise status on stderr')
    parser.add_argument('--json-out', type=Path)
    parser.add_argument('--benchmark', action='store_true', help='Optional backend samples; full Viewer measurements are in /developer')
    parser.add_argument('--raw-file', help='One representative RAW for optional backend samples; never included in output')
    args = parser.parse_args()
    report = new_report()
    try:
        asyncio.run(readiness(report))
    except Exception:
        failure(report, 'readiness', 'managed_lightcraft_not_ready')
    # Fixture integration remains useful even when this machine has no managed executable.
    frontend(report)
    backend(report)
    report['result'] = 'pass' if all(v == 'pass' for v in report['stages'].values()) and report['failure'] is None else 'fail'
    if args.benchmark:
        try:
            if not args.raw_file:
                raise ValueError()
            report['benchmark'] = asyncio.run(benchmark(args.raw_file))
        except Exception:
            report['benchmark'] = {'enabled': True, 'status': 'unavailable',
                'errorCode': 'benchmark_raw_required' if not args.raw_file else 'benchmark_operation_failed'}
    encoded = json.dumps(report, ensure_ascii=True, indent=2, allow_nan=False) + '\n'
    output_failed = False
    if args.json_out:
        try:
            args.json_out.parent.mkdir(parents=True, exist_ok=True)
            args.json_out.write_text(encoded, encoding='utf-8')
        except OSError:
            output_failed = True
    state = report['finalState'] or {}
    print(f"RAW Viewer smoke {report['result'].upper()} stage={report['failure']['stage'] if report['failure'] else 'complete'} "
          f"revision={state.get('revision')} quality={state.get('quality')} geometryId={state.get('geometryId')} "
          f"viewGeneration={state.get('viewGeneration')} region={state.get('regionActive')}", file=sys.stderr if args.json else sys.stdout)
    if output_failed:
        print('JSON export FAIL code=json_output_failed', file=sys.stderr)
    if args.json:
        print(encoded, end='')
    return 0 if report['result'] == 'pass' and not output_failed else 1


if __name__ == '__main__':
    raise SystemExit(main())
