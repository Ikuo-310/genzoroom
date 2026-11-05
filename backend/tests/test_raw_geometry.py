import asyncio
import copy
import json
import importlib.util
import os
import sys
from pathlib import Path
from uuid import uuid4

import pytest

from lightcraft_mcp import LightCraftError
from raw_geometry import DEFAULT_CROP, HANDLES, geometry_state, native_command, validate_operation
import raw_recipe_store as store
from tests import test_lightcraft_raw as native
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document
from tests.test_raw_history_api import body, operation, url
from tests.test_raw_controls import identity


class GeometryProcess(native.RawProcess):
    """A transport oracle, not a second crop engine; Native geometry math has separate integration tests."""
    fail_after = False

    def respond(self, message):
        args = message.get('params', {}).get('arguments', {})
        command = args.get('id', '')
        if message.get('method') != 'tools/call' or args.get('params') is None or not command.startswith(('crop.', 'photo.rotate', 'photo.flip')):
            return super().respond(message)
        p = args['params']
        self.commands.append((command, copy.deepcopy(p)))
        if command in self.fail_commands:
            return self.tool(message, error=True)
        settings = self.photos[self.active]['settings']
        c = settings['crop']
        if command == 'crop.set':
            if 'rect' in p:
                c['geometry']['rect'] = dict(zip(('x0', 'y0', 'x1', 'y1'), p['rect']))
            if 'angle' in p:
                c['geometry']['angle'] = p['angle']
        elif command == 'crop.straighten':
            c['geometry']['angle'] = p['angle']
        elif command == 'crop.reset':
            settings['crop'] = copy.deepcopy(DEFAULT_CROP)
        elif command == 'crop.drag':
            r = dict(zip(('x0', 'y0', 'x1', 'y1'), p['start']))
            dx, dy = p['to'][0] - p['from'][0], p['to'][1] - p['from'][1]
            if p['handle'] == 'move':
                r = {k: v + (dx if k.startswith('x') else dy) for k, v in r.items()}
            else:
                r['x1'] += dx; r['y1'] += dy
            c['geometry']['rect'] = r
        elif command == 'crop.aspect':
            a = p['aspect']
            c['aspect'] = None if a == 'free' or a == 'toggle' and c['aspect'] else [100, 100] if a in ('toggle', 'current', 'original') else [int(float(n) * 100) for n in a.split('x')] if isinstance(a, str) else [int(n * 100) for n in a]
        elif command == 'crop.rotateAspect':
            if c['aspect']:
                c['aspect'].reverse()
        elif command.startswith('photo.rotate'):
            names = ['Normal', 'Rotate90', 'Rotate180', 'Rotate270']
            settings['orientation'] = names[(names.index(settings['orientation']) + (1 if command.endswith('Right') else -1)) % 4]
        else:
            key = 'flip_h' if command.endswith('Horizontal') else 'flip_v'
            c[key] = not c[key]
        if self.fail_after:
            self.fail_get = True
        self.tool(message, {'changed': 1} if command.startswith('photo.') else None)


def op(kind, **params):
    return {'type': kind, 'params': params}


async def opened(tmp_path, local, monkeypatch, http):
    monkeypatch.setattr(native, 'RawProcess', GeometryProcess)
    api, manager, children, _ = await setup(tmp_path, local, monkeypatch)
    await authenticate(http, local)
    _, doc = await open_document(http)
    doc = await operation(http, doc, 'initialize')
    return api, children[0], doc


async def operate(http, doc, intent, request=None):
    request = request or body(doc) | {'kind': 'geometry', 'metadata': {'operation': intent['type']}, 'geometry': intent}
    return await operation(http, doc, 'operate', request)


async def begin(http, doc, kind='drag'):
    request = identity(doc) | {'expectedRevision': doc['revision'], 'settingsFingerprint': doc['settingsFingerprint'],
                               'gestureId': uuid4().hex, 'operation': kind}
    result = await http.post(f'/api/raw/documents/{doc["handle"]}/geometry/begin', json=request)
    assert result.status_code == 200, result.text
    return result.json()


