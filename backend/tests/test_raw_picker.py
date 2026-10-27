import asyncio
import copy
import json

import pytest

from raw_white_balance import validate_candidate, validate_pick_frame
from tests.test_raw_white_balance import start, initialize
from tests.test_windows_local import local, client, authenticate
from tests.test_raw_history_api import operation, body, url
from tests.test_raw_recipe_api import headers
from tests.test_raw_recipe_restore import open_asset
from tests.test_windows_raw_api import preview_body
from tests.test_lightcraft_mcp import until
import raw_recipe_store as store
from lightcraft_mcp import LightCraftError


async def rendered(http, doc, kind='after', side=1024, serial=1):
    response = await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=preview_body(doc, serial) | {
        'kind': kind, 'mode': 'whole', 'maxSide': side, 'quality': 'full', 'geometryId': None, 'viewGeneration': 0})
    assert response.status_code == 200, response.text
    geometry = json.loads(response.headers['x-raw-frame'])
    return {'kind': kind, 'geometryId': geometry['geometryId'], 'maxSide': side, 'quality': 'full', 'x': .45, 'y': .55}


def pick(doc, frame):
    return body(doc) | {'kind': 'wbPick', 'metadata': {}, 'frame': frame}


@pytest.mark.parametrize('kind', ['before', 'after'])
def test_picker_one_snapshot_noop_navigation_reopen_and_frozen_retry(local, tmp_path, monkeypatch, kind):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        child = children[0]
        child.adaptive_supported = True
        child.wb_candidate['mode'] = 'custom'
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                frame = await rendered(http, doc, kind)
                first = await operation(http, doc, 'operate', pick(doc, frame))
                assert first['history']['length'] == 1 and first['wb']['mode'] == 'custom'
                assert child.wb_requests[0]['frame'] == frame | {'geometryId': 'a' * 64}
                page = (await http.get(url(first), headers=headers(first))).json()
                assert page['steps'][0]['kind'] == 'wbPick' and page['steps'][0]['metadata'] == {}
                assert len(page['steps'][0]['changes']) == 2
                latest_frame = await rendered(http, first, kind, serial=2)
                same = await operation(http, first, 'operate', pick(first, latest_frame))
                assert same['history'] == first['history'] and same['revision'] == first['revision']
                undo = await operation(http, same, 'undo')
                redo = await operation(http, undo, 'redo')
                jumped = await operation(http, redo, 'jump', body(redo) | {'targetStepId': first['history']['selectedStepId']})
                assert len(child.wb_requests) == 2 and jumped['wb']['mode'] == 'custom'
                # Transport loss after application keeps the candidate, not an instruction to sample again.
                latest_frame = await rendered(http, jumped, kind, serial=3)
                child.wb_candidate['temp'] = 6000.
                child.wb_arm_failure = True
                request = pick(jumped, latest_frame)
                failed = await http.post(url(jumped) + '/operate', json=request)
                assert failed.status_code >= 400
                before_retry = len(child.wb_requests)
                child.wb_candidate['temp'] = 9000.
                retried = await operation(http, jumped, 'operate', request)
                assert retried['values']['wb.temp'] == 6000 and len(child.wb_requests) == before_retry
                asset = retried['assetId']
                await http.delete(f'/api/raw/workspaces/{retried["workspaceId"]}')
                _, response = await open_asset(http, asset)
                reopened = response.json()
                state = (await http.post(f'/api/raw/documents/{reopened["handle"]}/settings',
                    json={k: reopened[k] for k in ('workspaceId', 'generation', 'documentToken')})).json()
                assert state['wb']['mode'] == 'custom' and state['values']['wb.temp'] == 6000
                assert len(child.wb_requests) == before_retry
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('error', ['wb_geometry_mismatch', 'wb_point_outside_source', 'wb_source_unavailable',
                                   'wb_settings_mismatch', 'wb_no_valid_samples'])
