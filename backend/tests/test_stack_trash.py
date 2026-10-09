import asyncio
import json
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError
from stack_write import StackApplyRequest, apply_stacks
from test_stack_write import A, B, C, D, NEW, op, written, STACK_ID, SECOND_STACK_ID
from test_stack_assets import stack


def run_trash(*, singleton=False, raw=False, changed=False, stack_failure=False, create_failure=False, trash_failure=False, timeout=False, still_stacked=False, extra=False, corruption=None, detail_status=None, unrelated_invalid=False):
    calls = []
    stack_reads = 0
    asset_reads = 0
    current = [stack(member_ids=[A, B] if singleton else [A, B, C])]
    if unrelated_invalid:
        current.append(stack(SECOND_STACK_ID, str(UUID(int=99)), [D]))
    if changed:
        current[0]['primaryAssetId'] = B
    if extra:
        current.append(stack(SECOND_STACK_ID, D, [D, str(UUID(int=99))]))
    operations = [op('update', memberIds=[A] if singleton else [A, C], trashAssetIds=[B],
                     expectedMemberIds=[A, B] if singleton else [A, B, C], expectedPrimaryAssetId=A)]
    if extra:
        operations.append(op('update', name='two', stackId=SECOND_STACK_ID, memberIds=[D, str(UUID(int=99))], primaryAssetId=str(UUID(int=99))))
    def handler(request):
        nonlocal current, stack_reads, asset_reads
        path = request.url.path
        if request.method == 'GET':
            if path == '/api/stacks':
                stack_reads += 1
                if stack_reads > 1 and corruption == 'snapshot_http': return httpx.Response(503)
                visible = current
                if stack_reads > 1:
                    if corruption == 'invalid_snapshot': visible = [{**current[0], 'primaryAssetId': B}]
                    if corruption == 'quarantined_snapshot': visible = [*current, stack(SECOND_STACK_ID, A, [A, D])]
                    if corruption == 'unknown_members': visible = [*current, {'id': SECOND_STACK_ID, 'primaryAssetId': D}]
                    if corruption == 'unknown_member_id': visible = [*current, stack(SECOND_STACK_ID, D, [D, 'bad'])]
                    if corruption == 'unknown_entry': visible = [*current, None]
                    if corruption == 'unknown_primary': visible = [*current, stack(SECOND_STACK_ID, 'bad', [D])]
                    if corruption == 'duplicate_target_stack': visible = [*current, stack(NEW, D, [D, str(UUID(int=99))])]
                    if corruption == 'invalid_old_stack': visible = [*current, stack(STACK_ID, str(UUID(int=99)), [D])]
                    if corruption == 'replacement_missing': visible = [s for s in current if s['id'] != NEW]
                    if corruption == 'replacement_members': visible = [{**s, 'assets': [{'id': A}, {'id': D}]} if s['id'] == NEW else s for s in current]
                    if corruption == 'replacement_primary': visible = [{**s, 'primaryAssetId': C} if s['id'] == NEW else s for s in current]
                    if corruption == 'trash_member_owned': visible = [*current, stack(SECOND_STACK_ID, B, [B, D])]
                    if corruption == 'singleton_owned' and singleton: visible = [*current, stack(SECOND_STACK_ID, A, [A, D])]
                return httpx.Response(200, json=visible)
            asset_reads += 1
            if detail_status is not None and asset_reads >= 3: return httpx.Response(detail_status, json={'error':'PRIVATE RESPONSE BODY'})
            force_stack = corruption == 'detail_stack' and asset_reads >= 3
            return httpx.Response(200, json={'id': B, 'originalFileName': 'photo.dng' if raw else 'photo.jpg', 'isTrashed': False,
                                            'stack': {'id': NEW} if force_stack else {'id': STACK_ID} if any(s['id'] == STACK_ID for s in current) else None})
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


@pytest.mark.parametrize(('corruption','step','reason'), [
    ('invalid_snapshot','stack_list_parse','related_invalid_or_quarantined_stack_state'),
    ('quarantined_snapshot','stack_list_parse','related_invalid_or_quarantined_stack_state'),
    ('unknown_members','stack_list_parse','unproven_stack_ownership'),
    ('unknown_member_id','stack_list_parse','unproven_stack_ownership'),
    ('unknown_entry','stack_list_parse','unproven_stack_ownership'),
    ('unknown_primary','stack_list_parse','unproven_stack_ownership'),
    ('duplicate_target_stack','stack_list_parse','related_invalid_or_quarantined_stack_state'),
    ('invalid_old_stack','stack_list_parse','related_invalid_or_quarantined_stack_state'),
    ('trash_member_owned','trash_asset_stack_membership','trash_asset_still_in_stack'),
    ('detail_stack','trash_asset_detail_stack','asset_detail_still_stacked'),
    ('replacement_missing','replacement_stack_exists','replacement_stack_missing'),
    ('replacement_members','replacement_stack_members','replacement_members_mismatch'),
    ('replacement_primary','replacement_stack_primary','replacement_primary_mismatch'),
    ('singleton_owned','singleton_released','singleton_still_in_stack'),
])
def test_verification_failures_emit_step_and_reason(corruption, step, reason, monkeypatch):
    from backend_logging import backend_logger
    import stack_write
    entries = []
    monkeypatch.setattr(stack_write.backend_logger, 'add', lambda **entry: entries.append(entry))
    backend_logger.set_level('debug')
    try:
        results, calls = run_trash(singleton=corruption == 'singleton_owned', corruption=corruption)
        assert results[0].trashStatus == 'blocked'
        failed = [entry for entry in entries if entry.get('event') == 'trash.verify.failed']
        assert failed and failed[-1]['context']['verificationStep'] == step, failed
        assert failed[-1]['context']['reason'] == reason
        assert failed[-1]['context']['batchId']
        assert failed[-1]['context']['operationId'] == 'one'
        assert all(call[1] != '/api/assets' for call in calls)
    finally:
        backend_logger.set_level('off')


