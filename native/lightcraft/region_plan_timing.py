"""C3-B: bounded RAW Viewer regionPlan investigation, without browser or policy changes."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import statistics
import sys
from time import monotonic
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from lightcraft_raw import LightCraftRawSession
from lightcraft_runtime import LightCraftManager
from raw_preview_sequence import RawPreviewSequence, sequence_plan


async def measure(raw_file, binary, expected_native=(3990, 3000)):
    rows = []
    engine = None
    for repeat in range(4):
        manager = LightCraftManager(environment={**os.environ, 'GENZOROOM_LIGHTCRAFT_EXE': str(binary)}, gpu_backend='dx12')
        raw = LightCraftRawSession(manager, stage_cache='off', diagnostics=True)
        try:
            await manager.start()
            async with asyncio.timeout(60):
                while manager.status().state in ('starting', 'initializing'):
                    await asyncio.sleep(.05)
            artifact = manager.artifact_info()
            if not artifact or not await manager._raw_region_supported(manager.status().generation):
                raise RuntimeError('region_plan_capability_unavailable')
            opened = monotonic()
            handle, _ = await raw.open_raw(str(uuid4()), str(raw_file))
            sequence = RawPreviewSequence(raw, handle, (monotonic() - opened) * 1000)
            trials = [t for t in sequence_plan(3) if t['repeat'] == repeat]
            # Match the Viewer's preceding Whole/settings operations, stopping after its one Pan.
            for trial in trials:
                if trial['operation'] in ('before', 'after'):
                    break
                _, metadata = await sequence.step(trial)
                if (metadata['geometry']['nativeWidth'], metadata['geometry']['nativeHeight']) != expected_native:
                    raise RuntimeError('region_plan_input_geometry_mismatch')
                if trial['operation'] == 'regionPlan':
                    rows.append({'repeat': repeat, 'warmup': repeat == 0, 'phase': 'firstPlan',
                                 'timing': metadata['timing'], 'geometry': metadata['geometry']})
                    # One extra plan before any Region rendering tests source reuse directly.
                    _, second = await sequence.step(trial)
                    rows.append({'repeat': repeat, 'warmup': repeat == 0, 'phase': 'secondPlan', 'timing': second['timing']})
            # Window is absent from the preflight contract: the same Full frame serves either viewport.
            plan_trial = next(t for t in trials if t['operation'] == 'regionPlan')
            _, after_pan = await sequence.step(plan_trial)
            rows.append({'repeat': repeat, 'warmup': repeat == 0, 'phase': 'afterPanPlan', 'timing': after_pan['timing']})
            gpu = await manager.get_gpu_info()
            engine = {'version': artifact['version'], 'commit': artifact['upstreamCommit'],
                      'binarySha256': manager.status().executable_sha256,
                      'gpuBackend': 'dx12', 'gpuAdapter': gpu.adapter[:200] if gpu.adapter else None}
            if not all(r['timing'].get('regionPlan') for r in rows):
                raise RuntimeError('region_plan_timing_missing')
        finally:
            await raw.close()
            await manager.close()
    summary = {}
    for phase in ('firstPlan', 'secondPlan', 'afterPanPlan'):
        selected = [r['timing'] for r in rows if r['phase'] == phase and not r['warmup']]
        values = {k: [t[k] for t in selected] for k in ('nativeMs', 'backendOperationMs')}
        values.update({k: [t['regionPlan'][k] for t in selected] for k in selected[0]['regionPlan'] if k != 'sourceKind'})
        summary[phase] = {k: {'min': min(v), 'median': statistics.median(v), 'max': max(v)} for k, v in values.items()}
    return {'schemaVersion': 1, 'engine': engine, 'conditions': {'warmups': 1, 'measured': 3,
            'wholeRequestedSide': 1024, 'regionWindow': {'width': 768, 'height': 576}, 'stageCache': 'off'},
            'samples': rows, 'statistics': summary,
            'limitations': ['backendAdapterOnlyNoFrontendDecodeOrViewerAdopt',
                            'sameDocumentSecondPlanAndOnePanOnly', 'newDocumentPerRepeat',
                            'fileSystemCacheNotFlushed', 'noSeparateViewerWindowMeasurement']}


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--raw-file', type=Path, required=True)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--json-out', type=Path, required=True)
    parser.add_argument('--native-width', type=int, default=3990)
    parser.add_argument('--native-height', type=int, default=3000)
    args = parser.parse_args()
    report = asyncio.run(measure(args.raw_file.resolve(), args.binary.resolve(), (args.native_width, args.native_height)))
    args.json_out.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report['statistics'], indent=2))


if __name__ == '__main__':
    main()
