import asyncio
import copy
import json
from uuid import uuid4

import pytest

import raw_recipe_store as store
from raw_white_balance import result_fingerprint, validate_candidate
from tests import test_lightcraft_raw as native
from tests.test_lightcraft_mcp import reply, until
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document, preview_body
from tests.test_raw_history_api import operation, body, url, rows, recover
from tests.test_raw_recipe_api import headers
from tests.test_raw_recipe_restore import open_asset


class WBProcess(native.RawProcess):
    def __init__(self):
        super().__init__()
        self.as_shot_wb = [4875., 13.]
        self.before_supported = True
        self.wb_requests = []
        self.wb_gate = None
        self.wb_error = None
        self.wb_result_patch = None
        self.wb_after_estimate = None
        self.wb_fail_readback = 0
        self.wb_arm_failure = False
        self.wb_candidate = {'mode': 'auto', 'scale': 'kelvin', 'temp': 5200., 'tint': 11.}

    def respond(self, message):
        if message['method'] == 'tools/list':
            props = {'id': {'type': 'string', 'pattern': '^[1-9][0-9]*$'},
                     'wb_contract': {'type': 'integer', 'enum': [1]},
                     'operation': {'type': 'string', 'enum': ['auto', 'pick']},
                     'settingsFingerprint': {'type': 'string', 'pattern': '^[a-f0-9]{64}$'},
                     'requestId': {'type': 'string', 'pattern': '^[a-f0-9]{32}$'}}
            return reply(self.stdout, message, {'tools': [
                {'name': 'estimate_white_balance', 'inputSchema': {'type': 'object', 'additionalProperties': False,
                    'required': list(props), 'properties': props}},
                {'name': 'render_preview', 'inputSchema': {'properties': {'before': {'type': 'boolean'}}}}]})
        if message['method'] == 'tools/call':
            name, args = message['params']['name'], message['params']['arguments']
            if name == 'get_develop':
                value = self.photos[args['id']]['settings']
                text = json.dumps(value, sort_keys=True, indent=2).replace('1e-07', '1e-7')
                return reply(self.stdout, message, {'isError': False, 'structuredContent': copy.deepcopy(value),
                    'content': [{'type': 'text', 'text': text}]})
            if name == 'estimate_white_balance':
                self.wb_requests.append(copy.deepcopy(args))

                async def estimate():
                    if self.wb_gate:
                        await self.wb_gate.wait()
                    if self.returncode is not None:
                        return
                    value = self.photos[int(args['id'])]['settings']
                    raw = {'isError': False, 'structuredContent': value, 'content': [{'type': 'text',
                        'text': json.dumps(value, sort_keys=True, indent=2).replace('1e-07', '1e-7')}]}
                    assert args['settingsFingerprint'] == result_fingerprint(raw)
                    if self.wb_error:
                        return reply(self.stdout, message, {'isError': True,
                            'content': [{'type': 'text', 'text': json.dumps({'code': self.wb_error})}]})
                    result = {'wbContract': 1, 'identity': copy.deepcopy(args), 'candidate': dict(self.wb_candidate)}
                    if self.wb_result_patch:
                        self.wb_result_patch(result)
                    if self.wb_after_estimate:
                        self.wb_after_estimate()
                    self.tool(message, result)

                task = asyncio.create_task(estimate())
                self.deferred.add(task)
                task.add_done_callback(self.deferred.discard)
                return
            if name == 'command_run':
                if args['id'] == 'develop.get' and self.wb_fail_readback:
                    self.wb_fail_readback -= 1
                    return self.tool(message, error=True)
                if args['id'] == 'develop.merge' and self.wb_arm_failure:
                    self.wb_arm_failure = False
                    self.wb_fail_readback = 1
        return super().respond(message)


async def start(tmp_path, local, monkeypatch):
    monkeypatch.setattr(native, 'RawProcess', WBProcess)
    return await setup(tmp_path, local, monkeypatch)


async def initialize(http, local):
    await authenticate(http, local)
    _, doc = await open_document(http)
    return await operation(http, doc, 'initialize')


def aw(doc):
    return body(doc) | {'kind': 'wbAuto', 'metadata': {}}


