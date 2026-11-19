import asyncio
import json
import os
from pathlib import Path

import pytest

import edit_store
import windows_raw_api
from lightcraft_raw import LightCraftRawSession, _validate_png
from lightcraft_mcp import LightCraftError
from lightcraft_runtime import LightCraftManager
from raw_source import RawSourceCache
from tests.test_raw_source import Original
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import open_document
from tests.test_raw_adaptive_preview import target as whole_target
from tests.test_raw_history_api import operation, body
from tests.test_raw_controls import identity
from tests.test_raw_region_delivery import body as region_body


@pytest.mark.skipif(not os.environ.get('GENZOROOM_TEST_LIGHTCRAFT_EXE'), reason='real Native executable not requested')
def test_point_color_range_real_native_http(local, tmp_path, monkeypatch):
    async def run():
        edit_store.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        edit_store.initialize_database()
        image = (Path(__file__).resolve().parents[2] / 'docs/images/Anshitsu_Sakura.jpg').read_bytes()
        async def acquire(_):
            return Original(image), 'jpg'
        monkeypatch.setattr(windows_raw_api, 'RawSourceCache',
                            lambda: RawSourceCache(root=tmp_path / 'sources', acquire=acquire))
        (tmp_path / 'sources').mkdir()
        manager = LightCraftManager(environment={**os.environ, 'GENZOROOM_LIGHTCRAFT_EXE': os.environ['GENZOROOM_TEST_LIGHTCRAFT_EXE']}, platform='win32')
        raw = LightCraftRawSession(manager)
        api = local.raw_api
        await manager.start()
        async with asyncio.timeout(30):
            while manager.status().state in ('starting', 'initializing'):
                await asyncio.sleep(.05)
        assert manager.status().state == 'ready'
        api.bind(raw, manager)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                doc = await operation(http, doc, 'initialize')
                for x in (.3, .6):
                    doc = await operation(http, doc, 'operate', body(doc) | {
                        'kind':'pointColorPick', 'metadata':{'x':x,'y':.5}})
                endpoint = f'/api/raw/documents/{doc["handle"]}'
                baseline = (await raw.get_settings(api._raw_handle)).settings
                for serial, index, quality in ((1, 0, 'draft'), (2, 1, 'full')):
                    response = await http.post(endpoint + '/preview', json=whole_target(doc, serial=serial, quality=quality)
                                               | {'pointColorRangeIndex':index})
                    assert response.status_code == 200, response.text
                    assert response.headers['x-raw-point-color-range-index'] == str(index)
                    assert response.content.startswith(b'\x89PNG\r\n\x1a\n')
                geometry = json.loads(response.headers['x-raw-frame'])['geometryId']
                normal = await http.post(endpoint + '/preview', json=whole_target(doc, serial=3, quality='full'))
                assert normal.status_code == 200 and 'x-raw-point-color-range-index' not in normal.headers
                manager._session.point_color_range = False
                unsupported = await http.post(endpoint + '/preview', json=whole_target(doc, serial=4, quality='full')
                                              | {'pointColorRangeIndex':0})
                assert unsupported.status_code == 503, unsupported.text
                manager._session.point_color_range = True
                for invalid in (True, -1, 8, None, 1.5):
                    bad = await http.post(endpoint + '/preview', json=whole_target(doc, serial=5, quality='full')
                                          | {'pointColorRangeIndex':invalid})
                    assert bad.status_code == 400, bad.text
                bad = await http.post(endpoint + '/preview', json=whole_target(doc, serial=5, quality='full')
                                      | {'pointColorRangeIndex':0, 'kind':'before'})
                assert bad.status_code == 400
                bad = await http.post(endpoint + '/preview', json=whole_target(doc, serial=5, quality='full')
                                      | {'pointColorRangeIndex':0, 'mode':'crop-edit'})
                assert bad.status_code == 400
                region = region_body(api, geometry)
                planned = await http.post(endpoint + '/region', json=region_body(api, geometry, operation='plan'))
                assert planned.status_code == 200, planned.text
                plan_result = planned.json()
                region['target']['fullWidth'] = plan_result['fullWidth']
                region['target']['fullHeight'] = plan_result['fullHeight']
                region['target']['pointColorRangeIndex'] = 1
                rendered = await http.post(endpoint + '/region', json=region)
                assert rendered.status_code == 200, rendered.text
                assert json.loads(rendered.headers['x-raw-region'])['pointColorRangeIndex'] == 1
                normal_region = region_body(api, geometry)
                normal_region['target']['fullWidth'] = plan_result['fullWidth']
                normal_region['target']['fullHeight'] = plan_result['fullHeight']
                plain = await http.post(endpoint + '/region', json=normal_region)
                assert plain.status_code == 200, plain.text
                assert 'pointColorRangeIndex' not in json.loads(plain.headers['x-raw-region'])
                for invalid in (True, None, -1, 8, 1.5):
                    bad_region = region_body(api, geometry)
                    bad_region['target']['pointColorRangeIndex'] = invalid
                    assert (await http.post(endpoint + '/region', json=bad_region)).status_code == 400
                plan = region_body(api, geometry, operation='plan')
                plan['target']['pointColorRangeIndex'] = 0
                assert (await http.post(endpoint + '/region', json=plan)).status_code == 400
                assert (await raw.get_settings(api._raw_handle)).settings == baseline
                base = endpoint + '/point-color-interaction'
                owner = identity(doc) | {'documentRevision':doc['revision']}
                started = await http.post(base + '/begin', json=owner | {'control':'pointColor.0.range'})
                assert started.status_code == 200, started.text
                interaction = started.json()['interactionId']
                common = owner | {'interactionId':interaction, 'serial':1,'maxSide':512,'viewGeneration':0,'geometryId':None}
                original_preview = manager._raw_preview
                entered, release = asyncio.Event(), asyncio.Event()
                async def delayed_preview(*args, **kwargs):
                    entered.set()
                    await release.wait()
                    return await original_preview(*args, **kwargs)
                monkeypatch.setattr(manager, '_raw_preview', delayed_preview)
                updated = await http.post(base + '/update', json=common | {'sequence':1,'value':35,'pointColorRangeIndex':0})
                assert updated.status_code == 200, updated.text
                assert 1 in raw._point_color_interaction.preview_tickets
                await entered.wait()
                old = asyncio.create_task(http.post(base + '/preview', json=common | {'interactionSequence':1,'pointColorRangeIndex':0}))
                await asyncio.sleep(.01)
                wrong = await http.post(base + '/preview', json=common | {'interactionSequence':1,'pointColorRangeIndex':1})
                assert wrong.status_code == 204
                assert 1 not in raw._point_color_interaction.preview_tickets
                release.set()
                assert (await old).status_code == 204
                monkeypatch.setattr(manager, '_raw_preview', original_preview)
                updated = await http.post(base + '/update', json=common | {'sequence':2,'value':36,'pointColorRangeIndex':1})
                assert updated.status_code == 200, updated.text
                draft = await http.post(base + '/preview', json=common | {'interactionSequence':2,'pointColorRangeIndex':1})
                assert draft.status_code == 200, (draft.text, dict(draft.headers))
                assert draft.headers['x-raw-point-color-range-index'] == '1'
                cancelled = await http.post(base + '/cancel', json=owner | {'interactionId':interaction})
                assert cancelled.status_code == 204
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('actual', [None, 1, True, '0'])
def test_whole_rejects_mismatched_range_metadata(actual):
    from tests.test_lightcraft_raw import image_result
    result = image_result()
    meta = json.loads(result['content'][1]['text'])
    if actual is not None:
        meta['pointColorRangeIndex'] = actual
    result['content'][1]['text'] = json.dumps(meta)
    with pytest.raises(LightCraftError, match='lightcraft_invalid_preview'):
        _validate_png(result, 1, 1024, point_color_range_index=0)


