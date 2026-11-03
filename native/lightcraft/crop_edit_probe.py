"""Procedural pixels and Native command/read-only acceptance for Crop editing contract 1."""
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
from lightcraft_mcp import LightCraftMCP, MCPRpcError
from lightcraft_runtime import child_environment
from raw_white_balance import result_fingerprint
from settings_export_probe import synthetic_dng


async def _probe(binary, backend, expected_version):
    with tempfile.TemporaryDirectory(prefix='genzoroom-crop-') as folder:
        source = Path(folder) / 'grid.png'
        image = Image.new('RGB', (128, 96))
        image.putdata([(230 if x < 32 else 30, 40 if y < 48 else 210, (x * 2) % 256)
                       for y in range(96) for x in range(128)])
        image.save(source)
        raw = Path(folder) / 'cold.dng'
        raw.write_bytes(synthetic_dng())
        process = await asyncio.create_subprocess_exec(str(binary), 'mcp', '--headless', '--compact',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=24 * 1024**2, env=child_environment(os.environ, gpu_backend=backend, temp_directory=folder),
            **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        client = LightCraftMCP(process.stdout, process.stdin, 1)
        checks = 0
        try:
            await client.initialize('crop-edit-probe', expected_version=expected_version, timeout=30)
            schema = next(t['inputSchema'] for t in (await client.request('tools/list'))['tools']
                          if t['name'] == 'render_preview')['properties']
            assert schema['display_mode']['enum'] == ['crop-edit']
            assert schema['crop_edit_contract'] == {'type': 'integer', 'enum': [1]}

            async def command(name, params):
                return await client.call_tool('command_run', {'id': name, 'params': params}, timeout=60)

            if backend == 'dx12' and not (await command('app.gpu', {}))['available']:
                print('SKIP Crop DX12: no adapter')
                return
            await command('library.xmpPreferences', {'autoWrite': False})
            photo = (await command('library.import', {'paths': [str(source)], 'mode': 'add'}))['imported'][0]
            await command('library.select', {'ids': [photo], 'active': photo, 'mode': 'replace'})

            async def settings():
                return await client.call_tool_result('get_develop', {'id': photo})

            async def render(edit=True, **overrides):
                nonlocal checks
                before = await settings()
                fingerprint = result_fingerprint(before)
                args = {'id': photo, 'max_side': 128, 'quality': 'full'}
                args.update({'display_mode': 'crop-edit', 'crop_edit_contract': 1,
                             'request_id': 'a' * 32, 'settings_fingerprint': fingerprint}
                            if edit else {'preview_contract': 1})
                args.update(overrides)
                result = await client.call_tool_result('render_preview', args, timeout=120)
                assert before == await settings(), 'preview changed settings/fingerprint'
                meta = json.loads(next(c['text'] for c in result['content'] if c['type'] == 'text'))
                data = base64.b64decode(next(c['data'] for c in result['content'] if c['type'] == 'image'))
                with Image.open(BytesIO(data)) as output:
                    pixels = output.convert('RGB').copy()
                frame = meta['frame']
                assert set(frame) == {'geometryId', 'nativeWidth', 'nativeHeight', 'aspect', 'fullWidth', 'fullHeight', 'window'}
                assert frame['fullWidth'] == meta['width'] == pixels.width
                assert frame['fullHeight'] == meta['height'] == pixels.height
                assert frame['window'] is None and len(frame['geometryId']) == 64
                if edit:
                    assert meta['cropEditContract'] == 1 and meta['mode'] == 'crop-edit'
                    assert 'previewContract' not in meta and meta['kind'] == 'after'
                    assert meta['requestId'] == args['request_id'] and meta['settingsFingerprint'] == fingerprint
                    assert meta['canonicalGeometry'] == {k: before['structuredContent'][k] for k in ('crop', 'orientation')}
                    assert meta['bitmapSpace'] == 'oriented-warped-unstraightened-flipped'
                else:
                    assert meta['previewContract'] == 1 and meta['mode'] == 'whole'
                assert meta['execution']['outcome'] == ('gpu_success' if backend == 'dx12' else 'cpu_not_tried')
                checks += 1
                return meta, pixels

            # Noncentral crop removes the red left border; uncropped rendering recovers its pixels.
            await command('crop.set', {'rect': [.3, .2, .9, .8]})
            normal, cropped = await render(False)
            edit, full = await render()
            assert normal['frame']['geometryId'] != edit['frame']['geometryId']
            assert (full.width, full.height) == (128, 96)
            assert full.getpixel((4, 4))[0] > cropped.getpixel((4, 4))[0] + 40
            cached, cached_pixels = await render(stage_cache='on', stage_cache_budget_bytes=512 * 1024**2)
            assert cached_pixels.tobytes() == full.tobytes()
            await render(False, stage_cache='on', stage_cache_budget_bytes=512 * 1024**2)
            _, back = await render(stage_cache='on', stage_cache_budget_bytes=512 * 1024**2)
            assert back.tobytes() == full.tobytes(), 'mode cache collision'

            # All native Crop operations round-trip; numeric angle refits identically to Straighten.
            start = (await settings())['structuredContent']
            for name, params in [
                ('crop.drag', {'handle': 'bottomRight', 'from': [.9, .8], 'to': [.7, .7], 'start': [.3, .2, .9, .8]}),
                ('crop.aspect', {'aspect': '4x5'}), ('crop.aspect', {'aspect': [2, 3]}),
                ('crop.aspect', {'aspect': 'toggle'}), ('crop.rotateAspect', {}),
                ('crop.straighten', {'angle': 12}), ('develop.set', {'control': 'crop.angle', 'value': -12}),
                ('photo.rotateLeft', {'ids': [photo]}), ('photo.rotateRight', {'ids': [photo]}),
                ('photo.flipHorizontal', {'ids': [photo]}), ('photo.flipVertical', {'ids': [photo]}),
                ('crop.reset', {})]:
                response = await command(name, params)
                assert response is None or type(response.get('changed')) is int
                await render()

            for orientation in ('Normal', 'Rotate90'):
                for angle in (-12, 0, 12):
                    for fh, fv in ((False, False), (True, False), (False, True), (True, True)):
                        await command('develop.merge', {'settings': {'orientation': orientation,
                            'crop': {'geometry': {'rect': {'x0': -.01, 'y0': .2, 'x1': 1.01, 'y1': .7}, 'angle': angle},
                                     'flip_h': fh, 'flip_v': fv}}})
                        m, pixels = await render()
                        assert (m['frame']['nativeWidth'], m['frame']['nativeHeight']) == ((128, 96) if orientation == 'Normal' else (96, 128))
                        # Canonical angle/rect are ignored only by display, while orientation/flips remain.
                        await command('develop.merge', {'settings': {'crop': {'geometry': start['crop']['geometry']}}})
                        other, other_pixels = await render(quality='draft')
                        assert other['frame']['geometryId'] == m['frame']['geometryId']
                        assert other_pixels.size == pixels.size

            await command('photo.rotateRight', {'ids': [photo]})
            orientation = (await settings())['structuredContent']['orientation']
            await command('crop.reset', {})
            reset = (await settings())['structuredContent']
            assert reset['orientation'] == orientation
            assert reset['crop'] == {'geometry': {'rect': {'x0': 0.0, 'y0': 0.0, 'x1': 1.0, 'y1': 1.0}, 'angle': 0.0},
                                     'aspect': None, 'flip_h': False, 'flip_v': False}
            base = {'id': photo, 'display_mode': 'crop-edit', 'crop_edit_contract': 1,
                    'request_id': 'a' * 32, 'settings_fingerprint': result_fingerprint(await settings())}
            for patch, code in [({'display_mode': 'unknown'}, 'preview_invalid_contract'),
                                ({'crop_edit_contract': 2}, 'preview_invalid_contract'),
                                ({'crop_edit_contract': True}, 'preview_invalid_contract'),
                                ({'before': True}, 'preview_invalid_contract'),
                                ({'preview_contract': 1}, 'preview_invalid_contract'),
                                ({'quality': None}, 'preview_invalid_quality'),
                                ({'request_id': ''}, 'preview_invalid_contract'),
                                ({'max_side': 0}, 'preview_invalid_contract'),
                                ({'settings_fingerprint': '0' * 64}, 'preview_settings_mismatch'),
                                ({'extra': True}, 'preview_invalid_contract')]:
                try:
                    result = await client.request('tools/call', {'name': 'render_preview', 'arguments': base | patch}, timeout=60)
                except MCPRpcError as error:
                    # The shared MCP helper rejects unknown keys before dispatching the preview parser.
                    assert patch == {'extra': True} and error.rpc_code == -32602
                else:
                    assert result['isError'] is True and json.loads(result['content'][0]['text']) == {'code': code}
                checks += 1

            # No accept()/WB learning even for a cold RAW decode.
            photo = (await command('library.import', {'paths': [str(raw)], 'mode': 'add'}))['imported'][0]
            await render()
            print(json.dumps({'cropEditContract': 1, 'backend': backend, 'checks': checks,
                              'settingsUnchanged': True, 'peripheralPixels': True}))
        finally:
            await client.close()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()


def probe_crop_edit(binary, *, expected_version):
    for backend in ('off', 'dx12') if os.name == 'nt' else ('off',):
        asyncio.run(_probe(binary, backend, expected_version))


if __name__ == '__main__':
    probe_crop_edit(Path(sys.argv[1]).resolve(), expected_version='0.18.0')
