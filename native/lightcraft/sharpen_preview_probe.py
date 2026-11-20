import base64
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import zlib


def probe(binary):
    for backend in ('off', 'dx12'):
        with tempfile.TemporaryDirectory(prefix='genzoroom-sharpen-') as folder:
            def chunk(kind, data):
                return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

            source = Path(folder) / 'source.png'
            source.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 48, 8, 2, 0, 0, 0))
                               + chunk(b'IDAT', zlib.compress((b'\0' + bytes([80, 100, 130]) * 64) * 48)) + chunk(b'IEND', b''))
            env = {**os.environ, 'TEMP': folder, 'TMP': folder, 'LIGHTCRAFT_GPU_BACKEND': backend}
            process = subprocess.Popen([str(binary), 'mcp', '--headless', '--compact'], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8', env=env,
                creationflags=0x08000000 if os.name == 'nt' else 0)
            try:
                counter = 0

                def request(method, params):
                    nonlocal counter
                    counter += 1
                    process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': counter, 'method': method, 'params': params}) + '\n')
                    process.stdin.flush()
                    result = json.loads(process.stdout.readline())
                    if result.get('id') != counter or 'error' in result:
                        raise ValueError(f'MCP error: {result}')
                    return result['result']

                def call(name, args):
                    return request('tools/call', {'name': name, 'arguments': args})

                def ok(result):
                    if result.get('isError') is not False:
                        raise ValueError(f'operation failed: {result}')
                    return result

                def meta(result):
                    content = ok(result)['content']
                    image = next(item for item in content if item['type'] == 'image')
                    if image['mimeType'] != 'image/png' or not base64.b64decode(image['data'], validate=True).startswith(b'\x89PNG\r\n\x1a\n'):
                        raise ValueError('invalid preview image')
                    return json.loads(next(item['text'] for item in content if item['type'] == 'text'))

                request('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'genzoroom-build', 'version': '1'}})
                process.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n')
                process.stdin.flush()
                schema = next(t for t in request('tools/list', {})['tools'] if t['name'] == 'render_preview')['inputSchema']
                field = schema['properties']['sharpen_preview']
                if field.get('type') != 'string' or field.get('enum') != ['grayscale', 'detail', 'mask'] or 'sharpen_preview' in schema.get('required', []):
                    raise ValueError('sharpen preview schema mismatch')
                def command(name, params):
                    return ok(call('command_run', {'id': name, 'params': params}))
                command('library.import', {'paths': [str(source)], 'mode': 'add'})
                command('library.select', {'ids': [1], 'active': 1, 'mode': 'replace'})
                command('beforeAfter.setBefore', {'source': 'import'})
                command('develop.merge', {'settings': {'point_colors': [{'lum': 0.5, 'chroma': 0.1, 'hue': 30.0}]}})
                gpu = command('app.gpu', {'wait': True})['structuredContent']
                if backend == 'dx12' and not gpu.get('available'):
                    print('SKIP sharpening DX12 probe: no available adapter')
                    continue
                settings = ok(call('get_develop', {'id': 1}))['structuredContent']
                args = {'id': 1, 'max_side': 64, 'include_frame': True}
                for quality in ('draft', 'full'):
                    for mode in ('grayscale', 'detail', 'mask'):
                        result = meta(call('render_preview', {**args, 'quality': quality, 'sharpen_preview': mode}))
                        if result.get('kind') != 'after' or result.get('quality') != quality or result.get('sharpenPreview') != mode:
                            raise ValueError('sharpen preview response mismatch')
                for extra in ({'sharpen_preview': 'invalid'}, {'sharpen_preview': None}, {'sharpen_preview': 1},
                              {'sharpen_preview': 'mask', 'before': True}, {'sharpen_preview': 'mask', 'crop_edit': True},
                              {'sharpen_preview': 'mask', 'point_color_range_index': 0}):
                    if call('render_preview', {**args, **extra}).get('isError') is not True:
                        raise ValueError(f'invalid preview accepted: {extra}')
                normal = meta(call('render_preview', args))
                before = meta(call('render_preview', {**args, 'before': True}))
                point = meta(call('render_preview', {**args, 'point_color_range_index': 0}))
                if normal.get('kind') != 'after' or 'sharpenPreview' in normal or before.get('kind') != 'before' or point.get('pointColorRangeIndex') != 0:
                    raise ValueError('existing preview contract mismatch')
                if ok(call('get_develop', {'id': 1}))['structuredContent'] != settings:
                    raise ValueError('sharpen preview changed settings')
                gpu = command('app.gpu', {'wait': True})['structuredContent']
                if backend == 'dx12' and gpu.get('lastFallback'):
                    raise ValueError(f'DX12 rendering fell back to CPU: {gpu["lastFallback"]}')
                print(f'Sharpen preview contract verified with backend={backend}, GPU status={gpu}')
            finally:
                process.kill()
                process.wait()


if __name__ == '__main__':
    probe(Path(sys.argv[1]).resolve())
