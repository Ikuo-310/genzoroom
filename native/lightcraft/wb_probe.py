"""Small procedural-image WB contract probe against the actual managed MCP executable."""
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from lightcraft_mcp import LightCraftMCP
from lightcraft_runtime import child_environment


from raw_white_balance import settings_fingerprint, result_fingerprint


def validate_schema(tools):
    matches = [t for t in tools['tools'] if t.get('name') == 'estimate_white_balance']
    if len(matches) != 1:
        raise ValueError('WB tool missing or duplicated')
    tool = matches[0]
    schema = tool['inputSchema']
    fields = {'id', 'wb_contract', 'operation', 'settingsFingerprint', 'requestId', 'frame'}
    if schema.get('type') != 'object' or schema.get('additionalProperties') is not False \
            or set(schema.get('properties', {})) != fields \
            or set(schema.get('required', [])) != fields - {'frame'} \
            or schema['properties']['wb_contract'] != {'type': 'integer', 'enum': [1]} \
            or schema['properties']['operation'] != {'type': 'string', 'enum': ['auto', 'pick']} \
            or tool.get('annotations', {}).get('readOnlyHint') is not True:
        raise ValueError('WB schema mismatch')
    frame = schema['properties']['frame']
    if frame.get('additionalProperties') is not False \
            or set(frame['properties']) != {'kind', 'geometryId', 'maxSide', 'quality', 'x', 'y'} \
            or set(frame['required']) != set(frame['properties']) \
            or frame['properties']['kind']['enum'] != ['before', 'after'] \
            or frame['properties']['quality']['enum'] != ['draft', 'full']:
        raise ValueError('WB frame schema mismatch')


