import asyncio
import json
from uuid import UUID

import httpx
import pytest

import immich_export
from export_artifact import ExportArtifact
from export_runtime_store import get_export_run, retry_export_assets
from immich_export import ExportRegistrationError, ImmichExportRegistrar
from immich import get_album_assets
from tests.test_export_queue import A, db, save
from tests.test_export_runtime import queued
from tests.test_immich_export import OUT, Remote, context, detail, registrar, runtime


ALBUMS = [UUID(int=n) for n in (501, 502, 503)]
ARTIFACT = ExportArtifact('IMG-Genzo01.jpg', b'jpeg')


@pytest.mark.parametrize('count', [0, 1, 3])
def test_all_album_memberships_are_inherited_before_stack(count, monkeypatch):
    remote = Remote()
    remote.source_albums = ALBUMS[:count]
    events = []
    monkeypatch.setattr(immich_export, 'runtime_log', lambda event, **fields: events.append((event, fields)))
    assert asyncio.run(registrar(remote).register(detail(), ARTIFACT, context())).registered_asset_id == OUT
    assert remote.calls[0] == ('GET', '/albums')
    assert remote.calls[1] == ('POST', '/assets')
    stack_index = remote.calls.index(('POST', '/stacks'))
    tag_index = remote.calls.index(('PUT', '/tags/assets'))
    for album_id in remote.source_albums:
        assert OUT in remote.album_members[album_id]
        assert tag_index < remote.calls.index(('PUT', f'/albums/{album_id}/assets')) < stack_index
    inherited = [fields for event, fields in events if event == 'registration.albumsInherited']
    assert inherited[0]['sourceAssetId'] == str(A) and inherited[0]['registeredAssetId'] == str(OUT)
    assert inherited[0]['inheritedAlbumIds'] == [str(value) for value in ALBUMS[:count]]
    assert events[-1][1]['stackStarted'] is True


def test_duplicate_album_membership_is_success_and_album_ids_are_deduplicated(monkeypatch):
    remote = Remote()
    remote.source_albums = [ALBUMS[0], ALBUMS[0]]
    remote.album_members[ALBUMS[0]] = {OUT}
    events = []
    monkeypatch.setattr(immich_export, 'runtime_log', lambda event, **fields: events.append((event, fields)))
    asyncio.run(registrar(remote).register(detail(), ARTIFACT, context()))
    assert remote.calls.count(('PUT', f'/albums/{ALBUMS[0]}/assets')) == 1
    assert next(fields for event, fields in events if event == 'registration.albumAdded')['result'] == 'duplicate'
    assert remote.calls.count(('POST', '/stacks')) == 1


def test_album_reload_returns_new_cover_instead_of_losing_stacked_source():
    remote = Remote()
    remote.source_albums = ALBUMS[:1]
    def asset(asset_id):
        return {'id': str(asset_id), 'type': 'IMAGE', 'originalFileName': 'IMG.JPG',
                'fileCreatedAt': detail().date, 'tags': []}
    async def handle(request):
        if request.url.path == '/api/search/metadata':
            assert json.loads(request.content)['filter']['albumIds'] == {'any': [str(ALBUMS[0])]}
            members = {A} | remote.album_members.get(ALBUMS[0], set())
            return httpx.Response(200, json={'assets': {'items': [asset(value) for value in members], 'nextCursor': None}})
        if request.url.path == '/api/stacks' and request.method == 'GET':
            return httpx.Response(200, json=[{**stack, 'assets': [asset(UUID(member['id'])) for member in stack['assets']]}
                                             for stack in remote.stacks])
        return await remote.handle(request)
    transport = httpx.MockTransport(handle)
    async def scenario():
        before = await get_album_assets('http://immich.example', 'private-key', ALBUMS[0], transport=transport)
        assert [entry.id for entry in before] == [A]
        adapter = ImmichExportRegistrar('http://immich.example', 'private-key', transport=transport)
        await adapter.register(detail(), ARTIFACT, context())
        after = await get_album_assets('http://immich.example', 'private-key', ALBUMS[0], transport=transport)
        assert [entry.id for entry in after] == [OUT]
        assert after[0].primaryAssetId == OUT and set(after[0].stackMemberIds) == {A, OUT}
    asyncio.run(scenario())


@pytest.mark.parametrize('status,body', [
    (403, {}), (503, {}), (200, {'id': str(ALBUMS[0])}), (200, [None]),
    (200, [{}]), (200, [{'id': 'private album text'}]), (200, [{'id': None}]),
])
def test_album_lookup_failure_prevents_upload(status, body, monkeypatch):
    calls, events = [], []
    def handle(request):
        calls.append(request)
        return httpx.Response(status, json=body)
    monkeypatch.setattr(immich_export, 'runtime_log', lambda event, **fields: events.append((event, fields)))
    adapter = ImmichExportRegistrar('http://immich.example', 'key', transport=httpx.MockTransport(handle))
    with pytest.raises(ExportRegistrationError):
        asyncio.run(adapter.register(detail(), ARTIFACT, context()))
    assert [(request.method, request.url.path) for request in calls] == [('GET', '/api/albums')]
    assert dict(calls[0].url.params) == {'assetId': str(A)}
    failure = events[-1][1]
    assert failure['phase'] == 'album_context' and failure['stackStarted'] is False
    assert failure['registeredAssetId'] is None and failure['reason'] in ('album_lookup_failed', 'invalid_album_response')
    assert 'private album text' not in json.dumps(events)


