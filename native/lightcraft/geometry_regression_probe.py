"""Private real-RAW plan/render regression through the actual binary and Backend validators."""
import argparse
import asyncio
import copy
import ctypes
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from time import perf_counter

from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from lightcraft_mcp import LightCraftMCP
from lightcraft_runtime import child_environment
from lightcraft_raw import _validate_png
from raw_region import supports_region, validate_result


def process_rss(pid):
    if os.name != 'nt':
        return None
    class Counters(ctypes.Structure):
        _fields_ = [('cb', ctypes.c_ulong), ('faults', ctypes.c_ulong)] + [
            (name, ctypes.c_size_t) for name in ('peak', 'working', 'peakPaged', 'paged',
                'peakNonpaged', 'nonpaged', 'pagefile', 'peakPagefile')]
    kernel, psapi = ctypes.windll.kernel32, ctypes.windll.psapi
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
    handle = kernel.OpenProcess(0x410, False, pid)
    if not handle:
        raise ValueError('process memory inspection failed')
    try:
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            raise ValueError('process memory inspection failed')
        return counters.working
    finally:
        kernel.CloseHandle(handle)


async def probe(binary, private, backend, *, sanity=False, comparison_images=None):
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
            whole_ms = []
            for side in (1024, 1472, 2048):
                started = perf_counter()
                result = await client.call_tool_result('render_preview', {'id': photo, 'max_side': side,
                    'quality': 'full', 'preview_contract': 1, 'stage_cache': 'off'}, timeout=90)
                whole_png, _, _, metadata = _validate_png(result, photo, side, quality='full')
                whole_ms.append((perf_counter() - started) * 1000)
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
            started = perf_counter()
            cached_whole = await client.call_tool_result('render_preview', {'id': photo, 'max_side': 2048,
                'quality': 'full', 'preview_contract': 1, 'stage_cache': 'on', 'stage_cache_budget_bytes': 512 * 1024**2}, timeout=90)
            cached_whole_png, _, _, cached_metadata = _validate_png(cached_whole, photo, 2048, quality='full')
            warm_whole_ms = (perf_counter() - started) * 1000
            assert cached_whole_png == whole_png, 'Whole cache must preserve same-engine Full pixels'
            assert cached_metadata['frame']['geometryId'] == geometry['geometryId']
            cached_png, cached_region = await region('render', target, 'on')
            assert cached_png == png, 'sampling-source cache transition must preserve Full Region pixels'
            if backend == 'dx12':
                assert cached_region['diagnostics']['execution']['outcome'] == 'gpu_success'
            assert await command('develop.get', {'id': photo}) == private['settings']
            extra = {}
            if sanity:
                # Bounded sanity only: no alternate policies, budgets or old-engine benchmark.
                draft = copy.deepcopy(target)
                draft['quality'] = 'draft'
                await region('render', draft, 'on')
                times, rss = [], []
                for _ in range(3):
                    started = perf_counter()
                    repeated, repeated_metadata = await region('render', target, 'on')
                    times.append((perf_counter() - started) * 1000)
                    assert repeated == png
                    assert repeated_metadata['diagnostics']['stageCache']['retainedBytes'] <= 512 * 1024**2
                    rss.append(process_rss(process.pid))
                if os.name == 'nt':
                    assert max(rss) - min(rss) <= 512 * 1024**2, 'unbounded warm-render growth'
                await client.call_tool_result('render_preview', {'id': photo, 'max_side': 1024,
                    'quality': 'draft', 'preview_contract': 1, 'stage_cache': 'off'}, timeout=90)
                before_geometry = {key: private['settings'][key] for key in ('crop', 'orientation')}
                before = []
                before_meta = None
                for mode in ('off', 'on'):
                    arguments = {'id': photo, 'max_side': 2048, 'before': True, 'quality': 'full',
                                 'preview_contract': 1, 'stage_cache': mode}
                    if mode == 'on':
                        arguments['stage_cache_budget_bytes'] = 512 * 1024**2
                    result = await client.call_tool_result('render_preview', arguments, timeout=90)
                    pixels, _, _, before_meta = _validate_png(result, photo, 2048, kind='before',
                        before_fingerprint=baseline['beforeFingerprint'], geometry=before_geometry, quality='full')
                    if backend == 'dx12':
                        assert before_meta['execution']['outcome'] == 'gpu_success'
                    before.append(pixels)
                assert before[0] == before[1]
                before_query = copy.deepcopy(query)
                before_query['geometryId'] = before_meta['frame']['geometryId']
                before_query['identity'] = {key: value for key, value in identity.items() if key != 'revision'}
                before_query['identity'].update(kind='before', beforeKey='e' * 64)
                _, before_plan = await region('plan', before_query)
                before_frame = before_plan['response']
                before_target = copy.deepcopy(before_query)
                del before_target['desiredLongEdge']
                before_target.update(fullWidth=before_frame['fullWidth'], fullHeight=before_frame['fullHeight'],
                    window={'x': 256, 'y': 256, 'w': 512, 'h': 384},
                    validRegion={'x': 272, 'y': 272, 'w': 480, 'h': 352}, context=16, prefetch=64)
                before_off, _ = await region('render', before_target)
                before_on, _ = await region('render', before_target, 'on')
                assert before_off == before_on
                assert await command('develop.get', {'id': photo}) == private['settings']
                extra = {'sanity': {'wholeMs': whole_ms, 'warmWholeMs': warm_whole_ms,
                    'warmRegionMs': times, 'warmRssBytes': rss,
                    'draftWholeAndRegion': True, 'beforeWholeAndRegion': True, 'cacheFullPixelsIdentical': True}}
                if comparison_images is not None:
                    comparison_images.update(whole=whole_png, region=png, before=before[0])
            return {'backend': backend, 'recipeRevision': private['recipeRevision'], 'exactRawMatched': True, **extra,
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
            assert process.returncode == 0, 'Native process did not exit normally'


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--upgrade-sanity', action='store_true')
    args = parser.parse_args()
    private = json.loads(args.input.read_text(encoding='utf-8'))
    images = [{}, {}]
    reports = [asyncio.run(probe(args.binary, private, backend, sanity=args.upgrade_sanity,
        comparison_images=image)) for backend, image in zip(('off', 'dx12'), images)]
    if args.upgrade_sanity:
        comparison = {}
        for kind in ('whole', 'region', 'before'):
            cpu, gpu = [Image.open(io.BytesIO(image[kind])).convert('RGB') for image in images]
            assert cpu.size == gpu.size
            diff = ImageChops.difference(cpu, gpu)
            maximum = max(high for _, high in diff.getextrema())
            mean = sum(ImageStat.Stat(diff).mean) / 3
            assert maximum <= 3 and mean <= 1, 'CPU/DX12 pixels exceed the existing narrow tolerance'
            comparison[kind] = {'maxLsb': maximum, 'meanLsb': mean}
        reports.append({'cpuDx12Comparison': comparison})
    safe = json.dumps(reports, indent=2)
    for value in [*private['sourcePaths'], private['expectedContentHash']]:
        assert value not in safe
    args.output.write_text(safe + '\n', encoding='utf-8')
    print('Real RAW CPU/DX12 canonical geometry plan/render: PASS')


if __name__ == '__main__':
    main()
