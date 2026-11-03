"""Manufacturer-independent synthetic DNG settings/Export acceptance for a managed binary."""

import asyncio
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import struct
import sys
import tempfile

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from lightcraft_mcp import LightCraftMCP
from lightcraft_runtime import child_environment
from raw_controls import CONTROLS, control_location
from raw_white_balance import result_fingerprint


def synthetic_dng():
    """A plain uncompressed Bayer fixture; no camera model or vendor-specific decoder assumptions."""
    width, height = 128, 96
    tags = [
        (256, 4, [width]), (257, 4, [height]), (258, 3, [16]), (259, 3, [1]),
        (262, 3, [32803]), (273, 4, [0]), (277, 3, [1]), (278, 4, [height]),
        (279, 4, [width * height * 2]), (284, 3, [1]),
        (33421, 3, [2, 2]), (33422, 1, [0, 1, 1, 2]),
        (50706, 1, [1, 4, 0, 0]), (50707, 1, [1, 1, 0, 0]),
        (50710, 1, [0, 1, 2]), (50711, 3, [1]), (50714, 4, [0]),
        (50717, 4, [65535]),
        (50721, 10, [1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1]),
        (50728, 5, [1, 1, 1, 1, 1, 1]), (50778, 3, [21]),
    ]
    offset = 8 + 2 + len(tags) * 12 + 4
    entries, extra = [], bytearray()
    for tag, kind, values in sorted(tags):
        data = struct.pack('<' + {1: 'B', 3: 'H', 4: 'I', 5: 'I', 10: 'i'}[kind] * len(values), *values)
        count = len(values) // 2 if kind in (5, 10) else len(values)
        if len(data) > 4:
            value = struct.pack('<I', offset + len(extra))
            extra.extend(data)
        else:
            value = data.ljust(4, b'\0')
        entries.append((tag, kind, count, value))
    image_offset = offset + len(extra)
    header = b'II*\0' + struct.pack('<IH', 8, len(tags))
    header += b''.join(struct.pack('<HHI', tag, kind, count) +
                       (struct.pack('<I', image_offset) if tag == 273 else value)
                       for tag, kind, count, value in entries) + bytes(4) + extra
    return header + b''.join(struct.pack('<H', 12000 + x * 80 + y * 50)
                             for y in range(height) for x in range(width))


