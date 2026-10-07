import asyncio
import copy
import sqlite3
from concurrent.futures import ThreadPoolExecutor
import threading
from uuid import UUID, uuid4

import pytest

import edit_store
from edit_store import StoreUnavailable, list_export_queue
from export_runtime import ExportRuntime
from export_runtime_store import (
    RuntimeRejected, begin_export_item, complete_export_item, create_export_run,
    fail_export_item, get_export_run, reclaim_export_run, recoverable_export_run,
    request_export_stop, retry_export_assets, transition_export_item,
)
from tests.test_export_queue import A, B, C, database, db, request, save, snapshot
from tests.test_export_runtime import queued, owned_run, advance, Source, Family, Registrar, make_v2


def interrupted(status, *ids):
    queued(*ids)
    run, owner = owned_run(*ids)
    begin_export_item(run.run_id, owner)
    if status in ('encoding', 'registering'):
        advance(run, owner, ids[0], 'encoding')
    if status == 'registering':
        advance(run, owner, ids[0], 'registering')
    return get_export_run(run.run_id), owner


def fail_all(*ids):
    run, owner = interrupted('waiting', *ids)
    for asset_id in ids:
        begin_export_item(run.run_id, owner)
        fail_export_item(run.run_id, asset_id, owner, 'waiting', 'source_fetch_failed')
    return get_export_run(run.run_id)


def make_v3(path):
    make_v2(path)
    run_id, owner = uuid4(), uuid4()
    with database(path) as connection:
        edit_store._create_v3(connection)
        connection.execute('PRAGMA user_version=3')
        connection.execute("UPDATE export_queue SET status='encoding'")
        connection.execute("INSERT INTO export_runs VALUES (?, 'active', ?, ?, ?)",
                           (str(run_id), str(owner), '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z'))
        connection.execute("""INSERT INTO export_run_items VALUES (?,0,?,42,7,18,?,?,'encoding',NULL,NULL,?)""",
                           (str(run_id), str(A), snapshot()['processingVersion'], edit_store._json(snapshot()['currentRecipe']),
                            '2026-10-07T00:00:00.000Z'))
    return run_id, owner


@pytest.mark.parametrize('status', ['waiting', 'encoding', 'registering'])
def test_v3_migration_preserves_every_row_and_marks_existing_current(db, status):
    run_id, owner = make_v3(db)
    with database(db) as connection:
        connection.execute('UPDATE export_queue SET status=?', (status,))
        connection.execute('UPDATE export_run_items SET status=?', (status,))
        before = {table: connection.execute(f'SELECT * FROM {table}').fetchall()
                  for table in ('asset_edit_states', 'export_queue', 'export_runs', 'export_run_items')}
    run = recoverable_export_run()
    assert run.run_id == run_id and run.worker_id == owner
    assert not run.stop_requested and run.current_position == (None if status == 'waiting' else 0)
    with database(db) as connection:
        assert connection.execute('PRAGMA user_version').fetchone()[0] == 4
        for table, rows in before.items():
            after = connection.execute(f'SELECT * FROM {table}').fetchall()
            assert ([row[:5] for row in after] if table == 'export_runs' else after) == rows
        assert not connection.execute('PRAGMA foreign_key_check').fetchall()
    assert recoverable_export_run() == run


def test_v4_migration_failure_rolls_back_all_rebuilds(db, monkeypatch):
    make_v3(db)
    with database(db) as connection:
        before = connection.execute('SELECT * FROM export_runs').fetchall()
    original = edit_store.MIGRATIONS[3]
    def broken(connection):
        original(connection)
        raise sqlite3.OperationalError('migration failure')
    monkeypatch.setitem(edit_store.MIGRATIONS, 3, broken)
    with pytest.raises(StoreUnavailable):
        recoverable_export_run()
    with database(db) as connection:
        assert connection.execute('PRAGMA user_version').fetchone()[0] == 3
        assert connection.execute('SELECT * FROM export_runs').fetchall() == before
        assert not connection.execute("SELECT name FROM sqlite_master WHERE name LIKE '%_v4'").fetchall()


