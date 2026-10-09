import asyncio
import json
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError
from stack_write import StackApplyRequest, apply_stacks
from test_stack_write import A, B, C, D, NEW, op, written, STACK_ID, SECOND_STACK_ID
from test_stack_assets import stack


def run_trash(*, singleton=False, raw=False, changed=False, stack_failure=False, create_failure=False, trash_failure=False, timeout=False, still_stacked=False, extra=False):
    calls = []
    current = [stack(member_ids=[A, B] if singleton else [A, B, C])]
    if changed:
        current[0]['primaryAssetId'] = B
    if extra:
        current.append(stack(SECOND_STACK_ID, D, [D, str(UUID(int=99))]))
    operations = [op('update', memberIds=[A] if singleton else [A, C], trashAssetIds=[B],
                     expectedMemberIds=[A, B] if singleton else [A, B, C], expectedPrimaryAssetId=A)]
    if extra:
        operations.append(op('update', name='two', stackId=SECOND_STACK_ID, memberIds=[D, str(UUID(int=99))], primaryAssetId=str(UUID(int=99))))
    def handler(request):
        nonlocal current
        path = request.url.path
        if request.method == 'GET':
            if path == '/api/stacks':
                return httpx.Response(200, json=current)
            return httpx.Response(200, json={'id': B, 'originalFileName': 'photo.dng' if raw else 'photo.jpg', 'isTrashed': False,
                                            'stack': {'id': STACK_ID} if any(s['id'] == STACK_ID for s in current) else None})
        body = json.loads(request.content) if request.content else None
        calls.append((request.method, path, body))
        if path == '/api/assets':
            if timeout:
                raise httpx.ReadTimeout('unknown')
            return httpx.Response(500 if trash_failure else 204)
        if request.method == 'DELETE':
            if stack_failure:
                return httpx.Response(500)
            if not still_stacked:
                current = [s for s in current if s['id'] != STACK_ID]
            return httpx.Response(204)
        if request.method == 'PUT':
            next(s for s in current if s['id'] == SECOND_STACK_ID)['primaryAssetId'] = str(UUID(int=99))
            return written(ids=[D, str(UUID(int=99))], primary=str(UUID(int=99)), stack_id=SECOND_STACK_ID, code=200)
        if create_failure:
            return httpx.Response(500)
        current.append(stack(NEW, A, [A, C]))
        return written(ids=[A, C])
    results = asyncio.run(apply_stacks('http://immich.example/api', 'key', StackApplyRequest(operations=operations), transport=httpx.MockTransport(handler))).results
    return results, calls


@pytest.mark.parametrize('singleton', [False, True])
def test_release_replace_then_soft_trash(singleton):
    results, calls = run_trash(singleton=singleton)
    assert results[0].status == 'success' and results[0].trashStatus == 'success'
    assert [c[0] for c in calls] == (['DELETE', 'DELETE'] if singleton else ['DELETE', 'POST', 'DELETE'])
    assert calls[-1] == ('DELETE', '/api/assets', {'ids': [B], 'force': False})


@pytest.mark.parametrize('kwargs', [{'raw': True}, {'changed': True}, {'stack_failure': True}, {'create_failure': True}, {'still_stacked': True}])
def test_unsafe_or_failed_update_never_trashes(kwargs):
    results, calls = run_trash(**kwargs)
    assert results[0].trashStatus != 'success'
    assert all(c[1] != '/api/assets' for c in calls)


@pytest.mark.parametrize('timeout', [False, True])
def test_trash_failure_preserves_successful_update(timeout):
    results, calls = run_trash(trash_failure=True, timeout=timeout)
    assert results[0].status == 'success' and str(results[0].stackId) == NEW
    assert results[0].trashStatus == ('unknown' if timeout else 'failed')
    assert len(calls) == 3


def test_other_stack_updates_finish_before_trash():
    results, calls = run_trash(extra=True)
    assert all(r.status == 'success' for r in results)
    assert [c[0] for c in calls] == ['DELETE', 'POST', 'PUT', 'DELETE']


@pytest.mark.parametrize('changes', [{'trashAssetIds': [A]}, {'trashAssetIds': [B, B]}, {'expectedPrimaryAssetId': B}])
def test_reject_primary_and_invalid_reservation(changes):
    values = op('update', memberIds=[A, C], trashAssetIds=[B], expectedMemberIds=[A, B, C], expectedPrimaryAssetId=A)
    values.update(changes)
    with pytest.raises(ValidationError):
        StackApplyRequest(operations=[values])

def test_failed_replacement_reports_release_without_trash():
    results, calls = run_trash(create_failure=True)
    assert results[0].status == 'failed' and str(results[0].releasedStackId) == STACK_ID
    assert results[0].trashStatus == 'blocked'
    assert [c[0] for c in calls] == ['DELETE', 'POST']
