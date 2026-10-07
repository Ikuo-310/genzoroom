import asyncio
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
import json
from uuid import UUID, uuid4

import httpx
import pytest

import immich_export
from export_artifact import ExportArtifact
from export_runtime import ExportRuntime, ImmichExportSource, RegistrationContext, _artifact
from export_runtime_store import get_export_run, request_export_stop, recoverable_export_run, retry_export_assets
from immich import AssetDetail, AssetExif
from immich_export import ImmichExportRegistrar, ImmichFamilyFilenameProvider, ExportRegistrationError
from main import app
from tests.test_export_queue import A, B, C, db, request, save, snapshot
from tests.test_export_runtime import queued, jpg

OUT, TAG, STACK, OTHER = (UUID(int=n) for n in (100, 101, 102, 103))
STAMP = '2026-10-07T12:34:56.123Z'
DATE = '2020-02-29T01:02:03.000Z'


def detail(asset_id=A, filename='IMG.JPG', is_favorite=False):
    return AssetDetail(id=asset_id, filename=filename, date=DATE, preview_url='', thumbnail_url='',
                       format='JPEG', is_raw=False, is_favorite=is_favorite, exif=AssetExif())


def context():
    return RegistrationContext(uuid4(), A, 0, 1, 18, 'jpeg-preview-srgb8-v1', STAMP)


def stack(ids, primary=None, stack_id=STACK):
    return {'id': str(stack_id), 'primaryAssetId': str(primary or ids[0]), 'assets': [{'id': str(asset_id)} for asset_id in ids]}


def search(names, cursor=None):
    return httpx.Response(200, json={'assets': {'items': [{'id': str(UUID(int=n + 1)), 'type': 'IMAGE',
        'originalFileName': name, 'fileCreatedAt': DATE} for n, name in enumerate(names)], 'nextCursor': cursor}})


def multipart(request):
    message = BytesParser(policy=policy.default).parsebytes(
        b'Content-Type: ' + request.headers['content-type'].encode() + b'\r\nMIME-Version: 1.0\r\n\r\n' + request.content)
    return {part.get_param('name', header='content-disposition'): part for part in message.iter_parts()}


class Remote:
    def __init__(self, stacks=()):
        self.stacks, self.calls, self.uploads, self.outputs = list(stacks), [], [], {}
        self.tags = set()
        self.failure = None
        self.gate = None

    async def handle(self, request):
        assert request.headers['x-api-key'] == 'private-key'
        path = request.url.path.removeprefix('/api')
        self.calls.append((request.method, path))
        if self.failure == path:
            return httpx.Response(503, json={'error': 'private body'})
        if path == '/search/metadata':
            body = json.loads(request.content)
            assert body['filter'] == {'type': {'eq': 'IMAGE'}, 'trashedAt': {'eq': None}, 'originalFileName': {'startsWith': 'IMG'}}
            assert body['withStacked'] and body['size'] == 1000 and 'visibility' not in body['filter']
            return search(['IMG.JPG', *[value[0] for value in self.outputs.values()]])
        if path == '/assets' and request.method == 'POST':
            parts = multipart(request)
            assert set(parts) == {'assetData', 'filename', 'fileCreatedAt', 'fileModifiedAt', 'isFavorite'}
            content = parts['assetData'].get_payload(decode=True)
            filename = parts['filename'].get_payload(decode=True).decode()
            assert parts['assetData'].get_filename() == filename and parts['assetData'].get_content_type() == 'image/jpeg'
            assert parts['fileCreatedAt'].get_payload(decode=True).decode() == DATE
            modified = parts['fileModifiedAt'].get_payload(decode=True).decode()
            favorite = parts['isFavorite'].get_payload(decode=True).decode()
            assert favorite in ('true', 'false')
            self.uploads.append((filename, content, modified, favorite == 'true'))
            if content in self.outputs:
                asset_id = self.outputs[content][1]
                return httpx.Response(200, json={'id': str(asset_id), 'status': 'duplicate'})
            asset_id = UUID(int=100 + len(self.outputs))
            self.outputs[content] = (filename, asset_id)
            if self.gate == 'upload':
                await asyncio.Event().wait()
            return httpx.Response(201, json={'id': str(asset_id), 'status': 'created'})
        if path == '/tags':
            assert request.method == 'PUT' and json.loads(request.content) == {'tags': ['GenzoRoom']}
            return httpx.Response(200, json=[{'id': str(TAG), 'name': 'GenzoRoom', 'value': 'GenzoRoom'}])
        if path == '/tags/assets':
            body = json.loads(request.content)
            assert body['tagIds'] == [str(TAG)] and str(A) not in body['assetIds']
            asset_id = UUID(body['assetIds'][0])
            count = int(asset_id not in self.tags)
            self.tags.add(asset_id)
            if self.gate == 'tag': await asyncio.Event().wait()
            return httpx.Response(200, json={'count': count})
        if path == '/stacks' and request.method == 'GET':
            return httpx.Response(200, json=self.stacks)
        if path == '/stacks' and request.method == 'POST':
            ids = [UUID(value) for value in json.loads(request.content)['assetIds']]
            members = set(ids)
            for previous in self.stacks:
                if UUID(previous['primaryAssetId']) in ids:
                    members.update(UUID(member['id']) for member in previous['assets'])
            self.stacks = [stack(sorted(members, key=str), ids[0])]
            if self.gate == 'stack': await asyncio.Event().wait()
            return httpx.Response(201, json=self.stacks[0])
        if path.startswith('/stacks/') and request.method == 'PUT':
            previous = next(value for value in self.stacks if value['id'] == path.split('/')[-1])
            previous['primaryAssetId'] = json.loads(request.content)['primaryAssetId']
            return httpx.Response(200, json=previous)
        if path.startswith('/assets/'):
            asset_id = UUID(path.split('/')[2])
            if path.endswith('/original'):
                return httpx.Response(200, content=jpg(), headers={'Content-Type': 'image/jpeg'})
            tags = [{'id': str(TAG), 'value': 'GenzoRoom'}] if asset_id in self.tags else []
            return httpx.Response(200, json={'id': str(asset_id), 'type': 'IMAGE', 'originalFileName': 'IMG.JPG',
                'fileCreatedAt': DATE, 'isFavorite': False, 'tags': tags})
        raise AssertionError((request.method, path))


