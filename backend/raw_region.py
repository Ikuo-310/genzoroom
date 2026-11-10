"""C1-only Region DTO validation. No Viewer route or independent worker lives here."""
import json
import math
from pathlib import Path
import re

from lightcraft_mcp import LightCraftError, _decode

SCHEMA = json.loads(Path(__file__).with_name('raw_region_schema.json').read_text(encoding='utf-8'))
NATIVE_SCHEMA = json.loads(Path(__file__).with_name('raw_region_native_schema.json').read_text(encoding='utf-8'))
MAX_SIDE = 2048
MAX_PIXELS = 2_097_152
MAX_PNG_BYTES = 9 * 1024**2
MAX_LINE_BYTES = 13 * 1024**2
MAX_METADATA_BYTES = 16 * 1024


def matches(value, schema):
    if not isinstance(schema, dict) or set(schema) - {'oneOf','const','enum','type','properties','required',
            'additionalProperties','minimum','maximum','exclusiveMinimum','pattern'}:
        return False
    if 'oneOf' in schema:
        return sum(matches(value, s) for s in schema['oneOf']) == 1
    if 'const' in schema:
        return type(value) is type(schema['const']) and value == schema['const']
    if 'enum' in schema and value not in schema['enum']:
        return False
    kind = schema.get('type')
    if kind == 'object':
        return schema.get('additionalProperties') is False and isinstance(value, dict) and set(schema['required']) <= value.keys() and all(
            k in schema['properties'] and matches(v, schema['properties'][k]) for k, v in value.items())
    if kind in ('integer', 'number'):
        return type(value) in ((int,) if kind == 'integer' else (int, float)) and math.isfinite(value) \
            and value >= schema.get('minimum', -math.inf) and value <= schema.get('maximum', math.inf) \
            and ('exclusiveMinimum' not in schema or value > schema['exclusiveMinimum'])
    if kind == 'string':
        return type(value) is str and ('pattern' not in schema or re.fullmatch(schema['pattern'], value) is not None)
    return False


def validate_target(target, operation):
    try:
        if operation not in ('plan', 'render') or not matches(target, SCHEMA['$defs']['frameRequest' if operation == 'plan' else 'request']):
            raise ValueError()
        if target['identity']['kind'] == 'after' and target['identity']['revision'] != target['documentRevision']:
            raise ValueError()
        if operation == 'render':
            w, fw, fh, c = target['window'], target['fullWidth'], target['fullHeight'], target['context']
            if w['w'] * w['h'] > MAX_PIXELS or w['x'] + w['w'] > fw or w['y'] + w['h'] > fh:
                raise ValueError()
            x = w['x'] + (c if w['x'] else 0)
            y = w['y'] + (c if w['y'] else 0)
            right = w['x'] + w['w'] - (c if w['x'] + w['w'] != fw else 0)
            bottom = w['y'] + w['h'] - (c if w['y'] + w['h'] != fh else 0)
            if right <= x or bottom <= y or target['validRegion'] != {'x': x, 'y': y, 'w': right-x, 'h': bottom-y}:
                raise ValueError()
        return target
    except (KeyError, ValueError, TypeError, OverflowError, RecursionError):
        raise LightCraftError('raw_invalid_region_request') from None


def supports_region(result):
    if not isinstance(result, dict) or not isinstance(result.get('tools'), list):
        return False
    tools = [t for t in result['tools'] if isinstance(t, dict) and t.get('name') == 'render_region_preview']
    if len(tools) != 1:
        return False
    s = tools[0].get('inputSchema', {})
    if not isinstance(s, dict) or not isinstance(s.get('required'), list) or not all(type(k) is str for k in s['required']):
        return False
    p = s.get('properties', {})
    if not isinstance(p, dict) or not all(isinstance(p.get(k), dict) for k in ('id','region_contract','operation','target')):
        return False
    marker = p['region_contract']
    if marker.get('enum') != [1] or type(marker['enum'][0]) is not int:
        return False
    return s.get('type') == 'object' and {'id', 'region_contract', 'operation', 'target'} <= set(s.get('required', [])) \
        and p.get('id', {}).get('type') == 'string' and p.get('region_contract') == {'type': 'integer', 'enum': [1]} \
        and p.get('operation') == {'type': 'string', 'enum': ['plan', 'render']} \
        and _schema_equal(p.get('target'), {'oneOf': [NATIVE_SCHEMA['$defs']['frameRequest'], NATIVE_SCHEMA['$defs']['request']]})