def update_body(doc, sequence, intent):
    return identity(doc) | {'expectedRevision': doc['revision'], 'settingsFingerprint': doc['settingsFingerprint'],
                            'gestureId': doc['gestureId'], 'sequence': sequence, 'operation': intent}


@pytest.mark.parametrize('intent', [op('set', rect=[-.01, .1, .7, .8]), op('set', angle=12),
    *[op('drag', handle=h, **{'from': [.8, .8], 'to': [.7, .7]}) for h in HANDLES],
    op('aspect', aspect='4x5'), op('aspect', aspect=[2, 3]), op('aspect', aspect='toggle'),
    op('aspect', aspect='free'), op('aspect', aspect='current'), op('swap'), op('reset'),
    op('straighten', angle=-12), op('straighten', angle=12), op('rotateLeft'), op('rotateRight'), op('flipHorizontal'), op('flipVertical')])
def test_operations_persist_undo_redo_noop_and_receipt(local, tmp_path, monkeypatch, intent):
    async def run():
        async with client(local) as http:
            api, child, doc = await opened(tmp_path, local, monkeypatch, http)
            try:
                if intent['type'] == 'drag':
                    intent['params']['start'] = [0, 0, 1, 1]
                original = store.get_raw_history(api._history_identity)['recipe']['settings']
                request = body(doc) | {'kind': 'geometry', 'metadata': {'operation': intent['type']}, 'geometry': intent}
                result = await operate(http, doc, intent, request)
                saved = store.get_raw_history(api._history_identity)['recipe']['settings']
                expected_length = int(saved != original)
                assert result['history']['length'] == expected_length
                assert geometry_state(saved) == {k: result[k] for k in ('crop', 'orientation')}
                count = len(child.commands)
                replay = await operate(http, doc, intent, request)
                # Recipe replay still reads current metadata, but never repeats a geometry command.
                assert replay['replayed']
                assert [c for c, _ in child.commands[count:] if c.startswith(('crop.', 'photo.rotate', 'photo.flip'))] == []
                undone = await operation(http, result, 'undo')
                assert undone['crop'] == original['crop'] and undone['orientation'] == original['orientation']
                redone = await operation(http, undone, 'redo')
                assert redone['crop'] == result['crop'] and redone['orientation'] == result['orientation']
            finally:
                await api.close()
    asyncio.run(run())


def test_gesture_aggregates_and_rejects_interleaving(local, tmp_path, monkeypatch):
    async def run():
        async with client(local) as http:
            api, child, doc = await opened(tmp_path, local, monkeypatch, http)
            try:
                doc = await begin(http, doc)
                for sequence in range(3):
                    request = update_body(doc, sequence, op('drag', handle='bottomRight', **{'from': [1, 1], 'to': [.9 - .1*sequence, .9]}))
                    endpoint = f'/api/raw/documents/{doc["handle"]}/geometry'
                    response = await http.post(endpoint, json=request)
                    assert response.status_code == 200, response.text
                    doc = response.json()
                    commands = len(child.commands)
                    replay = await http.post(endpoint, json=request)
                    assert replay.json() == doc and len(child.commands) == commands
                    assert store.get_raw_history(api._history_identity)['history']['steps'] == []
                blocked = await http.post(f'/api/raw/documents/{doc["handle"]}/controls', json=identity(doc) | {'expectedRevision': doc['revision'], 'values': {'light.exposure': 1}})
                assert blocked.status_code == 409
                request = body(doc) | {'kind': 'geometry', 'metadata': {'operation': 'drag'}, 'gestureId': doc['gestureId']}
                committed = await operation(http, doc, 'commit', request)
                assert committed['history']['length'] == 1
                history = store.get_raw_history(api._history_identity)['history']['steps']
                assert history[0]['metadata'] == {'operation': 'drag'}
                assert (await operation(http, doc, 'commit', request))['replayed']
                undone = await operation(http, committed, 'undo')
                assert undone['crop'] == DEFAULT_CROP
                assert (await operation(http, undone, 'redo'))['crop'] == committed['crop']
            finally:
                await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('failed', ['command', 'readback', 'save'])
