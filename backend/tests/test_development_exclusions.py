import asyncio
import copy
import sqlite3
from unittest.mock import patch, AsyncMock
from uuid import uuid4
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
        assert request('PUT', p).status_code == 200
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
    with configure([family]): assert request('PUT', p).status_code == 200
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
        assert request('PUT', p).status_code >= 400
        assert request('GET', p).json()['items'][0]['excluded']

def test_validation_batch_unknown_and_unavailable(db, family):
    with configure([family]):
        assert request('PUT', path('asset', family['primaryAssetId'])).status_code == 409
        assert request('PUT', path('stack', uuid4())).status_code == 404
        assert request('PUT', path('stack', family['id'])).status_code == 200
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
    with configure([family]): request('PUT', path('stack', family['id']))
    ex.observe([], started)
    ex.observe([{}], ex._now())
    with edit_store._connection() as conn:
        assert conn.execute('SELECT count(*) FROM development_exclusions').fetchone()[0] == 1
    ex.observe([], ex._now())
    with edit_store._connection() as conn:
        assert conn.execute('SELECT count(*) FROM development_exclusions').fetchone()[0] == 0

def test_actual_stack_fetch_hook_and_failures(db, family):
    from immich import _get_asset_stacks
    with configure([family]): request('PUT', path('stack', family['id']))
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


def test_v4_migration_adds_only_exclusion_table(db):
    with edit_store._connection() as conn:
        conn.execute('DROP TABLE development_exclusions')
        conn.execute('PRAGMA user_version=4')
        before = {t: conn.execute(f'SELECT * FROM {t}').fetchall() for t in ('asset_edit_states', 'export_queue', 'export_runs', 'export_run_items')}
    with edit_store._connection() as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 5
        assert conn.execute('SELECT count(*) FROM development_exclusions').fetchone()[0] == 0
        for t, rows in before.items(): assert conn.execute(f'SELECT * FROM {t}').fetchall() == rows

def test_unknown_without_saved_row_is_not_confirmed_single(db):
    with patch.object(ex, 'snapshot_for', side_effect=ImmichRequestError('unreachable', 'failed')):
        item = request('GET', path('asset', uuid4())).json()['items'][0]
        assert not item['excluded'] and item['configuration'] == 'unknown'


def test_corrupt_snapshot_is_retained_and_logged_without_breaking_gallery(db, family):
    with configure([family]): request('PUT', path('stack', family['id']))
    with edit_store._connection() as conn:
        conn.execute("UPDATE development_exclusions SET member_ids_json='{}'")
    ex.observe([], ex._now())
    with edit_store._connection() as conn:
        assert conn.execute('SELECT count(*) FROM development_exclusions').fetchone()[0] == 1
