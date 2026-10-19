from uuid import uuid4

import pytest

import edit_store
from export_runtime_store import (create_export_run, fail_export_item, get_export_run,
                                  recoverable_export_run, retry_export_assets)
from tests.test_export_queue import A, B, database, db
from tests.test_export_runtime import queued


def failed_registration(asset_id):
    run = create_export_run([asset_id], worker_id=uuid4())
    fail_export_item(run.run_id, asset_id, run.worker_id, 'waiting', 'registration_failed')
    return get_export_run(run.run_id)


def downgrade_to_v5(connection):
    connection.execute('DROP INDEX export_registration_retries')
    connection.execute('ALTER TABLE export_run_items DROP COLUMN export_timestamp')
    connection.execute('PRAGMA user_version=5')


def test_v5_migration_preserves_preupgrade_active_and_failed_attempt_timestamps(db):
    queued(A)
    first = failed_registration(A)
    retry_export_assets([A])
    second = create_export_run([A], worker_id=uuid4())
    with database(db) as connection:
        downgrade_to_v5(connection)
        before = {table: connection.execute(f'SELECT * FROM {table}').fetchall()
                  for table in ('asset_edit_states', 'export_queue', 'export_runs', 'export_run_items', 'development_exclusions')}
    restored = recoverable_export_run()
    assert restored.run_id == second.run_id
    assert restored.items[0].export_timestamp == second.created_at > first.created_at
    assert get_export_run(first.run_id).items[0].export_timestamp == first.created_at
    with database(db) as connection:
        assert connection.execute('PRAGMA user_version').fetchone()[0] == 6
        assert not connection.execute('PRAGMA foreign_key_check').fetchall()
        for table, rows in before.items():
            after = connection.execute(f'SELECT * FROM {table}').fetchall()
            assert ([row[:-1] for row in after] if table == 'export_run_items' else after) == rows
    assert recoverable_export_run() == restored


def test_v6_migration_failure_rolls_back_column_backfill_index_and_version(db, monkeypatch):
    queued(A)
    first = failed_registration(A)
    with database(db) as connection:
        downgrade_to_v5(connection)
        before = connection.execute('SELECT * FROM export_run_items').fetchall()
    migrate = edit_store.MIGRATIONS[5]
    def fail_after_backfill(connection):
        migrate(connection)
        raise RuntimeError('injected migration failure')
    monkeypatch.setitem(edit_store.MIGRATIONS, 5, fail_after_backfill)
    with pytest.raises(RuntimeError, match='injected migration failure'):
        get_export_run(first.run_id)
    with database(db) as connection:
        assert connection.execute('PRAGMA user_version').fetchone()[0] == 5
        assert connection.execute('SELECT * FROM export_run_items').fetchall() == before
        assert 'export_timestamp' not in [row[1] for row in connection.execute('PRAGMA table_info(export_run_items)')]
        assert not connection.execute("SELECT 1 FROM sqlite_master WHERE name='export_registration_retries'").fetchall()


def test_retry_group_retains_each_items_own_registration_timestamp(db):
    queued(A, B)
    first, second = failed_registration(A), failed_registration(B)
    retry_export_assets([A, B])
    group = create_export_run([A, B])
    assert group.created_at > second.created_at > first.created_at
    assert [item.export_timestamp for item in group.items] == [first.created_at, second.created_at]
    assert get_export_run(group.run_id) == group