def test_relative_unknown_never_replays_and_save_retry_is_once(local, tmp_path, monkeypatch, failed):
    async def run():
        async with client(local) as http:
            api, child, doc = await opened(tmp_path, local, monkeypatch, http)
            try:
                if failed == 'command': child.fail_commands.add('photo.rotateRight')
                if failed == 'readback': child.fail_after = True
                old = store.append_raw_history
                if failed == 'save':
                    def unavailable(*args, **kwargs): raise store.StoreUnavailable()
                    monkeypatch.setattr(store, 'append_raw_history', unavailable)
                request = body(doc) | {'kind': 'geometry', 'metadata': {'operation': 'rotateRight'}, 'geometry': op('rotateRight')}
                response = await http.post(url(doc, 'operate'), json=request)
                assert response.status_code >= 400
                child.fail_commands.clear(); child.fail_get = False; child.fail_after = False
                monkeypatch.setattr(store, 'append_raw_history', old)
                replay = await http.post(url(doc, 'operate'), json=request)
                assert sum(name == 'photo.rotateRight' for name, _ in child.commands) == 1
                if failed == 'save':
                    assert replay.status_code == 200 and replay.json()['orientation'] == 'Rotate90'
                else:
                    assert replay.status_code == 409 and replay.json()['code'] == 'raw_geometry_outcome_unknown'
                    fresh = (await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))).json()
                    recovered = await http.post(url(doc, 'recover'), json={k:v for k,v in body(fresh).items() if k != 'saveId'})
                    assert recovered.status_code == 200, recovered.text
                    assert recovered.json()['orientation'] == 'Normal'
            finally:
                await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('bad', [op('oops'), op('set', rect=[0, 0, 0, 1]), op('set', angle=46),
    op('set', angle=True), op('drag', handle='bad', **{'from': [0, 0], 'to': [1, 1]}),
    op('aspect', aspect=[0, 1]), op('aspect', aspect=[100, 1]), op('rotateRight', ids=[1])])
def test_closed_operation_validation(bad):
    with pytest.raises(LightCraftError): validate_operation(bad)


@pytest.mark.parametrize('rect', [[-.1, 0, 1.1, 1], [0, -.1, 1, 1.1]])
def test_rect_is_not_clamped(rect):
    assert native_command(op('set', rect=rect), 1)[1]['rect'] == rect


