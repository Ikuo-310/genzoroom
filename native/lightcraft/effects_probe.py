"""Bounded Effects/Region diagnostic on synthetic RGB, never a camera-RAW benchmark."""
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
import sys
import tempfile
import time

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from lightcraft_artifact import MANAGED, resolve_managed_executable, verified_artifact
from lightcraft_mcp import LightCraftMCP
from lightcraft_runtime import child_environment
from raw_region import validate_result

BASE = {'effects.texture': 0, 'effects.clarity': 0, 'effects.dehaze': 0,
        'detail.sharpenAmount': 0, 'detail.nrLuminance': 0, 'detail.nrColor': 0}


def differences(a, b):
    hist = ImageChops.difference(a.convert('RGB'), b.convert('RGB')).histogram()
    counts = [sum(hist[k * 256 + i] for k in range(3)) for i in range(256)]
    total = sum(counts)
    def percentile(fraction):
        n = 0
        for i, count in enumerate(counts):
            n += count
            if n >= total * fraction:
                return i
    return {'maxLsb': max(i for i, count in enumerate(counts) if count),
            'meanLsb': round(sum(i * count for i, count in enumerate(counts)) / total, 6),
            'p50Lsb': percentile(.5), 'p95Lsb': percentile(.95), 'p99Lsb': percentile(.99),
            'over1Fraction': round(sum(counts[2:]) / total, 6),
            'over3Fraction': round(sum(counts[4:]) / total, 6),
            'over8Fraction': round(sum(counts[9:]) / total, 6)}


def procedural_scene(path):
    pixels = bytearray()
    for y in range(768):
        for x in range(1024):
            v = 55 + 130 * x / 1023 + 22 * math.sin(x / 8) * math.cos(y / 11)
            if 300 < x < 680 and 180 < y < 570:
                v += 45
            for k in range(3):
                pixels.append(round(max(0, min(255, v + 10 * math.sin((x + y) / 23 + k)))))
    Image.frombytes('RGB', (1024, 768), bytes(pixels)).resize((2048, 1536), Image.Resampling.BICUBIC).save(path)