def test_picker_safe_native_errors_do_not_apply_or_save(local, tmp_path, monkeypatch, error):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        child = children[0]
        child.adaptive_supported = True
        child.wb_error = error
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                original = copy.deepcopy(child.photos[child.active]['settings'])
                frame = await rendered(http, doc)
                response = await http.post(url(doc) + '/operate', json=pick(doc, frame))
                assert response.status_code == 422 and response.json()['code'] == 'raw_' + error
                assert child.photos[child.active]['settings'] == original and api._history_save is None
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert page['history']['length'] == 0
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('change', [{'geometryId': 'f' * 64}, {'maxSide': 2048}, {'kind': 'before'}, {'quality': 'draft'}])
def test_picker_requires_exact_confirmed_display_frame(local, tmp_path, monkeypatch, change):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        child = children[0]
        child.adaptive_supported = True
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                frame = await rendered(http, doc)
                response = await http.post(url(doc) + '/operate', json=pick(doc, frame | change))
                assert response.status_code == 422 and response.json()['code'] == 'raw_wb_geometry_mismatch'
                assert not child.wb_requests and api._history_save is None
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('change', [{'x': -1}, {'x': True}, {'y': float('nan')}, {'y': 1.01},
                                  {'maxSide': True}, {'maxSide': 2049}, {'kind': 'region'}, {'extra': 1}])
def test_picker_frame_validation(change):
    frame = {'kind': 'after', 'geometryId': 'a' * 64, 'maxSide': 1024, 'quality': 'full', 'x': .5, 'y': .5}
    with pytest.raises(ValueError):
        validate_pick_frame(frame | change)


def test_candidate_mode_and_nested_frame_identity_are_strict():
    frame = {'kind': 'before', 'geometryId': 'a' * 64, 'maxSide': 1024, 'quality': 'full', 'x': 1, 'y': .5}
    identity = {'operation': 'pick', 'frame': frame}
    candidate = {'mode': 'custom', 'scale': 'kelvin', 'temp': 5200., 'tint': 11.}
    result = {'wbContract': 1, 'identity': identity, 'candidate': candidate}
    assert validate_candidate(result, identity) == candidate
    for changed in [result | {'candidate': candidate | {'mode': 'auto'}},
                    result | {'identity': identity | {'frame': frame | {'x': True}}}]:
        with pytest.raises(ValueError):
            validate_candidate(changed, identity)


@pytest.mark.parametrize('change', ['revision', 'geometry', 'settings', 'disconnect'])
def test_picker_revalidates_owner_frame_and_settings_after_estimation(local, tmp_path, monkeypatch, change):
    async def run():
        api, manager, children, _ = await start(tmp_path, local, monkeypatch)
        child = children[0]
        child.adaptive_supported = True
        child.wb_candidate['mode'] = 'custom'
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                frame = await rendered(http, doc)
                child.wb_gate = asyncio.Event()
                running = asyncio.create_task(http.post(url(doc) + '/operate', json=pick(doc, frame)))
                await until(lambda: len(child.wb_requests) == 1)
                if change == 'revision':
                    photo = api.raw._photos[doc['assetId']]
                    api.raw._commit(photo, photo.settings_json)
                elif change == 'geometry':
                    api._wb_frames.clear()
                elif change == 'settings':
                    child.wb_after_estimate = lambda: child.photos[child.active]['settings']['light'].update(exposure=1.)
                else:
                    manager._abort_raw(doc['generation'], 'lightcraft_session_lost')
                child.wb_gate.set()
                result = await running
                assert result.status_code == 422, result.text
                assert not [1 for command, _ in child.commands if command == 'develop.merge']
                assert store.get_raw_history(api._history_identity)['history']['steps'] == []
                if change in ('settings', 'disconnect'):
                    await api._release(checkpoint_history=False)
        finally:
            await api.close()
    asyncio.run(run())