def test_actual_native_geometry_history_reload_and_preview(local, tmp_path, monkeypatch):
    """Exercise the real managed engine through HTTP and isolated SQLite, with a synthetic RAW."""
    import edit_store
    import windows_raw_api
    from lightcraft_raw import LightCraftRawSession
    from lightcraft_runtime import LightCraftManager
    from raw_source import RawSourceCache
    from tests.test_raw_source import Original
    from tests.test_raw_recipe_restore import open_asset
    root = Path(__file__).parents[2]
    from lightcraft_artifact import resolve_managed_executable
    binary_path = resolve_managed_executable(os.environ, sys.platform)
    if not binary_path: pytest.skip('managed Native artifact not available')
    binary = Path(binary_path)
    spec = importlib.util.spec_from_file_location('crop_synthetic', root / 'native/lightcraft/settings_export_probe.py')
    fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
    data = fixture.synthetic_dng()

    async def run():
        edit_store.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        edit_store.initialize_database()
        manager = LightCraftManager(environment={**os.environ, 'GENZOROOM_LIGHTCRAFT_EXE': str(binary)}, gpu_backend='off')
        await manager.start()
        async with asyncio.timeout(30):
            while manager.status().state not in ('ready', 'failed', 'disabled'): await asyncio.sleep(.01)
        assert manager.status().state == 'ready'
        raw = LightCraftRawSession(manager)
        api = local.raw_api
        api.bind(raw, manager)
        async def acquire(_): return Original(data), 'dng'
        def cache():
            folder = tmp_path / uuid4().hex
            folder.mkdir()
            return RawSourceCache(root=folder, acquire=acquire)
        monkeypatch.setattr(windows_raw_api, 'RawSourceCache', cache)
        async with client(local) as http:
            await authenticate(http, local)
            _, doc = await open_document(http)
            asset = doc['assetId']
            doc = await operation(http, doc, 'initialize')
            try:
                for intent in [op('set', rect=[.1, .2, .8, .9]), op('aspect', aspect=[4, 5]), op('aspect', aspect='toggle'),
                               op('aspect', aspect='current'), op('swap'), op('straighten', angle=-12),
                               op('straighten', angle=12), op('rotateRight'), op('flipHorizontal'), op('flipVertical')]:
                    doc = await operate(http, doc, intent)
                # Formal panel uses orientation-independent decimal ratios and explicit lock targets.
                doc = await operate(http, doc, op('aspect', aspect=[17, 22], orientation='crop'))
                assert sorted(doc['crop']['aspect']) == [1700, 2200]
                doc = await operate(http, doc, op('aspect', aspect='free'))
                rect = copy.deepcopy(doc['crop']['geometry']['rect'])
                doc = await operate(http, doc, op('aspect', aspect='current'))
                assert doc['crop']['aspect'] is not None and doc['crop']['geometry']['rect'] == rect
                turned = copy.deepcopy(doc)
                for _ in range(4): doc = await operate(http, doc, op('rotateRight'))
                assert doc['orientation'] == turned['orientation']
                for _ in range(4): doc = await operate(http, doc, op('rotateLeft'))
                assert doc['orientation'] == turned['orientation']
                doc = await begin(http, doc, kind='straighten')
                for sequence, angle in enumerate([-45, 0, 45]):
                    response = await http.post(f'/api/raw/documents/{doc["handle"]}/geometry', json=update_body(doc, sequence, op('straighten', angle=angle)))
                    assert response.status_code == 200, response.text
                    doc = response.json()
                    assert doc['crop']['geometry']['angle'] == angle
                doc = await operation(http, doc, 'commit', body(doc) | {'kind':'geometry','metadata':{'operation':'straighten'},'gestureId':doc['gestureId']})
                before_reset = copy.deepcopy(doc)
                reset = await operate(http, doc, op('reset'))
                assert reset['orientation'] == before_reset['orientation'] and reset['crop'] == DEFAULT_CROP
                doc = await operation(http, reset, 'undo')
                assert doc['crop'] == before_reset['crop']
                for h in HANDLES:
                    doc = await operate(http, doc, op('set', rect=[.2, .2, .8, .8], angle=0))
                    doc = await begin(http, doc)
                    request = update_body(doc, 0, op('drag', handle=h, **{'from': [.5, .5], 'to': [.51, .51]}))
                    response = await http.post(f'/api/raw/documents/{doc["handle"]}/geometry', json=request)
                    assert response.status_code == 200, response.text
                    doc = response.json()
                    doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'geometry', 'metadata': {'operation': 'drag'}, 'gestureId': doc['gestureId']})
                doc = await begin(http, doc)
                outside = await http.post(f'/api/raw/documents/{doc["handle"]}/geometry', json=update_body(doc, 0, op('drag', handle='move', **{'from':[.5,.5],'to':[100,-100]})))
                assert outside.status_code == 200, outside.text
                doc = outside.json()
                doc = await operation(http, doc, 'commit', body(doc) | {'kind':'geometry','metadata':{'operation':'drag','action':'move'},'gestureId':doc['gestureId']})
                saved = {k: doc[k] for k in ('crop', 'orientation')}
                # Existing scalar owner remains usable after Crop.
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/controls', json=identity(doc) | {'expectedRevision': doc['revision'], 'values': {'light.exposure': .25}})
                doc = response.json()
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': 'light.exposure'}})
                preview = await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json={k:doc[k] for k in ('workspaceId','generation','documentToken','revision')} | {'serial': 1,
                    'quality': 'full', 'mode': 'whole', 'maxSide': 64, 'viewGeneration': 1, 'geometryId': None})
                assert preview.status_code == 200, preview.text[:100]
                normal_id = json.loads(preview.headers['X-Raw-Frame'])['geometryId']
                for serial, quality in [(2, 'draft'), (3, 'full')]:
                    editing = await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json={k:doc[k] for k in ('workspaceId','generation','documentToken','revision')} | {'serial': serial,
                        'quality': quality, 'mode': 'crop-edit', 'maxSide': 64, 'viewGeneration': 2, 'geometryId': None})
                    assert editing.status_code == 200, editing.text[:100]
                    assert editing.headers['X-Raw-Crop-Edit-Contract'] == '1'
                    assert 'X-Raw-Preview-Contract' not in editing.headers
                    assert json.loads(editing.headers['X-Raw-Frame'])['geometryId'] != normal_id
                    meta = json.loads(editing.headers['X-Raw-Crop'])
                    assert meta['canonicalGeometry'] == {k:doc[k] for k in ('crop', 'orientation')}
                    assert meta['settingsFingerprint'] == doc['settingsFingerprint']
                    assert not api._wb_frames and not api._region_geometry
                settings = await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))
                assert settings.json()['settingsFingerprint'] == doc['settingsFingerprint']
                assert (await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')).status_code == 204
                _, response = await open_asset(http, asset)
                assert response.status_code == 200, response.text
                doc = response.json()
                state = await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))
                assert {k: state.json()[k] for k in saved} == saved
            finally:
                await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('field,value', [('expectedRevision', 999), ('generation', 999), ('documentToken', 'f'*32)])
