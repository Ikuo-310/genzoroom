import asyncio
import copy
import sqlite3
from unittest.mock import patch, AsyncMock
from uuid import UUID, uuid4
import httpx
import pytest
import edit_store
import development_exclusions as ex
from immich import _parse_stack_snapshot, ImmichRequestError
from main import app

@pytest.fixture
def db(tmp_path, monkeypatch):
    path = tmp_path / 'genzoroom.db'
    monkeypatch.setattr(edit_store, 'DB_PATH', path)
    return path

@pytest.fixture
def family():
    s, a, b = map(str, [uuid4(), uuid4(), uuid4()])
    return {'id': s, 'primaryAssetId': a, 'assets': [{'id': a}, {'id': b}]}

def request(method, path, body=None):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            return await client.request(method, path, json=body)
    return asyncio.run(run())

def configure(body):
    async def snapshot(*args):
        result = _parse_stack_snapshot(body, require_primary=True)
        ex.reconcile(result, ex._now())
        return result
    return patch.object(ex, 'snapshot_for', side_effect=snapshot)

def path(kind, target):
    return f'/development-exclusions/{kind}/{target}'

def expected(family):
    return {'expectedPrimaryAssetId': family['primaryAssetId'], 'expectedMemberIds': [member['id'] for member in family['assets']]}

@pytest.mark.parametrize('change', ['cover', 'add', 'remove'])
def test_registration_rejects_configuration_not_checked_for_queue(db, family, change):
    changed = copy.deepcopy(family)
    if change == 'cover': changed['primaryAssetId'] = changed['assets'][1]['id']
    elif change == 'add': changed['assets'].append({'id': str(uuid4())})
    else: changed['assets'].pop()
    with configure([changed]):
        response = request('PUT', path('stack', family['id']), expected(family))
        assert response.status_code == 409
        assert response.json()['detail']['code'] == 'exclusion_target_configuration_changed'
        assert not request('GET', path('stack', family['id'])).json()['items'][0]['excluded']

def test_registration_requires_valid_expected_stack_configuration(db, family):
    with configure([family]):
        target = path('stack', family['id'])
        assert request('PUT', target).status_code == 422
        payload = expected(family)
        assert request('PUT', target, {**payload, 'expectedMemberIds': payload['expectedMemberIds'] * 2}).status_code == 422
        assert request('PUT', target, {**payload, 'expectedPrimaryAssetId': str(uuid4())}).status_code == 422
        payload['expectedMemberIds'].reverse()
        assert request('PUT', target, payload).status_code == 200

def test_single_persistence_remove_no_other_state(db):
    p = path('asset', uuid4())
    with configure([]), patch.object(ex, 'get_asset_detail', new=AsyncMock()):
        assert request('PUT', p).status_code == 200
        assert request('GET', p).json()['items'][0]['excluded']
        # Separate connections verify persistence beyond a request's connection lifetime.
        with sqlite3.connect(db) as conn:
            assert conn.execute('SELECT count(*) FROM development_exclusions').fetchone()[0] == 1
            for table in ('asset_edit_states', 'export_queue', 'export_runs', 'export_run_items'):
                assert conn.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 0
        assert request('DELETE', p).status_code == 204
        assert not request('GET', p).json()['items'][0]['excluded']
        assert request('DELETE', p).status_code == 204

@pytest.mark.parametrize('change', ['cover', 'add', 'remove', 'dissolve', 'order'])
def test_stack_changes(db, family, change):
    p = path('stack', family['id'])
    with configure([family]):
        assert request('PUT', p, expected(family)).status_code == 200
        assert request('GET', p).json()['items'][0]['excluded']
    changed = copy.deepcopy(family)
    if change == 'cover': changed['primaryAssetId'] = changed['assets'][1]['id']
    elif change == 'add': changed['assets'].append({'id': str(uuid4())})
    elif change == 'remove': changed['assets'].pop()
    elif change == 'order': changed['assets'].reverse()
    with configure([] if change == 'dissolve' else [changed]):
        assert request('GET', p).json()['items'][0]['excluded'] == (change == 'order')