def test_region_rejects_wrong_and_unexpected_range_metadata():
    import copy
    import raw_region
    from tests.test_raw_region import result
    target = {'contractVersion':1, 'mode':'region', 'quality':'full', 'geometryId':'a'*64,
              'identity':{'assetId':'x', 'sourceId':'b'*64, 'generation':1,
                          'documentToken':'c'*32, 'kind':'after', 'revision':1},
              'documentRevision':1, 'viewGeneration':1, 'requestId':'d'*32,
              'fullWidth':16, 'fullHeight':12, 'window':{'x':0,'y':0,'w':8,'h':8},
              'validRegion':{'x':0,'y':0,'w':8,'h':8}, 'context':0, 'prefetch':0}
    native = {'kind':'after', 'quality':'full', 'geometryId':'a'*64,
              'fullWidth':16, 'fullHeight':12, 'window':target['window']}
    base = result(native, 'render')
    requested = target | {'pointColorRangeIndex':0}
    for index in (None, 1, True):
        candidate = copy.deepcopy(base)
        meta = json.loads(candidate['content'][1]['text'])
        if index is not None:
            meta['pointColorRangeIndex'] = index
        candidate['content'][1]['text'] = json.dumps(meta)
        with pytest.raises(LightCraftError, match='raw_invalid_region_response'):
            raw_region.validate_result(candidate, requested, 'render', 1)
    candidate = copy.deepcopy(base)
    meta = json.loads(candidate['content'][1]['text'])
    meta['pointColorRangeIndex'] = 0
    candidate['content'][1]['text'] = json.dumps(meta)
    with pytest.raises(LightCraftError, match='raw_invalid_region_response'):
        raw_region.validate_result(candidate, target, 'render', 1)


def test_full_frame_only_range_requests_supersede_older_modes(tmp_path, monkeypatch):
    from tests.test_lightcraft_raw import create
    from lightcraft_raw import SUPERSEDED

    async def run():
        raw, manager, children, files = await create(tmp_path)
        child = children[0]
        child.frame_supported = True
        original = manager._raw_preview
        received = []

        async def render(generation, photo_id, max_side, *, point_color_range_index=None, **kwargs):
            received.append((point_color_range_index, dict(kwargs)))
            output = await original(generation, photo_id, max_side, **kwargs)
            if point_color_range_index is not None:
                meta = json.loads(output['content'][1]['text'])
                meta['pointColorRangeIndex'] = point_color_range_index
                output['content'][1]['text'] = json.dumps(meta)
            return output

        monkeypatch.setattr(manager, '_raw_preview', render)
        try:
            handle, settings = await raw.open_raw('pixel', files[0])
            child.gate = asyncio.Event()
            first = raw.request_preview(handle, settings.revision, quality='full', point_color_range_index=0)
            await child.render_started.wait()
            second = raw.request_preview(handle, settings.revision, quality='full', point_color_range_index=1)
            third = raw.request_preview(handle, settings.revision, quality='full')
            assert await second is SUPERSEDED
            child.gate.set()
            assert await first is SUPERSEDED
            assert (await third).point_color_range_index is None
            final = await raw.request_preview(handle, settings.revision, quality='full', point_color_range_index=1)
            assert final.point_color_range_index == 1
            assert received[0][0] == 0 and received[-1][0] == 1
            assert received[-1][1]['include_frame'] is True and 'quality' not in received[-1][1]
        finally:
            if child.gate:
                child.gate.set()
            await raw.close()
            await manager.close()

    asyncio.run(run())