def test_snapshot_fetch_http_error_logs_status_code_without_response_body(monkeypatch):
    from backend_logging import backend_logger
    import stack_write
    entries = []
    monkeypatch.setattr(stack_write.backend_logger, 'add', lambda **entry: entries.append(entry))
    backend_logger.set_level('debug')
    try:
        results, _ = run_trash(corruption='snapshot_http')
        failed = next(entry for entry in entries if entry.get('event') == 'trash.verify.failed')
        assert results[0].errorCode == 'trash_verification_failed'
        assert failed['context']['verificationStep'] == 'stack_list_fetch'
        assert failed['context']['httpStatus'] == 503
        assert failed['context']['errorCode'] == 'unexpected_response'
        assert failed['context']['exceptionType'] == 'ImmichRequestError'
        assert 'PRIVATE RESPONSE BODY' not in repr(entries)
    finally:
        backend_logger.set_level('off')


def test_success_logs_snapshot_counts_and_each_passed_condition(monkeypatch):
    from backend_logging import backend_logger
    import stack_write
    entries = []
    monkeypatch.setattr(stack_write.backend_logger, 'add', lambda **entry: entries.append(entry))
    backend_logger.set_level('debug')
    try:
        results, _ = run_trash()
        assert results[0].status == 'success' and results[0].trashStatus == 'success'
        checks = [entry['context'] for entry in entries if entry.get('event') == 'trash.verify']
        by_step = {entry['verificationStep']: entry for entry in checks}
        assert by_step['stack_list_parse']['passed'] is True
        assert by_step['stack_list_parse']['invalidStackCount'] == 0
        assert by_step['stack_list_parse']['quarantinedMemberCount'] == 0
        assert by_step['trash_asset_stack_membership']['passed'] is True
        assert by_step['replacement_stack_exists']['passed'] is True
        assert by_step['replacement_stack_members']['passed'] is True
        assert by_step['replacement_stack_primary']['passed'] is True
        assert by_step['trash_asset_detail_stack']['stackFieldState'] == 'null'
        assert all(entry['batchId'] and entry['operationId'] == 'one' for entry in checks)
    finally:
        backend_logger.set_level('off')


def test_asset_detail_http_error_logs_status_code_and_exception_type(monkeypatch):
    from backend_logging import backend_logger
    import stack_write
    entries = []
    monkeypatch.setattr(stack_write.backend_logger, 'add', lambda **entry: entries.append(entry))
    backend_logger.set_level('debug')
    try:
        results, _ = run_trash(detail_status=503)
        failed = next(entry for entry in entries if entry.get('event') == 'trash.verify.failed')
        assert results[0].errorCode == 'trash_verification_failed'
        assert failed['context']['verificationStep'] == 'trash_asset_detail_fetch'
        assert failed['context']['httpStatus'] == 503
        assert failed['context']['errorCode'] == 'unexpected_response'
        assert failed['context']['exceptionType'] == 'ImmichRequestError'
        assert 'PRIVATE RESPONSE BODY' not in repr(entries)
    finally:
        backend_logger.set_level('off')


@pytest.mark.parametrize('singleton', [False, True])
def test_unrelated_invalid_stack_does_not_block_trash(singleton, monkeypatch):
    from backend_logging import backend_logger
    import stack_write
    entries = []
    monkeypatch.setattr(stack_write.backend_logger, 'add', lambda **entry: entries.append(entry))
    backend_logger.set_level('debug')
    try:
        results, calls = run_trash(singleton=singleton, unrelated_invalid=True)
        assert results[0].status == 'success' and results[0].trashStatus == 'success'
        assert calls[-1] == ('DELETE', '/api/assets', {'ids': [B], 'force': False})
        check = next(entry['context'] for entry in entries if entry.get('event') == 'trash.verify' and entry['context']['verificationStep'] == 'stack_list_parse')
        assert check['passed'] is True
        assert check['invalidStackCount'] == 1 and check['quarantinedMemberCount'] == 2
        assert check['relatedInvalidStackCount'] == 0
        assert check['relatedQuarantinedMemberCount'] == 0
        assert check['unprovenOwnershipEntryCount'] == 0
    finally:
        backend_logger.set_level('off')