@pytest.mark.parametrize('status', ['waiting', 'encoding', 'registering'])
@pytest.mark.parametrize('failure', [False, True])
def test_stop_keeps_current_until_terminal_and_releases_only_remaining(db, status, failure):
    run, owner = interrupted(status, A, B)
    first = request_export_stop(run.run_id)
    assert first.status == 'active' and first.stop_requested
    assert request_export_stop(run.run_id) == first
    assert [item['status'] for item in list_export_queue()] == [status, 'waiting']
    queued(C)
    if failure:
        fail_export_item(run.run_id, A, owner, status, 'worker_failed')
    else:
        if status == 'waiting':
            advance(run, owner, A, 'encoding')
        if status != 'registering':
            advance(run, owner, A, 'registering')
        complete_export_item(run.run_id, A, owner, uuid4())
    final = get_export_run(run.run_id)
    assert final.status == 'stopped' and final.current_position is None
    assert [item.status for item in final.items] == ['failed' if failure else 'succeeded', 'released']
    assert {item['assetId']: item['status'] for item in list_export_queue()} == {
        **({str(A): 'failed'} if failure else {}), str(B): 'queued', str(C): 'queued'}
    assert request_export_stop(run.run_id) == final
    assert begin_export_item(run.run_id, owner) is None
    assert create_export_run([B, C]).items[0].asset_id == B


def test_stop_before_first_acquisition_releases_all(db):
    queued(A, B)
    run, owner = owned_run(A, B)
    final = request_export_stop(run.run_id)
    assert final.status == 'stopped' and all(item.status == 'released' for item in final.items)
    assert begin_export_item(run.run_id, owner) is None


def test_stop_and_begin_race_never_releases_a_started_item(db):
    queued(A, B)
    run, owner = owned_run(A, B)
    barrier = threading.Barrier(2)
    def stop():
        barrier.wait()
        return request_export_stop(run.run_id)
    def begin():
        barrier.wait()
        return begin_export_item(run.run_id, owner)
    with ThreadPoolExecutor(2) as pool:
        stop_result, begin_result = pool.submit(stop), pool.submit(begin)
        stop_result.result()
        current = begin_result.result()
    final = get_export_run(run.run_id)
    if current is None:
        assert final.status == 'stopped'
    else:
        assert current.asset_id == A and final.current_position == 0
        assert final.items[0].status == 'waiting'
        fail_export_item(run.run_id, A, owner, 'waiting', 'worker_failed')
        assert get_export_run(run.run_id).status == 'stopped'


def test_stop_and_completion_race_releases_waiting_atomically(db):
    run, owner = interrupted('registering', A, B)
    barrier = threading.Barrier(2)
    def stop():
        barrier.wait(); return request_export_stop(run.run_id)
    def complete():
        barrier.wait(); return complete_export_item(run.run_id, A, owner, uuid4())
    with ThreadPoolExecutor(2) as pool:
        results = [pool.submit(stop), pool.submit(complete)]
        for result in results:
            result.result()
    assert get_export_run(run.run_id).status == 'stopped'
    assert list_export_queue()[0]['status'] == 'queued'


def test_retry_batch_keeps_old_history_and_next_run_freezes_current_revision(db):
    old = fail_all(A, B)
    changed = copy.deepcopy(snapshot())
    changed['currentRecipe']['adjustments']['temperature'] = 23
    edit_store.put_edit_state(A, 1, uuid4(), changed)
    result = retry_export_assets([A, B])
    assert [item['status'] for item in result] == ['queued', 'queued']
    assert get_export_run(old.run_id) == old
    new = create_export_run([A, B])
    assert new.items[0].frozen_revision == 2
    assert new.items[0].recipe['adjustments']['temperature'] == 23
    assert old.items[0].recipe['adjustments']['temperature'] == 12


@pytest.mark.parametrize('bad', ['mixed', 'duplicate', 'limit', 'empty', 'queued', 'missing', 'default', 'corrupt'])
def test_retry_rejects_without_partial_commit(db, bad):
    old = fail_all(A, B)
    targets = [A, B]
    if bad == 'mixed':
        queued(C); targets = [A, C]
    elif bad == 'duplicate': targets = [A, A]
    elif bad == 'limit': targets = [UUID(int=i + 1) for i in range(101)]
    elif bad == 'empty': targets = []
    elif bad == 'queued':
        retry_export_assets([B])
    elif bad == 'missing':
        targets = [A, C]
    elif bad in ('default', 'corrupt'):
        # Simulate an externally inconsistent saved row; normal default saves clean mutable Queue.
        with database(db) as connection:
            connection.execute('UPDATE asset_edit_states SET current_recipe_json=? WHERE asset_id=?',
                               (edit_store._json(snapshot(B, edited=False)['currentRecipe']) if bad == 'default' else '{}', str(B)))
    before = list_export_queue()
    with pytest.raises((RuntimeRejected, StoreUnavailable)):
        retry_export_assets(targets)
    assert list_export_queue() == before and get_export_run(old.run_id) == old