@pytest.mark.parametrize('case', ['failure', 'missing_cover', 'duplicate', 'unidentified', 'overlap'])
def test_uncertainty_retains_state(db, family, case):
    p = path('stack', family['id'])
    with configure([family]): assert request('PUT', p, expected(family)).status_code == 200
    changed = copy.deepcopy(family)
    if case == 'missing_cover':
        changed.pop('primaryAssetId'); body = [changed]
    elif case == 'duplicate': body = [changed, changed]
    elif case == 'unidentified': body = [{}]
    else: body = [changed, {**changed, 'id': str(uuid4())}]
    context = patch.object(ex, 'snapshot_for', side_effect=ImmichRequestError('unreachable', 'failed')) if case == 'failure' else configure(body)
    with context:
        item = request('GET', p).json()['items'][0]
        assert item['excluded'] and item['configuration'] == 'unknown'
        assert request('PUT', p, expected(family)).status_code >= 400
        assert request('GET', p).json()['items'][0]['excluded']

def test_validation_batch_unknown_and_unavailable(db, family):
    with configure([family]):
        assert request('PUT', path('asset', family['primaryAssetId'])).status_code == 409
        assert request('PUT', path('stack', uuid4()), expected(family)).status_code == 404
        assert request('PUT', path('stack', family['id']), expected(family)).status_code == 200
        targets = [{'kind': 'stack', 'id': family['id']}, {'kind': 'asset', 'id': family['primaryAssetId']}]
        assert [i['excluded'] for i in request('POST', '/development-exclusions/status', {'targets': targets}).json()['items']] == [True, False]
        assert request('POST', '/development-exclusions/status', {'targets': targets * 2}).status_code == 422
        assert request('DELETE', path('stack', family['id'])).status_code == 204
    assert request('GET', path('stack', 'invalid')).status_code == 422
    assert request('GET', path('other', uuid4())).status_code == 422
    assert request('POST', '/development-exclusions/status', {'targets': []}).json() == {'items': []}
    assert request('POST', '/development-exclusions/status', {'targets': [{'kind': 'asset', 'id': str(uuid4())}] * 101}).status_code == 422
    with configure([]), patch.object(ex, 'get_asset_detail', side_effect=ImmichRequestError('unexpected_response', 'missing', status_code=404)):
        assert request('PUT', path('asset', uuid4())).status_code >= 400
    with patch.object(edit_store, 'DB_PATH', db / 'missing' / 'db'):
        assert request('POST', '/development-exclusions/status', {'targets': []}).status_code == 503

def test_gallery_observation_and_stale_response(db, family):
    started = ex._now()
    with configure([family]): request('PUT', path('stack', family['id']), expected(family))
    ex.observe([], started)
    ex.observe([{}], ex._now())
    with edit_store._connection() as conn:
        assert conn.execute('SELECT count(*) FROM development_exclusions').fetchone()[0] == 1
    ex.observe([], ex._now())
    with edit_store._connection() as conn:
        assert conn.execute('SELECT count(*) FROM development_exclusions').fetchone()[0] == 0

def test_actual_stack_fetch_hook_and_failures(db, family):
    from immich import _get_asset_stacks
    with configure([family]): request('PUT', path('stack', family['id']), expected(family))
    def fetch(body, status=200):
        transport = httpx.MockTransport(lambda req: httpx.Response(status, json=body))
        return asyncio.run(_get_asset_stacks('http://immich/api', 'test-key', transport=transport))
    fetch([{}])
    with pytest.raises(ImmichRequestError): fetch([], 500)
    with edit_store._connection() as conn:
        assert conn.execute('SELECT count(*) FROM development_exclusions').fetchone()[0] == 1
    fetch([])
    with edit_store._connection() as conn:
        assert conn.execute('SELECT count(*) FROM development_exclusions').fetchone()[0] == 0


