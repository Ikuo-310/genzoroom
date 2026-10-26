import asyncio
import json

import pytest

from raw_diagnostics import trial_plan
from raw_preview_sequence import sequence_plan
from lightcraft_mcp import LightCraftError
from tests.test_raw_diagnostics import diagnostic_setup
from tests.test_raw_region import enable
from tests.test_windows_local import local, client, authenticate


def test_sequence_plan_is_small_and_rejects_ambiguous_conditions():
    assert len(sequence_plan(3)) == 40
    assert sum(t['warmup'] for t in sequence_plan(3)) == 10
    for changes in ({'repeats': 4}, {'repeats': True}, {'rawPath': 'PRIVATE'}, {'backend': 'unknown'}):
        with pytest.raises(LightCraftError):
            trial_plan({'assetId': '11111111-1111-4111-8111-111111111111',
                        'scenario': 'viewer', 'backend': 'cpu', 'repeats': 3, **changes})


def test_viewer_sequence_uses_isolated_native_owner_and_safe_metadata(local, tmp_path, monkeypatch):
    async def run():
        diag, editing, manager, children, _ = await diagnostic_setup(tmp_path, local, monkeypatch)
        spawn = manager._spawn
        async def region_spawn(*args, **kwargs):
            child = await spawn(*args, **kwargs)
            enable(child)
            return child
        manager._spawn = region_spawn
        try:
            async with client(local) as http:
                await authenticate(http, local)
                config = {'assetId': '11111111-1111-4111-8111-111111111111',
                          'scenario': 'viewer', 'backend': 'cpu', 'repeats': 1}
                response = await http.post('/api/developer/raw-preview/start', json=config)
                assert response.status_code == 200
                started = response.json()
                rows = []
                for trial in started['plan']:
                    body = {'runId': started['runId'], 'index': trial['index']}
                    prepared = await http.post('/api/developer/raw-preview/prepare', json=body)
                    assert prepared.status_code == 200, prepared.text
                    response = await http.post('/api/developer/raw-preview/render', json=body)
                    assert response.status_code == 200, response.text
                    meta = json.loads(response.headers['x-raw-diagnostic'])
                    rows.append(meta)
                    assert meta['operation'] == trial['operation'] and meta['warmup'] == trial['warmup']
                    assert meta['payloadBytes'] == (0 if trial['operation'] == 'regionPlan' else len(response.content))
                    assert meta['engine']['geometryDescriptor'] == 2
                    if trial['operation'] == 'regionPlan':
                        assert meta['timing']['regionPlan']['sourceKind'] == 'loaded'
                        assert meta['timing']['regionPlan']['plannerMs'] == 1
                    else:
                        assert 'regionPlan' not in meta['timing']
                    assert config['assetId'] not in json.dumps(meta)
                    assert all(key not in json.dumps(meta) for key in ('documentToken', 'sourceId', 'PRIVATE', 'settings'))
                assert len(children) == 3  # Editing process plus one isolated document per sequence.
                assert all(r['region'] for r in rows if r['operation'] in ('regionFull', 'pan'))
                for r in rows:
                    if r['operation'] == 'mutationDraft':
                        assert r['revision'] == next(o['revision'] for o in rows if o['repeat'] == r['repeat'] and o['operation'] == 'open') + 1
                assert editing.document is None and editing.workspace is None
                await http.post('/api/developer/raw-preview/stop', json={'runId': started['runId']})
        finally:
            await diag.close()
            await editing.close()
    asyncio.run(run())
