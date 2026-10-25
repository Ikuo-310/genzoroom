"""Offline reduction of opt-in structured logs; no production state or tuning.

The input export is private. Only explicit numeric/view fields reach the output.
Clear the existing debug log before one operation session, then export immediately.
Missing events (including buffer overflow) must not be interpreted as zero work.
"""
import argparse
from collections import Counter
from datetime import datetime
import json
import math
from pathlib import Path


VIEW_FIELDS = ('width', 'height', 'dpr', 'scale', 'zoomPercent', 'panX', 'panY',
               'nativeWidth', 'nativeHeight', 'fit', 'interacting', 'viewGeneration')
TIMING_EVENTS = {'region.started', 'region.received', 'region.completed', 'region.policy', 'region.aggregation',
    'region.overlay.decodeCompleted', 'region.overlay.adopted', 'region.overlay.pairAdopted', 'region.overlay.rebound'}


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def summarize(report):
    entries = report['entries']
    counts = Counter()
    views, timings = [], []
    first = None
    for entry in entries:
        event, c = entry.get('event'), entry.get('context') or {}
        if not isinstance(c, dict): continue
        if event == 'region.view':
            stamp = datetime.fromisoformat(entry['timestamp'].replace('Z', '+00:00')).timestamp()*1000
            if first is None: first = stamp
            view = {k: c[k] for k in VIEW_FIELDS if k in c and (finite(c[k]) or type(c[k]) is bool)}
            view['atMs'] = stamp-first; views.append(view); counts['viewUpdates'] += 1
        elif event == 'region.policy': counts['policyEvaluations'] += 1
        elif event == 'region.delivery':
            d, op = c.get('disposition'), c.get('operation')
            if d == 'queued':
                counts['planRequests' if op == 'plan' else 'renderRequests'] += 1
                if c.get('quality') in ('draft', 'full'): counts[c['quality']+'Requests'] += 1
            names = {'pending_replaced': 'pendingReplacedItems', 'stale': 'staleDiscards', 'cancelled': 'cancelledWaiters',
                     'superseded': 'superseded', 'whole_fallback': 'wholeFallbacks', 'failed': 'regionFailures'}
            if d in names: counts[names[d]] += 1
        elif event == 'region.auto.evaluate':
            if c.get('decision') == 'region_reuse': counts['reuse'] += 1
            if c.get('decision') == 'region_replan': counts['replanDecisions'] += 1
        elif event == 'region.planning':
            counts['planningEvents'] += 1
            if c.get('limited') is True: counts['limitedPlanningEvents'] += 1
        elif event == 'region.completed': counts['nativeCompletedCalls'] += 1
        elif event == 'region.overlay.rebound': counts['rebind'] += 1
        elif event in ('region.overlay.decodeFailed', 'region.overlay.pairRejected', 'region.overlay.geometryMismatch'):
            counts['overlayFailures'] += 1
        # Timing fields are already recorded at their owning boundary; do not remeasure them.
        fields = ('queueWaitMs', 'responseWaitMs', 'bodyReadMs', 'validationMs', 'nativeMs', 'renderMs',
                  'decodeMs', 'adoptWaitMs', 'viewAgeMs', 'aggregationWaitMs', 'payloadBytes')
        timing = {k: c[k] for k in fields if k in c and finite(c[k]) and c[k] >= 0}
        if timing and event in TIMING_EVENTS: timings.append({'event': event, **timing})
    return {'schemaVersion': 1, 'measurementKind': 'structured-log-session',
        'bufferDropped': report.get('buffer', {}).get('droppedEntryCount'),
        'observedCounts': dict(counts), 'views': views, 'timings': timings,
        'limitations': ['Counts are observed events, not proof of absence when logging is missing or dropped.',
            'Queued requests, completed Native calls and adopted overlays are separate units.',
            'Clear logs before each session; this reducer does not infer session boundaries.']}


def scheduler(times, aggregation_ms, service_ms):
    """Non-extending aggregation + running1/pending1 model; every sample needs work.

    Deliberately excludes geometry reuse, Whole gating, preflight and decode. Its
    request count is a pressure model, not a replay of the production scheduler.
    """
    if not times or aggregation_ms <= 0 or service_ms <= 0 or any(not finite(t) or t < 0 for t in times) or times != sorted(times):
        raise ValueError('invalid_scheduler_input')
    events = [(t, 2, i) for i, t in enumerate(times)]
    import heapq
    heapq.heapify(events)
    slot = False; latest = None; running = None; pending = None
    requests = superseded = stale = samples = 0
    final = 0
    while events:
        at, kind, value = heapq.heappop(events)
        if kind == 2:
            latest = value
            if not slot:
                slot = True; heapq.heappush(events, (at+aggregation_ms, 1, 0))
        elif kind == 1:
            slot = False; samples += 1
            if running is None:
                running = latest; requests += 1
                heapq.heappush(events, (at+service_ms, 0, running))
            else:
                if pending is not None: superseded += 1
                pending = latest
        else:
            if value != latest: stale += 1
            if value == len(times)-1: final = at-times[-1]
            running = None
            if pending is not None:
                running = pending; pending = None; requests += 1
                heapq.heappush(events, (at+service_ms, 0, running))
    return {'aggregationMs': aggregation_ms, 'assumedServiceMs': service_ms, 'inputUpdates': len(times),
        'sampledIntents': samples, 'aggregationSuppressed': len(times)-samples, 'modeledRequests': requests,
        'pendingSuperseded': superseded, 'staleCompletions': stale, 'finalLatencyMs': final}


def hysteresis(rhos, start, stop):
    if not 0 < start <= stop or any(not finite(r) or r <= 0 for r in rhos): raise ValueError('invalid_rho_input')
    active = False; transitions = 0; enabled = 0
    for rho in rhos:
        next_active = rho < (stop if active else start)
        transitions += next_active != active; active = next_active; enabled += active
    return {'startRho': start, 'stopRho': stop, 'transitions': transitions, 'activeSamples': enabled}


def quantization(requested, native_side, step):
    if step <= 0 or native_side < 16 or any(not finite(v) or v < 0 for v in requested): raise ValueError('invalid_f_input')
    quantized = [min(native_side, max(16, math.ceil(v/step)*step)) for v in requested]
    changes = lambda values: sum(a != b for a, b in zip(values, values[1:]))
    return {'step': step, 'requested': requested, 'quantized': quantized,
        'requestedChanges': changes(requested), 'quantizedChanges': changes(quantized),
        'actualNativeF': None, 'sourceLevelChanges': None}


def main():
    p = argparse.ArgumentParser(__doc__)
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--aggregation-ms', type=int, nargs='*', default=[])
    p.add_argument('--service-ms', type=float)
    p.add_argument('--rho-candidates', type=float, nargs='*', default=[])
    args = p.parse_args()
    result = summarize(json.loads(args.input.read_text(encoding='utf-8')))
    views = result['views']
    if args.aggregation_ms:
        if args.service_ms is None: p.error('--service-ms is required for a pressure simulation')
        result['pressureSimulation'] = [scheduler([v['atMs'] for v in views], ms, args.service_ms) for ms in args.aggregation_ms]
    # Candidates come from the measurement operator; none are production defaults.
    if args.rho_candidates:
        entries = json.loads(args.input.read_text(encoding='utf-8'))['entries']
        rhos = [e['context']['rho'] for e in entries if e.get('event') == 'region.auto.evaluate' and finite(e.get('context', {}).get('rho'))]
        result['rhoComparison'] = [hysteresis(rhos, .85, .95)] + [hysteresis(rhos, v, v) for v in args.rho_candidates]
    args.output.write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__': main()
