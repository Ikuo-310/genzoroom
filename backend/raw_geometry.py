"""Closed Native geometry intents; pointer data is transient, never History metadata."""
import copy
import math
from lightcraft_mcp import LightCraftError

OPERATIONS = ('set', 'drag', 'aspect', 'swap', 'reset', 'straighten', 'rotateLeft', 'rotateRight', 'flipHorizontal', 'flipVertical')
GESTURES = ('set', 'drag', 'straighten')
# These failures originate before the geometry command is sent by the existing mutation owner.
NOT_SENT = ('raw_session_edit_limit', 'raw_busy', 'raw_busy_timeout', 'raw_revision_conflict', 'raw_invalid_request')
HANDLES = ('topLeft', 'topRight', 'bottomRight', 'bottomLeft', 'top', 'right', 'bottom', 'left', 'move')
ORIENTATIONS = ('Normal', 'FlipH', 'Rotate180', 'FlipV', 'Transpose', 'Rotate90', 'Transverse', 'Rotate270')
DEFAULT_CROP = dict(geometry=dict(rect=dict(x0=0.0, y0=0.0, x1=1.0, y1=1.0), angle=0.0), aspect=None, flip_h=False, flip_v=False)


def number(v):
    try:
        return type(v) in (int, float) and math.isfinite(v)
    except OverflowError:
        return False


def vector(v, length):
    return type(v) is list and len(v) == length and all(number(n) for n in v)


def geometry_state(settings, *, required=False):
    if type(settings) is not dict:
        raise LightCraftError('raw_invalid_geometry')
    crop = settings.get('crop', None if required else DEFAULT_CROP)
    orientation = settings.get('orientation', None if required else 'Normal')
    try:
        if not (type(crop) is dict and set(crop) == {'geometry', 'aspect', 'flip_h', 'flip_v'}):
            raise ValueError()
        g = crop['geometry']
        if not (type(g) is dict and set(g) == {'rect', 'angle'}):
            raise ValueError()
        r = g['rect']
        if not (type(r) is dict and set(r) == {'x0', 'y0', 'x1', 'y1'}):
            raise ValueError()
        if not (all(number(v) for v in r.values()) and r['x0'] < r['x1'] and (r['y0'] < r['y1'])):
            raise ValueError()
        if not (number(g['angle']) and -45 <= g['angle'] <= 45):
            raise ValueError()
        a = crop['aspect']
        if not (a is None or (type(a) is list and len(a) == 2 and all((type(n) is int and 1 <= n <= 4294967295 for n in a)) and (1 / 20 <= a[0] / a[1] <= 20))):
            raise ValueError()
        if not (type(crop['flip_h']) is bool and type(crop['flip_v']) is bool):
            raise ValueError()
        if not (type(orientation) is str and orientation in ORIENTATIONS):
            raise ValueError()
    except (KeyError, TypeError, ValueError, OverflowError):
        raise LightCraftError('raw_invalid_geometry') from None
    return {'crop': copy.deepcopy(crop), 'orientation': orientation}


def validate_operation(operation):
    if type(operation) is not dict or set(operation) != {'type', 'params'} or type(operation['type']) is not str:
        raise LightCraftError('raw_invalid_request')
    kind, p = (operation['type'], operation['params'])
    if kind not in OPERATIONS or type(p) is not dict:
        raise LightCraftError('raw_invalid_request')
    valid = False
    if kind == 'set':
        valid = bool(p) and (not set(p) - {'rect', 'angle'}) and ('angle' not in p or (number(p['angle']) and -45 <= p['angle'] <= 45))
        if 'rect' in p:
            valid = valid and vector(p['rect'], 4) and (p['rect'][0] < p['rect'][2]) and (p['rect'][1] < p['rect'][3])
    elif kind == 'straighten':
        valid = set(p) == {'angle'} and number(p['angle']) and (-45 <= p['angle'] <= 45)
    elif kind == 'drag':
        valid = {'handle', 'from', 'to'} <= set(p) and (not set(p) - {'handle', 'from', 'to', 'start', 'keepRatio'})
        valid = valid and type(p['handle']) is str and (p['handle'] in HANDLES) and vector(p['from'], 2) and vector(p['to'], 2)
        valid = valid and ('keepRatio' not in p or type(p['keepRatio']) is bool)
        valid = valid and ('start' not in p or (vector(p['start'], 4) and p['start'][0] < p['start'][2] and (p['start'][1] < p['start'][3])))
    elif kind == 'aspect':
        valid = 'aspect' in p and (not set(p) - {'aspect', 'orientation'}) and ('orientation' not in p or p['orientation'] in ('crop', 'given'))
        a = p.get('aspect')
        if type(a) is str and a in ('free', 'original', 'current', 'toggle'):
            pass
        else:
            try:
                pair = [float(n) for n in a.split('x')] if type(a) is str and len(a) <= 40 else a
                valid = valid and vector(pair, 2) and all((n > 0 and 1 <= math.floor(n * 100 + .5) <= 4294967295 for n in pair)) and (1 / 20 <= pair[0] / pair[1] <= 20)
            except (ValueError, TypeError, ZeroDivisionError, OverflowError):
                valid = False
    else:
        valid = not p
    if not valid:
        raise LightCraftError('raw_invalid_request')
    return copy.deepcopy(operation)


def native_command(operation, photo_id):
    operation = validate_operation(operation)
    kind = operation['type']
    if kind.startswith(('rotate', 'flip')):
        return ('photo.' + kind, {'ids': [photo_id]})
    return ('crop.' + {'swap': 'rotateAspect'}.get(kind, kind), operation['params'])


def valid_metadata(metadata):
    return type(metadata) is dict and set(metadata) == {'operation'} and (type(metadata['operation']) is str) and (metadata['operation'] in OPERATIONS)
