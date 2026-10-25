"""Tests for offline-only C3 tooling, including privacy and scheduler boundaries."""
import importlib.util
from pathlib import Path
import pytest
import sys

def load(name):
    path = Path(__file__).resolve().parents[2] / 'native/lightcraft' / (name+'.py')
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

trace = load('region_c3_trace')
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'native/lightcraft'))
try:
    report_tool = load('region_c3_report')
finally:
    sys.path.pop(0)

def test_trace_allowlists_metadata_and_distinguishes_queued_from_native():
    report = {'buffer': {'droppedEntryCount': 3}, 'entries': [
        {'timestamp': '2026-10-25T00:00:00Z', 'event': 'region.view', 'context': {
            'width': 1952, 'height': 1096, 'scale': 1, 'documentToken': 'private', 'sourceId': 'private', 'path': 'private'}},
        {'event': 'region.delivery', 'context': {'disposition': 'queued', 'operation': 'render', 'quality': 'full'}},
        {'event': 'region.completed', 'context': {'nativeMs': 120, 'body': 'private'}},
        {'event': 'region.overlay.rebound', 'context': {}},
        {'event': 'private', 'context': {'nativeMs': 1}},
    ]}
    result = trace.summarize(report)
    assert result['bufferDropped'] == 3
    assert result['observedCounts'] == {'viewUpdates': 1, 'renderRequests': 1, 'fullRequests': 1, 'nativeCompletedCalls': 1, 'rebind': 1}
    assert 'private' not in str(result)

def test_scheduler_nonextending_aggregation_and_bounded_pending():
    result = trace.scheduler(list(range(0, 1001, 10)), 180, 400)
    assert result['sampledIntents'] == 6
    assert result['modeledRequests'] < result['sampledIntents']
    assert result['pendingSuperseded'] > 0
    assert result['finalLatencyMs'] > 0
    assert trace.scheduler([0], 180, 100)['finalLatencyMs'] == 280

def test_hysteresis_and_quantization_are_offline_inputs():
    values = [.86, .84, .86, .84, .96]
    assert trace.hysteresis(values, .85, .95)['transitions'] == 2
    assert trace.hysteresis(values, .85, .85)['transitions'] == 4
    result = trace.quantization([3000, 3010, 3020, 3100, 4064], 4064, 256)
    assert result['quantized'] == [3072, 3072, 3072, 3328, 4064]
    assert result['actualNativeF'] is None

@pytest.mark.parametrize('times', [[], [1, 0], [-1], [float('nan')]])
def test_invalid_simulation_input(times):
    with pytest.raises(ValueError): trace.scheduler(times, 180, 100)

def test_session_adoption_can_advance_generation_without_a_new_input():
    entry = lambda ms, event, context: {'timestamp': f'2026-10-25T00:00:00.{ms:03d}Z', 'event': event, 'context': context}
    fe = [entry(0, 'region.view', {'viewGeneration': 1, 'width': 1000, 'height': 750, 'scale': 1, 'dpr': 1,
            'nativeWidth': 4064, 'nativeHeight': 3056, 'panX': 0, 'panY': 0, 'interacting': False, 'documentToken': 'private'}),
        entry(200, 'region.overlay.adopted', {'viewGeneration': 2, 'quality': 'full', 'requestId': 'private'})]
    lo = report_tool.epoch(fe[0])
    result = report_tool.session(fe, [], lo, lo+1000, 'cold-1to1', lo)
    assert result['lastViewToFinalFullMs'] == result['firstViewToFullMs'] == 200
    assert 'private' not in str(result)
    assert report_tool.distribution([1, 10])['p95'] == 10