def test_aw_one_history_noop_preserves_redo_and_reopen_restores(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        child = children[0]
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                assert doc['wbAutoAvailable']
                before_key = doc['beforeKey']
                first = await operation(http, doc, 'operate', aw(doc))
                assert first['history']['length'] == first['history']['cursor'] == 1
                assert first['values']['wb.temp'] == 5200 and first['values']['wb.tint'] == 11
                assert first['wb']['mode'] == 'auto' and first['beforeKey'] == before_key
                snapshot = copy.deepcopy(child.photos[child.active]['settings'])
                page = (await http.get(url(first), headers=headers(first))).json()
                assert page['steps'][0]['kind'] == 'wbAuto'
                assert {c['control'] for c in page['steps'][0]['changes']} == {'wb.temp', 'wb.tint'}
                no_op = await operation(http, first, 'operate', aw(first))
                assert no_op['history'] == first['history'] and no_op['revision'] == first['revision']
                for action in ('undo', 'redo'):
                    no_op = await operation(http, no_op, action)
                assert len(child.wb_requests) == 2
                assert child.photos[child.active]['settings'] == snapshot
                # A mode-only edit is a full settings change and gets its own step.
                response = await http.post(f'/api/raw/documents/{no_op["handle"]}/controls',
                    json={k: no_op[k] for k in ('workspaceId', 'generation', 'documentToken')} |
                    {'expectedRevision': no_op['revision'], 'values': {'wb.temp': 5200}})
                manual = response.json()
                manual = await operation(http, manual, 'commit', body(manual) | {'kind': 'control', 'metadata': {'control': 'wb.temp'}})
                auto = await operation(http, manual, 'operate', aw(manual))
                assert auto['history']['length'] == 3
                assert (await http.get(url(auto), headers=headers(auto))).json()['steps'][-1]['changes'] == []
                undone = await operation(http, auto, 'undo')
                # Candidate equals the selected manual WB in all fields; no-op must keep the Redo branch.
                child.wb_candidate['mode'] = 'auto'
                await operation(http, undone, 'jump', body(undone) | {'targetStepId': first['history']['selectedStepId']})
                current = api.document.copy()
                current['recipeRevision'] = store.get_raw_history(api._history_identity)['revision']
                kept = await operation(http, current, 'operate', aw(current))
                assert kept['history']['length'] == 3 and kept['history']['cursor'] == 1
                before_count = len(child.wb_requests)
                asset = kept['assetId']
                await http.delete(f'/api/raw/workspaces/{kept["workspaceId"]}')
                _, reopened_response = await open_asset(http, asset)
                reopened = reopened_response.json()
                settings = (await http.post(f'/api/raw/documents/{reopened["handle"]}/settings',
                    json={k: reopened[k] for k in ('workspaceId', 'generation', 'documentToken')})).json()
                assert settings['wb']['mode'] == 'auto' and settings['values']['wb.temp'] == 5200
                assert len(child.wb_requests) == before_count
        finally:
            await api.close()
    asyncio.run(run())


def test_aw_uses_native_number_tokens_for_the_correct_photo(local, tmp_path, monkeypatch):
    async def run():
        monkeypatch.setitem(native.DEFAULT['light'], 'exposure', 1e-7)
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                await operation(http, doc, 'operate', aw(doc))
                assert children[0].wb_requests[0]['id'] == str(api.raw._photos[doc['assetId']].photo_id)
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('patch', [
    lambda r: r.update(wbContract=True), lambda r: r['identity'].update(id='999'),
    lambda r: r['identity'].update(wb_contract=True), lambda r: r['candidate'].update(temp=None),
    lambda r: r['candidate'].update(temp=50001), lambda r: r['candidate'].update(tint=True),
    lambda r: r['candidate'].update(scale='unknown'), lambda r: r['candidate'].update(mode='custom'),
    lambda r: r['candidate'].update(extra='private'),
])
def test_rejects_invalid_candidates_without_settings_or_history_changes(local, tmp_path, monkeypatch, patch):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                child = children[0]
                before, durable = copy.deepcopy(child.photos), rows()
                child.wb_result_patch = patch
                response = await http.post(url(doc, 'operate'), json=aw(doc))
                assert response.status_code == 422, response.text
                assert response.json()['code'] == 'raw_wb_invalid_response'
                assert child.photos == before and rows() == durable
                assert api._history_save is None
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('code', ['wb_no_valid_samples', 'wb_estimation_failed', 'wb_source_unavailable', 'PRIVATE C:/secret.raw'])
def test_estimation_failures_are_safe_rejections_and_do_not_block_later_edits(local, tmp_path, monkeypatch, code):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                child = children[0]
                before, durable = copy.deepcopy(child.photos), rows()
                child.wb_error = code
                response = await http.post(url(doc, 'operate'), json=aw(doc))
                assert response.status_code == 422, response.text
                assert 'PRIVATE' not in response.text and 'secret.raw' not in response.text
                assert child.photos == before and rows() == durable
                assert api._history_save is None
                child.wb_error = None
                await operation(http, doc, 'operate', aw(doc))
        finally:
            await api.close()
    asyncio.run(run())


def test_native_change_after_estimate_is_never_applied(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                child = children[0]
                child.wb_after_estimate = lambda: child.photos[child.active]['settings']['light'].update(exposure=1.)
                response = await http.post(url(doc, 'operate'), json=aw(doc))
                assert response.status_code == 422
                assert not [p for c, p in child.commands if c == 'develop.merge']
                assert store.get_raw_history(api._history_identity)['history']['steps'] == []
                await api._release(checkpoint_history=False)
        finally:
            await api.close()
    asyncio.run(run())


def test_readback_failure_retry_saves_the_applied_candidate_without_estimating_or_applying_twice(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                child = children[0]
                request = aw(doc)
                durable = rows()
                child.wb_arm_failure = True
                response = await http.post(url(doc, 'operate'), json=request)
                assert response.status_code == 502
                assert rows() == durable and api.raw.status().state == 'desynchronized'
                result = await operation(http, doc, 'operate', request)
                assert result['history']['length'] == 1 and result['nativeMatchesRecipe']
                assert len(child.wb_requests) == 1
                assert len([1 for c, p in child.commands if c == 'develop.merge']) == 1
        finally:
            await api.close()
    asyncio.run(run())


def test_save_failure_retry_and_replay_never_repeat_wb(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                request = aw(doc)
                append = store.append_raw_history
                monkeypatch.setattr(store, 'append_raw_history', lambda *a, **k: (_ for _ in ()).throw(store.StoreUnavailable()))
                assert (await http.post(url(doc, 'operate'), json=request)).status_code == 503
                monkeypatch.setattr(store, 'append_raw_history', append)
                result = await operation(http, doc, 'operate', request)
                replay = await operation(http, doc, 'operate', request)
                assert result['history']['length'] == 1 and replay['replayed']
                assert len(children[0].wb_requests) == 1
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('change', ['revision', 'selection', 'restart', 'disconnect'])
def test_owner_or_session_change_during_estimation_discards_the_candidate(local, tmp_path, monkeypatch, change):
    async def run():
        api, manager, children, _ = await start(tmp_path, local, monkeypatch)
        other = None
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                child = children[0]
                child.wb_gate = asyncio.Event()
                request = asyncio.create_task(http.post(url(doc, 'operate'), json=aw(doc)))
                await until(lambda: len(child.wb_requests) == 1)
                if change == 'revision':
                    photo = api.raw._photos[doc['assetId']]
                    api.raw._commit(photo, photo.settings_json)
                elif change == 'selection':
                    epoch = api.raw._epoch
                    other = asyncio.create_task(api.raw.select(api._raw_handle))
                    await until(lambda: api.raw._epoch != epoch)
                elif change == 'restart':
                    await manager.restart()
                    await until(lambda: manager.status().state == 'ready')
                else:
                    manager._abort_raw(doc['generation'], 'lightcraft_session_lost')
                child.wb_gate.set()
                response = await request
                assert response.status_code == 422, response.text
                assert not [1 for c, p in child.commands if c == 'develop.merge']
                assert store.get_raw_history(api._history_identity)['history']['steps'] == []
                if other:
                    await other
                if change in ('restart', 'disconnect'):
                    # Generation loss cannot certify a checkpoint; explicit discard retains durable SQLite truth.
                    await api._release(checkpoint_history=False)
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('action', ['operate', 'undo', 'controls', 'reset'])
def test_competing_operations_cannot_apply_to_the_old_revision(local, tmp_path, monkeypatch, action):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                child = children[0]
                child.wb_gate = asyncio.Event()
                first = asyncio.create_task(http.post(url(doc, 'operate'), json=aw(doc)))
                await until(lambda: len(child.wb_requests) == 1)
                if action in ('operate', 'undo'):
                    competing = asyncio.create_task(http.post(url(doc, action), json=aw(doc) if action == 'operate' else body(doc)))
                elif action == 'controls':
                    competing = asyncio.create_task(http.post(f'/api/raw/documents/{doc["handle"]}/controls',
                        json={k: doc[k] for k in ('workspaceId', 'generation', 'documentToken')} |
                        {'expectedRevision': doc['revision'], 'values': {'light.exposure': 1.}}))
                else:
                    competing = asyncio.create_task(http.post(f'/api/raw/assets/{doc["assetId"]}/edits/reset',
                        json={k: doc[k] for k in ('workspaceId', 'handle', 'generation', 'documentToken')} |
                        {'documentRevision': doc['revision']}))
                await asyncio.sleep(.01)
                child.wb_gate.set()
                assert (await first).status_code == 200
                assert (await competing).status_code == 409
                assert len(child.wb_requests) == 1
                assert store.get_raw_history(api._history_identity)['history']['steps'][-1]['kind'] == 'wbAuto'
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('candidate', [
    {'mode': 'auto', 'scale': 'kelvin', 'temp': float('nan'), 'tint': 0},
    {'mode': 'auto', 'scale': 'kelvin', 'temp': float('inf'), 'tint': 0},
    {'mode': 'auto', 'scale': 'kelvin', 'temp': 5000, 'tint': -151},
])
def test_non_finite_or_out_of_range_candidates_are_never_usable(candidate):
    identity = {'id': '1', 'wb_contract': 1, 'operation': 'auto', 'settingsFingerprint': 'a' * 64, 'requestId': 'b' * 32}
    with pytest.raises(ValueError):
        validate_candidate({'wbContract': 1, 'identity': identity, 'candidate': candidate}, identity)


@pytest.mark.parametrize('navigation', ['asset', 'leave'])
def test_navigation_waits_for_aw_and_checkpoints_the_original_asset(local, tmp_path, monkeypatch, navigation):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                original_identity = dict(api._history_identity)
                child = children[0]
                child.wb_gate = asyncio.Event()
                editing = asyncio.create_task(http.post(url(doc, 'operate'), json=aw(doc)))
                await until(lambda: len(child.wb_requests) == 1)
                async def navigate():
                    released = await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')
                    if navigation == 'leave':
                        return released
                    assert released.status_code == 204
                    _, opened = await open_asset(http, uuid4())
                    return opened

                leaving = asyncio.create_task(navigate())
                await asyncio.sleep(.01)
                assert not leaving.done()
                child.wb_gate.set()
                assert (await editing).status_code == 200
                assert (await leaving).status_code in (200, 204)
                state = store.get_raw_history(original_identity)
                assert len(state['history']['steps']) == 1 and state['recipe']['settings']['wb']['mode'] == 'auto'
                assert len(child.wb_requests) == 1
        finally:
            await api.close()
    asyncio.run(run())


def test_candidate_scale_is_applied_without_forcing_kelvin(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                children[0].wb_candidate['scale'] = 'legacy'
                result = await operation(http, doc, 'operate', aw(doc))
                assert result['wb']['scale'] == 'legacy' and not result['wb']['available']
                state = store.get_raw_history(api._history_identity)
                assert state['recipe']['settings']['wb']['scale'] == 'legacy'
                restored = await operation(http, result, 'undo')
                assert restored['wb']['scale'] == 'kelvin'
        finally:
            await api.close()
    asyncio.run(run())


def test_explicit_retry_uses_frozen_candidate_only_after_confirming_no_application(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                request = aw(doc)
                child = children[0]
                child.fail_commands.add('develop.merge')
                assert (await http.post(url(doc, 'operate'), json=request)).status_code == 502
                assert child.photos[child.active]['settings']['wb']['temp'] == 6500
                child.fail_commands.clear()
                child.wb_candidate['temp'] = 9999
                result = await operation(http, doc, 'operate', request)
                assert result['values']['wb.temp'] == 5200
                assert result['history']['length'] == 1 and len(child.wb_requests) == 1
        finally:
            await api.close()
    asyncio.run(run())


def test_unexpected_applied_state_requires_existing_explicit_recovery(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await start(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await initialize(http, local)
                request = aw(doc)
                child = children[0]
                original = child.respond

                def mismatch(message):
                    original(message)
                    if message['method'] == 'tools/call' and message['params']['name'] == 'command_run' \
                            and message['params']['arguments']['id'] == 'develop.merge':
                        child.photos[child.active]['settings']['wb']['temp'] = 5199.

                monkeypatch.setattr(child.stdin, 'respond', mismatch)
                durable = rows()
                assert (await http.post(url(doc, 'operate'), json=request)).status_code == 502
                response = await http.post(url(doc, 'operate'), json=request)
                assert response.status_code == 409 and response.json()['code'] == 'raw_history_readback_mismatch'
                assert len(child.wb_requests) == 1 and rows() == durable
                monkeypatch.setattr(child.stdin, 'respond', original)
                restored = await recover(http, api, doc)
                assert restored['history']['length'] == 0 and restored['values']['wb.temp'] == 6500
                assert restored['nativeMatchesRecipe'] and api._history_save is None
        finally:
            await api.close()
    asyncio.run(run())
