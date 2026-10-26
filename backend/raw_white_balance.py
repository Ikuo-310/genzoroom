"""Native WB contract 1: token-preserving identity and bounded candidate validation."""
import hashlib
import json
import math


def settings_fingerprint(native_text):
    # Keep native number/string tokens: Python's 1e-07 differs from serde_json's 1e-7.
    # get_develop text already has recursively sorted keys; strip only insignificant whitespace.
    if not isinstance(native_text, str):
        raise ValueError('native settings JSON object required')
    settings = json.loads(native_text)
    if not isinstance(settings, dict):
        raise ValueError('native settings JSON object required')
    compact, quoted, escaped = [], False, False
    for character in native_text:
        if quoted:
            compact.append(character)
            if escaped:
                escaped = False
            elif character == '\\':
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
            compact.append(character)
        elif character not in ' \t\r\n':
            compact.append(character)
    compact = ''.join(compact)
    # develop.get explicitly displays process=1, while DevelopSettings serialization omits legacy V1.
    # Slice top-level token spans instead of reserializing floats or removing nested fields.
    if type(settings.get('process')) is int and settings['process'] == 1:
        decoder, fields, position = json.JSONDecoder(), [], 1
        while position < len(compact) - 1:
            key, key_end = decoder.raw_decode(compact, position)
            _, end = decoder.raw_decode(compact, key_end + 1)
            if key != 'process':
                fields.append(compact[position:end])
            position = end + 1
        compact = '{' + ','.join(fields) + '}'
    return hashlib.sha256(compact.encode()).hexdigest()


def result_fingerprint(result):
    if not isinstance(result, dict) or result.get('isError') is not False or not isinstance(result.get('content'), list) \
            or len(result['content']) != 1 or not isinstance(result['content'][0], dict) or result['content'][0].get('type') != 'text':
        raise ValueError('native settings response required')
    text = next(c['text'] for c in result['content'] if c['type'] == 'text')
    if type(text) is not str or len(text.encode('utf-8')) > 256 * 1024:
        raise ValueError('native settings response too large')
    if json.loads(text) != result['structuredContent']:
        raise ValueError('native settings text/structuredContent mismatch')
    return settings_fingerprint(text)


def supports_wb(tools):
    items = tools.get('tools') if isinstance(tools, dict) else None
    matches = [t for t in items if isinstance(t, dict) and t.get('name') == 'estimate_white_balance'] if isinstance(items, list) else []
    if len(matches) != 1:
        return False
    schema = matches[0].get('inputSchema', {})
    if not isinstance(schema, dict):
        return False
    props = schema.get('properties', {})
    return (schema.get('type') == 'object' and schema.get('additionalProperties') is False
            and isinstance(props, dict) and isinstance(schema.get('required'), list)
            and all(type(key) is str for key in schema['required'])
            and {'id', 'wb_contract', 'operation', 'settingsFingerprint', 'requestId'} <= set(schema['required'])
            and props.get('wb_contract') == {'type': 'integer', 'enum': [1]}
            and type(props['wb_contract']['enum'][0]) is int
            and props.get('operation') == {'type': 'string', 'enum': ['auto', 'pick']}
            and props.get('id') == {'type': 'string', 'pattern': '^[1-9][0-9]*$'}
            and props.get('settingsFingerprint') == {'type': 'string', 'pattern': '^[a-f0-9]{64}$'}
            and props.get('requestId') == {'type': 'string', 'pattern': '^[a-f0-9]{32}$'})


def validate_candidate(result, identity):
    if type(result) is not dict or set(result) != {'wbContract', 'identity', 'candidate'} \
            or type(result['wbContract']) is not int or result['wbContract'] != 1 \
            or type(result['identity']) is not dict or set(result['identity']) != set(identity) \
            or any(type(result['identity'][key]) is not type(value) or result['identity'][key] != value
                   for key, value in identity.items()):
        raise ValueError('WB identity mismatch')
    candidate = result['candidate']
    if type(candidate) is not dict or set(candidate) != {'mode', 'scale', 'temp', 'tint'} \
            or candidate['mode'] != 'auto' or candidate['scale'] not in ('kelvin', 'legacy') \
            or any(type(candidate[k]) not in (int, float) or not math.isfinite(candidate[k]) for k in ('temp', 'tint')) \
            or not 2000 <= candidate['temp'] <= 50000 or not -150 <= candidate['tint'] <= 150:
        raise ValueError('WB candidate invalid')
    return dict(candidate)