def test_single_is_invalidated_when_it_joins_confirmed_stack(db, family):
    asset_id = family['assets'][0]['id']
    p = path('asset', asset_id)
    with configure([]), patch.object(ex, 'get_asset_detail', new=AsyncMock()):
        assert request('PUT', p).status_code == 200
    with configure([family]):
        item = request('GET', p).json()['items'][0]
        assert not item['excluded'] and item['configuration'] == 'stacked'


def test_single_survives_unrelated_stack_and_incomplete_snapshot(db, family):
    asset_id = str(uuid4())
    p = path('asset', asset_id)
    with configure([]), patch.object(ex, 'get_asset_detail', new=AsyncMock()):
        assert request('PUT', p).status_code == 200
    with configure([family]):
        assert request('GET', p).json()['items'][0]['excluded']
    with configure([{}]):
        item = request('GET', p).json()['items'][0]
        assert item['excluded'] and item['configuration'] == 'unknown'


def test_single_invalidates_with_unrelated_invalid_stack_information(db, family):
    asset_id = family['assets'][0]['id']
    p = path('asset', asset_id)
    with configure([]), patch.object(ex, 'get_asset_detail', new=AsyncMock()):
        assert request('PUT', p).status_code == 200
    with configure([family, {}]):
        item = request('GET', p).json()['items'][0]
        assert not item['excluded'] and item['configuration'] == 'stacked'


def test_single_survives_conflicting_stack_ownership(db, family):
    asset_id = family['assets'][0]['id']
    p = path('asset', asset_id)
    second_stack = {**copy.deepcopy(family), 'id': str(uuid4())}
    with configure([]), patch.object(ex, 'get_asset_detail', new=AsyncMock()):
        assert request('PUT', p).status_code == 200
    with configure([family, second_stack]):
        item = request('GET', p).json()['items'][0]
        assert item['excluded'] and item['configuration'] == 'unknown'


def test_old_stack_observation_does_not_remove_new_single_exclusion(db, family):
    asset_id = family['assets'][0]['id']
    stale_started_at = ex._now()
    with configure([]), patch.object(ex, 'get_asset_detail', new=AsyncMock()):
        assert request('PUT', path('asset', asset_id)).status_code == 200
    ex.reconcile(_parse_stack_snapshot([family], require_primary=True), stale_started_at)
    assert request('GET', path('asset', asset_id)).json()['items'][0]['excluded']


def test_v4_migration_preserves_export_rows(db):
    with edit_store._connection() as conn:
        conn.execute('DROP TABLE asset_raw_recipes')
        conn.execute('DROP TABLE raw_recipe_saves')
        conn.execute('DROP TABLE development_exclusions')
        conn.execute('DROP INDEX export_registration_retries')
        conn.execute('ALTER TABLE export_run_items DROP COLUMN export_timestamp')
        conn.execute('PRAGMA user_version=4')
        before = {t: conn.execute(f'SELECT * FROM {t}').fetchall() for t in ('asset_edit_states', 'export_queue', 'export_runs', 'export_run_items')}
    with edit_store._connection() as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == edit_store.SCHEMA_VERSION
        assert conn.execute('SELECT count(*) FROM development_exclusions').fetchone()[0] == 0
        for t, rows in before.items(): assert conn.execute(f'SELECT * FROM {t}').fetchall() == rows

def test_unknown_without_saved_row_is_not_confirmed_single(db):
    with patch.object(ex, 'snapshot_for', side_effect=ImmichRequestError('unreachable', 'failed')):
        item = request('GET', path('asset', uuid4())).json()['items'][0]
        assert not item['excluded'] and item['configuration'] == 'unknown'


def test_corrupt_snapshot_is_retained_and_logged_without_breaking_gallery(db, family):
    with configure([family]): request('PUT', path('stack', family['id']), expected(family))
    with edit_store._connection() as conn:
        conn.execute("UPDATE development_exclusions SET member_ids_json='{}'")
    ex.observe([], ex._now())
    with edit_store._connection() as conn:
        assert conn.execute('SELECT count(*) FROM development_exclusions').fetchone()[0] == 1


