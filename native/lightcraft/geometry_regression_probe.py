"""Private real-RAW plan/render regression through the actual binary and Backend validators."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from lightcraft_mcp import LightCraftMCP
from lightcraft_runtime import child_environment
from lightcraft_raw import _validate_png
from raw_region import supports_region, validate_result


async def probe(binary, private, backend):
    with tempfile.TemporaryDirectory(prefix='genzoroom-geometry-regression-') as folder:
        process = await asyncio.create_subprocess_exec(str(binary), 'mcp', '--headless', '--compact',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=24 * 1024**2, env=child_environment(os.environ, gpu_backend=backend, temp_directory=folder),
            **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        client = LightCraftMCP(process.stdout, process.stdin, 1)
        try:
            await client.initialize('canonical-geometry-regression', timeout=30)
            tools = await client.request('tools/list', timeout=10)
            assert supports_region(tools)
            tool = next(t for t in tools['tools'] if t['name'] == 'render_region_preview')
            assert tool['_meta']['genzoroom.geometryDescriptorContract'] == 2
            async def command(name, params):
                return await client.call_tool('command_run', {'id': name, 'params': params}, timeout=90)
            await command('app.memoryBudget', {'mb': 1024})
            if backend == 'dx12':
                assert (await command('app.gpu', {}))['available'] is True
            photo = None
            for source in private['sourcePaths']:
                imported = await command('library.import', {'paths': [source], 'mode': 'add'})
                for candidate in imported['imported']:
                    inspected = await command('photo.inspect', {'id': candidate})
                    if inspected['content_hash'] == private['expectedContentHash']:
                        photo = candidate
            assert photo is not None, 'cached RAW must match persisted Recipe content identity'
            await command('library.select', {'ids': [photo], 'active': photo, 'mode': 'replace'})
            baseline = await command('beforeAfter.setBefore', {'source': 'import'})
            await command('develop.reset', {'ids': [photo]})
            await command('develop.merge', {'settings': private['settings']})
            assert await command('develop.get', {'id': photo}) == private['settings']
            whole = []
            for side in (1024, 1472, 2048):
                result = await client.call_tool_result('render_preview', {'id': photo, 'max_side': side,
                    'quality': 'full', 'preview_contract': 1, 'stage_cache': 'off'}, timeout=90)
                _, _, _, metadata = _validate_png(result, photo, side, quality='full')
                if backend == 'dx12':
                    assert metadata['execution']['outcome'] == 'gpu_success'
                whole.append(metadata)
            geometry = whole[-1]['frame']
            assert all(m['frame']['geometryId'] == geometry['geometryId'] for m in whole)
            assert all((m['frame']['nativeWidth'], m['frame']['nativeHeight']) == (4064, 3056) for m in whole)
            identity = {'assetId': '12345678-1234-4234-9234-123456789abc', 'sourceId': 'b' * 64,
                'generation': 1, 'documentToken': 'c' * 32, 'kind': 'after', 'revision': 2}
            query = {'contractVersion': 1, 'mode': 'region', 'quality': 'full', 'geometryId': geometry['geometryId'],
                'identity': identity, 'documentRevision': 2, 'viewGeneration': 7, 'requestId': 'd' * 32, 'desiredLongEdge': 4064}
            async def region(operation, target, cache='off'):
                arguments = {'id': str(photo), 'region_contract': 1,
                    'operation': operation, 'target': target, 'stage_cache': cache}
                if cache == 'on':
                    arguments['stage_cache_budget_bytes'] = 512 * 1024**2
                result = await client.call_tool_result('render_region_preview', arguments, timeout=90)
                return validate_result(result, target, operation, photo,
                    baseline['beforeFingerprint'] if target['identity']['kind'] == 'before' else None)
            _, planned = await region('plan', query)
            frame = planned['response']
            assert frame['geometryId'] == geometry['geometryId']
            assert (frame['nativeWidth'], frame['nativeHeight'], frame['fullWidth'], frame['fullHeight']) == (4064, 3056, 4064, 3056)
            planner_input = {'geometry': {k: geometry[k] for k in ('geometryId', 'nativeWidth', 'nativeHeight')},
                'full': {k: frame[k] for k in ('geometryId', 'fullWidth', 'fullHeight')},
                'view': {'width': 1952, 'height': 1096, 'dpr': 1, 'scale': 1, 'panX': 0, 'panY': 0},
                'context': 16, 'prefetch': 64}
            output = subprocess.check_output(['node', str(ROOT / 'native/lightcraft/region_plan_probe.cjs')],
                input=json.dumps(planner_input).encode(), cwd=ROOT)
            plan = json.loads(output)
            assert plan['mode'] == 'region'
            target = {k: v for k, v in query.items() if k != 'desiredLongEdge'}
            target.update(fullWidth=frame['fullWidth'], fullHeight=frame['fullHeight'], window=plan['contextWindow'],
                validRegion=plan['validRegion'], context=16, prefetch=64)
            png, rendered = await region('render', target)
            response = rendered['response']
            assert response['geometryId'] == geometry['geometryId']
            assert all(response[k] == target[k] for k in ('fullWidth', 'fullHeight', 'window', 'validRegion'))
            assert (response['width'], response['height']) == (target['window']['w'], target['window']['h'])
            if backend == 'dx12':
                assert rendered['diagnostics']['execution']['outcome'] == 'gpu_success'
            # C1's existing opt-in test budget exercises source ownership; product policy is untouched.
            cached_whole = await client.call_tool_result('render_preview', {'id': photo, 'max_side': 2048,
                'quality': 'full', 'preview_contract': 1, 'stage_cache': 'on', 'stage_cache_budget_bytes': 512 * 1024**2}, timeout=90)
            _, _, _, cached_metadata = _validate_png(cached_whole, photo, 2048, quality='full')
            assert cached_metadata['frame']['geometryId'] == geometry['geometryId']
            cached_png, cached_region = await region('render', target, 'on')
            assert cached_png == png, 'sampling-source cache transition must preserve Full Region pixels'
            if backend == 'dx12':
                assert cached_region['diagnostics']['execution']['outcome'] == 'gpu_success'
            assert await command('develop.get', {'id': photo}) == private['settings']
            return {'backend': backend, 'recipeRevision': private['recipeRevision'], 'exactRawMatched': True,
                'settingsUnchanged': True, 'geometryDescriptorContract': 2, 'previewContract': 1, 'regionContract': 1,
                'whole': [{'requestedSide': side, 'bitmap': [m['width'], m['height']], 'native': [m['frame']['nativeWidth'], m['frame']['nativeHeight']],
                    'execution': m['execution']} for side, m in zip((1024, 1472, 2048), whole)],
                'canonicalGeometryMatches': True, 'planSucceeded': True, 'actualF': [frame['fullWidth'], frame['fullHeight']],
                'planSourceLevel': planned['diagnostics']['sourceLevel'], 'renderSucceeded': True,
                'renderSourceLevel': rendered['diagnostics']['sourceLevel'], 'window': target['window'],
                'validRegion': target['validRegion'], 'nativePlacement': plan['nativePlacement'],
                'visibleNativeRect': plan['nativeVisibleRect'], 'limited': plan['limited'],
                'bitmap': [response['width'], response['height']], 'pngBytes': len(png), 'execution': rendered['diagnostics']['execution'],
                'cacheSourceTransition': {'fullPixelsIdentical': True, 'wholeCache': cached_metadata['stageCache'],
                    'regionCache': cached_region['diagnostics']['stageCache']}}
        finally:
            await client.close()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    private = json.loads(args.input.read_text(encoding='utf-8'))
    reports = [asyncio.run(probe(args.binary, private, backend)) for backend in ('off', 'dx12')]
    safe = json.dumps(reports, indent=2)
    for value in [*private['sourcePaths'], private['expectedContentHash']]:
        assert value not in safe
    args.output.write_text(safe + '\n', encoding='utf-8')
    print('Real RAW CPU/DX12 canonical geometry plan/render: PASS')


if __name__ == '__main__':
    main()