def registrar(remote):
    return ImmichExportRegistrar('http://immich.example/api', 'private-key', transport=httpx.MockTransport(remote.handle))


def runtime(remote):
    transport = httpx.MockTransport(remote.handle)
    return ExportRuntime(source=ImmichExportSource('http://immich.example/api', 'private-key', transport=transport),
        family=ImmichFamilyFilenameProvider('http://immich.example/api', 'private-key', transport=transport),
        registrar=ImmichExportRegistrar('http://immich.example/api', 'private-key', transport=transport))


@pytest.mark.parametrize('filename,names,expected', [
    ('IMG.foo.JPG', ['IMG.JPG', 'IMG-Genzo03.jpg', 'IMGx.jpg', 'img.jpg', 'IMG-Genzo03more.jpg'], ['IMG-Genzo03.jpg', 'IMG.JPG']),
    ('IMG-Genzo03.JPG', ['IMG-Genzo04.jpg', 'IMG.PNG', 'IMG-Genzo03-Genzo01.jpg'], ['IMG-Genzo04.jpg', 'IMG.PNG']),
])
def test_family_uses_structured_prefix_then_exact_first_dot_case_sensitive_family(filename, names, expected):
    calls = []
    def handle(request):
        calls.append(json.loads(request.content))
        return search(names)
    provider = ImmichFamilyFilenameProvider('http://immich.example', 'key', transport=httpx.MockTransport(handle))
    assert asyncio.run(provider.filenames(detail(filename=filename), context())) == expected
    assert calls[0]['filter']['originalFileName'] == {'startsWith': 'IMG'}
    assert calls[0]['withStacked'] and 'visibility' not in calls[0]['filter']


def test_family_paginates_full_1000_deduplicates_and_excludes_trash():
    calls = []
    def handle(request):
        calls.append(json.loads(request.content))
        if len(calls) == 1: return search(['IMG-Genzo03.jpg'] * 1000, 'next')
        response = search(['IMG-Genzo04.jpg', 'IMG-Genzo03.jpg', 'IMG-Genzo99.jpg'])
        body = response.json(); body['assets']['items'][-1]['trashedAt'] = STAMP
        return httpx.Response(200, json=body)
    provider = ImmichFamilyFilenameProvider('http://immich.example', 'key', transport=httpx.MockTransport(handle))
    assert asyncio.run(provider.filenames(detail(), context())) == ['IMG-Genzo03.jpg', 'IMG-Genzo04.jpg']
    assert calls[1]['cursor'] == 'next' and calls[0]['size'] == 1000