def test_missing_primary_member_does_not_block_unrelated_single_asset(db, family):
    incomplete = {**copy.deepcopy(family), 'primaryAssetId': str(uuid4())}
    unrelated = uuid4()
    snapshot = _parse_stack_snapshot([incomplete], require_primary=True)
    assert not snapshot.complete and not snapshot.stacks
    assert ex.configuration(snapshot, 'asset', unrelated)[0] == 'single'
    with configure([incomplete]), patch.object(ex, 'get_asset_detail', new=AsyncMock()) as detail:
        response = request('PUT', path('asset', unrelated))
        assert response.status_code == 200
        item = request('GET', path('asset', unrelated)).json()['items'][0]
        assert item['excluded'] and item['configuration'] == 'single'
        detail.assert_awaited_once()


@pytest.mark.parametrize('related', ['cover', 'member'])
def test_incomplete_stack_related_assets_remain_unknown(db, family, related):
    incomplete = {**copy.deepcopy(family), 'primaryAssetId': str(uuid4())}
    target_id = incomplete['primaryAssetId'] if related == 'cover' else incomplete['assets'][0]['id']
    with configure([incomplete]), patch.object(ex, 'get_asset_detail', new=AsyncMock()) as detail:
        item = request('GET', path('asset', target_id)).json()['items'][0]
        assert item['configuration'] == 'unknown'
        assert request('PUT', path('asset', target_id)).status_code == 409
        detail.assert_not_awaited()


def test_valid_stack_operations_survive_unrelated_incomplete_stack(db, family):
    incomplete = {'id': str(uuid4()), 'primaryAssetId': str(uuid4()), 'assets': [{'id': str(uuid4())}]}
    snapshot = _parse_stack_snapshot([family, incomplete], require_primary=True)
    assert ex.configuration(snapshot, 'asset', UUID(family['primaryAssetId']))[0] == 'stacked'
    with configure([family, incomplete]):
        p = path('stack', family['id'])
        assert request('PUT', p, expected(family)).status_code == 200
        assert request('GET', p).json()['items'][0]['excluded']
        assert request('DELETE', p).status_code == 204
        assert not request('GET', p).json()['items'][0]['excluded']


@pytest.mark.parametrize('damage', ['stack_id', 'cover_id', 'members_missing', 'members_wrong_type', 'members_empty', 'member_id', 'duplicate_member'])
def test_unidentifiable_membership_keeps_unrelated_assets_unknown(db, family, damage):
    damaged = copy.deepcopy(family)
    if damage == 'stack_id': damaged.pop('id')
    elif damage == 'cover_id': damaged.pop('primaryAssetId')
    elif damage == 'members_missing': damaged.pop('assets')
    elif damage == 'members_wrong_type': damaged['assets'] = {}
    elif damage == 'members_empty': damaged['assets'] = []
    elif damage == 'member_id': damaged['assets'].append({'id': 'invalid'})
    else: damaged['assets'].append(damaged['assets'][0])
    with configure([damaged]), patch.object(ex, 'get_asset_detail', new=AsyncMock()) as detail:
        unrelated = uuid4()
        assert request('GET', path('asset', unrelated)).json()['items'][0]['configuration'] == 'unknown'
        assert request('GET', path('stack', unrelated)).json()['items'][0]['configuration'] == 'unknown'
        assert request('PUT', path('asset', unrelated)).status_code == 409
        detail.assert_not_awaited()


@pytest.mark.parametrize('conflict', ['duplicate_stack', 'shared_member'])
def test_ambiguous_membership_is_quarantined_per_asset(db, family, conflict):
    other = copy.deepcopy(family)
    if conflict == 'shared_member': other['id'] = str(uuid4())
    snapshot = _parse_stack_snapshot([family, other], require_primary=True)
    assert not snapshot.complete and not snapshot.stacks
    for member in family['assets']:
        assert ex.configuration(snapshot, 'asset', UUID(member['id']))[0] == 'unknown'
    assert ex.configuration(snapshot, 'asset', uuid4())[0] == 'single'
    assert ex.configuration(snapshot, 'stack', UUID(family['id']))[0] == 'unknown'