async def probe(binary, backend):
    with tempfile.TemporaryDirectory(prefix='genzoroom-effects-') as folder:
        source = Path(folder) / 'scene.png'
        procedural_scene(source)
        process = await asyncio.create_subprocess_exec(str(binary), 'mcp', '--headless', '--compact',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=24 * 1024**2, env=child_environment(os.environ, gpu_backend=backend, temp_directory=folder),
            **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        client = LightCraftMCP(process.stdout, process.stdin, 1)
        try:
            await client.initialize('effects-probe', expected_version=MANAGED['version'], timeout=30)
            async def command(name, params):
                return await client.call_tool('command_run', {'id': name, 'params': params}, timeout=60)
            if backend == 'dx12' and not (await command('app.gpu', {}))['available']:
                return {'backend': backend, 'skipped': 'no_adapter'}, {}
            photo = (await command('library.import', {'paths': [str(source)], 'mode': 'add'}))['imported'][0]
            await command('library.select', {'ids': [photo], 'active': photo, 'mode': 'replace'})
            timings, checks, samples, quality_checks = [], [], {}, []
            def execution(meta):
                actual = meta['execution']['outcome']
                assert actual == ('gpu_success' if backend == 'dx12' else 'cpu_not_tried'), actual
            async def whole(side, quality, cache='off', label=''):
                started = time.perf_counter()
                result = await client.call_tool_result('render_preview', {'id': photo, 'max_side': side,
                    'quality': quality, 'preview_contract': 1, 'stage_cache': cache,
                    **({'stage_cache_budget_bytes': 512 * 1024**2} if cache == 'on' else {})}, timeout=90)
                meta = json.loads(next(v['text'] for v in result['content'] if v['type'] == 'text'))
                execution(meta)
                image = Image.open(io.BytesIO(base64.b64decode(next(v['data'] for v in result['content'] if v['type'] == 'image')))).convert('RGB')
                timings.append({'case': label, 'mode': 'whole', 'side': side, 'quality': quality, 'cache': cache,
                                'requestMs': round((time.perf_counter() - started) * 1000, 3)})
                return image, meta
            async def region(operation, target, cache='off'):
                started = time.perf_counter()
                result = await client.call_tool_result('render_region_preview', {'id': str(photo), 'region_contract': 1,
                    'operation': operation, 'target': target, 'stage_cache': cache,
                    **({'stage_cache_budget_bytes': 512 * 1024**2} if cache == 'on' else {})}, timeout=90)
                png, metadata = validate_result(result, target, operation, photo)
                if operation == 'render':
                    execution(metadata['diagnostics'])
                return png, metadata, round((time.perf_counter() - started) * 1000, 3)
            cases = [(f'{key}{value:+}', {f'effects.{key}': value})
                     for key in ('texture', 'clarity', 'dehaze') for value in (-100, -40, 40, 100)]
            cases += [('combined+', {f'effects.{k}': 100 for k in ('texture', 'clarity', 'dehaze')}),
                      ('combined-', {f'effects.{k}': -100 for k in ('texture', 'clarity', 'dehaze')}),
                      ('combinedNRSharpen', {'effects.texture': 70, 'effects.clarity': 70, 'effects.dehaze': 70,
                          'detail.sharpenAmount': 150, 'detail.nrLuminance': 100, 'detail.nrColor': 100}),
                      ('neutral', {})]
            for index, (name, values) in enumerate(cases):
                print(f'effects probe {backend}: {name}', file=sys.stderr, flush=True)
                await command('develop.set', {'values': BASE | values})
                settings = await client.call_tool('get_develop', {'id': photo})
                for key, value in (BASE | values).items():
                    group, field = key.split('.')
                    field = {'sharpenAmount': 'sharpen_amount', 'nrLuminance': 'nr_luminance', 'nrColor': 'nr_color'}.get(field, field)
                    assert settings[group][field] == value
                # Region caps its grid at native dimensions: 2048 is this synthetic source's 100% grid.
                for side in ((1024, 2048) if name in ('texture+100', 'clarity+100', 'dehaze+100') else (1024,)):
                    draft_image = None
                    for quality in ('draft', 'full'):
                        reference, meta = await whole(side, quality, label=name)
                        if quality == 'draft':
                            draft_image = reference
                        else:
                            quality_checks.append({'case': name, 'side': side, 'difference': differences(draft_image, reference)})
                        if side == 1024 and quality == 'full':
                            samples[name] = reference
                        identity = {'assetId': '12345678-1234-4234-9234-123456789abc',
                            'sourceId': hashlib.sha256(source.read_bytes()).hexdigest(), 'generation': 1,
                            'documentToken': 'c' * 32, 'kind': 'after', 'revision': index + 1}
                        query = {'contractVersion': 1, 'mode': 'region', 'quality': quality,
                            'geometryId': meta['frame']['geometryId'], 'identity': identity,
                            'documentRevision': index + 1, 'viewGeneration': index + 1,
                            'requestId': 'd' * 32, 'desiredLongEdge': side}
                        _, plan, _ = await region('plan', query)
                        fw, fh = plan['response']['fullWidth'], plan['response']['fullHeight']
                        assert (fw, fh) == reference.size, (side, quality, (fw, fh), reference.size)
                        points = [('center', fw // 2 - 192, fh // 2 - 144), ('topLeft', 0, 0),
                                  ('topRight', fw - 384, 0), ('bottomLeft', 0, fh - 288),
                                  ('bottomRight', fw - 384, fh - 288), ('edge', 0, fh // 2 - 144),
                                  ('pan', fw // 2 - 179, fh // 2 - 137)]
                        for location, x, y in points:
                            valid = {'x': x, 'y': y, 'w': 384, 'h': 288}
                            # Keep the same valid pixels when varying context, to isolate boundary sensitivity.
                            contexts = (16, 64, 256) if location in ('center', 'pan') and name in (
                                'texture+100', 'clarity+100', 'dehaze+100', 'combinedNRSharpen') else (16,)
                            for context in contexts:
                                wx, wy = max(0, x - context), max(0, y - context)
                                right, bottom = min(fw, x + 384 + context), min(fh, y + 288 + context)
                                target = {k: v for k, v in query.items() if k != 'desiredLongEdge'}
                                # The contract includes image-edge pixels in validRegion; keep our comparison ROI fixed.
                                vx, vy = wx + (context if wx else 0), wy + (context if wy else 0)
                                vr, vb = right - (context if right < fw else 0), bottom - (context if bottom < fh else 0)
                                target.update(fullWidth=fw, fullHeight=fh, window={'x': wx, 'y': wy, 'w': right-wx, 'h': bottom-wy},
                                              validRegion={'x': vx, 'y': vy, 'w': vr-vx, 'h': vb-vy}, context=context, prefetch=0)
                                png, _, ms = await region('render', target)
                                image = Image.open(io.BytesIO(png)).convert('RGB')
                                a = reference.crop((x, y, x + 384, y + 288))
                                b = image.crop((x-wx, y-wy, x-wx+384, y-wy+288))
                                checks.append({'case': name, 'side': side, 'quality': quality, 'location': location,
                                    'windowOrigin': [wx, wy], 'context': context, 'comparisonRegion': valid, 'validRegion': target['validRegion'],
                                    'difference': differences(a, b),
                                    'innerDifference': differences(a.crop((48,48,336,240)), b.crop((48,48,336,240)))})
                                timings.append({'case': name, 'mode': 'region', 'side': side, 'quality': quality,
                                    'context': context, 'location': location, 'requestMs': ms})
                assert await client.call_tool('get_develop', {'id': photo}) == settings
            # Earlier requests disabled stage caching; this measures stage-cold/warm, not cold RAW decode.
            await command('develop.set', {'values': BASE | {'effects.clarity': 70, 'effects.dehaze': 70, 'effects.texture': 70}})
            cold, _ = await whole(1536, 'full', 'on', 'stageCold')
            warm, _ = await whole(1536, 'full', 'on', 'stageWarm')
            assert cold.tobytes() == warm.tobytes()
            identity = {'assetId': '12345678-1234-4234-9234-123456789abc',
                'sourceId': hashlib.sha256(source.read_bytes()).hexdigest(), 'generation': 1,
                'documentToken': 'c' * 32, 'kind': 'after', 'revision': 100}
            _, meta = await whole(1536, 'full')
            query = {'contractVersion': 1, 'mode': 'region', 'quality': 'full', 'geometryId': meta['frame']['geometryId'],
                'identity': identity, 'documentRevision': 100, 'viewGeneration': 100, 'requestId': 'd'*32, 'desiredLongEdge': 1536}
            _, plan, _ = await region('plan', query)
            target = {k: v for k, v in query.items() if k != 'desiredLongEdge'}
            target.update(fullWidth=plan['response']['fullWidth'], fullHeight=plan['response']['fullHeight'],
                window={'x': 320, 'y': 256, 'w': 416, 'h': 320}, validRegion={'x': 336, 'y': 272, 'w': 384, 'h': 288}, context=16, prefetch=0)
            region_images = []
            for label in ('stageColdRegion', 'stageWarmRegion'):
                png, _, ms = await region('render', target, 'on')
                region_images.append(png)
                timings.append({'case': label, 'mode': 'region', 'side': 1536, 'quality': 'full', 'cache': 'on', 'requestMs': ms})
            assert region_images[0] == region_images[1]
            # Native eye applies to hidden state too; reset must preserve it.
            await command('develop.merge', {'settings': {'vignette': {'amount': -33, 'style': 'paintOverlay'},
                'grain': {'amount': 27, 'size': 81, 'roughness': 19, 'seed': 12345}}})
            before = await client.call_tool('get_develop', {'id': photo})
            on, _ = await whole(1024, 'full')
            await command('develop.sectionEnabled', {'section': 'effects', 'enabled': False})
            off, _ = await whole(1024, 'full')
            assert differences(on, off)['maxLsb'] > 0
            assert await client.call_tool('get_develop', {'id': photo}) == before | {'disabled_sections': ['effects']}
            await command('develop.sectionEnabled', {'section': 'effects', 'enabled': True})
            restored, _ = await whole(1024, 'full')
            assert on.tobytes() == restored.tobytes()
            for key in ('texture', 'clarity', 'dehaze'):
                snapshot = await client.call_tool('get_develop', {'id': photo})
                await command('develop.resetControl', {'control': f'effects.{key}'})
                expected = copy.deepcopy(snapshot)
                expected['effects'][key] = 0
                assert await client.call_tool('get_develop', {'id': photo}) == expected
            await command('develop.merge', {'settings': before})
            await command('develop.resetSection', {'section': 'effects'})
            expected = copy.deepcopy(before)
            expected['effects'].update(texture=0, clarity=0, dehaze=0)
            assert await client.call_tool('get_develop', {'id': photo}) == expected
            return {'backend': backend, 'execution': 'gpu_success' if backend == 'dx12' else 'cpu_not_tried',
                    'nativeReadbackAndToggleReset': 'pass', 'cacheColdWarmIdentical': True,
                    'checks': checks, 'draftFullSameGrid': quality_checks, 'requestTimings': timings}, samples
        finally:
            await client.close()
            if process.returncode is None:
                process.terminate()
            await asyncio.wait_for(process.wait(), 10)


def write_report(path, report):
    encoded = json.dumps(report, indent=2, allow_nan=False)
    # One measurement per line keeps the full distribution evidence reviewable in a Git diff.
    for result in report['results']:
        for key in ('checks', 'draftFullSameGrid', 'requestTimings'):
            if key not in result:
                continue
            expanded = json.dumps(result[key], indent=2, allow_nan=False).replace('\n', '\n      ')
            rows = ',\n'.join('        ' + json.dumps(row, separators=(',', ':'), allow_nan=False) for row in result[key])
            encoded = encoded.replace(expanded, '[\n' + rows + '\n      ]', 1)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(encoded + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json-out', type=Path, required=True)
    args = parser.parse_args()
    binary = Path(resolve_managed_executable({}, 'win32'))
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    assert verified_artifact(binary, digest, MANAGED['version']) is not None
    results, samples = [], []
    for backend in ('off', 'dx12'):
        result, images = asyncio.run(probe(binary, backend))
        results.append(result)
        samples.append(images)
    comparison = {name: differences(samples[0][name], samples[1][name]) for name in sorted(samples[0].keys() & samples[1].keys())}
    report = {'version': MANAGED['version'], 'commit': MANAGED['commit'], 'binarySha256': digest,
        'source': 'procedural_rgb_2048x1536_not_camera_raw', 'sourceLevel': '1024x768 procedural pattern resized to 2048x1536 before import; 2048 grid is 100%',
        'limitations': ['noActualRaw', 'noBrowser', 'noRssVram', 'requestTimingIncludesTransportAndDecode',
                        'stageColdIsNotColdSourceDecode', 'contextVariantsAreDiagnosticsNotPolicyChanges'],
        'results': results, 'cpuDx12WholeFull1024': comparison}
    write_report(args.json_out, report)
    print(json.dumps({'output': args.json_out.name, 'backends': [r['backend'] for r in results],
                      'checks': sum(len(r.get('checks', [])) for r in results)}))


if __name__ == '__main__':
    main()