@pytest.mark.parametrize('status,body', [
    (403, {}), (500, {}), (302, {}),
    (200, [{'id': str(OUT), 'success': False, 'error': 'no_permission'}]),
    (200, [{'id': str(OUT), 'success': False, 'error': 'not_found'}]),
    (200, [{'id': str(OUT), 'success': False, 'error': 'private error text'}]),
    (200, []), (200, {}), (200, [None]), (200, [{'id': str(A), 'success': True}]),
    (200, [{'id': str(OUT), 'success': 'true'}]), (200, [{'id': str(OUT), 'success': True, 'error': 'no_permission'}]),
    (200, [{'id': str(OUT), 'success': True}] * 2),
])
def test_album_add_failure_cannot_reach_stack(status, body, monkeypatch):
    remote = Remote()
    remote.source_albums = ALBUMS[:1]
    events = []
    async def handle(request):
        if request.url.path == f'/api/albums/{ALBUMS[0]}/assets':
            return httpx.Response(status, json=body)
        return await remote.handle(request)
    monkeypatch.setattr(immich_export, 'runtime_log', lambda event, **fields: events.append((event, fields)))
    adapter = ImmichExportRegistrar('http://immich.example', 'private-key', transport=httpx.MockTransport(handle))
    with pytest.raises(ExportRegistrationError):
        asyncio.run(adapter.register(detail(), ARTIFACT, context()))
    assert len(remote.outputs) == 1 and remote.tags == {OUT}
    assert not any(path.startswith('/stacks') for _, path in remote.calls)
    failure = events[-1][1]
    assert failure['phase'] == 'album' and failure['stackStarted'] is False
    assert failure['sourceAssetId'] == str(A) and failure['registeredAssetId'] == str(OUT)
    assert failure['albumId'] == str(ALBUMS[0]) and failure['result'] == 'failed'
    assert failure['reason'] in ('album_permission_denied', 'album_add_failed', 'invalid_album_add_response')
    assert 'private error text' not in json.dumps(events)


def test_partial_album_failure_manual_retry_reuses_upload_and_completes_all_albums(db, monkeypatch):
    queued(A)
    remote = Remote()
    remote.source_albums = ALBUMS
    remote.failure = f'/albums/{ALBUMS[2]}/assets'
    events = []
    monkeypatch.setattr(immich_export, 'runtime_log', lambda event, **fields: events.append((event, fields)))
    async def scenario():
        first = runtime(remote)
        old_id = await first.start([A])
        await first.wait()
        failed = get_export_run(old_id)
        assert failed.status == 'failed' and failed.items[0].error_code == 'registration_failed'
        assert remote.album_members == {ALBUMS[0]: {OUT}, ALBUMS[1]: {OUT}}
        assert not remote.stacks
        # A second failure must retain the first upload identity, including after another Retry.
        for succeeds in (False, True):
            retry_export_assets([A])
            if succeeds: remote.failure = None
            worker = runtime(remote)
            run_id = await worker.start([A])
            await worker.wait()
            run = get_export_run(run_id)
            assert run.created_at > failed.created_at
            assert run.items[0].export_timestamp == failed.items[0].export_timestamp
            assert run.status == ('completed' if succeeds else 'failed')
        assert run.items[0].registered_asset_id == OUT
    asyncio.run(scenario())
    assert len(remote.outputs) == 1 and len(remote.stacks) == 1
    assert remote.album_members == dict.fromkeys(ALBUMS, {OUT})
    assert len({upload[1] for upload in remote.uploads}) == 1
    assert remote.calls.count(('POST', '/stacks')) == 1
    assert [fields['result'] for event, fields in events if event == 'registration.albumAdded'].count('duplicate') == 4


def test_registration_failure_retry_after_saved_revision_change_uses_new_output(db):
    queued(A)
    remote = Remote()
    remote.failure = '/stacks'
    async def scenario():
        worker = runtime(remote)
        old_id = await worker.start([A])
        await worker.wait()
        old = get_export_run(old_id)
        save(A, revision=old.items[0].frozen_revision)
        retry_export_assets([A])
        remote.failure = None
        worker = runtime(remote)
        new_id = await worker.start([A])
        await worker.wait()
        new = get_export_run(new_id)
        assert new.status == 'completed'
        assert new.items[0].export_timestamp == new.created_at > old.items[0].export_timestamp
    asyncio.run(scenario())
    assert len(remote.outputs) == 2


def test_large_album_inheritance_keeps_all_ids_in_bounded_diagnostic_contexts(monkeypatch):
    from backend_logging import BackendLogger
    remote = Remote()
    remote.source_albums = [UUID(int=n) for n in range(600, 665)]
    logger = BackendLogger()
    logger.set_level('info')
    monkeypatch.setattr('export_runtime_store.backend_logger', logger)
    asyncio.run(registrar(remote).register(detail(), ARTIFACT, context()))
    entries = logger.get_entries()
    chunks = [entry['context']['inheritedAlbumIds'] for entry in entries if entry['event'] == 'registration.albumsInherited']
    assert [value for chunk in chunks for value in chunk] == [str(album_id) for album_id in remote.source_albums]
