"""Focused sharpening image checks against the attested, unchanged Native MCP binary.

Uses a procedural image, not a camera RAW or a browser. No performance thresholds.
"""
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
from raw_controls import DETAIL_RESET_DEFAULTS
from raw_region import validate_result


def differences(a, b):
    values = ImageChops.difference(a.convert('RGB'), b.convert('RGB')).tobytes()
    return {'maxLsb': max(values), 'meanLsb': sum(values) / len(values),
            'changedChannels': sum(v != 0 for v in values)}


async def probe(binary, backend):
    with tempfile.TemporaryDirectory(prefix='genzoroom-sharpen-') as folder:
        source = Path(folder) / 'detail.png'
        # Flat texture, step edges and fine lines exercise masking without camera-dependent decoding.
        pixels = bytearray()
        for y in range(576):
            for x in range(768):
                value = 100 + (45 if x > 384 else 0) + 15 * math.sin(x / 4) * math.cos(y / 5)
                value += 6 if (x * 7919 + y * 104729) % 13 < 6 else -6
                pixels.extend([round(value)] * 3)
        Image.frombytes('RGB', (768, 576), bytes(pixels)).save(source)
        process = await asyncio.create_subprocess_exec(str(binary), 'mcp', '--headless', '--compact',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=24 * 1024**2, env=child_environment(os.environ, gpu_backend=backend, temp_directory=folder),
            **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        client = LightCraftMCP(process.stdout, process.stdin, 1)
        try:
            await client.initialize('sharpen-probe', expected_version=MANAGED['version'], timeout=30)
            async def command(name, params):
                return await client.call_tool('command_run', {'id': name, 'params': params}, timeout=60)
            gpu = await command('app.gpu', {})
            if backend == 'dx12' and not gpu['available']:
                return {'backend': backend, 'skipped': 'no_adapter'}
            photo = (await command('library.import', {'paths': [str(source)], 'mode': 'add'}))['imported'][0]
            await command('library.select', {'ids': [photo], 'active': photo, 'mode': 'replace'})
            await command('beforeAfter.setBefore', {'source': 'import'})
            timings = []
            def execution(metadata):
                actual = metadata['execution']['outcome']
                if actual != ('gpu_success' if backend == 'dx12' else 'cpu_not_tried'):
                    raise AssertionError(f'Unexpected Native execution outcome: {actual}')
            async def whole(side, quality='full'):
                started = time.perf_counter()
                result = await client.call_tool_result('render_preview', {'id': photo, 'max_side': side,
                    'quality': quality, 'preview_contract': 1, 'stage_cache': 'off'}, timeout=90)
                metadata = json.loads(next(v['text'] for v in result['content'] if v['type'] == 'text'))
                execution(metadata)
                png = base64.b64decode(next(v['data'] for v in result['content'] if v['type'] == 'image'))
                image = Image.open(io.BytesIO(png)).convert('RGB')
                assert image.size == (side, side * 3 // 4)
                timings.append({'side': side, 'quality': quality, 'requestMs': round((time.perf_counter() - started) * 1000, 2)})
                return image, metadata
            async def set_values(amount, mask):
                await command('develop.set', {'values': {'detail.sharpenAmount': amount, 'detail.sharpenMasking': mask}})
                settings = await client.call_tool('get_develop', {'id': photo})
                assert settings['detail']['sharpen_amount'] == amount and settings['detail']['sharpen_masking'] == mask
            checks = []
            for side in (384, 768):
                await set_values(0, 0)
                plain, _ = await whole(side)
                await set_values(0, 100)
                zero_mask, _ = await whole(side)
                assert zero_mask.tobytes() == plain.tobytes()
                await set_values(150, 0)
                sharp, _ = await whole(side)
                delta = differences(plain, sharp)
                assert delta['changedChannels'] > 0
                await set_values(150, 100)
                masked, metadata = await whole(side)
                mask_delta = differences(sharp, masked)
                assert mask_delta['changedChannels'] > 0
                assert differences(plain, masked)['meanLsb'] < delta['meanLsb']
                draft, _ = await whole(side, 'draft')
                assert differences(plain, draft)['changedChannels'] > 0
                before = await client.call_tool('get_develop', {'id': photo})
                await command('develop.sectionEnabled', {'section': 'detail', 'enabled': False})
                off, _ = await whole(side)
                assert off.tobytes() == plain.tobytes()
                disabled = await client.call_tool('get_develop', {'id': photo})
                assert disabled == before | {'disabled_sections': ['detail']}
                await command('develop.sectionEnabled', {'section': 'detail', 'enabled': True})
                on, _ = await whole(side)
                assert on.tobytes() == masked.tobytes()
                checks.append({'side': side, 'amountEffect': delta, 'maskEffect': mask_delta})
            # Match the current context=16 contract at the same virtual full size/source scale.
            await set_values(150, 0)
            whole_image, metadata = await whole(768)
            identity = {'assetId': '12345678-1234-4234-9234-123456789abc', 'sourceId': hashlib.sha256(source.read_bytes()).hexdigest(),
                'generation': 1, 'documentToken': 'c' * 32, 'kind': 'after', 'revision': 1}
            query = {'contractVersion': 1, 'mode': 'region', 'quality': 'full', 'geometryId': metadata['frame']['geometryId'],
                'identity': identity, 'documentRevision': 1, 'viewGeneration': 1, 'requestId': 'd' * 32, 'desiredLongEdge': 768}
            async def region(operation, target):
                result = await client.call_tool_result('render_region_preview', {'id': str(photo), 'region_contract': 1,
                    'operation': operation, 'target': target, 'stage_cache': 'off'}, timeout=90)
                return validate_result(result, target, operation, photo)
            _, plan = await region('plan', query)
            target = {k: v for k, v in query.items() if k != 'desiredLongEdge'}
            target.update(fullWidth=plan['response']['fullWidth'], fullHeight=plan['response']['fullHeight'],
                window={'x': 128, 'y': 96, 'w': 512, 'h': 384}, validRegion={'x': 144, 'y': 112, 'w': 480, 'h': 352}, context=16, prefetch=0)
            png, metadata = await region('render', target)
            execution(metadata['diagnostics'])
            region_image = Image.open(io.BytesIO(png)).convert('RGB')
            reference = whole_image.crop((128, 96, 640, 480))
            interior = differences(reference.crop((16, 16, 496, 368)), region_image.crop((16, 16, 496, 368)))
            boundary = differences(reference, region_image)
            assert interior['maxLsb'] <= 1
            await command('develop.merge', {'settings': {'detail': {k: 2 if k == 'sharpen_radius' else 73 for k in DETAIL_RESET_DEFAULTS},
                'enhance': {'denoise': 62, 'denoise_on': True, 'raw_details': True, 'super_resolution': True}}})
            before_reset = await client.call_tool('get_develop', {'id': photo})
            await command('develop.resetSection', {'section': 'detail'})
            after_reset = await client.call_tool('get_develop', {'id': photo})
            expected = copy.deepcopy(before_reset)
            expected['detail'].update(DETAIL_RESET_DEFAULTS)
            expected['enhance']['denoise'] = 0
            expected['enhance'].pop('denoise_on', None)
            assert after_reset == expected
            return {'backend': backend, 'execution': 'gpu_success' if backend == 'dx12' else 'cpu_not_tried',
                'source': 'procedural_rgb_not_camera_raw', 'checks': checks, 'regionContext16': {'validRegion': interior, 'includingWindowEdges': boundary},
                'detailReset': 'pass', 'requestTimings': timings, 'performanceBenchmark': False}
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
    print(json.dumps(report))


if __name__ == '__main__':
    main()