@pytest.mark.parametrize('bad', ['loop', 'empty', 'cursor_type', 'missing_cursor', 'bad_id', 'bad_items', 'redirect', 'network', 'limit'])
def test_family_fails_bounded_on_invalid_response_or_cursor(bad, monkeypatch):
    if bad == 'limit': monkeypatch.setattr(immich_export, 'MAX_FAMILY_PAGES', 2)
    def handle(request):
        if bad == 'network': raise httpx.ReadTimeout('private server')
        if bad == 'redirect': return httpx.Response(302)
        body = search(['IMG.JPG'], 'same').json()
        if bad == 'empty': body['assets']['items'] = []
        if bad == 'cursor_type': body['assets']['nextCursor'] = 1
        if bad == 'missing_cursor': del body['assets']['nextCursor']
        if bad == 'bad_id': body['assets']['items'][0]['id'] = 'private'
        if bad == 'bad_items': body['assets']['items'] = None
        if bad == 'limit': body['assets']['nextCursor'] = str(uuid4())
        return httpx.Response(200, json=body)
    provider = ImmichFamilyFilenameProvider('http://immich.example', 'key', transport=httpx.MockTransport(handle))
    with pytest.raises((ValueError, KeyError, httpx.RequestError)):
        asyncio.run(provider.filenames(detail(), context()))


@pytest.mark.parametrize('existing,expected_write', [
    ([], 'POST'), ([stack([B, A, C], B)], 'POST'), ([stack([OUT, A], OUT)], None),
    ([stack([A, OUT], A)], 'PUT'),
])
def test_registration_upload_tag_stack_and_cover_cases(existing, expected_write):
    remote = Remote(existing)
    artifact = ExportArtifact('IMG-Genzo01.jpg', b'JPEG content')
    result = asyncio.run(registrar(remote).register(detail(), artifact, context()))
    assert result.registered_asset_id == OUT
    assert remote.uploads[0][:3] == (artifact.filename, artifact.jpeg, STAMP)
    writes = [(method, path) for method, path in remote.calls if path.startswith('/stacks') and method != 'GET']
    assert [method for method, _ in writes] == ([expected_write] if expected_write else [])
    assert remote.stacks[0]['primaryAssetId'] == str(OUT)
    assert str(A) in [member['id'] for member in remote.stacks[0]['assets']]
    if existing and expected_write == 'POST':
        assert {str(A), str(B), str(C), str(OUT)} == {member['id'] for member in remote.stacks[0]['assets']}
    assert not any(method == 'DELETE' for method, _ in remote.calls)


@pytest.mark.parametrize('is_favorite', [True, False])
def test_registration_upload_inherits_source_favorite_without_update(is_favorite):
    remote = Remote()
    artifact = ExportArtifact('IMG-Genzo01.jpg', b'JPEG content')
    asyncio.run(registrar(remote).register(detail(is_favorite=is_favorite), artifact, context()))
    assert remote.uploads[0][:2] == (artifact.filename, artifact.jpeg)
    assert remote.uploads[0][3] is is_favorite
    assert ('POST', '/assets') in remote.calls
    assert not any(method == 'PUT' and path.startswith('/assets') for method, path in remote.calls)


@pytest.mark.parametrize('unrelated', [
    [stack([UUID(int=200)], stack_id=UUID(int=300))],
    [stack([UUID(int=200), UUID(int=201)], UUID(int=202), UUID(int=300))],
    [{'id': str(UUID(int=300)), 'assets': [{'id': str(UUID(int=200))}]}],
    [{'id': 'invalid', 'primaryAssetId': str(UUID(int=200)), 'assets': [{'id': str(UUID(int=200))}, None]}],
    [stack([UUID(int=200), UUID(int=201)], stack_id=UUID(int=300)),
     stack([UUID(int=200), UUID(int=202)], stack_id=UUID(int=301))],
])
def test_registration_ignores_unrelated_stack_defects_and_preserves_source_members(unrelated):
    remote = Remote([stack([B, A, C], B)])
    writes = []
    async def handle(request):
        if request.url.path == '/api/stacks' and request.method == 'GET':
            return httpx.Response(200, json=[*remote.stacks, *unrelated])
        if request.url.path == '/api/stacks' and request.method == 'POST':
            writes.append(json.loads(request.content))
        return await remote.handle(request)
    adapter = ImmichExportRegistrar('http://immich.example/api', 'private-key', transport=httpx.MockTransport(handle))
    result = asyncio.run(adapter.register(detail(), ExportArtifact('IMG-Genzo01.jpg', b'jpeg'), context()))
    assert result.registered_asset_id == OUT
    assert writes == [{'assetIds': [str(OUT), str(B)]}]
    assert remote.stacks[0]['primaryAssetId'] == str(OUT)
    assert {member['id'] for member in remote.stacks[0]['assets']} == {str(A), str(B), str(C), str(OUT)}
    assert not any(method == 'DELETE' for method, _ in remote.calls)


