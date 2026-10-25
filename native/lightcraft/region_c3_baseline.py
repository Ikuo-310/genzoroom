"""Opt-in C3 measurements. Private input stays outside the safe, allowlisted result.

Uses the accepted binary without modifying Native sources. This is an MCP benchmark,
not an HTTP/browser or real-user gesture measurement.
"""
import argparse
import asyncio
import ctypes
from ctypes import wintypes
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import threading
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from lightcraft_mcp import LightCraftMCP
from lightcraft_runtime import child_environment
from lightcraft_raw import _validate_png
from raw_region import supports_region, validate_result
from lightcraft_mcp import MCPToolError


class WindowsMemory:
    """PSAPI working set is resident process memory, never dedicated GPU memory."""
    class Counters(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
            (key, ctypes.c_size_t) for key in ('PeakWorkingSetSize', 'WorkingSetSize',
            'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
            'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage', 'PrivateUsage')]

    def __init__(self, pid):
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.query = ctypes.WinDLL('psapi', use_last_error=True).GetProcessMemoryInfo
        self.query.argtypes = [wintypes.HANDLE, ctypes.POINTER(self.Counters), wintypes.DWORD]
        self.query.restype = wintypes.BOOL
        self.handle = self.kernel.OpenProcess(0x1000 | 0x10, False, pid)
        if not self.handle:
            raise OSError('process_memory_unavailable')
        self.samples = []
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.poll, daemon=True)
        self.thread.start()

    def read(self):
        c = self.Counters(); c.cb = ctypes.sizeof(c)
        if not self.query(self.handle, ctypes.byref(c), c.cb):
            raise OSError('process_memory_unavailable')
        return {'workingSetBytes': c.WorkingSetSize, 'privateBytes': c.PrivateUsage,
                'lifetimePeakWorkingSetBytes': c.PeakWorkingSetSize}

    def poll(self):
        while not self.stop.wait(.02):
            try:
                # A bounded rolling sample avoids an unbounded benchmark memory footprint.
                self.samples.append(self.read()['workingSetBytes'])
                if len(self.samples) > 30000: del self.samples[:1000]
            except OSError:
                return

    def close(self):
        self.stop.set(); self.thread.join(); self.kernel.CloseHandle(self.handle)


def coverage(plan):
    a, b = plan['nativeVisibleRect'], plan['validNativeRect']
    area = max(0, min(a['x1'], b['x1']) - max(a['x0'], b['x0'])) * max(0, min(a['y1'], b['y1']) - max(a['y0'], b['y0']))
    return area / ((a['x1'] - a['x0']) * (a['y1'] - a['y0']))


def planner(geometry, frame, view):
    output = subprocess.check_output(['node', str(ROOT / 'native/lightcraft/region_plan_probe.cjs')],
        input=json.dumps({'geometry': geometry, 'full': frame, 'view': view, 'context': 16, 'prefetch': 64}).encode(),
        cwd=ROOT, stderr=subprocess.DEVNULL)
    return json.loads(output)