def test_stale_begin_is_rejected_before_native(local, tmp_path, monkeypatch, field, value):
    async def run():
        async with client(local) as http:
            api, child, doc = await opened(tmp_path, local, monkeypatch, http)
            try:
                count = len(child.commands)
                request = identity(doc) | {'expectedRevision': doc['revision'], 'settingsFingerprint': doc['settingsFingerprint'], 'gestureId': uuid4().hex, 'operation': 'set', field: value}
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/geometry/begin', json=request)
                assert response.status_code == 409 and len(child.commands) == count
            finally: await api.close()
    asyncio.run(run())


def test_parallel_duplicate_and_http_reply_loss_do_not_repeat_rotate(local, tmp_path, monkeypatch):
    async def run():
        async with client(local) as http:
            api, child, doc = await opened(tmp_path, local, monkeypatch, http)
            request = body(doc) | {'kind': 'geometry', 'metadata': {'operation': 'flipHorizontal'}, 'geometry': op('flipHorizontal')}
            try:
                replies = await asyncio.gather(*[http.post(url(doc, 'operate'), json=request) for _ in range(2)])
                assert all(r.status_code == 200 for r in replies)
                assert sum(c == 'photo.flipHorizontal' for c, _ in child.commands) == 1
                # Discard both HTTP replies and use only the immutable receipt request.
                replay = await http.post(url(doc, 'operate'), json=request)
                assert replay.json()['crop']['flip_h'] is True and replay.json()['replayed']
                assert sum(c == 'photo.flipHorizontal' for c, _ in child.commands) == 1
            finally: await api.close()
    asyncio.run(run())


def test_legacy_crop_omission_restores_without_rewriting_saved_row(local, tmp_path, monkeypatch):
    from tests.test_raw_recipe_restore import seed, open_asset
    from tests.test_raw_recipe_api import headers
    async def run():
        async with client(local) as http:
            monkeypatch.setattr(native, 'RawProcess', GeometryProcess)
            api, _, _, _ = await setup(tmp_path, local, monkeypatch)
            await authenticate(http, local)
            asset = uuid4()
            saved = seed(asset)
            recipe = saved['recipe']
            recipe['settings'].pop('crop'); recipe['settings'].pop('orientation')
            key = {k:v for k,v in recipe.items() if k != 'settings'}
            store.put_raw_recipe(key, 1, uuid4(), recipe['settings'])
            prior = store.get_raw_recipe(key)
            try:
                _, response = await open_asset(http, asset)
                assert response.status_code == 200, response.text
                doc = await operation(http, response.json(), 'initialize')
                assert doc['crop'] == DEFAULT_CROP
                result = await operate(http, doc, op('reset'))
                assert result['history']['length'] == 0
                assert 'crop' not in store.get_raw_recipe(key)['recipe']['settings']
                assert prior['recipe']['settings'] == store.get_raw_recipe(key)['recipe']['settings']
            finally: await api.close()
    asyncio.run(run())