@pytest.mark.parametrize('target', [A, OUT])
@pytest.mark.parametrize('defect', ['missing_primary', 'ambiguous', 'duplicate_stack_id', 'malformed'])
def test_registration_rejects_target_quarantine_before_stack_mutation(target, defect, monkeypatch):
    existing = [stack([target, B])]
    if defect == 'missing_primary': existing[0]['primaryAssetId'] = str(C)
    if defect == 'ambiguous': existing.append(stack([target, C], stack_id=OTHER))
    if defect == 'duplicate_stack_id': existing.append(stack([C, UUID(int=200)]))
    if defect == 'malformed': existing[0]['assets'].append({'id': 'invalid'})
    remote = Remote(existing)
    events = []
    monkeypatch.setattr(immich_export, 'runtime_log', lambda event, **fields: events.append((event, fields)))
    with pytest.raises(ExportRegistrationError) as error:
        asyncio.run(registrar(remote).register(detail(), ExportArtifact('IMG-Genzo01.jpg', b'jpeg'), context()))
    assert error.value.code == 'registration_failed'
    assert not any(path.startswith('/stacks') and method != 'GET' for method, path in remote.calls)
    failure = next(fields for event, fields in events if event == 'registration.stepFailed')
    assert failure['phase'] == 'stack_context'
    assert failure['sourceQuarantined'] is (target == A)
    assert failure['outputQuarantined'] is (target == OUT)
    assert failure['invalidStackCount'] >= 1 and failure['quarantinedMemberCount'] >= 2
    assert set(failure) == {'level', 'runId', 'assetId', 'position', 'phase', 'errorCode',
                           'sourceQuarantined', 'outputQuarantined', 'validStackCount', 'invalidStackCount', 'quarantinedMemberCount'}


@pytest.mark.parametrize('existing', [
    [stack([A, B]), stack([OUT, C], stack_id=OTHER)], [stack([OUT, C], stack_id=OTHER)],
    [stack([A, B]), stack([A, C], stack_id=OTHER)], [{'id': str(STACK), 'primaryAssetId': str(A), 'assets': []}],
])
def test_registration_refuses_foreign_or_ambiguous_stack_without_mutation(existing):
    remote = Remote(existing)
    with pytest.raises(ExportRegistrationError): asyncio.run(registrar(remote).register(detail(), ExportArtifact('IMG-Genzo01.jpg', b'jpeg'), context()))
    assert not any(path.startswith('/stacks') and method != 'GET' for method, path in remote.calls)


@pytest.mark.parametrize('status,body', [
    (200, {'id': str(OUT), 'status': 'created'}), (201, {'id': str(OUT), 'status': 'duplicate'}),
    (201, {'id': 'bad', 'status': 'created'}), (201, {'id': str(OUT), 'status': 'created', 'extra': True}),
    (201, {'id': str(A), 'status': 'created'}), (302, {'id': str(OUT), 'status': 'created'}),
    (401, {}), (403, {}), (500, {}), (201, []), (201, None),
])
def test_upload_strict_status_uuid_shape_and_http_failure(status, body):
    calls = []
    def handle(request):
        calls.append(request.url.path)
        return httpx.Response(status, json=body)
    remote = ImmichExportRegistrar('http://immich.example', 'key', transport=httpx.MockTransport(handle))
    with pytest.raises(ExportRegistrationError) as error:
        asyncio.run(remote.register(detail(), ExportArtifact('IMG-Genzo01.jpg', b'jpeg'), context()))
    assert str(error.value) == '' and error.value.code == 'registration_failed'
    assert calls == ['/api/assets']


@pytest.mark.parametrize('path', ['/tags', '/tags/assets', '/stacks'])
def test_registration_write_failure_keeps_queue_failed(db, path):
    queued(A)
    remote = Remote(); remote.failure = path
    async def scenario():
        worker = runtime(remote); run_id = await worker.start([A]); await worker.wait()
        run = get_export_run(run_id)
        assert run.status == 'failed' and run.items[0].error_code == 'registration_failed'
        retry_export_assets([A])
    asyncio.run(scenario())


