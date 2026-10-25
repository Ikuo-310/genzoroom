"""Build a safe C3 session artifact from private exports and action timestamps.

Request IDs are used only for in-memory joins and are never written. Absolute
timestamps and process IDs are reduced to relative times and process classes.
"""
import argparse
from collections import Counter
from datetime import datetime
import json
import math
from pathlib import Path
import statistics

from region_c3_trace import summarize, scheduler, hysteresis, quantization


def epoch(entry):
    return datetime.fromisoformat(entry['timestamp'].replace('Z', '+00:00')).timestamp()*1000


def distribution(values):
    values = sorted(values)
    return None if not values else {'count': len(values), 'min': values[0], 'median': statistics.median(values),
        'p95': values[math.ceil(len(values)*.95)-1], 'max': values[-1]}


def session(frontend, backend, lo, hi, label, first_retained):
    fe = [e for e in frontend if lo <= epoch(e) < hi]
    be = [e for e in backend if lo <= epoch(e) < hi]
    result = summarize({'entries': fe+be})
    result.pop('limitations'); result.pop('bufferDropped'); result.pop('measurementKind'); result.pop('schemaVersion')
    views = [e for e in fe if e['event'] == 'region.view']
    policies = [e for e in fe if e['event'] == 'region.auto.evaluate']
    adoptions = [e for e in fe if e['event'] in ('region.overlay.adopted', 'region.overlay.pairAdopted', 'region.overlay.rebound')]
    result['scenario'] = label
    result['frontendStartRetained'] = first_retained <= lo
    result['viewDurationMs'] = epoch(views[-1])-epoch(views[0]) if views else None
    result['gestureCount'] = sum(e['context'].get('interacting') is True and (i == 0 or not views[i-1]['context'].get('interacting')) for i, e in enumerate(views))
    result['fullAdoptions'] = sum(e['context'].get('quality') == 'full' for e in adoptions)
    result['draftAdoptions'] = sum(e['context'].get('quality') == 'draft' for e in adoptions)
    finals = [e for e in adoptions if e['context'].get('quality') == 'full']
    end_view = views[-1] if views else None
    # Lifecycle/Whole negotiation can advance the owner generation without a new
    # input event. An adopted overlay has already passed the production current guard.
    final = next((e for e in finals if end_view and epoch(e) >= epoch(end_view)), None)
    result['lastViewToFinalFullMs'] = epoch(final)-epoch(end_view) if final else None
    first_draft = next((e for e in adoptions if e['context'].get('quality') == 'draft'), None)
    result['firstViewToDraftMs'] = epoch(first_draft)-epoch(views[0]) if first_draft and views else None
    first_full = finals[0] if finals else None
    result['firstViewToFullMs'] = epoch(first_full)-epoch(views[0]) if first_full and views else None
    result['actionStartToFirstAdoptionMs'] = epoch(adoptions[0])-lo if adoptions else None
    result['rho'] = distribution([e['context']['rho'] for e in policies if 'rho' in e['context']])
    complete = [e['context'] for e in be if e['event'] == 'region.completed']
    result['nativePlanCalls'] = sum(c['operation'] == 'plan' for c in complete)
    result['nativeRenderCalls'] = sum(c['operation'] == 'render' for c in complete)
    result['nativeDraftRenders'] = sum(c['operation'] == 'render' and c['quality'] == 'draft' for c in complete)
    result['nativeFullRenders'] = sum(c['operation'] == 'render' and c['quality'] == 'full' for c in complete)
    result['nativeSourceLevels'] = dict(Counter(c['sourceLevel'] for c in complete))
    result['pngBytes'] = sum(c.get('payloadBytes', 0) for c in complete)
    result['nativeWorkMs'] = distribution([c['renderMs'] for c in complete])
    result['nativeTransportReadbackMs'] = distribution([c['nativeMs'] for c in complete])
    result['backendValidationMs'] = distribution([c['validationMs'] for c in complete])
    # The difference includes encode/file I/O/Base64/transport/readback, not encode alone.
    result['nativeResidualMs'] = distribution([max(0, c['nativeMs']-c['renderMs']) for c in complete])
    result['firstViewToPolicyMs'] = distribution([epoch(p)-epoch(v) for v in views
        for p in [next((p for p in fe if p['event'] == 'region.policy' and epoch(p) >= epoch(v)
            and p['context'].get('viewGeneration') == v['context'].get('viewGeneration')), None)] if p])
    result['decodeMs'] = distribution([e['context']['decodeMs'] for e in fe if e['event'] == 'region.overlay.decodeCompleted' and 'decodeMs' in e['context']])
    result['pairWaitMs'] = distribution([e['context']['adoptWaitMs'] for e in fe if e['event'] == 'region.overlay.pairAdopted' and 'adoptWaitMs' in e['context']])
    result['actualFs'] = sorted({(c['fullWidth'], c['fullHeight']) for c in complete})
    result['requestsPerViewUpdate'] = result['nativeRenderCalls']/len(views) if views else None
    if result['frontendStartRetained']:
        for key in ('viewUpdates', 'policyEvaluations', 'planRequests', 'renderRequests', 'reuse', 'rebind',
            'replanDecisions', 'pendingReplacedItems', 'superseded', 'staleDiscards', 'cancelledWaiters',
            'wholeFallbacks', 'regionFailures', 'overlayFailures', 'limitedPlanningEvents'):
            result['observedCounts'].setdefault(key, 0)
    return result


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--logs', type=Path, nargs='+', required=True)
    parser.add_argument('--actions', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--memory', type=Path)
    args = parser.parse_args()
    snapshots = [json.loads(p.read_text(encoding='utf-8-sig')) for p in args.logs]
    # Export snapshots overlap; deduplicate private records before safe projection.
    def merged(source):
        rows = {json.dumps(e, sort_keys=True): e for s in snapshots for e in s[source]}
        return sorted(rows.values(), key=epoch)
    fe, be = merged('frontend'), merged('backend')
    actions = json.loads(args.actions.read_text())
    retained = [min(map(epoch, s['frontend'])) for s in snapshots]
    latest = max(epoch(fe[-1]), epoch(be[-1]))+1
    # A FIFO log suffix can contain a complete later session even when earlier events were dropped.
    sessions = []
    for i, a in enumerate(actions):
        lo = actions[i]['atEpochMs']; hi = actions[i+1]['atEpochMs'] if i+1 < len(actions) else latest
        complete = any(min(map(epoch, s['frontend'])) <= lo
            and epoch({'timestamp': s['generatedAt']}) >= hi for s in snapshots)
        sessions.append(session(fe, be, lo, hi, a['scenario'], lo if complete else float('inf')))
    warm = next(a['atEpochMs'] for a in actions if a['scenario'] == 'warm-rezoom100')
    ended = next(a['atEpochMs'] for a in actions if a['scenario'] == 'user-continuous-pan-ended')
    human_views = [e for e in fe if warm+1000 < epoch(e) < ended and e['event'] == 'region.view']
    assert human_views
    human_lo, human_hi = epoch(human_views[0]), ended
    warm_index = next(i for i, row in enumerate(sessions) if row['scenario'] == 'warm-rezoom100')
    sessions[warm_index] = session(fe, be, warm, human_lo, 'warm-rezoom100', min(retained))
    human = session(fe, be, human_lo, human_hi, 'human-continuous-pan', min(retained))
    generations = [e['context']['viewGeneration'] for e in human_views]
    human['viewGenerationsContiguous'] = generations == list(range(generations[0], generations[-1]+1))
    human['frontendStartRetained'] = any(min(map(epoch, s['frontend'])) < human_lo
        and max(map(epoch, s['frontend'])) >= epoch(human_views[-1]) for s in snapshots)
    def visible(c):
        w, h, scale = c['nativeWidth'], c['nativeHeight'], c['scale']
        left = (c['width']-w*scale)/2+c['panX']; top = (c['height']-h*scale)/2+c['panY']
        return {'x0': max(0, -left/scale), 'y0': max(0, -top/scale),
            'x1': min(w, (c['width']-left)/scale), 'y1': min(h, (c['height']-top)/scale)}
    def contains(a, b):
        return a['x0'] <= b['x0'] and a['y0'] <= b['y0'] and a['x1'] >= b['x1'] and a['y1'] >= b['y1']
    geometry_held = total_with_prior = 0; previous = None
    for e in [e for e in fe if human_lo <= epoch(e) < human_hi]:
        if e['event'] in ('region.overlay.adopted', 'region.overlay.pairAdopted', 'region.overlay.rebound'):
            previous = e['context'].get('validNativeRect')
        elif e['event'] == 'region.view' and previous:
            total_with_prior += 1; geometry_held += contains(previous, visible(e['context']))
    outside = render_count = 0
    for e in [e for e in be if human_lo <= epoch(e) < human_hi and e['event'] == 'region.completed' and e['context']['operation'] == 'render']:
        latest_view = next((v for v in reversed(human_views) if epoch(v) <= epoch(e)), None)
        if latest_view:
            c = e['context']; r = c['validRegion']; v = latest_view['context']
            rect = {'x0': r['x']*v['nativeWidth']/c['fullWidth'], 'y0': r['y']*v['nativeHeight']/c['fullHeight'],
                'x1': (r['x']+r['w'])*v['nativeWidth']/c['fullWidth'], 'y1': (r['y']+r['h'])*v['nativeHeight']/c['fullHeight']}
            render_count += 1; outside += not contains(rect, visible(v))
    human['contextPrefetchObservation'] = {'viewUpdatesWithPriorAdoption': total_with_prior,
        'priorAdoptedValidRectContainsView': geometry_held, 'geometricContainmentRate': geometry_held/total_with_prior if total_with_prior else None,
        'renderCompletions': render_count, 'visibleOutsideValidAtCompletion': outside,
        'limitation': 'Geometric eligibility only; not proof that the overlay stayed displayed across quality/F/owner transitions.'}
    queued = {e['context'].get('requestId'): e for e in fe if e['event'] == 'region.delivery'
        and e['context'].get('disposition') == 'queued' and human_lo <= epoch(e) < human_hi}
    distances = []; previous_request = None
    for e in [e for e in be if human_lo <= epoch(e) < human_hi and e['event'] == 'region.completed'
        and e['context']['operation'] == 'render']:
        q = queued.get(e['context'].get('requestId'))
        v = next((v for v in reversed(human_views) if q and epoch(v) <= epoch(q)
            and v['context']['viewGeneration'] == q['context'].get('viewGeneration')), None)
        if v:
            c = v['context']; point = (c['panX']/c['scale'], c['panY']/c['scale'], e['context']['quality'])
            if previous_request and point[2] == previous_request[2]:
                distances.append(math.hypot(point[0]-previous_request[0], point[1]-previous_request[1]))
            previous_request = point
    human['contextPrefetchObservation']['sameQualityNativeRenderRequestDisplacementPx'] = distribution(distances)
    service = human['nativeTransportReadbackMs']['median'] + human['backendValidationMs']['median']
    times = [epoch(e)-human_lo for e in human_views]
    rho_start = next(a['atEpochMs'] for a in actions if a['scenario'] == 'zoom125')
    rhos = [e['context']['rho'] for e in fe if e['event'] == 'region.auto.evaluate' and 'rho' in e['context']
        and rho_start <= epoch(e) < ended]
    # Candidate values derive from observed densities; they are report data, never product defaults.
    bracket = [r for r in rhos if .7 <= r <= 1.1]
    candidate = (min(bracket)+max(bracket))/2 if bracket else .85
    native_width, native_height = (human_views[0]['context'][key] for key in ('nativeWidth', 'nativeHeight'))
    native_side = max(native_width, native_height)
    scales = [min(1, e['context']['scale']*e['context']['dpr'])*native_side for e in fe if e['event'] == 'region.view'
        and (e['context'].get('nativeWidth'), e['context'].get('nativeHeight')) == (native_width, native_height)
        and epoch(e) >= actions[0]['atEpochMs']]
    result = {'schemaVersion': 1, 'measurementKind': 'windows-development-viewer-trace',
        'snapshotBuffers': [s['buffers'] for s in snapshots], 'sessions': sessions, 'humanPan': human,
        'pressureSimulation': [scheduler(times, ms, service) for ms in (50, 100, 180, 250)],
        'pressureModelLimitations': ['Every sampled intent needs work; no geometry reuse, Whole/preflight gating or decode.',
            'Service duration uses the human session median Native transport/readback plus validation; this is not predicted Viewer latency.'],
        'rhoComparison': [hysteresis(rhos, .85, .95), hysteresis(rhos, .85, .85), hysteresis(rhos, candidate, candidate)],
        'rhoComparisonScope': 'One document: zoom125 through the end of human Pan; initially inactive density-only model.',
        'syntheticThresholdWobble': {'rhos': [.86, .84, .86, .84, .96], 'measurementKind': 'synthetic-not-observed',
            'current': hysteresis([.86, .84, .86, .84, .96], .85, .95),
            'noHysteresis': hysteresis([.86, .84, .86, .84, .96], .85, .85)},
        'quantization': quantization(scales, native_side, 256),
        'unavailableTimings': ['HTTP client start to Backend admission', 'PNG encode alone', 'GPU readback alone', 'HTTP body transmission alone']}
    if args.memory:
        samples = [json.loads(line) for line in args.memory.read_text().splitlines()]
        # Keep separate Python process groups; a launcher must not be added to Backend RSS.
        groups = sorted({(r['process'], r['pid']) for r in samples})
        result['processMemory'] = []
        for index, (name, pid) in enumerate(groups):
            group = [r for r in samples if r['pid'] == pid]
            row = {'processClass': name, 'instance': index, 'sampleIntervalMs': 100,
                'workingSetBytes': distribution([r['workingSetBytes'] for r in group]),
                'privateBytes': distribution([r['privateBytes'] for r in group]), 'phases': []}
            for a in actions:
                after = [r for r in group if a['atEpochMs']+1500 <= r['atEpochMs'] <= a['atEpochMs']+2500]
                if after:
                    row['phases'].append({'scenario': a['scenario'], 'workingSetBytes': after[-1]['workingSetBytes'],
                        'privateBytes': after[-1]['privateBytes']})
            result['processMemory'].append(row)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False)+'\n', encoding='utf-8')


if __name__ == '__main__': main()