def test_geometry_noop_keeps_redo_and_jump_uses_snapshots(local, tmp_path, monkeypatch):
    from tests.test_raw_recipe_api import headers
    async def run():
        async with client(local) as http:
            api, child, doc = await opened(tmp_path, local, monkeypatch, http)
            try:
                first = await operate(http, doc, op('rotateRight'))
                second = await operate(http, first, op('flipVertical'))
                listing = (await http.get(url(second), headers=headers(second))).json()
                doc = await operation(http, second, 'jump', body(second) | {'targetStepId': listing['steps'][0]['stepId']})
                assert doc['orientation'] == 'Rotate90' and not doc['crop']['flip_v']
                doc = await operate(http, doc, op('reset'))
                assert doc['history']['length'] == 2 and doc['history']['cursor'] == 1
                doc = await operation(http, doc, 'redo')
                assert doc['crop']['flip_v']
            finally: await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('malformed', ['boolean', 'missing'])
def test_invalid_native_geometry_can_be_discarded_by_explicit_recovery(local, tmp_path, monkeypatch, malformed):
    async def run():
        async with client(local) as http:
            api, child, doc = await opened(tmp_path, local, monkeypatch, http)
            respond = child.stdin.respond
            def invalid(message):
                args = message.get('params', {}).get('arguments', {})
                respond(message)
                if args.get('id') == 'photo.rotateRight':
                    if malformed == 'missing':
                        child.photos[child.active]['settings'].pop('crop')
                    else:
                        child.photos[child.active]['settings']['crop']['flip_h'] = 1
            child.stdin.respond = invalid
            try:
                req = body(doc) | {'kind': 'geometry', 'metadata': {'operation': 'rotateRight'}, 'geometry': op('rotateRight')}
                failed = await http.post(url(doc, 'operate'), json=req)
                assert failed.status_code == 502 and api.raw.status().state == 'desynchronized'
                retry = await http.post(url(doc, 'operate'), json=req)
                assert retry.status_code == 409
                child.stdin.respond = respond
                recover = await http.post(url(doc, 'recover'), json={k:v for k,v in body(doc).items() if k != 'saveId'})
                assert recover.status_code == 200, recover.text
                assert recover.json()['crop'] == DEFAULT_CROP and recover.json()['orientation'] == 'Normal'
            finally: await api.close()
    asyncio.run(run())