@pytest.mark.parametrize('status', ['waiting', 'encoding', 'registering'])
def test_retry_rejects_runtime_locked_items(db, status):
    run, _ = interrupted(status, A)
    with pytest.raises(RuntimeRejected, match='queue_item_not_failed'):
        retry_export_assets([A])
    assert get_export_run(run.run_id) == run


@pytest.mark.parametrize('status', ['waiting', 'encoding', 'registering'])
@pytest.mark.parametrize('stop', [False, True])
@pytest.mark.parametrize('failure', [False, True])
def test_recovery_regenerates_reclaims_and_honors_persisted_stop(db, status, stop, failure):
    run, old_owner = interrupted(status, A, B)
    if stop:
        request_export_stop(run.run_id)
    async def scenario():
        source, family, registrar = Source(broken=A if failure else None), Family(), Registrar()
        runtime = ExportRuntime(source=source, family=family, registrar=registrar)
        assert await runtime.recover() == run.run_id
        await runtime.wait()
        assert source.started == ([A] if stop else [A, B])
        assert all(original.closed == 1 for original in source.originals)
        assert len(registrar.calls) == (0 if failure and stop else 1 if failure or stop else 2)
    asyncio.run(scenario())
    final = get_export_run(run.run_id)
    assert final.worker_id != old_owner
    assert final.items[0].recipe == run.items[0].recipe
    assert final.status == ('stopped' if stop else 'failed' if failure else 'completed')
    with pytest.raises(RuntimeRejected):
        fail_export_item(run.run_id, A, old_owner, 'waiting', 'worker_failed')


def test_waiting_without_current_recovery_resumes_first(db):
    queued(A, B)
    old = create_export_run([A, B])
    async def scenario():
        runtime = ExportRuntime(source=Source(), family=Family(), registrar=Registrar())
        assert await runtime.recover() == old.run_id
        await runtime.wait()
    asyncio.run(scenario())
    assert get_export_run(old.run_id).status == 'completed'


def test_duplicate_recovery_and_normal_start_share_process_guard(db):
    run, _ = interrupted('encoding', A)
    queued(B)
    async def scenario():
        gate = asyncio.Event()
        first = ExportRuntime(source=Source(gate=gate), family=Family(), registrar=Registrar())
        second = ExportRuntime(source=Source(), family=Family(), registrar=Registrar())
        assert await first.recover() == run.run_id
        for action in (second.recover(), second.start([B])):
            with pytest.raises(RuntimeRejected, match='run_active'):
                await action
        gate.set(); await first.wait(); await second.wait()
    asyncio.run(scenario())


def test_reclaim_compare_and_swap_refuses_stale_observation(db):
    run, owner = interrupted('registering', A)
    claimed = reclaim_export_run(run.run_id, owner, uuid4())
    assert claimed.items[0].status == 'waiting' and claimed.current_position == 0
    with pytest.raises(RuntimeRejected, match='run_owned'):
        reclaim_export_run(run.run_id, owner, uuid4())


def test_shutdown_keeps_stop_current_and_recovery_finishes_it(db):
    queued(A, B)
    async def scenario():
        gate = asyncio.Event()
        runtime = ExportRuntime(source=Source(gate=gate), family=Family(), registrar=Registrar())
        run_id = await runtime.start([A, B])
        await runtime.stop(run_id)
        runtime._task.cancel()
        with pytest.raises(asyncio.CancelledError): await runtime.wait()
        interrupted_run = get_export_run(run_id)
        assert interrupted_run.current_position == 0 and interrupted_run.stop_requested
        resumed = ExportRuntime(source=Source(), family=Family(), registrar=Registrar())
        assert await resumed.recover() == run_id
        await resumed.wait()
        assert get_export_run(run_id).status == 'stopped'
    asyncio.run(scenario())


@pytest.mark.parametrize('corruption', ["current_position=99", "current_position=NULL, stop_requested=1", "status='completed'", "stop_requested=2"])
def test_runtime_corruption_is_unavailable(db, corruption):
    run, _ = interrupted('encoding', A)
    with database(db) as connection:
        connection.execute('PRAGMA ignore_check_constraints=ON')
        connection.execute(f'UPDATE export_runs SET {corruption}')
    with pytest.raises(StoreUnavailable): get_export_run(run.run_id)