@pytest.mark.parametrize('stage', ['upload', 'tag', 'stack'])
def test_interrupted_registration_recovery_has_identical_jpeg_and_converges_without_duplicate(db, stage):
    queued(A, B)
    remote = Remote(); remote.gate = stage
    async def scenario():
        worker = runtime(remote); run_id = await worker.start([A, B])
        for _ in range(300):
            ready = bool(remote.outputs) if stage == 'upload' else bool(remote.tags) if stage == 'tag' else bool(remote.stacks)
            if ready: break
            await asyncio.sleep(0.005)
        assert ready
        request_export_stop(run_id)
        worker._task.cancel()
        with pytest.raises(asyncio.CancelledError): await worker.wait()
        persisted = recoverable_export_run()
        assert persisted.stop_requested and persisted.items[0].status == 'registering'
        remote.gate = None
        resumed = runtime(remote); assert await resumed.recover() == run_id; await resumed.wait()
        final = get_export_run(run_id)
        assert final.status == 'stopped' and final.items[0].registered_asset_id == OUT
        assert len(remote.outputs) == 1 and len(remote.uploads) == 2
        assert remote.uploads[0][1] == remote.uploads[1][1]
        assert remote.uploads[0][2] == remote.uploads[1][2] == persisted.created_at
        if stage == 'stack': assert remote.calls.count(('POST', '/stacks')) == 1
    asyncio.run(scenario())


def test_new_run_new_timestamp_new_jpeg_and_incremented_filename(db):
    queued(A)
    remote = Remote()
    async def scenario():
        first = runtime(remote); old_id = await first.start([A]); await first.wait()
        edit_store = __import__('edit_store'); edit_store.enqueue_export_assets([A])
        second = runtime(remote); new_id = await second.start([A]); await second.wait()
        assert get_export_run(new_id).created_at != get_export_run(old_id).created_at
        assert get_export_run(new_id).status == 'completed'
    asyncio.run(scenario())
    assert [entry[0] for entry in remote.uploads] == ['IMG-Genzo01.jpg', 'IMG-Genzo02.jpg']
    assert remote.uploads[0][1] != remote.uploads[1][1] and len(remote.outputs) == 2


def test_production_start_api_wiring_configuration_errors_and_request_lifetime(db, monkeypatch):
    import main
    queued(A)
    remote = Remote()
    monkeypatch.setenv('IMMICH_URL', 'http://immich.example/api'); monkeypatch.setenv('IMMICH_API_KEY', 'private-key')
    monkeypatch.setattr(main, 'ImmichExportSource', lambda url, key: runtime(remote)._source)
    monkeypatch.setattr(main, 'ImmichFamilyFilenameProvider', lambda url, key: runtime(remote)._family)
    monkeypatch.setattr(main, 'ImmichExportRegistrar', lambda url, key: registrar(remote))
    async def scenario():
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                bad = await client.post('/export/runtime/start', json={'assetIds': [str(A), str(A)]})
                assert bad.status_code == 422
                response = await client.post('/export/runtime/start', json={'assetIds': [str(A)]})
                assert response.status_code == 200 and response.json()['runId']
            await app.state.export_runtime.wait()
            assert not __import__('edit_store').list_export_queue()
    asyncio.run(scenario())


def test_upload_timeout_network_failure_and_logging_privacy(monkeypatch):
    entries = []
    monkeypatch.setattr(__import__('immich').backend_logger, 'add', lambda **entry: entries.append(entry))
    remote = Remote()
    asyncio.run(registrar(remote).register(detail(filename='private-filename.JPG'), ExportArtifact('private-output.jpg', b'secret JPEG bytes'), context()))
    encoded = json.dumps(entries)
    assert all(value not in encoded for value in ('private-key', 'private-filename', 'private-output', 'secret JPEG bytes', 'immich.example'))
    def failing(request):
        assert request.extensions['timeout']['read'] == 120 and request.extensions['timeout']['write'] == 120
        raise httpx.WriteTimeout('private exception')
    adapter = ImmichExportRegistrar('http://immich.example', 'key', transport=httpx.MockTransport(failing))
    with pytest.raises(ExportRegistrationError): asyncio.run(adapter.register(detail(), ExportArtifact('IMG-Genzo01.jpg', b'jpeg'), context()))
    monkeypatch.setattr(__import__('immich').backend_logger, 'add', lambda **entry: (_ for _ in ()).throw(RuntimeError('logger failure')))
    assert asyncio.run(registrar(Remote()).register(detail(), ExportArtifact('IMG-Genzo01.jpg', b'jpeg'), context())).registered_asset_id == OUT


