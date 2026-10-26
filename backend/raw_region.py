"""C1-only Region DTO validation. No Viewer route or independent worker lives here."""
import json
import math
from pathlib import Path
import re

from lightcraft_mcp import LightCraftError, _decode

SCHEMA = json.loads(Path(__file__).with_name('raw_region_schema.json').read_text(encoding='utf-8'))
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
        and _schema_equal(p.get('target'), {'oneOf': [SCHEMA['$defs']['frameRequest'], SCHEMA['$defs']['request']]})


def _schema_equal(a, b):
    try:
        # Python's True == 1 must not let a boolean capability/schema masquerade as contract 1.
        return json.dumps(a,sort_keys=True,allow_nan=False) == json.dumps(b,sort_keys=True,allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        return False


def _diagnostics(d, operation, before_fingerprint):
    keys = {'sourceLevel', 'sourceHostBytes', 'sourceCacheBytes', 'nativeMs'}
    if operation == 'render':
        keys |= {'execution', 'stageCache', 'workWindow'}
    if before_fingerprint is not None:
        keys |= {'beforeFingerprint', 'effectiveBeforeFingerprint'}
    if isinstance(d, dict) and 'planTiming' in d:
        if operation != 'plan':
            raise ValueError()
        validate_plan_timing(d['planTiming'], d.get('nativeMs'))
        keys.add('planTiming')
    if not isinstance(d, dict) or set(d) != keys or d['sourceLevel'] not in ('Thumb', 'Preview', 'Full'):
        raise ValueError()
    for key in ('sourceHostBytes', 'sourceCacheBytes'):
        if type(d[key]) is not int or not 0 <= d[key] <= 2**53-1:
            raise ValueError()
    if type(d['nativeMs']) not in (int, float) or not math.isfinite(d['nativeMs']) or d['nativeMs'] < 0:
        raise ValueError()
    if before_fingerprint is not None and (d['beforeFingerprint'] != before_fingerprint
            or type(d['effectiveBeforeFingerprint']) is not str or not re.fullmatch('[a-f0-9]{16}', d['effectiveBeforeFingerprint'])):
        raise ValueError()
    if operation == 'render':
        cache = d['stageCache']
        if not isinstance(cache, dict) or set(cache) != {'mode','applied','reason','cpuBytes','gpuBytes','retainedBytes','budgetBytes'} \
                or cache['mode'] not in ('off','on') or type(cache['applied']) is not bool or cache['reason'] not in ('none','budget') \
                or any(type(cache[k]) is not int or not 0 <= cache[k] <= 2**53-1 for k in ('cpuBytes','gpuBytes','retainedBytes','budgetBytes')) \
                or cache['retainedBytes'] > cache['budgetBytes'] \
                or cache['mode'] == 'off' and (cache['applied'] or cache['retainedBytes'] or cache['reason'] != 'none') \
                or cache['mode'] == 'on' and (cache['budgetBytes'] == 0 or cache['applied'] != (cache['reason'] == 'none')):
            raise ValueError()
        e = d['execution']
        if not isinstance(e, dict) or set(e) != {'outcome','backend','reason'} or not (
                e == {'outcome':'gpu_success','backend':'gpu','reason':'none'}
                or e == {'outcome':'cpu_fallback','backend':'cpu','reason':'gpu_failed'}
                or e['outcome'] == 'cpu_not_tried' and e['backend'] == 'cpu'
                and e['reason'] in ('cpu_requested','shutdown','gpu_disabled','unsupported','gpu_unavailable')):
            raise ValueError()


def validate_plan_timing(value, native_ms):
    durations = {'sourcePreparationMs', 'sourceAcquisitionMs', 'imageSelectionMs',
                 'plannerMs', 'geometryMs', 'sourceRetentionMs', 'otherMs'}
    if not isinstance(value, dict) or set(value) != durations | {'sourceKind'} \
            or value['sourceKind'] not in ('loaded', 'fit', 'file', 'other') \
            or any(type(value[k]) not in (int, float) or not math.isfinite(value[k]) or value[k] < 0 for k in durations) \
            or type(native_ms) not in (int, float) or not math.isfinite(native_ms) \
            or abs(sum(value[k] for k in durations) - native_ms) > 0.01:
        raise ValueError()


def validate_result(result, target, operation, photo_id, before_fingerprint=None):
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
        if set(meta) != {'response', 'diagnostics'}:
            raise ValueError()
        r = meta['response']
        if not matches(r, SCHEMA['$defs']['frameResponse' if operation == 'plan' else 'response']):
            raise ValueError()
        mismatches = [key for key, expected in target.items() if r.get(key) != expected]
        if r.get('kind') != target['identity']['kind']:
            mismatches.append('kind')
        if mismatches:
            # Echo diagnostics name fields only; opaque document/source tokens are never logged.
            from lightcraft_runtime import lightcraft_log
            context = {
                'stage': 'native_response_echo', 'reason': 'echo_mismatch', 'operation': operation,
                'revision': target['documentRevision'], 'quality': target['quality'],
                'kind': target['identity']['kind'], 'viewGeneration': target['viewGeneration'],
                'mismatchFields': mismatches, 'nativeResponseReceived': True,
                'mismatchSide': 'native_response',
                'geometryMatches': 'geometryId' not in mismatches,
                'identityMatches': 'identity' not in mismatches,
            }
            if 'desiredLongEdge' in target:
                context['requestDesiredLongEdge'] = target['desiredLongEdge']
                context['responseDesiredLongEdge'] = r.get('desiredLongEdge')
            lightcraft_log('region.geometryMismatch', level='warn', **context)
            raise LightCraftError('raw_region_geometry_mismatch')
        _diagnostics(meta['diagnostics'], operation, before_fingerprint)
        if operation == 'plan':
            if images or result.get('structuredContent') != meta or r['fullWidth'] > r['nativeWidth'] or r['fullHeight'] > r['nativeHeight']:
                raise ValueError()
            return b'', meta
        validate_target({k:r[k] for k in target}, 'render')
        if 'structuredContent' in result or len(images) != 1 or (r['width'],r['height']) != (r['window']['w'],r['window']['h']):
            raise ValueError()
        work = meta['diagnostics']['workWindow']
        if not matches(work, SCHEMA['$defs']['request']['properties']['window']) or work['w']*work['h'] > MAX_PIXELS \
                or work['x']+work['w'] > r['fullWidth'] or work['y']+work['h'] > r['fullHeight'] \
                or work['x'] > r['window']['x'] or work['y'] > r['window']['y'] \
                or work['x']+work['w'] < r['window']['x']+r['window']['w'] or work['y']+work['h'] < r['window']['y']+r['window']['h']:
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
        return raw, meta
    except LightCraftError as error:
        if error.code == 'lightcraft_invalid_preview':
            raise LightCraftError('raw_invalid_region_response') from None
        raise
    except (KeyError, ValueError, TypeError, AttributeError, OverflowError, RecursionError):
        raise LightCraftError('raw_invalid_region_response') from None
