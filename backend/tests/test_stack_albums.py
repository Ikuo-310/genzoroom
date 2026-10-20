"""Album normalization uses live membership without changing Stack outcome contracts."""
import asyncio
import json
from uuid import UUID

import httpx
import pytest

from immich import ImmichAlbumError, remove_asset_from_album
from stack_write import StackApplyRequest, apply_stacks
from test_stack_write import A, B, C, D, NEW, op
from test_stack_assets import STACK_ID, SECOND_STACK_ID, stack

X, Y = (str(UUID(int=n)) for n in (501, 502))


def run(operations, albums=None, existing=(), failure=None):
    albums = {asset: set(ids) for asset, ids in (albums or {}).items()}
    stacks = {s['id']: dict(s) for s in existing}
    calls = []

    def handler(request):
        path, method = request.url.path.removeprefix('/api'), request.method
        body = json.loads(request.content) if request.content else None
        calls.append((method, path, body))
        if failure:
            response = failure(method, path, body)
            if response is not None:
                return response
        if path == '/albums':
            return httpx.Response(200, json=[{'id': i} for i in sorted(albums.get(request.url.params['assetId'], set()))])
        if path.startswith('/albums/'):
            album = path.split('/')[2]
            asset = body['ids'][0]
            membership = albums.setdefault(asset, set())
            present = album in membership
            if method == 'PUT':
                membership.add(album)
                error = 'duplicate' if present else None
            else:
                membership.discard(album)
                error = None if present else 'not_found'
            return httpx.Response(200, json=[{'id': asset, 'success': error is None, **({'error': error} if error else {})}])
        if path == '/stacks' and method == 'GET':
            return httpx.Response(200, json=list(stacks.values()))
        if method == 'GET' and path.startswith('/assets/'):
            asset = path.split('/')[-1]
            owner = next((s for s in stacks.values() if any(a['id'] == asset for a in s['assets'])), None)
            return httpx.Response(200, json={'id': asset, 'originalFileName': 'photo.jpg', 'isTrashed': False,
                                            'stack': {'id': owner['id'], 'primaryAssetId': owner['primaryAssetId']} if owner else None})
        if path == '/assets':
            assert body['force'] is False
            return httpx.Response(204)
        if method == 'DELETE':
            stacks.pop(path.split('/')[-1])
            return httpx.Response(204)
        if method == 'POST':
            sid = str(UUID(int=100 + len(stacks)))
            stacks[sid] = stack(sid, body['assetIds'][0], body['assetIds'])
            return httpx.Response(201, json=stacks[sid])
        if method == 'PUT':
            sid = path.split('/')[-1]
            stacks[sid]['primaryAssetId'] = body['primaryAssetId']
            return httpx.Response(200, json=stacks[sid])
        if method == 'GET':
            return httpx.Response(200, json=stacks[path.split('/')[-1]])
        raise AssertionError((method, path))

    results = asyncio.run(apply_stacks('http://immich.example/api', 'key', StackApplyRequest(operations=operations),
                                     transport=httpx.MockTransport(handler))).results
    return results, calls, albums, stacks


@pytest.mark.parametrize('memberships', [{}, {A: {X}}, {A: {X, Y}}, {A: {X}, B: {Y}}])
def test_create_unions_all_members_and_cleans_only_after_stack(memberships):
    results, calls, albums, _ = run([op()], memberships)
    union = set().union(*memberships.values()) if memberships else set()
    assert results[0].status == 'success'
    assert albums.get(A, set()) == union and albums.get(B, set()) == set()
    writes = [(m, p) for m, p, _ in calls if m != 'GET']
    assert writes == [('PUT', f'/albums/{a}/assets') for a in sorted(union)] + [('POST', '/stacks')] + [('DELETE', f'/albums/{a}/assets') for a in sorted(union)]


def test_cover_change_includes_external_noncover_membership():
    results, _, albums, _ = run([op('update', primaryAssetId=B)], {A: {X}, B: {Y}}, [stack(member_ids=[A, B])])
    assert results[0].status == 'success' and albums[B] == {X, Y} and albums[A] == set()


def test_dissolve_expands_albums_after_delete():
    results, calls, albums, _ = run([op('delete')], {A: {X, Y}}, [stack(member_ids=[A, B])])
    assert results[0].status == 'success' and albums[A] == albums[B] == {X, Y}
    assert next(i for i, c in enumerate(calls) if c[0] == 'DELETE') < next(i for i, c in enumerate(calls) if c[0] == 'PUT')


@pytest.mark.parametrize('members', [[A, B, C], [A, C]])
def test_member_addition_and_purge_preserve_departures(members):
    results, _, albums, _ = run([op('update', memberIds=members)], {A: {X}, C: {Y}}, [stack(member_ids=[A, B])])
    assert results[0].status == 'success' and albums[A] == {X, Y}
    assert albums.get(C, set()) == set()
    assert albums.get(B, set()) == ({X} if B not in members else set())


def test_stack_move_uses_original_source_and_destination_albums():
    operations = [op('update', memberIds=[A, C]), op('update', name='two', stackId=SECOND_STACK_ID, memberIds=[B, D], primaryAssetId=B)]
    results, _, albums, _ = run(operations, {A: {X}, C: {Y}}, [stack(member_ids=[A, B]), stack(SECOND_STACK_ID, C, [C, D])])
    assert all(r.status == 'success' for r in results)
    assert albums[A] == albums[B] == {X, Y}
    assert albums[C] == albums[D] == set()