async def measure(binary, private, backend, cache):
    with tempfile.TemporaryDirectory(prefix='genzoroom-c3-') as folder:
        process = await asyncio.create_subprocess_exec(str(binary), 'mcp', '--headless', '--compact',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=24*1024**2, env=child_environment(os.environ, gpu_backend=backend, temp_directory=folder), creationflags=0x08000000)
        memory = WindowsMemory(process.pid)
        client = LightCraftMCP(process.stdout, process.stdin, 1)
        rows, snapshots = [], []
        def snapshot(phase): snapshots.append({'phase': phase, **memory.read()})
        async def command(name, params):
            try:
                return await client.call_tool('command_run', {'id': name, 'params': params}, timeout=120)
            except Exception:
                print(json.dumps({'failedCommand': name}), file=sys.stderr)
                raise
        cache_args = {'stage_cache': cache}
        if cache == 'on': cache_args['stage_cache_budget_bytes'] = 512*1024**2
        try:
            await client.initialize('c3-baseline', timeout=30)
            tools = await client.request('tools/list', timeout=10)
            assert supports_region(tools)
            tool = next(t for t in tools['tools'] if t['name'] == 'render_region_preview')
            assert tool['_meta']['genzoroom.geometryDescriptorContract'] == 2
            await command('app.memoryBudget', {'mb': 1024})
            if backend == 'dx12' and (await command('app.gpu', {}))['available'] is not True:
                return {'backend': backend, 'stageCacheMode': cache, 'skipped': 'no_adapter'}
            snapshot('baseline')
            photo = None
            for source in private['sourcePaths']:
                imported = await command('library.import', {'paths': [source], 'mode': 'add'})
                for candidate in imported['imported']:
                    if (await command('photo.inspect', {'id': candidate}))['content_hash'] == private['expectedContentHash']:
                        photo = candidate; break
                if photo: break
            assert photo is not None, 'private_source_not_found'
            await command('library.select', {'ids': [photo], 'active': photo, 'mode': 'replace'})
            before = await command('beforeAfter.setBefore', {'source': 'import'})
            await command('develop.reset', {'ids': [photo]})
            await command('develop.merge', {'settings': private['settings']})
            geometry = None
            for side in (1024, 1472, 2048):
                start = time.perf_counter()
                raw = await client.call_tool_result('render_preview', {'id': photo, 'max_side': side,
                    'quality': 'full', 'preview_contract': 1, **cache_args}, timeout=120)
                received = time.perf_counter()
                png, _, _, meta = _validate_png(raw, photo, side, quality='full')
                geometry = {k: meta['frame'][k] for k in ('nativeWidth', 'nativeHeight', 'geometryId')}
                rows.append({'scenario': f'whole{side}', 'temperature': 'cold-first-preview' if side == 1024 else 'warm-source',
                    'mcpRoundTripMs': (received-start)*1000, 'backendValidationMs': (time.perf_counter()-received)*1000,
                    'pngBytes': len(png), 'bitmap': [meta['width'], meta['height']],
                    'stageCache': meta['stageCache'], 'execution': meta['execution']})
                snapshot(f'whole{side}')
                del raw, png
            serial = 0
            async def region(operation, target, scenario, temperature):
                nonlocal serial
                serial += 1; target = {**target, 'requestId': f'{serial:032x}'}
                memory.samples.clear()
                start = time.perf_counter()
                try:
                    raw = await client.call_tool_result('render_region_preview', {'id': str(photo), 'region_contract': 1,
                        'operation': operation, 'target': target, **cache_args}, timeout=120)
                except MCPToolError as error:
                    print(json.dumps({'operation': operation, 'scenario': scenario, 'errorCode': error.code,
                        'reason': error.diagnostic_reason}), file=sys.stderr)
                    raise
                received = time.perf_counter()
                png, meta = validate_result(raw, target, operation, photo,
                    before['beforeFingerprint'] if target['identity']['kind'] == 'before' else None)
                row = {'scenario': scenario, 'temperature': temperature, 'operation': operation, 'kind': target['identity']['kind'],
                    'quality': target['quality'], 'desiredLongEdge': target.get('desiredLongEdge'),
                    'actualF': [meta['response']['fullWidth'], meta['response']['fullHeight']],
                    'mcpRoundTripMs': (received-start)*1000, 'backendValidationMs': (time.perf_counter()-received)*1000,
                    'diagnostics': {k: meta['diagnostics'][k] for k in ('execution', 'nativeMs', 'sourceCacheBytes',
                        'sourceHostBytes', 'sourceLevel', 'stageCache', 'workWindow') if k in meta['diagnostics']}, 'pngBytes': len(png),
                    'base64Characters': 4*math.ceil(len(png)/3),
                    'sampledPeakWorkingSetBytes': max(memory.samples, default=None), **memory.read()}
                rows.append(row)
                return meta['response'], row
            identity = {'assetId': '12345678-1234-4234-9234-123456789abc', 'sourceId': 'b'*64,
                'generation': 1, 'documentToken': 'c'*32, 'kind': 'after', 'revision': 2}
            query = {'contractVersion': 1, 'mode': 'region', 'quality': 'full', 'geometryId': geometry['geometryId'],
                'identity': identity, 'documentRevision': 2, 'viewGeneration': 1}
            n = max(geometry['nativeWidth'], geometry['nativeHeight'])
            for width, height, dpr in ((1952, 1096, 1), (1952, 1096, 1.25), (1952, 1096, 2), (2560, 1440, 2)):
                fit = min(width/geometry['nativeWidth'], height/geometry['nativeHeight'])
                for label, scale in [('fit', fit), ('50', .5), ('75', .75), ('100', 1), ('125', 1.25), ('150', 1.5), ('200', 2)]:
                    name = f'{width}x{height}-dpr{dpr}-zoom{label}'
                    # These are controlled view inputs, not captures of a user's Viewer gestures.
                    desired = min(n, max(16, math.ceil(n*min(1, scale*dpr)/256)*256))
                    rho = min(2048/geometry['nativeWidth'], rows[2]['bitmap'][1]/geometry['nativeHeight'])/(scale*dpr)
                    if rho >= .85:
                        rows.append({'scenario': name, 'operation': 'policy', 'rho': rho, 'regionOn': False}); continue
                    frame, _ = await region('plan', {**query, 'desiredLongEdge': desired}, name,
                        'cold-first-region' if serial == 0 else 'warm-document')
                    if serial == 1: snapshot('region-plan')
                    view = {'width': width, 'height': height, 'dpr': dpr, 'scale': scale, 'panX': 0, 'panY': 0}
                    plan = planner(geometry, {k: frame[k] for k in ('geometryId', 'fullWidth', 'fullHeight')}, view)
                    assert plan['mode'] == 'region'
                    target = {**query, 'fullWidth': frame['fullWidth'], 'fullHeight': frame['fullHeight'],
                        'window': plan['contextWindow'], 'validRegion': plan['validRegion'], 'context': 16, 'prefetch': 64}
                    _, row = await region('render', target, name, 'warm-document')
                    row.update(rho=rho, regionOn=True, limited=plan['limited'], coverage=coverage(plan),
                        requestedWindow=plan['requestedWindow'], window=plan['contextWindow'], validRegion=plan['validRegion'],
                        pixelCount=plan['contextWindow']['w']*plan['contextWindow']['h'])
                    if width == 1952 and dpr == 1 and label == '100':
                        snapshot('region-render-returned-not-browser-adopted')
                        for kind in ('after', 'before'):
                            paired = {**target}
                            if kind == 'before': paired['identity'] = {k: v for k, v in identity.items() if k != 'revision'} | {'kind': 'before', 'beforeKey': 'f'*64}
                            await region('render', paired, 'pair-1to1', 'warm-document')
                        await region('render', {**target, 'quality': 'draft'}, 'draft-1to1', 'warm-document')
                        await region('render', target, 'repeat-1to1', 'warm-document')
            # Native has no Viewer zoom-out/adoption event: do not label this as a UI lifecycle sample.
            raw = await client.call_tool_result('render_preview', {'id': photo, 'max_side': 1472,
                'quality': 'full', 'preview_contract': 1, **cache_args}, timeout=120)
            _validate_png(raw, photo, 1472, quality='full'); del raw
            snapshot('whole-after-region')
            assert await command('develop.get', {'id': photo}) == private['settings']
            return {'backend': backend, 'stageCacheMode': cache, 'stageCacheBudgetBytes': 512*1024**2 if cache == 'on' else None,
                'rawNativeDimensions': [geometry['nativeWidth'], geometry['nativeHeight']],
                'settingsUnchanged': True, 'rows': rows, 'memorySnapshots': snapshots,
                'documentCloseMemory': None, 'gpuDedicatedBytes': None, 'gpuSharedBytes': None}
        finally:
            memory.close()
            await client.close()
            try: await asyncio.wait_for(process.wait(), 5)
            except TimeoutError: process.kill(); await process.wait()