@pytest.mark.parametrize('operation', ['stop', 'retry', 'reclaim'])
def test_zero_row_write_rolls_back_entire_operation(db, operation):
    if operation == 'retry':
        run = fail_all(A, B)
    else:
        run, _ = interrupted('encoding', A, B)
    before = list_export_queue()
    with database(db) as connection:
        table = 'export_runs' if operation != 'retry' else 'export_queue'
        connection.execute(f"CREATE TRIGGER ignore_update BEFORE UPDATE ON {table} BEGIN SELECT RAISE(IGNORE); END")
    with pytest.raises(StoreUnavailable):
        if operation == 'stop': request_export_stop(run.run_id)
        elif operation == 'retry': retry_export_assets([A, B])
        else: reclaim_export_run(run.run_id, run.worker_id, uuid4())
    assert list_export_queue() == before and get_export_run(run.run_id) == run


def test_api_fixed_errors_runtime_state_retry_and_stop(db):
    old = fail_all(A)
    response = request('POST', '/export/queue/retry', {'assetIds': [str(A)]})
    assert response.status_code == 200 and response.json()['items'][0]['status'] == 'queued'
    assert request('POST', '/export/queue/retry', {'assetIds': [str(A)]}).status_code == 409
    for body in ({'assetIds': [str(A), str(A)]}, {'assetIds': ['private Recipe body']}, {'assetIds': [str(A)] * 101}):
        response = request('POST', '/export/queue/retry', body)
        assert response.status_code == 422 and 'private' not in response.text
    run = create_export_run([A], worker_id=uuid4())
    state = request('GET', '/export/runtime').json()
    assert set(state) == {'runId', 'status', 'stopRequested', 'stopAllowed', 'currentAssetId'}
    assert state['runId'] == str(run.run_id) and state['stopAllowed']
    stopped = request('POST', f'/export/runs/{run.run_id}/stop')
    assert stopped.status_code == 200 and stopped.json()['status'] == 'stopped'
    assert request('POST', f'/export/runs/{run.run_id}/stop').json() == stopped.json()
    assert request('POST', f'/export/runs/{old.run_id}/stop').status_code == 409
    assert request('GET', '/export/runtime').json()['runId'] is None


def test_recovery_unconfigured_does_not_claim_or_mutate(db):
    run, _ = interrupted('registering', A)
    assert asyncio.run(ExportRuntime().recover()) is None
    assert get_export_run(run.run_id) == run


def test_registration_attempt_interrupted_is_replayed_with_same_frozen_context(db):
    queued(A)
    async def scenario():
        gate = asyncio.Event()
        first_registrar = Registrar(gate=gate)
        runtime = ExportRuntime(source=Source(), family=Family(), registrar=first_registrar)
        run_id = await runtime.start([A])
        for _ in range(200):
            if first_registrar.calls:
                break
            await asyncio.sleep(0.005)
        assert len(first_registrar.calls) == 1
        original = get_export_run(run_id)
        assert original.items[0].status == 'registering'
        runtime._task.cancel()
        with pytest.raises(asyncio.CancelledError): await runtime.wait()
        replay = Registrar()
        resumed = ExportRuntime(source=Source(), family=Family(), registrar=replay)
        await resumed.recover(); await resumed.wait()
        assert len(replay.calls) == 1
        assert replay.calls[0] == first_registrar.calls[0]
        assert get_export_run(run_id).status == 'completed'
    asyncio.run(scenario())


def test_stop_retry_logs_are_safe_and_logger_failure_cannot_fail_commit(db, monkeypatch):
    import export_runtime_store
    run, owner = interrupted('encoding', A, B)
    entries = []
    monkeypatch.setattr(export_runtime_store.backend_logger, 'add', lambda **entry: entries.append(entry))
    request_export_stop(run.run_id)
    advance(run, owner, A, 'registering')
    complete_export_item(run.run_id, A, owner, uuid4())
    stopped = [entry for entry in entries if entry['event'].startswith('run.stop')]
    assert {entry['event'] for entry in stopped} == {'run.stopRequested', 'run.stopCompleted'}
    assert all(entry['level'] == 'info' for entry in stopped)
    assert all(not ({'recipe', 'history', 'body', 'jpeg', 'credentials'} & entry['context'].keys()) for entry in entries)
    def broken(**entry): raise RuntimeError('private credential body')
    monkeypatch.setattr(export_runtime_store.backend_logger, 'add', broken)
    failed = fail_all(C)
    assert retry_export_assets([C])[-1]['status'] == 'queued'
    assert get_export_run(failed.run_id).status == 'failed'