@pytest.mark.parametrize('phase,status', [('lookup', 'failed'), ('add', 'failed'), ('stack', 'failed'), ('unknown', 'unknown'), ('cleanup', 'success')])
def test_failures_never_rollback_or_cleanup_uncertain_stack(phase, status):
    def failure(method, path, body):
        if phase == 'lookup' and path == '/albums': return httpx.Response(403)
        if phase == 'add' and path.startswith('/albums/') and method == 'PUT': return httpx.Response(403)
        if phase == 'stack' and path == '/stacks' and method == 'POST': return httpx.Response(500)
        if phase == 'unknown' and path == '/stacks' and method == 'POST': raise httpx.ReadTimeout('timeout')
        if phase == 'cleanup' and path.startswith('/albums/') and method == 'DELETE': return httpx.Response(403)
    results, calls, albums, _ = run([op()], {B: {X}}, failure=failure)
    assert results[0].status == status
    if phase in ('lookup', 'add'):
        assert not any(p == '/stacks' and m != 'GET' for m, p, _ in calls)
    if phase != 'cleanup':
        assert not any(m == 'DELETE' for m, _, _ in calls)
    if phase in ('stack', 'unknown', 'cleanup'):
        assert albums[A] == albums[B] == {X}


@pytest.mark.parametrize('trash_status', [204, 403])
def test_original_cover_trash_retains_membership_and_keeps_stack_result(trash_status):
    operation = op('update', memberIds=[B, C], primaryAssetId=B, trashAssetIds=[A], expectedMemberIds=[A, B, C], expectedPrimaryAssetId=A)
    def failure(method, path, body):
        if path == '/assets': return httpx.Response(trash_status)
    results, calls, albums, _ = run([operation], {A: {X}, B: {Y}}, [stack(member_ids=[A, B, C])], failure)
    assert results[0].status == 'success'
    assert results[0].trashStatus == ('success' if trash_status == 204 else 'failed')
    assert albums[B] == {X, Y} and albums[A] == {X}
    assert not any(m == 'DELETE' and p.startswith('/albums/') and b['ids'] == [A] for m, p, b in calls)
    assert ('DELETE', '/assets', {'ids': [A], 'force': False}) in calls
    assert calls.index(('PUT', f'/albums/{X}/assets', {'ids': [B]})) < calls.index(('DELETE', f'/stacks/{STACK_ID}', None))


@pytest.mark.parametrize('status,body,expected', [
    (200, [{'id': B, 'success': True}], 'removed'),
    (200, [{'id': B, 'success': False, 'error': 'not_found'}], 'not_found'),
    (404, [], None), (403, [], None),
    (200, [{'id': B, 'success': False, 'error': 'no_permission'}], None),
    (200, [{'id': A, 'success': True}], None), (200, {}, None),
    (200, [{'id': B, 'success': 1}], None),
])
def test_remove_helper_validates_item_absence_not_http_404(status, body, expected):
    async def execute():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(status, json=body))) as client:
            return await remove_asset_from_album(client, 'http://immich.example/api', {}, UUID(X), UUID(B))
    if expected:
        assert asyncio.run(execute()) == expected
    else:
        with pytest.raises(ImmichAlbumError): asyncio.run(execute())


def test_dnd_manual_create_uses_the_same_album_path():
    results, _, albums, _ = run([op(name='draft:manual:1')], {A: {X}, B: {Y}})
    assert results[0].status == 'success' and albums[A] == {X, Y} and albums[B] == set()


def test_dissolve_expansion_failure_preserves_stack_success():
    def failure(method, path, body):
        if method == 'PUT' and body['ids'] == [B]: return httpx.Response(403)
    results, _, albums, stacks = run([op('delete')], {A: {X}}, [stack(member_ids=[A, B])], failure)
    assert results[0].status == 'success' and not stacks
    assert albums[A] == {X} and albums.get(B, set()) == set()


def test_related_failure_keeps_original_membership_as_recovery_anchor():
    operations = [op('update', memberIds=[A, C]), op('update', name='two', stackId=SECOND_STACK_ID, memberIds=[B, D], primaryAssetId=B)]
    def failure(method, path, body):
        if method == 'POST' and body['assetIds'][0] == B: return httpx.Response(500)
    results, calls, albums, _ = run(operations, {A: {X}, C: {Y}}, [stack(member_ids=[A, B]), stack(SECOND_STACK_ID, C, [C, D])], failure)
    assert [r.status for r in results] == ['success', 'failed']
    assert albums[C] == {Y}
    assert not any(m == 'DELETE' and p.startswith('/albums/') for m, p, _ in calls)


def test_next_operation_reloads_membership_after_cleanup_failure():
    def failure(method, path, body):
        if method == 'DELETE' and path.startswith('/albums/'): return httpx.Response(403)
    first, _, albums, stacks = run([op()], {A: {X}, B: {Y}}, failure=failure)
    assert first[0].status == 'success' and albums[B] == {Y}
    # A later COVER edit reads the server again, including a manually added Album on the child.
    albums[B].add(str(UUID(int=503)))
    second, _, albums, _ = run([op('update', stackId=str(first[0].stackId), primaryAssetId=B)], albums, list(stacks.values()))
    assert second[0].status == 'success' and albums[A] == set()
    assert albums[B] == {X, Y, str(UUID(int=503))}


@pytest.mark.parametrize('kind', ['create', 'update', 'delete'])
def test_no_album_operations_never_write_albums(kind):
    results, calls, _, _ = run([op(kind)], existing=[] if kind == 'create' else [stack(member_ids=[A, B])])
    assert results[0].status == 'success'
    assert not any(m != 'GET' and p.startswith('/albums/') for m, p, _ in calls)