def test_edit_limit_is_not_sent_and_gesture_can_commit_before_regeneration(local, tmp_path, monkeypatch):
    async def run():
        async with client(local) as http:
            api, child, doc = await opened(tmp_path, local, monkeypatch, http)
            try:
                doc = await begin(http, doc, 'straighten')
                api.raw._edits = 256
                count = len(child.commands)
                request = update_body(doc, 0, op('straighten', angle=4))
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/geometry', json=request)
                assert response.json()['code'] == 'raw_session_edit_limit' and len(child.commands) == count
                assert api._geometry_gesture['stage'] == 'ready'
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'geometry', 'metadata': {'operation': 'straighten'}, 'gestureId': doc['gestureId']})
                assert doc['history']['length'] == 0
                assert (await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')).status_code == 204
                _, reopened = await open_document(http)
                assert reopened['documentToken'] != doc['documentToken'] and reopened['mutationAttempts'] == 0
            finally: await api.close()
    asyncio.run(run())


def test_cancelled_http_waiter_retains_relative_operation_until_receipt(local, tmp_path, monkeypatch):
    from tests.test_lightcraft_mcp import until
    async def run():
        async with client(local) as http:
            api, child, doc = await opened(tmp_path, local, monkeypatch, http)
            entered, release = asyncio.Event(), asyncio.Event()
            respond = child.stdin.respond
            def held(message):
                args = message.get('params', {}).get('arguments', {})
                if args.get('id') == 'photo.flipHorizontal':
                    entered.set()
                    async def finish():
                        await release.wait(); respond(message)
                    task = asyncio.create_task(finish())
                    child.deferred.add(task); task.add_done_callback(child.deferred.discard)
                else: respond(message)
            child.stdin.respond = held
            try:
                request = body(doc) | {'kind': 'geometry', 'metadata': {'operation': 'flipHorizontal'}, 'geometry': op('flipHorizontal')}
                waiter = asyncio.create_task(http.post(url(doc, 'operate'), json=request))
                await entered.wait()
                waiter.cancel()
                with pytest.raises(asyncio.CancelledError): await waiter
                release.set()
                await until(lambda: api._history_save['stage'] == 'complete')
                response = await http.post(url(doc, 'operate'), json=request)
                assert response.json()['replayed'] and response.json()['crop']['flip_h']
                assert sum(c == 'photo.flipHorizontal' for c, _ in child.commands) == 1
            finally:
                release.set()
                await api.close()
    asyncio.run(run())


def test_parallel_gesture_updates_cannot_reuse_sequence_for_different_intent(local, tmp_path, monkeypatch):
    async def run():
        async with client(local) as http:
            api, child, doc = await opened(tmp_path, local, monkeypatch, http)
            try:
                doc = await begin(http, doc, 'straighten')
                endpoint = f'/api/raw/documents/{doc["handle"]}/geometry'
                responses = await asyncio.gather(*[http.post(endpoint, json=update_body(doc, 0, op('straighten', angle=a))) for a in (3, 4)])
                assert sorted(r.status_code for r in responses) == [200, 409]
                current = next(r.json() for r in responses if r.status_code == 200)
                assert sum(c == 'crop.straighten' for c, _ in child.commands) == 1
                doc = await operation(http, current, 'commit', body(current) | {'kind': 'geometry', 'metadata': {'operation': 'straighten'}, 'gestureId': current['gestureId']})
                assert doc['history']['length'] == 1
            finally: await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('metadata,valid', [
    ({'operation':'drag','action':'move'},True), ({'operation':'drag','action':'resize'},True),
    ({'operation':'aspect','action':'lock'},True), ({'operation':'aspect','action':'unlock'},True),
    ({'operation':'drag','action':'lock'},False), ({'operation':'reset','action':'move'},False),
    ({'operation':'drag','action':{}},False), ({'operation':'drag','pointer':[1,2]},False),
])
def test_geometry_history_action_labels_are_closed(metadata,valid):
    from raw_geometry import valid_metadata
    assert valid_metadata(metadata) is valid


def test_geometry_action_metadata_survives_saved_history(local,tmp_path,monkeypatch):
    async def run():
        async with client(local) as http:
            api,child,doc=await opened(tmp_path,local,monkeypatch,http)
            try:
                doc=await begin(http,doc)
                response=await http.post(f'/api/raw/documents/{doc["handle"]}/geometry',json=update_body(doc,0,op('drag',handle='bottomRight',**{'from':[1,1],'to':[.8,.8]})))
                assert response.status_code==200
                doc=response.json()
                doc=await operation(http,doc,'commit',body(doc)|{'kind':'geometry','metadata':{'operation':'drag','action':'resize'},'gestureId':doc['gestureId']})
                steps=store.get_raw_history(api._history_identity)['history']['steps']
                assert steps[-1]['metadata']=={'operation':'drag','action':'resize'}
                undone=await operation(http,doc,'undo')
                assert undone['crop']==DEFAULT_CROP
                assert (await operation(http,undone,'redo'))['crop']==doc['crop']
            finally:
                await api.close()
    asyncio.run(run())


async def discard(http,doc):
    return await http.post(f'/api/raw/workspaces/{doc["workspaceId"]}/discard',json={k:doc[k] for k in ('handle','generation','documentToken')})


def test_begin_and_cancel_do_not_consume_native_edits(local,tmp_path,monkeypatch):
    async def run():
        async with client(local) as http:
            api,child,doc=await opened(tmp_path,local,monkeypatch,http)
            try:
                attempts=api.raw.status().edits
                doc=await begin(http,doc)
                assert api.raw.status().edits==attempts
                response=await http.post(url(doc,'recover'),json={k:v for k,v in body(doc).items() if k!='saveId'})
                assert response.status_code==200,response.text
                assert api.raw.status().edits==attempts and api._geometry_gesture is None
                assert response.json()['history']['length']==0
            finally:await api.close()
    asyncio.run(run())


def test_discard_recovers_exit_from_exhausted_dirty_gesture_without_writing_recipe(local,tmp_path,monkeypatch):
    async def run():
        async with client(local) as http:
            api,child,doc=await opened(tmp_path,local,monkeypatch,http)
            try:
                durable=copy.deepcopy(api._history_identity)
                before=store.get_raw_history(durable)
                doc=await begin(http,doc)
                response=await http.post(f'/api/raw/documents/{doc["handle"]}/geometry',json=update_body(doc,0,op('drag',handle='move',**{'from':[.5,.5],'to':[.6,.5]})))
                doc=response.json();api.raw._edits=256
                response=await http.post(url(doc,'recover'),json={k:v for k,v in body(doc).items() if k!='saveId'})
                assert response.status_code>=400
                response=await discard(http,doc)
                assert response.status_code==204,response.text
                assert api.workspace is None and api.document is None
                assert store.get_raw_history(durable)==before
                assert (await discard(http,doc)).status_code==204
                _,reopened=await open_document(http)
                assert reopened['mutationAttempts']==0 and reopened['generation']!=doc['generation']
                assert (await discard(http,doc)).status_code==409
                await api.close()
            finally:
                if api.workspace:await api.close()
    asyncio.run(run())


def test_discard_waits_for_accepted_write_and_rejects_new_writes(local,tmp_path,monkeypatch):
    import threading
    entered=threading.Event();release=threading.Event()
    append=store.append_raw_history
    def delayed(*args,**kwargs):
        entered.set()
        if not release.wait(10):raise AssertionError('write gate timed out')
        return append(*args,**kwargs)
    async def run():
        async with client(local) as http:
            api,child,doc=await opened(tmp_path,local,monkeypatch,http)
            identity_saved=copy.deepcopy(api._history_identity)
            monkeypatch.setattr(store,'append_raw_history',delayed)
            try:
                request=body(doc)|{'kind':'geometry','metadata':{'operation':'rotateRight'},'geometry':op('rotateRight')}
                write=asyncio.create_task(http.post(url(doc,'operate'),json=request))
                async with asyncio.timeout(5):
                    while not entered.is_set():await asyncio.sleep(.01)
                disposal=asyncio.create_task(discard(http,doc))
                await asyncio.sleep(.02)
                assert not disposal.done()
                denied=await http.post(url(doc,'operate'),json=request)
                assert denied.status_code==409 and denied.json()['code']=='raw_busy'
                release.set()
                assert (await write).status_code==200
                assert (await disposal).status_code==204
                saved=store.get_raw_history(identity_saved)
                assert len(saved['history']['steps'])==1
                denied=await http.post(url(doc,'operate'),json=request)
                assert denied.status_code>=400
                assert store.get_raw_history(identity_saved)==saved
            finally:
                release.set();await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('field,value',[('generation',True),('generation',999),('documentToken','f'*32),('handle','a'*32)])
def test_discard_rejects_stale_identity(local,tmp_path,monkeypatch,field,value):
    async def run():
        async with client(local) as http:
            api,child,doc=await opened(tmp_path,local,monkeypatch,http)
            try:
                payload={k:doc[k] for k in ('handle','generation','documentToken')};payload[field]=value
                response=await http.post(f'/api/raw/workspaces/{doc["workspaceId"]}/discard',json=payload)
                assert response.status_code==409 and api.workspace==doc['workspaceId']
            finally:await api.close()
    asyncio.run(run())



def test_discard_closes_native_even_if_restart_for_normal_release_fails(local,tmp_path,monkeypatch):
    async def run():
        async with client(local) as http:
            api,child,doc=await opened(tmp_path,local,monkeypatch,http)
            old=api.raw
            async def failed(*args,**kwargs):raise LightCraftError('raw_reset_failed')
            monkeypatch.setattr(old,'reset_session',failed)
            try:
                response=await discard(http,doc)
                assert response.status_code==204,response.text
                assert old._closed and api.raw is not old and api.workspace is None
            finally:await api.close()
    asyncio.run(run())
