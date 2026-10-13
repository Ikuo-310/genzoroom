import json
from unittest.mock import patch
from uuid import UUID
import pytest
from backend_logging import BackendLogger
from development_exclusions import configuration
from immich import _parse_stack_snapshot

S, T, A, B, C = [str(UUID(int=value)) for value in (100, 101, 1, 2, 3)]

def stack(stack_id=S, primary=A, members=(A, B)):
    return {'id': stack_id, 'primaryAssetId': primary, 'assets': [{'id': member} for member in members]}

@pytest.fixture
def logger(monkeypatch):
    logger = BackendLogger()
    logger.set_level('debug')
    monkeypatch.setattr('immich.backend_logger', logger)
    return logger

def events(logger, event):
    return [entry['context'] for entry in logger.get_entries() if entry['event'] == event]

def summary(logger):
    return events(logger, 'stack.snapshot.parsed')[-1]

def details(logger):
    return events(logger, 'stack.snapshot.invalid')

def test_normal_and_empty_snapshots_have_only_correct_summary(logger):
    result = _parse_stack_snapshot([stack()], require_primary=True)
    assert result.complete and len(result.stacks) == 1
    assert summary(logger).items() >= {'stackCount': 1, 'validStackCount': 1, 'invalidEntryCount': 0,
                                      'complete': True, 'reasonCounts': {}, 'requirePrimary': True}.items()
    assert details(logger) == []
    _parse_stack_snapshot([], require_primary=True)
    assert summary(logger)['stackCount'] == 0
    assert summary(logger)['complete']

@pytest.mark.parametrize('value,reason', [
    ({'primaryAssetId': A, 'assets': [{'id': A}]}, 'invalid_stack_id'),
    ({'id': 'PRIVATE_BAD_ID', 'primaryAssetId': A, 'assets': [{'id': A}]}, 'invalid_stack_id'),
    ({'id': S, 'assets': [{'id': A}]}, 'invalid_primary_id'),
    ({'id': S, 'primaryAssetId': 'PRIVATE_BAD_COVER', 'assets': [{'id': A}]}, 'invalid_primary_id'),
    ({'id': S, 'primaryAssetId': A}, 'invalid_member_array'),
    ({'id': S, 'primaryAssetId': A, 'assets': 'PRIVATE_ARRAY'}, 'invalid_member_array'),
    (stack(members=()), 'empty_member_array'),
    (stack(members=(A, 'PRIVATE_MEMBER')), 'invalid_member_id'),
    ({'id': S, 'primaryAssetId': A, 'assets': [{'id': A}, None]}, 'invalid_member_id'),
    (stack(members=(A, A.upper())), 'duplicate_member_id'),
    (stack(primary=C), 'primary_not_member'),
    (None, 'invalid_stack_id'),
])
def test_invalid_reasons_match_existing_branches_and_never_log_unvalidated_data(logger, value, reason):
    snapshot = _parse_stack_snapshot([value], require_primary=True)
    assert not snapshot.complete and not snapshot.stacks
    assert summary(logger)['reasonCounts'][reason] == 1
    detail = details(logger)[0]
    assert reason in detail['reasons'] and detail['entryIndex'] == 0
    assert detail['snapshotId'] == summary(logger)['snapshotId']
    assert 'PRIVATE' not in json.dumps(logger.create_report())


def test_duplicate_stack_ids_include_both_positions_and_related_uuid(logger):
    snapshot = _parse_stack_snapshot([stack(), stack(primary=C, members=(C,))], require_primary=True)
    assert snapshot.invalid_stack_ids == {UUID(S)}
    assert summary(logger)['reasonCounts']['duplicate_stack_id'] == 2
    assert [d['entryIndex'] for d in details(logger)] == [0, 1]
    assert details(logger)[0]['relatedStackIds'] == [S]
    assert details(logger)[0]['relatedEntryIndices'] == [1]
    assert details(logger)[1]['relatedEntryIndices'] == [0]


def test_member_ownership_conflicts_include_other_stack_and_cover_uuid(logger):
    snapshot = _parse_stack_snapshot([stack(), stack(T, B, (B, C))], require_primary=True)
    assert not snapshot.complete and snapshot.quarantined_member_ids == {UUID(A), UUID(B), UUID(C)}
    first, second = details(logger)
    assert first['stackId'] == S and first['primaryAssetId'] == A and first['memberIds'] == [A, B]
    assert first['relatedStackIds'] == [T] and second['relatedStackIds'] == [S]
    assert summary(logger)['reasonCounts']['member_ownership_conflict'] == 2


def test_invalid_entry_possible_cover_ownership_is_also_diagnosed(logger):
    invalid = {'id': T, 'primaryAssetId': A}
    snapshot = _parse_stack_snapshot([stack(), invalid], require_primary=True)
    assert not snapshot.stacks
    assert 'member_ownership_conflict' in details(logger)[0]['reasons']
    assert details(logger)[0]['relatedStackIds'] == [T]

@pytest.mark.parametrize('level', ['off', 'error', 'warn', 'info'])
def test_no_snapshot_diagnostic_output_below_debug(logger, level):
    logger.set_level(level)
    snapshot = _parse_stack_snapshot([{}], require_primary=True)
    assert not snapshot.complete
    assert logger.get_entries() == []

@pytest.mark.parametrize('method', ['get_level', 'add'])
def test_logger_failure_does_not_change_snapshot_or_exclusion_configuration(logger, method):
    body = [stack(), {}]
    with patch.object(logger, method, side_effect=RuntimeError('PRIVATE_FAILURE')):
        snapshot = _parse_stack_snapshot(body, require_primary=True)
    assert snapshot.stacks == [body[0]] and not snapshot.complete
    assert configuration(snapshot, 'asset', UUID(C))[0] == 'unknown'
    assert configuration(snapshot, 'stack', UUID(S))[0] == 'confirmed'


def test_primary_presence_rule_remains_context_dependent(logger):
    body = [stack(primary=C)]
    home = _parse_stack_snapshot(body, require_primary=False)
    assert home.complete and home.stacks == body
    assert summary(logger)['reasonCounts'] == {}
    strict = _parse_stack_snapshot(body, require_primary=True)
    assert not strict.complete and not strict.stacks
    assert summary(logger)['reasonCounts'] == {'primary_not_member': 1}


def test_details_are_bounded_without_losing_reason_aggregates(logger):
    _parse_stack_snapshot([{}] * 120, require_primary=True)
    assert len(details(logger)) == 100
    assert summary(logger)['invalidEntryCount'] == 120
    assert summary(logger)['detailsOmittedCount'] == 20
    assert summary(logger)['reasonCounts']['invalid_stack_id'] == 120


def test_long_uuid_lists_are_bounded_with_explicit_omission_counts(logger):
    members = tuple(str(UUID(int=i)) for i in range(1, 50))
    _parse_stack_snapshot([stack(primary=str(UUID(int=999)), members=members)], require_primary=True)
    detail = details(logger)[0]
    assert detail['memberCount'] == 49 and len(detail['memberIds']) == 16
    assert detail['memberIdsOmittedCount'] == 33
    assert all(str(UUID(value)) == value for value in detail['memberIds'])