def test_picker_save_failure_replays_without_resampling_and_retains_original_whole_size(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        child = children[0]
        child.adaptive_supported = True
        child.wb_candidate['mode'] = 'custom'
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                frame = await rendered(http, doc, side=1024)
                await rendered(http, doc, side=2048, serial=2)
                request = pick(doc, frame)
                append = store.append_raw_history
                monkeypatch.setattr(store, 'append_raw_history', lambda *a, **k: (_ for _ in ()).throw(store.StoreUnavailable()))
                assert (await http.post(url(doc) + '/operate', json=request)).status_code == 503
                monkeypatch.setattr(store, 'append_raw_history', append)
                result = await operation(http, doc, 'operate', request)
                replay = await operation(http, doc, 'operate', request)
                assert result['history']['length'] == 1 and replay['replayed']
                assert len(child.wb_requests) == 1 and child.wb_requests[0]['frame']['maxSide'] == 1024
        finally:
            await api.close()
    asyncio.run(run())


def test_frame_invalidated_after_apply_is_unknown_until_serialized_readback(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        child = children[0]
        child.adaptive_supported = True
        child.wb_candidate['mode'] = 'custom'
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                frame = await rendered(http, doc)
                respond = child.stdin.respond
                def lose_frame(message):
                    result = respond(message)
                    if message.get('method') == 'tools/call' and message['params']['name'] == 'command_run' \
                            and message['params']['arguments']['id'] == 'develop.merge':
                        api._wb_frames.clear()
                    return result
                monkeypatch.setattr(child.stdin, 'respond', lose_frame)
                request = pick(doc, frame)
                failure = await http.post(url(doc) + '/operate', json=request)
                assert failure.status_code == 409 and failure.json()['code'] == 'raw_history_readback_mismatch'
                assert 'wbExpected' in api._history_save
                recovered = await operation(http, doc, 'operate', request)
                assert recovered['wb']['mode'] == 'custom' and recovered['history']['length'] == 1
                assert len(child.wb_requests) == 1
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('code,expected', [('lightcraft_timeout', 'raw_wb_timeout'),
                                         ('lightcraft_eof', 'raw_wb_connection_failed'),
                                         ('lightcraft_invalid_json', 'raw_wb_invalid_response'),
                                         ('lightcraft_session_lost', 'raw_wb_connection_failed')])
def test_picker_estimation_transport_failure_is_distinct_and_read_only(local, tmp_path, monkeypatch, code, expected):
    async def run():
        api, manager, children, _ = await start(tmp_path, local, monkeypatch)
        children[0].adaptive_supported = True
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                frame = await rendered(http, doc)
                async def fail(*args, **kwargs):
                    raise LightCraftError(code)
                monkeypatch.setattr(manager, '_raw_estimate_wb', fail)
                failure = await http.post(url(doc) + '/operate', json=pick(doc, frame))
                assert failure.status_code == 422 and failure.json()['code'] == expected
                assert api._history_save is None
                assert not [1 for command, _ in children[0].commands if command == 'develop.merge']
        finally:
            await api.close()
    asyncio.run(run())


def test_picker_same_selected_snapshot_keeps_redo(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        child = children[0]
        child.adaptive_supported = True
        child.wb_candidate['mode'] = 'custom'
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                first = await operation(http, doc, 'operate', pick(doc, await rendered(http, doc)))
                child.wb_candidate['temp'] = 6000.
                second = await operation(http, first, 'operate', pick(first, await rendered(http, first, serial=2)))
                undone = await operation(http, second, 'undo')
                child.wb_candidate['temp'] = 5200.
                unchanged = await operation(http, undone, 'operate', pick(undone, await rendered(http, undone, serial=3)))
                assert unchanged['history']['cursor'] == 1 and unchanged['history']['length'] == 2
                assert unchanged['revision'] == undone['revision']
                redone = await operation(http, unchanged, 'redo')
                assert redone['values']['wb.temp'] == 6000 and len(child.wb_requests) == 3
        finally:
            await api.close()
    asyncio.run(run())
