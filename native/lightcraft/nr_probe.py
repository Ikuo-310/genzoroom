"""Focused NR image/Region checks on procedural RGB, never an actual-RAW performance benchmark."""
import argparse
import asyncio
import base64
import copy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import random
import sys
import tempfile
import time

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from lightcraft_artifact import MANAGED, resolve_managed_executable, verified_artifact
from lightcraft_mcp import LightCraftMCP
from lightcraft_runtime import child_environment
from raw_region import validate_result
from sharpen_probe import differences

BASE = {'detail.nrLuminance': 0, 'detail.nrDetail': 50, 'detail.nrColor': 0,
        'detail.nrColorDetail': 50, 'detail.nrColorSmoothness': 50,
        'detail.sharpenAmount': 0, 'detail.sharpenMasking': 0}


def noise(image):
    # A flat part of the procedural scene avoids interpreting its step edges as noise.
    data = image.crop((image.width // 16, image.height // 16, image.width // 4, image.height // 4)).tobytes()
    pixels = list(zip(data[0::3], data[1::3], data[2::3]))
    luma = [(r + 2 * g + b) / 4 for r, g, b in pixels]
    chroma = [(r - g, b - g) for r, g, b in pixels]
    mean = sum(luma) / len(luma)
    cm = [sum(p[k] for p in chroma) / len(chroma) for k in (0, 1)]
    return {'luminanceVariance': sum((v - mean) ** 2 for v in luma) / len(luma),
            'chromaVariance': sum(sum((p[k] - cm[k]) ** 2 for k in (0, 1)) for p in chroma) / len(chroma)}


async def probe(binary, backend):
    with tempfile.TemporaryDirectory(prefix='genzoroom-nr-') as folder:
        source = Path(folder) / 'noise.png'
        rng = random.Random(719)
        pixels = bytearray()
        for y in range(768):
            for x in range(1024):
                base = 110 + (45 if x > 600 else 0) + (12 * math.sin(x / 6) if y > 300 else 0)
                lum = rng.gauss(0, 16)
                for k in range(3):
                    color = 12 * math.sin(x / 17 + k * 2) if y > 300 else 0
                    pixels.append(round(max(0, min(255, base + lum + rng.gauss(0, 12) + color))))
        Image.frombytes('RGB', (1024, 768), bytes(pixels)).save(source)
        process = await asyncio.create_subprocess_exec(str(binary), 'mcp', '--headless', '--compact',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=24 * 1024**2, env=child_environment(os.environ, gpu_backend=backend, temp_directory=folder),
            **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        client = LightCraftMCP(process.stdout, process.stdin, 1)
        try:
            await client.initialize('nr-probe', expected_version=MANAGED['version'], timeout=30)
            async def command(name, params):
                return await client.call_tool('command_run', {'id': name, 'params': params}, timeout=60)
            if backend == 'dx12' and not (await command('app.gpu', {}))['available']:
                return {'backend': backend, 'skipped': 'no_adapter'}
            photo = (await command('library.import', {'paths': [str(source)], 'mode': 'add'}))['imported'][0]
            await command('library.select', {'ids': [photo], 'active': photo, 'mode': 'replace'})
            await command('beforeAfter.setBefore', {'source': 'import'})
            timings, checks, regions, findings = [], [], [], []
            def execution(meta):
                assert meta['execution']['outcome'] == ('gpu_success' if backend == 'dx12' else 'cpu_not_tried')
            async def set_values(patch):
                await command('develop.set', {'values': BASE | patch})
            async def whole(side, quality='full', cache='off'):
                started = time.perf_counter()
                result = await client.call_tool_result('render_preview', {'id': photo, 'max_side': side,
                    'quality': quality, 'preview_contract': 1, 'stage_cache': cache,
                    **({'stage_cache_budget_bytes': 512 * 1024**2} if cache == 'on' else {})}, timeout=90)
                meta = json.loads(next(v['text'] for v in result['content'] if v['type'] == 'text'))
                execution(meta)
                image = Image.open(io.BytesIO(base64.b64decode(next(v['data'] for v in result['content'] if v['type'] == 'image')))).convert('RGB')
                assert image.size == (side, side * 3 // 4)
                timings.append({'mode': 'whole', 'side': side, 'quality': quality, 'cache': cache,
                                'requestMs': round((time.perf_counter() - started) * 1000, 2)})
                return image, meta
            for side in (512, 1024):
                await set_values({})
                plain, _ = await whole(side)
                await set_values({'detail.nrDetail': 100, 'detail.nrColorDetail': 100, 'detail.nrColorSmoothness': 100})
                zero, _ = await whole(side)
                assert zero.tobytes() == plain.tobytes()
                metrics = {'side': side, 'off': noise(plain), 'effects': {}}
                for amount, metric in [('detail.nrLuminance', 'luminanceVariance'), ('detail.nrColor', 'chromaVariance')]:
                    await set_values({amount: 100})
                    reduced, _ = await whole(side)
                    metrics[amount] = noise(reduced)
                    assert metrics[amount][metric] < metrics['off'][metric]
                for control, amount in [('detail.nrDetail', 'detail.nrLuminance'), ('detail.nrColorDetail', 'detail.nrColor'),
                                        ('detail.nrColorSmoothness', 'detail.nrColor')]:
                    await set_values({amount: 100, control: 0})
                    low, _ = await whole(side)
                    await set_values({amount: 100, control: 100})
                    high, _ = await whole(side)
                    effect = differences(low, high)
                    assert effect['changedChannels'] > 0
                    metrics['effects'][control] = effect
                maximum = {'detail.nrLuminance': 100, 'detail.nrColor': 100, 'detail.nrColorSmoothness': 100,
                           'detail.sharpenAmount': 150}
                await set_values(maximum)
                combined, meta = await whole(side)
                draft, dm = await whole(side, 'draft', 'on')
                assert differences(plain, draft)['changedChannels'] > 0 and dm['frame'] == meta['frame']
                cached, _ = await whole(side, cache='on')
                assert cached.tobytes() == combined.tobytes()
                saved = await client.call_tool('get_develop', {'id': photo})
                await command('develop.sectionEnabled', {'section': 'detail', 'enabled': False})
                off, _ = await whole(side)
                assert off.tobytes() == plain.tobytes()
                assert await client.call_tool('get_develop', {'id': photo}) == saved | {'disabled_sections': ['detail']}
                await command('develop.sectionEnabled', {'section': 'detail', 'enabled': True})
                on, _ = await whole(side)
                assert on.tobytes() == combined.tobytes()
                checks.append(metrics)
                # Re-plan at both view sizes and pan to the image edge without changing policy.
                for name, patch in [('luminanceMax', {'detail.nrLuminance': 100}),
                                    ('colorMax', {'detail.nrColor': 100, 'detail.nrColorSmoothness': 100}),
                                    ('nrAndSharpenMax', maximum)]:
                    await set_values(patch)
                    region_settings = await client.call_tool('get_develop', {'id': photo})
                    reference, meta = await whole(side)
                    identity = {'assetId': '12345678-1234-4234-9234-123456789abc', 'sourceId': hashlib.sha256(source.read_bytes()).hexdigest(),
                        'generation': 1, 'documentToken': 'c' * 32, 'kind': 'after', 'revision': len(regions) + 1}
                    query = {'contractVersion': 1, 'mode': 'region', 'quality': 'full', 'geometryId': meta['frame']['geometryId'],
                        'identity': identity, 'documentRevision': identity['revision'], 'viewGeneration': len(regions) + 1,
                        'requestId': 'd' * 32, 'desiredLongEdge': side}
                    async def region(operation, target):
                        result = await client.call_tool_result('render_region_preview', {'id': str(photo), 'region_contract': 1,
                            'operation': operation, 'target': target, 'stage_cache': 'off'}, timeout=90)
                        return validate_result(result, target, operation, photo)
                    _, plan = await region('plan', query)
                    assert (plan['response']['fullWidth'], plan['response']['fullHeight']) == reference.size
                    w, h = (384, 256) if side == 512 else (512, 384)
                    for x, y in ((64, 64), (0, 0)):
                        target = {k: v for k, v in query.items() if k != 'desiredLongEdge'}
                        ix, iy = (16 if x else 0), (16 if y else 0)
                        target.update(fullWidth=side, fullHeight=side * 3 // 4, window={'x': x, 'y': y, 'w': w, 'h': h},
                            validRegion={'x': x + ix, 'y': y + iy, 'w': w - ix - 16, 'h': h - iy - 16}, context=16, prefetch=0)
                        started = time.perf_counter()
                        png, rm = await region('render', target)
                        timings.append({'mode': 'region', 'side': side, 'quality': 'full', 'cache': 'off',
                            'requestMs': round((time.perf_counter() - started) * 1000, 2)})
                        execution(rm['diagnostics'])
                        image = Image.open(io.BytesIO(png)).convert('RGB')
                        crop = reference.crop((x, y, x + w, y + h))
                        valid = differences(crop.crop((ix, iy, w - 16, h - 16)), image.crop((ix, iy, w - 16, h - 16)))
                        inner = differences(crop.crop((64, 64, w - 64, h - 64)), image.crop((64, 64, w - 64, h - 64)))
                        regions.append({'scenario': name, 'side': side, 'imageEdge': x == 0,
                            'validRegionContext16': valid, 'diagnosticInterior64': inner,
                            'includingWindowEdges': differences(crop, image)})
                        if valid['maxLsb'] > 1:
                            findings.append({'code': 'region_valid_pixels_differ', 'case': len(regions) - 1})
                            # Re-render the same valid pixels with more context to isolate the boundary cause.
                            expanded = copy.deepcopy(target)
                            ex, ey = max(0, x - 48), max(0, y - 48)
                            right, bottom = min(side, x + w + 48), min(side * 3 // 4, y + h + 48)
                            expanded.update(window={'x': ex, 'y': ey, 'w': right - ex, 'h': bottom - ey}, context=64)
                            extra_png, _ = await region('render', expanded)
                            extra = Image.open(io.BytesIO(extra_png)).convert('RGB')
                            v = target['validRegion']
                            more_context = differences(reference.crop((v['x'], v['y'], v['x'] + v['w'], v['y'] + v['h'])),
                                extra.crop((v['x'] - ex, v['y'] - ey, v['x'] - ex + v['w'], v['y'] - ey + v['h'])))
                            regions[-1]['context64SameValidRegion'] = more_context
                            assert more_context['maxLsb'] <= 1
                        draft_target = copy.deepcopy(target)
                        draft_target['quality'] = 'draft'
                        started = time.perf_counter()
                        draft_png, draft_meta = await region('render', draft_target)
                        timings.append({'mode': 'region', 'side': side, 'quality': 'draft', 'cache': 'off',
                            'requestMs': round((time.perf_counter() - started) * 1000, 2)})
                        execution(draft_meta['diagnostics'])
                        draft_image = Image.open(io.BytesIO(draft_png)).convert('RGB')
                        assert draft_image.size == image.size
                        regions[-1]['draftFullDifference'] = differences(image, draft_image)
                    assert await client.call_tool('get_develop', {'id': photo}) == region_settings
            return {'backend': backend, 'source': 'procedural_rgb_not_camera_raw', 'imageChecks': 'pass',
                    'regionEquality': 'differences_observed' if findings else 'within_one_lsb', 'checks': checks, 'regions': regions,
                    'findings': findings, 'requestTimings': timings, 'actualRawPerformance': 'unmeasured', 'memory': 'unmeasured'}
        finally:
            await client.close()
            if process.returncode is None:
                process.terminate()
            await asyncio.wait_for(process.wait(), 10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path)
    parser.add_argument('--json-out', type=Path)
    args = parser.parse_args()
    binary = args.binary or Path(resolve_managed_executable({}, 'win32'))
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    if verified_artifact(binary, digest, MANAGED['version']) is None:
        raise RuntimeError('Managed binary receipt mismatch')
    report = {'binarySha256': digest, 'version': MANAGED['version'], 'results': [asyncio.run(probe(binary, backend)) for backend in ('off', 'dx12')]}
    if args.json_out:
        args.json_out.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'binarySha256': digest, 'results': [
            {key: result[key] for key in ('backend', 'skipped', 'imageChecks', 'regionEquality', 'findings') if key in result} for result in report['results']]}))
    else:
        print(json.dumps(report))


if __name__ == '__main__':
    main()
