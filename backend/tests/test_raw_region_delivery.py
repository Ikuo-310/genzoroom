import asyncio
import json
import hashlib
import re
from dataclasses import replace

import pytest

from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document
from tests.test_raw_region import enable, target
from tests.test_raw_adaptive_preview import target as whole_target
from tests.test_lightcraft_mcp import until
from lightcraft_mcp import LightCraftError
import windows_raw_api as module
import raw_region


async def connect(api, http, child):
    enable(child)
    child.adaptive_supported = True
    _, doc = await open_document(http)
    # Exercise the explicit public-token attestation even when the internal token differs.
    api.document['documentToken'] = doc['documentToken'] = 'e' * 32
    response = await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=whole_target(doc, quality='full'))
    assert response.status_code == 200, response.text
    geometry = json.loads(response.headers['x-raw-frame'])['geometryId']
    return doc, geometry


def body(api, geometry, operation='render', view=1):
    t = target(api.raw, api._raw_handle, operation=operation, view=view)
    t['identity']['documentToken'] = api.document['documentToken']
    t['geometryId'] = geometry
    return {'workspaceId': api.workspace, 'operation': operation, 'target': t}


def test_public_region_plan_render_and_common_worker(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        try:
            async with client(local) as http:
                await authenticate(http, local)
                doc, geometry = await connect(api, http, child)
                url = f'/api/raw/documents/{doc["handle"]}'
                owner = await http.get(url + '/region', headers={'X-Raw-Workspace': doc['workspaceId'],
                    'X-Raw-Generation': str(doc['generation']), 'X-Raw-Token': doc['documentToken']})
                assert owner.json() == {'sourceId': api.raw.region_identity(api._raw_handle)['sourceId'], 'regionContract': 1}
                for operation in ('plan', 'render'):
                    response = await http.post(url + '/region', json=body(api, geometry, operation))
                    assert response.status_code == 200, response.text
                    meta = response.json() if operation == 'plan' else json.loads(response.headers['x-raw-region'])
                    assert meta['geometryId'] == geometry and meta['identity']['documentToken'] == 'e'*32
                    assert not api._image_leases
                child.gate = asyncio.Event(); child.render_started.clear()
                region = asyncio.create_task(http.post(url + '/region', json=body(api, geometry, view=2)))
                await child.render_started.wait()
                whole = asyncio.create_task(http.post(url + '/preview', json=whole_target(doc, serial=2)))
                await asyncio.sleep(0)
                child.gate.set()
                await asyncio.gather(region, whole)
                assert child.max_inflight == 1 and not api._image_leases
        finally:
            if child.gate: child.gate.set()
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('supported', [True, False])
def test_native_hash128_owner_preserves_c0_identity_and_public_owner_checks(local, tmp_path, monkeypatch, supported):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        events = []
        monkeypatch.setattr(module, 'lightcraft_log', lambda event, **context: events.append((event, context)))
        try:
            async with client(local) as http:
                await authenticate(http, local)
                doc, geometry = await connect(api, http, children[0])
                # Actual C1 photo.inspect returns Hash128, unlike the fake Native's SHA-256.
                native_hash = '1234567890abcdef' * 2
                api.raw._photo(api._raw_handle).content_hash = native_hash
                api.manager._session.region_preview = supported
                url = f'/api/raw/documents/{doc["handle"]}/region'
                headers = {'X-Raw-Workspace': doc['workspaceId'], 'X-Raw-Generation': str(doc['generation']),
                           'X-Raw-Token': doc['documentToken']}
                response = await http.get(url, headers=headers)
                assert response.status_code == 200
                source = response.json()['sourceId']
                assert re.fullmatch('[a-f0-9]{64}', source)
                assert source == hashlib.sha256(b'genzoroom-region-source-v1\0' + native_hash.encode('ascii')).hexdigest()
                assert response.json()['regionContract'] == (1 if supported else None)
                assert any(event == 'region.owner.completed' and context.get('sourceIdCharacters') == 64
                           and context.get('supported') is supported for event, context in events)
                for key, value in [('X-Raw-Workspace', 'f'*32), ('X-Raw-Generation', str(doc['generation']+1)),
                                   ('X-Raw-Token', 'f'*32)]:
                    assert (await http.get(url, headers=headers | {key: value})).status_code == 409
                if supported:
                    result = await http.post(url, json=body(api, geometry, 'plan'))
                    assert result.status_code == 200, result.text
                    assert result.json()['identity']['sourceId'] == source
                whole = await http.post(url.removesuffix('/region') + '/preview', json=whole_target(doc, serial=2))
                assert whole.status_code == 200
                assert any(event == 'region.owner.failed' and context.get('errorCode') == 'raw_stale_handle'
                           and context.get('status') == 409 for event, context in events)
                assert doc['documentToken'] not in json.dumps(events)
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('spoof', ['workspace', 'handle', 'assetId', 'sourceId', 'documentToken', 'generation', 'revision', 'shape'])
def test_spoofed_owner_never_sends_native(local, tmp_path, monkeypatch, spoof):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                doc, geometry = await connect(api, http, children[0])
                value = body(api, geometry)
                handle = doc['handle']
                if spoof == 'workspace': value['workspaceId'] = 'f'*32
                elif spoof == 'handle': handle = 'f'*32
                elif spoof == 'shape': value['target']['window']['w'] = 2049
                elif spoof == 'revision': value['target']['documentRevision'] += 1; value['target']['identity']['revision'] += 1
                elif spoof == 'generation': value['target']['identity'][spoof] += 1
                else: value['target']['identity'][spoof] = 'f'* (32 if spoof == 'documentToken' else 64) if spoof != 'assetId' else 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                response = await http.post(f'/api/raw/documents/{handle}/region', json=value)
                assert response.status_code in (400, 409), response.text
                assert not children[0].region_arguments and not api._image_leases
        finally: await api.close()
    asyncio.run(run())


def test_region_cancel_replacement_and_100_view_updates(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]; tasks = []
        try:
            async with client(local) as http:
                await authenticate(http, local)
                doc, geometry = await connect(api, http, child)
                url = f'/api/raw/documents/{doc["handle"]}/region'
                child.gate = asyncio.Event(); child.render_started.clear()
                tasks.append(asyncio.create_task(http.post(url, json=body(api, geometry))))
                await child.render_started.wait()
                for n in range(2, 102):
                    tasks.append(asyncio.create_task(http.post(url, json=body(api, geometry, view=n))))
                    await until(lambda: api.raw._pending is not None and api.raw._pending.region_target['viewGeneration'] == n)
                    assert len(api._image_leases) <= 3 and child.inflight == 1
                latest = body(api, geometry, view=101)['target']['requestId']
                response = await http.post(url + '/cancel', json={k: doc[k] for k in ('workspaceId','generation','documentToken')} | {'requestId': latest})
                assert response.status_code == 204
                child.gate.set()
                responses = await asyncio.gather(*tasks)
                assert all(r.status_code == 204 for r in responses)
                assert len(child.region_arguments) == 1 and not api._image_leases
                assert child.max_inflight == 1
        finally:
            if child.gate: child.gate.set()
            await asyncio.gather(*tasks, return_exceptions=True)
            await api.close()
    asyncio.run(run())


def test_legacy_binary_retains_whole_availability(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                await authenticate(http, local)
                _, doc = await open_document(http)
                cap = (await http.get('/api/raw/capabilities')).json()
                assert cap['available'] and 'regionContract' not in cap
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/region', json=body(api, 'a'*64))
                assert response.status_code == 503
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/preview', json=whole_target(doc))
                assert response.status_code == 200
        finally: await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('boundary', ['close', 'shutdown'])
def test_region_response_send_retains_session_and_source(local, tmp_path, monkeypatch, boundary):
    async def run():
        api, _, children, cache = await setup(tmp_path, local, monkeypatch)
        entered, release = asyncio.Event(), asyncio.Event()
        original = module._ImageResponse.__call__
        async def slow_body(response, scope, receive, send):
            async def slow_send(message):
                if message['type'] == 'http.response.body' and 'x-raw-region' in response.headers:
                    entered.set(); await release.wait()
                await send(message)
            await original(response, scope, receive, slow_send)
        monkeypatch.setattr(module._ImageResponse, '__call__', slow_body)
        closing = sending = None
        try:
            async with client(local) as http:
                await authenticate(http, local)
                doc, geometry = await connect(api, http, children[0])
                sending = asyncio.create_task(http.post(f'/api/raw/documents/{doc["handle"]}/region', json=body(api, geometry)))
                await entered.wait()
                closing = asyncio.create_task(api.close() if boundary == 'shutdown' else api._release())
                await asyncio.sleep(.01)
                assert not closing.done() and api._response_leases and any(cache.iterdir())
                assert api.raw._active is not None
                release.set()
                assert (await sending).status_code == 200
                await closing
                assert not api._image_leases and not api._response_leases and not api._lease_tickets
        finally:
            release.set()
            await asyncio.gather(*(t for t in (sending, closing) if t), return_exceptions=True)
            await api.close()
    asyncio.run(run())


def test_region_http_waiter_cancel_is_detached_but_native_is_joined(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]; task = None
        try:
            async with client(local) as http:
                await authenticate(http, local)
                doc, geometry = await connect(api, http, child)
                child.gate = asyncio.Event(); child.render_started.clear()
                task = asyncio.create_task(http.post(f'/api/raw/documents/{doc["handle"]}/region', json=body(api, geometry)))
                await child.render_started.wait()
                task.cancel(); await asyncio.gather(task, return_exceptions=True)
                assert child.inflight == 1 and api._image_leases
                child.gate.set()
                await until(lambda: not api._image_tasks)
                assert not api._image_leases and not api._lease_tickets
                assert api.raw.status().state == 'synced'
        finally:
            if child.gate: child.gate.set()
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('boundary', ['mismatch', 'timeout', 'generation'])
def test_http_failure_boundaries_reclaim_region_leases(local, tmp_path, monkeypatch, boundary):
    async def run():
        api, manager, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        try:
            async with client(local) as http:
                await authenticate(http, local)
                doc, geometry = await connect(api, http, child)
                value = body(api, geometry)
                if boundary == 'mismatch':
                    validate = raw_region.validate_result
                    def mismatch(result, *args):
                        meta = json.loads(result['content'][1]['text']); meta['response']['viewGeneration'] += 1
                        result['content'][1]['text'] = json.dumps(meta)
                        return validate(result, *args)
                    monkeypatch.setattr(raw_region, 'validate_result', mismatch)
                elif boundary == 'timeout':
                    api.raw._timeouts = replace(api.raw._timeouts, preview=.03)
                    child.gate = asyncio.Event()
                else:
                    await api.raw.reset_session(restore_active=False)
                response = await http.post(f'/api/raw/documents/{doc["handle"]}/region', json=value)
                assert response.status_code in (409, 502, 503), response.text
                assert not api._image_leases and not api._lease_tickets
                if boundary == 'mismatch': assert api.raw.status().state == 'synced'
                if boundary == 'timeout':
                    await until(lambda: child.returncode is not None)
                    assert child.returncode is not None
                    response = await http.post(f'/api/raw/documents/{doc["handle"]}/region', json=value)
                    assert response.status_code != 200
        finally:
            if child.gate: child.gate.set()
            await api.close()
    asyncio.run(run())