def _schema_equal(a, b):
    try:
        # Python's True == 1 must not let a boolean capability/schema masquerade as contract 1.
        return json.dumps(a,sort_keys=True,allow_nan=False) == json.dumps(b,sort_keys=True,allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        return False


def validate_result(result, target, operation, photo_id):
    """Runs on the owner's existing bounded validation thread, including plan-only metadata."""
    try:
        content = result['content']
        texts = [v for v in content if v.get('type') == 'text']
        images = [v for v in content if v.get('type') == 'image']
        if len(texts) != 1 or len(content) != (1 if operation == 'plan' else 2):
            raise ValueError()
        text = texts[0]['text']
        if not isinstance(text, str) or len(text.encode('utf-8')) > MAX_METADATA_BYTES:
            raise ValueError()
        meta = _decode(text.encode('utf-8'))
        native_keys = ({'kind','quality','geometryId','nativeWidth','nativeHeight','fullWidth','fullHeight'}
                       if operation == 'plan' else
                       {'kind','quality','geometryId','fullWidth','fullHeight','window','width','height'})
        if not isinstance(meta, dict) or set(meta) != native_keys:
            raise ValueError()
        mismatches = [key for key, expected in (('geometryId',target['geometryId']),
            ('quality',target['quality']),('kind',target['identity']['kind'])) if meta.get(key) != expected]
        if operation == 'render' and (meta.get('fullWidth') != target['fullWidth']
                or meta.get('fullHeight') != target['fullHeight'] or meta.get('window') != target['window']):
            mismatches.append('window')
        if mismatches:
            from lightcraft_runtime import lightcraft_log
            context = {
                'stage': 'native_response_echo', 'reason': 'echo_mismatch', 'operation': operation,
                'revision': target['documentRevision'], 'quality': target['quality'],
                'kind': target['identity']['kind'], 'viewGeneration': target['viewGeneration'],
                'mismatchFields': mismatches, 'nativeResponseReceived': True,
                'mismatchSide': 'native_response',
                'geometryMatches': 'geometryId' not in mismatches,
                'identityMatches': True,
            }
            if 'desiredLongEdge' in target:
                context['requestDesiredLongEdge'] = target['desiredLongEdge']
                context['responseDesiredLongEdge'] = target['desiredLongEdge']
            lightcraft_log('region.geometryMismatch', level='warn', **context)
            raise LightCraftError('raw_region_geometry_mismatch')
        if operation == 'plan':
            r = {**target, **meta}
            if images or result.get('structuredContent') != meta or r['fullWidth'] > r['nativeWidth'] or r['fullHeight'] > r['nativeHeight']:
                raise ValueError()
            if not matches(r, SCHEMA['$defs']['frameResponse']):
                raise ValueError()
            return b'', {'response': r}
        r = {**target, **meta}
        if not matches(r, SCHEMA['$defs']['response']):
            raise ValueError()
        validate_target({k:r[k] for k in target}, 'render')
        if 'structuredContent' in result or len(images) != 1 or r['window'] != target['window'] \
                or (r['width'],r['height']) != (r['window']['w'],r['window']['h']):
            raise ValueError()
        data = images[0].get('data')
        if not isinstance(data, str) or not data or len(data) > 4*((MAX_PNG_BYTES+2)//3):
            raise ValueError()
        # Reuse CRC, exact PNG termination and Pillow validation without widening Whole's contract.
        from lightcraft_raw import _validate_png
        shim = {'content':[images[0], {'type':'text','text':json.dumps({'id':photo_id,'width':r['width'],'height':r['height']})}]}
        raw, _, _ = _validate_png(shim, photo_id, MAX_SIDE)
        if len(raw) > MAX_PNG_BYTES:
            raise ValueError()
        return raw, {'response': r}
    except LightCraftError as error:
        if error.code == 'lightcraft_invalid_preview':
            raise LightCraftError('raw_invalid_region_response') from None
        raise
    except (KeyError, ValueError, TypeError, AttributeError, OverflowError, RecursionError):
        raise LightCraftError('raw_invalid_region_response') from None
