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
    with tempfile.TemporaryDirectory(prefix='genzoroom-point-color-') as folder:
        source = Path(folder) / 'source.png'
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        source.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 48, 8, 2, 0, 0, 0))
                           + chunk(b'IDAT', zlib.compress((b'\0' + bytes([80, 100, 130]) * 64) * 48)) + chunk(b'IEND', b''))
        env = {**os.environ, 'TEMP': folder, 'TMP': folder}
        process = subprocess.Popen([str(binary), 'mcp', '--headless', '--compact'], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8', env=env,
            creationflags=0x08000000 if os.name == 'nt' else 0)
        try:
            counter = 0
            def request(method, params):
                nonlocal counter
                counter += 1
                process.stdin.write(json.dumps({'jsonrpc':'2.0','id':counter,'method':method,'params':params}) + '\n')
                process.stdin.flush()
                response = json.loads(process.stdout.readline())
                if response.get('id') != counter or 'error' in response:
                    raise ValueError(f'Point Color Range MCP error: {response}')
                return response['result']
            def call(name, args):
                return request('tools/call', {'name':name, 'arguments':args})
            def ok(result):
                if result.get('isError') is not False:
                    raise ValueError(f'Point Color Range operation failed: {result}')
                return result
            def image_meta(result):
                content = ok(result)['content']
                image = next(item for item in content if item['type'] == 'image')
                png = base64.b64decode(image['data'], validate=True)
                if image['mimeType'] != 'image/png' or not png.startswith(b'\x89PNG\r\n\x1a\n'):
                    raise ValueError('Point Color Range image mismatch')
                return json.loads(next(item['text'] for item in content if item['type'] == 'text'))
            request('initialize', {'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'genzoroom-build','version':'1'}})
            process.stdin.write(json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'}) + '\n')
            process.stdin.flush()
            tools = request('tools/list', {})['tools']
            for name in ('render_preview', 'render_region_preview'):
                schema = next(tool for tool in tools if tool['name'] == name)['inputSchema']
                field = schema['properties']['point_color_range_index']
                if field.get('type') != 'integer' or field.get('minimum') != 0 or field.get('maximum') != 7 or 'point_color_range_index' in schema.get('required', []):
                    raise ValueError('Point Color Range schema mismatch')
            def command(name, params):
                return ok(call('command_run', {'id':name,'params':params}))
            command('library.import', {'paths':[str(source)],'mode':'add'})
            command('library.select', {'ids':[1],'active':1,'mode':'replace'})
            command('develop.merge', {'settings':{'point_colors':[{'lum':0.5,'chroma':0.1,'hue':30.0},{'lum':0.6,'chroma':0.12,'hue':210.0}]}})
            settings = ok(call('get_develop', {'id':1}))['structuredContent']
            normal = image_meta(call('render_preview', {'id':1,'max_side':64,'quality':'full','include_frame':True}))
            if 'pointColorRangeIndex' in normal:
                raise ValueError('normal Whole contains overlay metadata')
            for quality, index in [('draft', 0), ('full', 1)]:
                meta = image_meta(call('render_preview', {'id':1,'max_side':64,'quality':quality,'include_frame':True,'point_color_range_index':index}))
                if meta.get('pointColorRangeIndex') != index or meta.get('quality') != quality or meta['frame']['geometryId'] != normal['frame']['geometryId']:
                    raise ValueError('Whole Point Color Range metadata mismatch')
            gid = normal['frame']['geometryId']
            base = {'kind':'after','quality':'full','geometryId':gid,'desiredLongEdge':64}
            def region(operation, target, **extra):
                return call('render_region_preview', {'id':'1','region_contract':1,'operation':operation,'target':target,**extra})
            plan = ok(region('plan', base))['structuredContent']
            target = {'kind':'after','quality':'full','geometryId':gid,'fullWidth':plan['fullWidth'],'fullHeight':plan['fullHeight'],
                      'window':{'x':0,'y':0,'w':plan['fullWidth'],'h':plan['fullHeight']}}
            meta = image_meta(region('render', target, point_color_range_index=1))
            if meta.get('pointColorRangeIndex') != 1 or meta.get('geometryId') != gid or meta.get('window') != target['window']:
                raise ValueError('Region Point Color Range metadata mismatch')
            if 'pointColorRangeIndex' in image_meta(region('render', target)):
                raise ValueError('normal Region contains overlay metadata')
            if region('plan', base, point_color_range_index=0).get('isError') is not True:
                raise ValueError('Point Color Range plan accepted')
            if ok(call('get_develop', {'id':1}))['structuredContent'] != settings:
                raise ValueError('Point Color Range changed settings')
        finally:
            process.kill()
            process.wait()
    print('Point Color Range Whole and Region contract verified')


if __name__ == '__main__':
    probe(Path(sys.argv[1]).resolve())
