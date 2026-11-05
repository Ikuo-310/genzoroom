"""Check output-only lens cropping against persisted settings, Whole, Region and JPEG."""
import asyncio
import base64
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from lightcraft_mcp import LightCraftMCP
from lightcraft_runtime import child_environment
from raw_white_balance import result_fingerprint
from settings_export_probe import synthetic_dng


async def probe(binary, backend, version):
    with tempfile.TemporaryDirectory(prefix='genzoroom-optics-crop-') as folder:
        source, output = Path(folder) / 'source.dng', Path(folder) / 'output.jpg'
        source.write_bytes(synthetic_dng())
        process = await asyncio.create_subprocess_exec(str(binary), 'mcp', '--headless', '--compact',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=24 * 1024**2, env=child_environment(os.environ, gpu_backend=backend, temp_directory=folder),
            **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        client = LightCraftMCP(process.stdout, process.stdin, 1)
        try:
            await client.initialize('optics-crop-probe', expected_version=version, timeout=30)
            async def tool(name, args):
                return await client.call_tool(name, args, timeout=90)
            async def command(name, params):
                return await tool('command_run', {'id': name, 'params': params})
            if backend == 'dx12' and not (await command('app.gpu', {}))['available']:
                print('SKIP optics Crop DX12: no adapter')
                return
            await command('library.xmpPreferences', {'autoWrite': False})
            photo = (await command('library.import', {'paths': [str(source)], 'mode': 'add'}))['imported'][0]
            await command('library.select', {'ids': [photo], 'active': photo, 'mode': 'replace'})
            async def settings():
                return await client.call_tool_result('get_develop', {'id': photo})
            async def render(args):
                result = await client.call_tool_result('render_preview', {'id': photo, 'max_side': 64,
                    'quality': 'full', **args}, timeout=90)
                meta = json.loads(next(v['text'] for v in result['content'] if v['type'] == 'text'))
                png = base64.b64decode(next(v['data'] for v in result['content'] if v['type'] == 'image'))
                return meta, Image.open(BytesIO(png)).convert('RGB')

            initial = (await settings())['structuredContent']
            legacy = json.loads((Path(__file__).parent / 'fixtures/develop-v0.18.json').read_text(encoding='utf-8'))
            await command('develop.merge', {'settings': legacy['settings']})
            assert (await settings())['structuredContent'] == legacy['settings'], 'v0.18.0 Crop Recipe changed on restore'
            await render({'preview_contract': 1})
            cases = [
                ('plain', False, 0, 0, 0, False), ('crop', True, 0, 0, 0, False),
                ('distortion', False, -60, 0, 0, False), ('distortion-crop', True, -60, 0, 0, False),
                ('ca', False, 0, 100, 0, False), ('straighten', True, -60, 0, 7, False),
                ('rotate-flip', True, -60, 100, 7, True), ('auto-ca', True, 0, 0, 0, False),
            ]
            for label, cropped, distortion, ca, angle, rotated in cases:
                await command('develop.reset', {'ids': [photo]})
                await command('develop.merge', {'settings': {
                    'orientation': 'Rotate90' if rotated else 'Normal',
                    'crop': {'geometry': {'rect': {'x0': 0, 'y0': .02 if cropped else 0,
                        'x1': .99 if cropped else 1, 'y1': 1}, 'angle': angle},
                        'flip_h': rotated, 'flip_v': rotated},
                    'optics': {'distortion': distortion, 'ca_red': ca, 'remove_ca': label == 'auto-ca'},
                    'geometry': {'constrain_crop': False}}})
                saved = await settings()
                fingerprint = result_fingerprint(saved)
                meta, whole = await render({'preview_contract': 1})
                frame = meta['frame']
                assert meta['execution']['outcome'] == ('gpu_success' if backend == 'dx12' else 'cpu_not_tried')
                draft, _ = await render({'preview_contract': 1, 'quality': 'draft'})
                assert draft['frame']['geometryId'] == frame['geometryId']
                cached, cached_pixels = await render({'preview_contract': 1, 'stage_cache': 'on',
                    'stage_cache_budget_bytes': 512 * 1024**2})
                assert cached['frame'] == frame and cached_pixels.tobytes() == whole.tobytes()
                edit, _ = await render({'display_mode': 'crop-edit', 'crop_edit_contract': 1,
                    'request_id': 'a' * 32, 'settings_fingerprint': fingerprint})
                assert (edit['frame']['nativeWidth'], edit['frame']['nativeHeight']) == ((96, 128) if rotated else (128, 96))
                assert edit['canonicalGeometry']['crop'] == saved['structuredContent']['crop']
                if label == 'plain':
                    plain_geometry = frame['geometryId']
                if label == 'distortion':
                    assert frame['nativeWidth'] < 128 and frame['nativeHeight'] < 96, label
                if label == 'ca':
                    # Subpixel CA constraints can round back to the same integer output size.
                    assert frame['nativeWidth'] <= 128 and frame['nativeHeight'] <= 96
                    assert frame['geometryId'] != plain_geometry
                identity = {'assetId': '12345678-1234-4234-9234-123456789abc', 'sourceId': 'a' * 64,
                    'generation': 1, 'documentToken': 'b' * 32, 'kind': 'after', 'revision': 1}
                query = {'contractVersion': 1, 'mode': 'region', 'quality': 'full',
                    'geometryId': frame['geometryId'], 'identity': identity, 'documentRevision': 1,
                    'viewGeneration': 1, 'requestId': 'c' * 32,
                    # Compare the same sub-native scale; Region caps its plan at native dimensions.
                    'desiredLongEdge': max(frame['fullWidth'], frame['fullHeight'])}
                async def region(operation, target):
                    result = await client.call_tool_result('render_region_preview', {'id': str(photo),
                        'region_contract': 1, 'operation': operation, 'target': target}, timeout=90)
                    return json.loads(next(v['text'] for v in result['content'] if v['type'] == 'text'))
                plan = (await region('plan', query))['response']
                for key in ('geometryId', 'nativeWidth', 'nativeHeight', 'fullWidth', 'fullHeight'):
                    assert plan[key] == frame[key], (label, key, plan[key], frame[key])
                width, height = plan['fullWidth'], plan['fullHeight']
                target = {k: v for k, v in query.items() if k != 'desiredLongEdge'}
                window = {'x': 0, 'y': 0, 'w': width, 'h': height}
                target.update(fullWidth=width, fullHeight=height, window=window,
                    validRegion=window, context=0, prefetch=0)
                result = await client.call_tool_result('render_region_preview', {'id': str(photo),
                    'region_contract': 1, 'operation': 'render', 'target': target}, timeout=90)
                region_meta = json.loads(next(v['text'] for v in result['content'] if v['type'] == 'text'))
                assert region_meta['response']['geometryId'] == frame['geometryId']
                png = base64.b64decode(next(v['data'] for v in result['content'] if v['type'] == 'image'))
                region_pixels = Image.open(BytesIO(png)).convert('RGB')
                assert region_pixels.size == whole.size
                assert max(abs(a - b) for a, b in zip(region_pixels.tobytes(), whole.tobytes())) <= 3, label
                await tool('export', {'id': photo, 'path': str(output), 'format': 'jpeg', 'longEdge': 0,
                    'quality': 95, 'colorSpace': 'srgb', 'bitDepth': 8, 'hdr': False, 'sharpen': 'none',
                    'metadata': 'none', 'addToPhotos': False})
                with Image.open(output) as jpeg:
                    assert jpeg.size == (max(1, round(frame['nativeWidth'])), max(1, round(frame['nativeHeight']))), label
                assert await settings() == saved, 'render/export persisted the automatic output crop'
                await command('develop.reset', {'ids': [photo]})
                await command('develop.merge', {'settings': saved['structuredContent']})
                assert await settings() == saved, 'Recipe readback/fingerprint did not round-trip'
            await command('develop.reset', {'ids': [photo]})
            assert (await settings())['structuredContent'] == initial
            print(f'Optics Crop {backend}: {len(cases)} cases, Whole/Region/JPEG, readback/restore/Reset PASS')
        finally:
            await client.close()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()


if __name__ == '__main__':
    version = json.loads((Path(__file__).parent / 'manifest.json').read_text(encoding='utf-8'))['version']
    for backend in ('off', 'dx12') if os.name == 'nt' else ('off',):
        asyncio.run(probe(Path(sys.argv[1]).resolve(), backend, version))
