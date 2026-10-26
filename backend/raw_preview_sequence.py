"""Small diagnostic sequence; no persistence, policy tuning or performance verdicts."""

import secrets
from time import monotonic

from lightcraft_mcp import LightCraftError
from lightcraft_raw import SUPERSEDED

OPERATIONS = ('open', 'wholeDraft', 'wholeFull', 'mutationDraft', 'endFull',
              'regionPlan', 'regionFull', 'pan', 'before', 'after')


def sequence_plan(repeats):
    return [{"index": index, "operation": operation, "repeat": repeat, "warmup": repeat == 0,
             "quality": "draft" if operation in ('wholeDraft', 'mutationDraft') else "full",
             "stageCache": "off", "temperature": "cold", "group": f"viewer:{repeat}"}
            for index, (repeat, operation) in enumerate(
                (r, op) for r in range(repeats + 1) for op in OPERATIONS)]


class RawPreviewSequence:
    def __init__(self, raw, handle, open_ms):
        self.raw, self.handle, self.open_ms = raw, handle, open_ms
        self.whole = self.plan = None

    async def step(self, trial):
        started = monotonic()
        operation = trial['operation']
        snapshot = await self.raw.get_settings(self.handle)
        if operation == 'mutationDraft':
            snapshot = await self.raw.set_controls(self.handle, {'light.exposure': 0.25}, snapshot.revision)
        region = None
        native_ms = validation_ms = None
        plan_timing = None
        if operation in ('regionPlan', 'regionFull', 'pan'):
            if not self.whole:
                raise LightCraftError('raw_diagnostic_sequence_invalid')
            geometry = self.whole.frame
            target = {'contractVersion': 1, 'mode': 'region', 'quality': 'full',
                      'geometryId': geometry['geometryId'], 'identity': self.raw.region_identity(self.handle),
                      'documentRevision': snapshot.revision, 'viewGeneration': trial['index'] + 1,
                      'requestId': secrets.token_hex(16)}
            if operation == 'regionPlan':
                result = await self.raw.request_region(self.handle, {**target,
                    'desiredLongEdge': max(geometry['nativeWidth'], geometry['nativeHeight'])}, operation='plan')
                if result is SUPERSEDED:
                    raise LightCraftError('raw_diagnostic_superseded')
                self.plan = result.metadata['response']
                native_ms = result.metadata['diagnostics']['nativeMs']
                plan_timing = result.metadata['diagnostics'].get('planTiming')
                frame = self.whole
            else:
                if not self.plan:
                    raise LightCraftError('raw_diagnostic_sequence_invalid')
                fw, fh = self.plan['fullWidth'], self.plan['fullHeight']
                # One modest viewport and one outside-cache Pan; C0/C3 product budgets stay unchanged.
                w, h = min(768, fw), min(576, fh)
                x = min(fw - w, max(0, (fw - w) // 2 + (w if operation == 'pan' else 0)))
                y = max(0, (fh - h) // 2)
                window = {'x': x, 'y': y, 'w': w, 'h': h}
                result = await self.raw.request_region(self.handle, {**target, 'fullWidth': fw, 'fullHeight': fh,
                    'window': window, 'validRegion': window, 'context': 0, 'prefetch': 0})
                if result is SUPERSEDED:
                    raise LightCraftError('raw_diagnostic_superseded')
                metadata = result.metadata
                native_ms = metadata['diagnostics']['nativeMs']
                region = {'fullWidth': fw, 'fullHeight': fh, 'window': window,
                          'limited': fw < geometry['nativeWidth'] or fh < geometry['nativeHeight']}
                frame = result
        else:
            frame = await self.raw.request_preview(self.handle, snapshot.revision, 1024,
                kind='before' if operation == 'before' else 'after', quality=trial['quality'], serial=trial['index'] + 1)
            if frame is SUPERSEDED:
                raise LightCraftError('raw_diagnostic_superseded')
            if operation != 'before':
                self.whole = frame
            if frame.metrics:
                native_ms, validation_ms = frame.metrics['nativeMs'], frame.metrics['validationMs']
        geometry = frame.frame if operation == 'before' else self.whole.frame
        if not geometry:
            raise LightCraftError('raw_diagnostic_geometry_missing')
        elapsed = (monotonic() - started) * 1000
        bitmap = ({'width': region['window']['w'], 'height': region['window']['h']} if region
                  else {'width': frame.width, 'height': frame.height})
        data = b'' if operation == 'regionPlan' else frame.data
        return data, {'operation': operation, 'repeat': trial['repeat'], 'warmup': trial['warmup'],
            'revision': snapshot.revision, 'viewGeneration': trial['index'] + 1,
            'quality': trial['quality'], 'geometry': geometry, 'bitmap': bitmap, 'region': region,
            'wholeRequestedSide': 1024, 'stageCache': {'mode': 'off', 'applied': False},
            'timing': {'backendOperationMs': elapsed + (self.open_ms if operation == 'open' else 0),
                       'openMs': self.open_ms if operation == 'open' else None,
                       'nativeMs': native_ms, 'validationMs': validation_ms,
                       **({'regionPlan': plan_timing} if plan_timing is not None else {})}, 'payloadBytes': len(data)}