async def _probe(binary, backend, expected_version):
    with tempfile.TemporaryDirectory(prefix='genzoroom-wb-') as folder:
        source = Path(folder) / 'sample.png'
        Image.new('RGB', (128, 96), (106, 117, 109)).save(source)
        black = Path(folder) / 'black.png'
        Image.new('RGB', (128, 96)).save(black)
        process = await asyncio.create_subprocess_exec(str(binary), 'mcp', '--headless', '--compact',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=24 * 1024**2, env=child_environment(os.environ, gpu_backend=backend, temp_directory=folder),
            **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        client = LightCraftMCP(process.stdout, process.stdin, 1)
        try:
            await client.initialize('wb-probe', expected_version=expected_version, timeout=30)
            validate_schema(await client.request('tools/list', timeout=10))

            async def command(name, params):
                return await client.call_tool('command_run', {'id': name, 'params': params}, timeout=60)

            gpu = await command('app.gpu', {})
            if backend == 'dx12' and not gpu['available']:
                print('SKIP WB DX12 integration: no available adapter')
                return {'backend': backend, 'skipped': 'no_adapter'}
            photo = (await command('library.import', {'paths': [str(source)], 'mode': 'add'}))['imported'][0]
            dark = (await command('library.import', {'paths': [str(black)], 'mode': 'add'}))['imported'][0]
            await command('library.select', {'ids': [photo], 'active': photo, 'mode': 'replace'})
            await command('beforeAfter.setBefore', {'source': 'import'})
            await command('develop.merge', {'settings': {'optics': {'distortion': -80},
                'geometry': {'vertical': 12}, 'light': {'exposure': 1e-7}}})
            settings_result = await client.call_tool_result('get_develop', {'id': photo})
            settings = settings_result['structuredContent']
            identity = {'id': str(photo), 'wb_contract': 1, 'operation': 'auto',
                        'requestId': 'c' * 32, 'settingsFingerprint': result_fingerprint(settings_result)}
            checks = 0

            async def estimate(args, code=None, unchanged=settings):
                nonlocal checks
                result = await client.request('tools/call', {'name': 'estimate_white_balance', 'arguments': args}, timeout=60)
                current = await client.call_tool('get_develop', {'id': int(args['id'])})
                if current != unchanged:
                    raise ValueError('WB changed develop settings')
                checks += 1
                if code:
                    if result != {'isError': True, 'content': [{'type': 'text', 'text': json.dumps({'code': code}, separators=(',', ':'))}]}:
                        raise ValueError('WB fixed error mismatch')
                    return None
                if result.get('isError') is not False:
                    raise ValueError('WB estimate failed')
                value = result['structuredContent']
                if set(value) != {'wbContract', 'identity', 'candidate'} or value['wbContract'] != 1 or value['identity'] != args:
                    raise ValueError('WB identity mismatch')
                candidate = value['candidate']
                if set(candidate) != {'mode', 'scale', 'temp', 'tint'} or candidate['mode'] != ('auto' if args['operation'] == 'auto' else 'custom') \
                        or candidate['scale'] != 'legacy' or any(type(candidate[k]) not in (int, float) or not math.isfinite(candidate[k]) for k in ('temp', 'tint')) \
                        or not 2000 <= candidate['temp'] <= 50000 or not -150 <= candidate['tint'] <= 150:
                    raise ValueError('WB candidate invalid')
                return candidate

            auto = await estimate(identity)
            # Legacy Recipe process is displayed by develop.get but omitted by the Native hash input.
            await command('develop.merge', {'settings': {'process': 1}})
            legacy_result = await client.call_tool_result('get_develop', {'id': photo})
            legacy_identity = {**identity, 'settingsFingerprint': result_fingerprint(legacy_result)}
            await estimate(legacy_identity, unchanged=legacy_result['structuredContent'])
            await command('develop.merge', {'settings': {'process': settings['process']}})
            frames = {}
            execution = None
            for kind in ('after', 'before'):
                rendered = await client.call_tool_result('render_preview', {'id': photo, 'max_side': 128,
                    'preview_contract': 1, 'quality': 'full', 'before': kind == 'before'}, timeout=60)
                meta = json.loads(next(c['text'] for c in rendered['content'] if c['type'] == 'text'))
                expected = 'gpu_success' if backend == 'dx12' else 'cpu_not_tried'
                if meta['execution']['outcome'] != expected:
                    raise ValueError('WB regression render execution mismatch')
                execution = meta['execution']
                frames[kind] = {'kind': kind, 'geometryId': meta['frame']['geometryId'], 'maxSide': 128,
                                'quality': 'full', 'x': 0.5, 'y': 0.5}
                await estimate({**identity, 'operation': 'pick', 'frame': frames[kind]})
            if frames['before']['geometryId'] == frames['after']['geometryId']:
                raise ValueError('WB Before fixture must have distinct geometry')
            await estimate({**identity, 'operation': 'pick', 'frame': {**frames['before'], 'geometryId': frames['after']['geometryId']}}, 'wb_geometry_mismatch')
            for patch, code in (({'wb_contract': 2}, 'wb_invalid_request'),
                                ({'settingsFingerprint': 'f' * 64}, 'wb_settings_mismatch'),
                                ({'frame': frames['after']}, 'wb_invalid_request'),
                                ({'operation': 'pick'}, 'wb_invalid_request'),
                                ({'extra': 'private-path'}, 'wb_invalid_request')):
                await estimate(identity | patch, code)
            for x in (-1, 2, None, 'NaN'):
                await estimate({**identity, 'operation': 'pick', 'frame': {**frames['after'], 'x': x}}, 'wb_invalid_request')
            dark_result = await client.call_tool_result('get_develop', {'id': dark})
            dark_settings = dark_result['structuredContent']
            await estimate({**identity, 'id': str(dark), 'settingsFingerprint': result_fingerprint(dark_result)},
                           'wb_no_valid_samples', unchanged=dark_settings)
            legacy = await command('develop.wb', {'mode': 'auto'})
            if any(auto[k] != legacy[k] for k in ('temp', 'tint')):
                raise ValueError('WB differs from legacy AW')
            summary = {'backend': backend, 'checks': checks, 'settingsUnchanged': True,
                       'wbContract': 1, 'execution': execution}
            print('WB binary probe ' + json.dumps(summary, separators=(',', ':')))
            return summary
        finally:
            await client.close()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.kill()
                await process.wait()


def probe_wb(binary, *, expected_version):
    results = [asyncio.run(_probe(binary, 'off', expected_version))]
    if os.name == 'nt':
        results.append(asyncio.run(_probe(binary, 'dx12', expected_version)))
    return results