async def _probe(binary, expected_version):
    with tempfile.TemporaryDirectory(prefix='genzoroom-settings-') as folder:
        source, output = Path(folder) / 'synthetic.dng', Path(folder) / 'export.jpg'
        source.write_bytes(synthetic_dng())
        source_hash = hashlib.sha256(source.read_bytes()).digest()
        process = await asyncio.create_subprocess_exec(str(binary), 'mcp', '--headless', '--compact',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=24 * 1024**2, env=child_environment(os.environ, gpu_backend='off', temp_directory=folder),
            **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        client = LightCraftMCP(process.stdout, process.stdin, 1)
        try:
            await client.initialize('settings-export-probe', expected_version=expected_version, timeout=30)
            async def tool(name, arguments):
                result = await client.call_tool_result(name, arguments, timeout=60)
                if 'structuredContent' in result:
                    return result['structuredContent']
                text = result['content'][0]['text']
                return None if text == 'ok' else json.loads(text)
            async def command(name, params):
                return await tool('command_run', {'id': name, 'params': params})
            definitions = await client.request('tools/list', timeout=30)
            required_tools = {'command_run', 'import', 'select_photos', 'get_develop', 'render_preview',
                              'render_region_preview', 'estimate_white_balance', 'export'}
            if not required_tools <= {item['name'] for item in definitions['tools']}:
                raise ValueError('GenzoRoom MCP tool missing')
            commands = await tool('command_list', {})
            required_commands = {'library.import', 'library.select', 'photo.inspect', 'develop.get', 'develop.set',
                'develop.merge', 'develop.reset', 'develop.sectionEnabled', 'develop.resetControl',
                'develop.resetSection', 'develop.wb', 'beforeAfter.setBefore', 'app.memoryBudget',
                'library.memory', 'library.xmpPreferences', 'app.gpu'}
            if not required_commands <= {item['id'] for item in commands}:
                raise ValueError('GenzoRoom native command missing')
            await command('library.xmpPreferences', {'autoWrite': False})
            photo = (await tool('import', {'paths': [str(source)], 'mode': 'add'}))['imported'][0]
            await tool('select_photos', {'ids': [photo], 'active': photo})
            await command('beforeAfter.setBefore', {'source': 'import'})
            initial = await tool('get_develop', {'id': photo})
            values = {key: min(spec[1], max(spec[0], spec[3] + spec[2])) for key, spec in CONTROLS.items()}
            await command('develop.set', {'values': values})
            await command('develop.merge', {'settings': {'grading': {'global': {'hue': 25, 'sat': 10, 'lum': 5}}}})
            saved = await tool('get_develop', {'id': photo})
            for key, expected in values.items():
                parent, field = control_location(saved, key)
                if parent[field] != expected:
                    raise ValueError(f'Native control readback mismatch: {key}')
            after_frame = None
            for before in (False, True):
                for quality in ('draft', 'full'):
                    result = await client.call_tool_result('render_preview', {'id': photo, 'max_side': 128,
                        'before': before, 'quality': quality, 'preview_contract': 1}, timeout=60)
                    metadata = json.loads(next(item['text'] for item in result['content'] if item['type'] == 'text'))
                    if metadata['previewContract'] != 1 or metadata['quality'] != quality or \
                            metadata['kind'] != ('before' if before else 'after') or metadata['frame']['nativeWidth'] != 128:
                        raise ValueError('Synthetic RAW Preview contract mismatch')
                    if not before and quality == 'full':
                        after_frame = metadata['frame']
            fingerprint = result_fingerprint(await client.call_tool_result('get_develop', {'id': photo}))
            for operation in ('auto', 'pick'):
                arguments = {'id': str(photo), 'wb_contract': 1, 'operation': operation,
                             'settingsFingerprint': fingerprint, 'requestId': 'a' * 32}
                if operation == 'pick':
                    arguments['frame'] = {'kind': 'after', 'geometryId': after_frame['geometryId'],
                                          'maxSide': 128, 'quality': 'full', 'x': .5, 'y': .5}
                estimate = await tool('estimate_white_balance', arguments)
                if estimate['wbContract'] != 1 or estimate['identity'] != arguments:
                    raise ValueError('Synthetic RAW WB identity mismatch')
            if await tool('get_develop', {'id': photo}) != saved:
                raise ValueError('Before/Preview changed DevelopSettings')
            await command('develop.reset', {'ids': [photo]})
            await command('develop.merge', {'settings': saved})
            if await tool('get_develop', {'id': photo}) != saved:
                raise ValueError('DevelopSettings restore mismatch')
            fixture = json.loads((Path(__file__).parent / 'fixtures/develop-v0.14.json').read_text(encoding='utf-8'))
            await command('develop.reset', {'ids': [photo]})
            await command('develop.merge', {'settings': fixture['settings']})
            saved = await tool('get_develop', {'id': photo})
            if saved != fixture['settings']:
                raise ValueError('Saved v0.14.0 DevelopSettings restore mismatch')
            await tool('export', {'id': photo, 'path': str(output), 'format': 'jpeg', 'longEdge': 0,
                'quality': 95, 'colorSpace': 'srgb', 'bitDepth': 8, 'hdr': False, 'sharpen': 'none',
                'metadata': 'none', 'addToPhotos': False})
            with Image.open(BytesIO(output.read_bytes())) as image:
                if image.format != 'JPEG' or image.size != (128, 96):
                    raise ValueError('Native full-resolution JPEG mismatch')
            if await tool('get_develop', {'id': photo}) != saved:
                raise ValueError('Export changed DevelopSettings')
            legacy = {key: value for key, value in initial.items() if key != 'grading'}
            await command('develop.reset', {'ids': [photo]})
            await command('develop.merge', {'settings': legacy})
            if await tool('get_develop', {'id': photo}) != initial:
                raise ValueError('Legacy missing-grading defaults mismatch')
            if hashlib.sha256(source.read_bytes()).digest() != source_hash or any(Path(folder).glob('*.xmp')):
                raise ValueError('Native changed source or wrote an XMP sidecar')
            print(f'Synthetic DNG settings/Export: {len(values)} controls, v0.14 restore, grading defaults/global, JPEG, source protection passed')
        finally:
            await client.close()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()


def probe_settings_export(binary, *, expected_version):
    asyncio.run(_probe(binary, expected_version))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('binary', type=Path)
    args = parser.parse_args()
    version = json.loads((Path(__file__).parent / 'manifest.json').read_text(encoding='utf-8'))['version']
    probe_settings_export(args.binary.resolve(), expected_version=version)