def test_partial_stack_observation_never_invalidates_existing_exclusions(db, family):
    singleton = uuid4()
    with configure([]), patch.object(ex, 'get_asset_detail', new=AsyncMock()):
        assert request('PUT', path('asset', singleton)).status_code == 200
    with configure([family]):
        assert request('PUT', path('stack', family['id']), expected(family)).status_code == 200
    incomplete = copy.deepcopy(family)
    incomplete['assets'] = [{'id': str(singleton)}]
    with configure([incomplete]):
        stack_item = request('GET', path('stack', family['id'])).json()['items'][0]
        single_item = request('GET', path('asset', singleton)).json()['items'][0]
        assert stack_item['excluded'] and stack_item['configuration'] == 'unknown'
        assert single_item['excluded'] and single_item['configuration'] == 'unknown'
    with edit_store._connection() as connection:
        assert connection.execute('SELECT count(*) FROM development_exclusions').fetchone()[0] == 2


def test_unrelated_stack_absence_is_proven_by_identifiable_partial_snapshot(db, family):
    with configure([family]):
        assert request('PUT', path('stack', family['id']), expected(family)).status_code == 200
    partial = {'id': str(uuid4()), 'primaryAssetId': str(uuid4()), 'assets': [{'id': str(uuid4())}]}
    with configure([partial]):
        item = request('GET', path('stack', family['id'])).json()['items'][0]
        assert not item['excluded'] and item['configuration'] == 'absent'
        assert request('GET', path('stack', partial['id'])).json()['items'][0]['configuration'] == 'unknown'


def test_complete_snapshot_keeps_single_and_stacked_classification(family):
    snapshot = _parse_stack_snapshot([family], require_primary=True)
    assert snapshot.complete and snapshot.membership_identifiable
    assert ex.configuration(snapshot, 'asset', uuid4())[0] == 'single'
    assert ex.configuration(snapshot, 'asset', UUID(family['primaryAssetId']))[0] == 'stacked'
    assert ex.configuration(snapshot, 'stack', UUID(family['id']))[0] == 'confirmed'
    assert ex.configuration(snapshot, 'stack', uuid4())[0] == 'absent'


def test_missing_primary_member_snapshot_bounds_uncertainty_to_known_uuids(family):
    partial = {**copy.deepcopy(family), 'primaryAssetId': str(uuid4())}
    snapshot = _parse_stack_snapshot([partial], require_primary=True)
    assert not snapshot.complete and snapshot.membership_identifiable
    assert snapshot.invalid_stack_ids == {UUID(partial['id'])}
    assert snapshot.quarantined_member_ids == {UUID(partial['primaryAssetId']), *(UUID(member['id']) for member in partial['assets'])}


def test_716_stack_reproduction_allows_unrelated_single_without_relaxing_partial_stacks(db):
    valid = [{'id': str(UUID(int=10000+i)), 'primaryAssetId': str(UUID(int=20000+2*i)),
              'assets': [{'id': str(UUID(int=20000+2*i))}, {'id': str(UUID(int=20001+2*i))}]} for i in range(711)]
    partial = [{'id': str(UUID(int=30000+i)), 'primaryAssetId': str(UUID(int=40000+i)),
                'assets': [{'id': str(UUID(int=50000+i))}]} for i in range(5)]
    body = valid + partial
    snapshot = _parse_stack_snapshot(body, require_primary=True)
    assert len(snapshot.stacks) == 711 and len(snapshot.invalid_stack_ids) == 5
    assert not snapshot.complete and snapshot.membership_identifiable
    unrelated = UUID(int=90000)
    with configure(body), patch.object(ex, 'get_asset_detail', new=AsyncMock()):
        assert request('PUT', path('asset', unrelated)).status_code == 200
        item = request('GET', path('asset', unrelated)).json()['items'][0]
        assert item['excluded'] and item['configuration'] == 'single'
        for stack in partial:
            assert request('GET', path('stack', stack['id'])).json()['items'][0]['configuration'] == 'unknown'
    with edit_store._connection() as connection:
        for table in ('asset_edit_states', 'export_queue', 'export_runs', 'export_run_items'):
            assert connection.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 0