def main():
    p = argparse.ArgumentParser(__doc__)
    p.add_argument('--binary', type=Path, required=True)
    p.add_argument('--private-input', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    if os.name != 'nt': p.error('Windows PSAPI measurement requires Windows')
    manifest = json.loads((ROOT/'native/lightcraft/manifest.json').read_text())
    digest = hashlib.sha256(args.binary.read_bytes()).hexdigest()
    receipt = json.loads(args.binary.with_suffix('.genzoroom.json').read_text())
    assert receipt['binarySha256'] == digest
    assert receipt['commit'] == manifest['commit'] and receipt['patches'] == manifest['patches']
    private = json.loads(args.private_input.read_text(encoding='utf-8'))
    result = {'schemaVersion': 1, 'measurementKind': 'controlled-native-mcp-not-user-trace',
        'environment': {'os': platform.platform(), 'python': platform.python_version(), 'node': subprocess.check_output(['node', '--version'], text=True).strip()},
        'binarySha256': digest, 'upstreamCommit': manifest['commit'], 'patchDigest': manifest['patches'][0]['sha256'],
        'privateRecipeRevision': private['recipeRevision'], 'runs': []}
    for backend, cache in [('off', 'off'), ('dx12', 'off'), ('off', 'on'), ('dx12', 'on')]:
        result['runs'].append(asyncio.run(measure(args.binary, private, backend, cache)))
        args.output.write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
        print(json.dumps({'backend': backend, 'cache': cache, 'rows': len(result['runs'][-1].get('rows', []))}))


if __name__ == '__main__':
    # Never print private MCP exceptions, arguments or source paths on a failed run.
    try: main()
    except Exception as error:
        print(json.dumps({'failed': True, 'exceptionType': type(error).__name__,
            'frames': [{'function': f.name, 'line': f.lineno} for f in traceback.extract_tb(error.__traceback__)]}), file=sys.stderr)
        sys.exit(1)