@pytest.mark.parametrize('phase,bad', [
    ('/tags', []), ('/tags', [{'id': 'bad', 'name': 'GenzoRoom', 'value': 'GenzoRoom'}]),
    ('/tags', [{'id': str(TAG), 'name': 'Other', 'value': 'Other'}]),
    ('/tags/assets', {'count': True}), ('/tags/assets', {'count': 2}), ('/tags/assets', {'count': 0}),
    ('/stacks', stack([OUT], OUT)), ('/stacks', stack([OUT, A], A)),
    ('/stacks', stack([OUT, A, B], OUT)), ('/stacks', {'id': 'bad', 'primaryAssetId': str(OUT), 'assets': []}),
])
def test_invalid_tag_or_stack_acknowledgement_cannot_certify_registration(phase, bad):
    remote = Remote()
    async def handle(request):
        if request.url.path == '/api' + phase and request.method != 'GET':
            return httpx.Response(201 if phase == '/stacks' else 200, json=bad)
        return await remote.handle(request)
    adapter = ImmichExportRegistrar('http://immich.example', 'private-key', transport=httpx.MockTransport(handle))
    with pytest.raises(ExportRegistrationError):
        asyncio.run(adapter.register(detail(), ExportArtifact('IMG-Genzo01.jpg', b'jpeg'), context()))


def test_registration_retry_reapplies_tag_zero_count_and_puts_cover_only_once():
    remote = Remote([stack([A, OUT], A)])
    adapter = registrar(remote)
    artifact = ExportArtifact('IMG-Genzo01.jpg', b'jpeg')
    assert asyncio.run(adapter.register(detail(), artifact, context())).registered_asset_id == OUT
    assert asyncio.run(adapter.register(detail(), artifact, context())).registered_asset_id == OUT
    assert len(remote.outputs) == 1 and remote.calls.count(('PUT', f'/stacks/{STACK}')) == 1
    assert ('GET', f'/assets/{OUT}') in remote.calls


def test_existing_run_creation_time_is_export_time_and_distinct_for_immediate_new_runs(db, monkeypatch):
    from export_runtime_store import create_export_run, fail_export_item
    monkeypatch.setattr('export_runtime_store._now', lambda: STAMP)
    queued(A)
    first = create_export_run([A], worker_id=uuid4())
    assert first.items[0].export_timestamp == first.created_at == STAMP
    fail_export_item(first.run_id, A, first.worker_id, 'waiting', 'worker_failed')
    retry_export_assets([A])
    second = create_export_run([A])
    assert second.created_at > first.created_at and second.items[0].export_timestamp == second.created_at


def test_canonical_icc_header_has_no_process_clock_dependency():
    import struct
    from jpeg_codec import _srgb_profile
    profile = _srgb_profile()
    assert struct.unpack('>6H', profile.tobytes()[24:36]) == (2000, 1, 1, 0, 0, 0)
    assert profile.tobytes()[84:100] == bytes(16)
    assert _srgb_profile().tobytes() == profile.tobytes()


def test_configured_lifespan_resumes_interrupted_run_with_production_adapters(db, monkeypatch):
    import main
    from tests.test_export_recovery import interrupted
    old, _ = interrupted('registering', A)
    remote = Remote()
    monkeypatch.setenv('IMMICH_URL', 'http://immich.example/api'); monkeypatch.setenv('IMMICH_API_KEY', 'private-key')
    monkeypatch.setattr(main, 'ImmichExportSource', lambda url, key: runtime(remote)._source)
    monkeypatch.setattr(main, 'ImmichFamilyFilenameProvider', lambda url, key: runtime(remote)._family)
    monkeypatch.setattr(main, 'ImmichExportRegistrar', lambda url, key: registrar(remote))
    async def scenario():
        async with app.router.lifespan_context(app):
            await app.state.export_runtime.wait()
            assert get_export_run(old.run_id).status == 'completed'
    asyncio.run(scenario())


def test_start_checkpoint_storage_failure_stays_503_and_retains_recoverable_run(db, monkeypatch):
    from edit_store import StoreUnavailable
    queued(A)
    monkeypatch.setattr('export_runtime.begin_export_item', lambda *args: (_ for _ in ()).throw(StoreUnavailable()))
    async def scenario():
        worker = runtime(Remote())
        with pytest.raises(StoreUnavailable): await worker.start([A])
        await worker.wait()
        assert recoverable_export_run().items[0].status == 'waiting'
    asyncio.run(scenario())
