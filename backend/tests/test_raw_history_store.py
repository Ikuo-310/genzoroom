import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from threading import Barrier
from uuid import uuid4

import pytest

import edit_store
import raw_recipe_store as raw
import storage
from tests.test_export_queue import A, db, snapshot
from tests.test_raw_recipe_store import identity, old_database, rows, save, settings


TABLES = ("asset_raw_recipes", "raw_recipe_saves", "asset_raw_histories",
          "asset_raw_history_steps", "raw_history_saves")


def value(exposure=0):
    return settings(light={"exposure": exposure}, extra={"preserved": [1, {"x": True}]})


def append(exposure, revision=0, *, key=None, save_id=None, step_id=None, baseline=None, **kwargs):
    return raw.append_raw_history(key or identity(), revision, save_id or uuid4(), value(exposure),
        kind="control", metadata={"control": "light.exposure"}, step_id=step_id,
        baseline_settings=baseline, **kwargs)


def history(key=None):
    return raw.get_raw_history(key or identity())


def move(target, revision, exposure):
    return raw.move_raw_history_cursor(identity(), revision, uuid4(), value(exposure), target_step_id=target)


def dump(db):
    return {table: rows(db, table) for table in TABLES}


@pytest.mark.parametrize("version", range(1, 8))
def test_migration_preserves_all_existing_rows_and_columns(db, version):
    before = old_database(db, version)
    if version == 7:
        with closing(sqlite3.connect(db)) as connection:
            encoded = edit_store._json(value())
            raw._write_recipe(connection, identity(), None, 0, str(uuid4()), encoded,
                              raw._request_hash(identity(), encoded, 0))
            connection.commit()
        for table in ("asset_raw_recipes", "raw_recipe_saves"):
            with closing(sqlite3.connect(db)) as connection:
                before[table] = ([row[1] for row in connection.execute(f"PRAGMA table_info({table})")], rows(db, table))
    storage.validate_existing_database(db)
    edit_store.initialize_database()
    storage.validate_existing_database(db)
    with closing(sqlite3.connect(db)) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 8
        for table, (columns, previous) in before.items():
            assert connection.execute(f"SELECT {','.join(columns)} FROM {table}").fetchall() == previous
        assert not connection.execute("PRAGMA foreign_key_check").fetchall()
    assert all(not rows(db, table) for table in TABLES[2:])


@pytest.mark.parametrize("version", [1, 6, 7])
def test_failed_v8_migration_rolls_back_schema_and_data(db, monkeypatch, version):
    before = old_database(db, version)
    migrate = edit_store.MIGRATIONS[7]
    def fail(connection):
        migrate(connection)
        raise sqlite3.OperationalError("injected migration failure")
    monkeypatch.setitem(edit_store.MIGRATIONS, 7, fail)
    with pytest.raises(storage.StorageInitializationError):
        edit_store.initialize_database()
    with closing(sqlite3.connect(db)) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == version
        assert set(before) == {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table, (_, previous) in before.items():
            assert rows(db, table) == previous


def test_read_absent_and_legacy_recipe_is_lazy(db):
    edit_store.initialize_database()
    before = dump(db)
    absent = raw.get_raw_history(identity(), initial_settings=value())
    assert absent == {"recipe": None, "revision": 0, "initialized": False,
                      "history": {"baselineSettings": value(), "cursor": 0, "steps": []}}
    assert history()["history"] is None
    assert dump(db) == before
    legacy = save(value=value())
    before = dump(db)
    loaded = history()
    assert loaded["recipe"] == legacy["recipe"]
    assert loaded["history"] == {"baselineSettings": value(), "cursor": 0, "steps": []}
    assert not loaded["initialized"] and dump(db) == before
    assert save(value=value(1), revision=1)["revision"] == 2


def test_delete_raw_edits_removes_recipe_history_for_one_asset_and_preserves_jpeg(db):
    from uuid import uuid4
    from tests.test_export_queue import snapshot
    from tests.test_raw_recipe_store import A

    other_asset = uuid4()
    other = identity(assetId=str(other_asset))
    jpeg = edit_store.put_edit_state(A, 0, uuid4(), snapshot())
    edit_store.enqueue_export_assets([A])
    save(identity())
    append(1, revision=1, baseline=settings())
    save(other)
    raw.initialize_raw_history(other, 1, uuid4(), settings())

    before_jpeg = {table: rows(db, table) for table in ("asset_edit_states", "export_queue")}
    result = raw.delete_raw_edits(str(A))
    assert result["recipes"] == 1 and result["histories"] == 1
    assert raw.get_raw_recipe(identity()) == {"recipe": None}
    assert raw.get_raw_history(identity())["history"] is None
    assert raw.get_raw_recipe(other)["recipe"] is not None
    assert raw.get_raw_history(other)["initialized"] is True
    assert {table: rows(db, table) for table in before_jpeg} == before_jpeg
    assert edit_store.get_edit_state(A) == jpeg


def test_delete_raw_edits_without_history_is_idempotent(db):
    save()
    result = raw.delete_raw_edits(str(A))
    assert result["recipes"] == 1 and result["histories"] == 0
    assert raw.delete_raw_edits(str(A))["recipes"] == 0


def test_delete_raw_edits_with_initialized_empty_history(db):
    save()
    raw.initialize_raw_history(identity(), 1, uuid4(), settings())
    assert raw.get_raw_history(identity())["initialized"] is True
    assert raw.delete_raw_edits(str(A))["histories"] == 1
    assert raw.get_raw_history(identity())["history"] is None


def test_delete_raw_edits_rolls_back_on_database_failure(db):
    save()
    append(1, revision=1, baseline=settings())
    before = dump(db)
    with closing(sqlite3.connect(db)) as connection:
        connection.execute("""CREATE TRIGGER fail_raw_reset BEFORE DELETE ON asset_raw_recipes
            BEGIN SELECT RAISE(ABORT, 'injected failure'); END""")
        connection.commit()
    with pytest.raises(raw.StoreUnavailable):
        raw.delete_raw_edits(str(A))
    assert dump(db) == before


@pytest.mark.parametrize("legacy", [False, True])
def test_first_step_and_explicit_initialization(db, legacy):
    if legacy:
        save(value=value())
    first = append(1, int(legacy), baseline=value())
    loaded = history()
    assert loaded["initialized"]
    assert loaded["history"]["baselineSettings"] == value()
    assert loaded["history"]["cursor"] == 1
    assert loaded["history"]["steps"][0]["settings"] == value(1)
    assert loaded["recipe"]["settings"] == value(1)
    assert first["ack"]["historyLength"] == 1
    assert len(rows(db, "raw_recipe_saves")) == int(legacy) + 1
    second_key = identity(assetId=str(uuid4()))
    raw.initialize_raw_history(second_key, 0, uuid4(), value())
    assert history(second_key)["history"] == {"baselineSettings": value(), "cursor": 0, "steps": []}


def test_cursor_undo_redo_jump_and_branching(db):
    raw.initialize_raw_history(identity(), 0, uuid4(), value())
    one = append(1, 1)["ack"]["stepId"]
    two = append(2, 2)["ack"]["stepId"]
    three = append(3, 3)["ack"]["stepId"]
    assert move(two, 4, 2)["ack"]["historyCursor"] == 2
    assert move(three, 5, 3)["ack"]["historyCursor"] == 3
    assert move(None, 6, 0)["ack"]["historyCursor"] == 0
    assert move(one, 7, 1)["ack"]["historyCursor"] == 1
    branched = append(4, 8)
    assert branched["ack"]["historyLength"] == branched["ack"]["historyCursor"] == 2
    assert [step["stepId"] for step in history()["history"]["steps"]] == [one, branched["ack"]["stepId"]]
    before = dump(db)
    with pytest.raises(edit_store.StoreConflict, match="raw_history_target_missing"):
        move(three, 9, 3)
    assert dump(db) == before


def test_noop_keeps_redo_but_receipts_save_id_and_same_settings_different_cursor(db):
    first = append(1, baseline=value())
    append(0, 1)
    moved = move(None, 2, 0)
    assert moved["ack"]["changed"] and moved["ack"]["historyCursor"] == 0
    request_id = uuid4()
    noop = append(0, 3, save_id=request_id)
    assert not noop["ack"]["changed"] and noop["ack"]["historyLength"] == 2
    replay = append(0, 3, save_id=request_id)
    assert replay["replayed"] and replay["ack"] == noop["ack"]
    moved = move(history()["history"]["steps"][1]["stepId"], 4, 0)
    assert moved["ack"]["changed"] and moved["ack"]["historyCursor"] == 2
    assert history()["revision"] == 5
    assert first["ack"]["stepId"] == history()["history"]["steps"][0]["stepId"]


def test_200_retention_baseline_and_stable_ids_replay_after_prune(db):
    first_id = uuid4()
    first = append(1, save_id=first_id, baseline=value())
    ids = [first["ack"]["stepId"]]
    for index in range(2, 202):
        result = append(index, index - 1)
        ids.append(result["ack"]["stepId"])
    loaded = history()
    assert len(loaded["history"]["steps"]) == loaded["history"]["cursor"] == 200
    assert loaded["history"]["baselineSettings"] == value(1)
    assert [step["stepId"] for step in loaded["history"]["steps"]] == ids[1:]
    assert [row[6] for row in rows(db, "asset_raw_history_steps")] == list(range(1, 201))
    replay = append(1, save_id=first_id, baseline=value())
    assert replay["replayed"] and replay["ack"] == first["ack"]
    assert replay["ack"]["revision"] == 1 and replay["current"]["revision"] == 201
    assert move(None, 201, 1)["ack"]["historyCursor"] == 0
    assert move(ids[-1], 202, 201)["ack"]["historyCursor"] == 200
    assert history()["recipe"]["settings"] == value(201)
    with pytest.raises(edit_store.StoreConflict, match="raw_history_step_id_reused"):
        append(300, 203, step_id=ids[0])


def test_retention_policy_not_fixed_in_schema_and_branch_prune_order(db, monkeypatch):
    monkeypatch.setattr(raw, "HISTORY_LIMIT", 2)
    a = append(1, baseline=value())["ack"]["stepId"]
    b = append(2, 1)["ack"]["stepId"]
    move(a, 2, 1)
    c = append(3, 3)["ack"]["stepId"]
    assert [step["stepId"] for step in history()["history"]["steps"]] == [a, c]
    assert history()["history"]["baselineSettings"] == value()
    append(4, 4)
    assert history()["history"]["baselineSettings"] == value(1)
    assert b not in {step["stepId"] for step in history()["history"]["steps"]}


def test_recipe_checkpoint_and_save_id_domains(db):
    old_id = uuid4()
    old = save(value=value(), save_id=old_id)
    step_id = uuid4()
    first = append(1, 1, save_id=step_id)
    assert save(value=value(), save_id=old_id) == old
    checkpoint = save(value=value(1), revision=2)
    assert checkpoint["revision"] == 3 and history()["history"]["cursor"] == 1
    before = dump(db)
    with pytest.raises(edit_store.StoreConflict, match="raw_history_requires_operation"):
        save(value=value(2), revision=3)
    with pytest.raises(edit_store.StoreConflict, match="save_id_reused"):
        save(value=value(1), revision=1, save_id=step_id)
    with pytest.raises(edit_store.StoreConflict, match="save_id_reused"):
        append(0, save_id=old_id, baseline=value())
    with pytest.raises(edit_store.StoreConflict, match="save_id_reused"):
        append(2, 1, save_id=step_id)
    with pytest.raises(edit_store.StoreConflict, match="save_id_reused"):
        raw.initialize_raw_history(identity(), 1, step_id, value(1))
    assert append(1, 1, save_id=step_id)["ack"] == first["ack"]
    assert dump(db) == before


def test_move_readback_and_baseline_mismatch_are_rejected(db):
    first = append(1, baseline=value())
    before = dump(db)
    with pytest.raises(edit_store.StoreConflict, match="raw_history_readback_mismatch"):
        move(first["ack"]["stepId"], 1, 9)
    with pytest.raises(edit_store.StoreConflict, match="raw_history_baseline_mismatch"):
        append(2, 1, baseline=value(9))
    assert dump(db) == before


def test_concurrent_writers_have_one_cas_winner(db):
    raw.initialize_raw_history(identity(), 0, uuid4(), value())
    barrier = Barrier(2)
    def attempt(exposure):
        barrier.wait()
        try:
            return append(exposure, 1)
        except edit_store.StoreConflict:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        result = list(pool.map(attempt, [1, 2]))
    assert sum(item is not None for item in result) == 1
    assert history()["revision"] == 2 and len(history()["history"]["steps"]) == 1


@pytest.mark.parametrize("key_change", [
    {"assetId": str(uuid4())}, {"sourceContentHash": "b" * 16}, {"engineName": "other"},
    {"engineVersion": "0.10.1"}, {"engineCommit": "b" * 40}, {"settingsSchemaVersion": 2},
])
def test_identity_isolation(db, key_change):
    append(1, baseline=value())
    other = identity(**key_change)
    assert not history(other)["initialized"]
    schema = other["settingsSchemaVersion"]
    raw.initialize_raw_history(other, 0, uuid4(), settings(version=schema))
    assert history(other)["history"]["cursor"] == 0
    assert history()["history"]["cursor"] == 1


@pytest.mark.parametrize("kind,metadata", [
    ("bad", {}), ([], {}), ("control", {"control": "crop.angle"}), ("control", {"control": []}),
    ("sectionToggle", {"section": "color", "enabled": 1}), ("sectionReset", {"section": "unknown"}),
    ("allReset", {"text": "x" * 1025}), ("allReset", {"path": "PRIVATE"}), ("control", []),
])
def test_invalid_kind_and_metadata_are_rejected_before_open(db, kind, metadata):
    with pytest.raises(raw.InvalidRawHistory):
        raw.append_raw_history(identity(), 0, uuid4(), value(1), kind=kind, metadata=metadata, baseline_settings=value())
    assert not db.exists()


@pytest.mark.parametrize("kind,metadata", [
    ("controlReset", {"control": "wb.temp"}), ("sectionReset", {"section": "color"}),
    ("sectionToggle", {"section": "light", "enabled": False}), ("allReset", {}),
])
def test_allowlisted_operation_metadata_roundtrips(db, kind, metadata):
    raw.append_raw_history(identity(), 0, uuid4(), value(1), kind=kind, metadata=metadata, baseline_settings=value())
    assert history()["history"]["steps"][0]["metadata"] == metadata


@pytest.mark.parametrize("mutation", [
    "UPDATE asset_raw_histories SET history_cursor=999",
    "UPDATE asset_raw_histories SET baseline_settings_json='{}'",
    "UPDATE asset_raw_histories SET baseline_settings_json='{'",
    "UPDATE asset_raw_history_steps SET position=2",
    "UPDATE asset_raw_history_steps SET step_id='bad'",
    "UPDATE asset_raw_history_steps SET kind='bad'",
    "UPDATE asset_raw_history_steps SET metadata_json='{}'",
    "UPDATE asset_raw_history_steps SET metadata_json='{'",
    "UPDATE asset_raw_history_steps SET develop_settings_json='{}'",
    "UPDATE asset_raw_history_steps SET created_at='bad'",
    "UPDATE raw_history_saves SET request_hash=printf('%064d',0)",
    "UPDATE raw_history_saves SET result_hash=printf('%064d',0)",
    "UPDATE raw_history_saves SET request_json='{}'",
    "UPDATE raw_history_saves SET result_json='{}'",
    "UPDATE raw_history_saves SET recipe_revision=2",
    "UPDATE raw_history_saves SET updated_at='bad'",
    "UPDATE raw_recipe_saves SET request_hash=printf('%064d',0)",
    "DELETE FROM asset_raw_histories",
    "DELETE FROM raw_history_saves",
], ids=["cursor", "baseline", "baseline-json", "position", "step-uuid", "kind", "metadata", "metadata-json",
        "snapshot", "timestamp", "request-hash", "result-hash", "request", "result", "revision", "receipt-time",
        "recipe-receipt", "missing-parent", "missing-receipt"])
def test_corruption_is_fail_closed_and_not_repaired(db, mutation):
    append(1, baseline=value())
    with closing(sqlite3.connect(db)) as connection:
        connection.execute(mutation)
        connection.commit()
    corrupted = dump(db)
    for read in (lambda: history(), lambda: raw.get_raw_recipe(identity()), lambda: raw.lookup_raw_recipe(identity()),
                 lambda: append(2, 1), lambda: save(value=value(1), revision=1)):
        with pytest.raises(edit_store.StoreUnavailable):
            read()
        assert dump(db) == corrupted


@pytest.mark.parametrize("phase", ["raw-receipt", "recipe", "history-receipt", "parent", "step", "prune", "commit", "busy"])
def test_all_write_boundaries_rollback_together(db, monkeypatch, phase):
    monkeypatch.setattr(raw, "HISTORY_LIMIT", 1)
    append(1, baseline=value())
    before = dump(db)
    connect = sqlite3.connect
    prefixes = {"raw-receipt": "INSERT INTO raw_recipe_saves", "recipe": "UPDATE asset_raw_recipes",
                "history-receipt": "INSERT INTO raw_history_saves", "parent": "INSERT INTO asset_raw_histories",
                "step": "INSERT INTO asset_raw_history_steps", "prune": "DELETE FROM asset_raw_history_steps"}
    class FailingConnection(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            if sql == "PRAGMA busy_timeout=3000" and phase == "busy":
                sql = "PRAGMA busy_timeout=0"
            if phase in prefixes and sql.startswith(prefixes[phase]):
                raise sqlite3.OperationalError("injected private I/O failure")
            return super().execute(sql, parameters)
        def commit(self):
            if phase == "commit":
                raise sqlite3.OperationalError("injected commit failure")
            return super().commit()
    with closing(connect(db, isolation_level=None)) as locker:
        if phase == "busy":
            locker.execute("BEGIN IMMEDIATE")
        with monkeypatch.context() as patch:
            patch.setattr(edit_store.sqlite3, "connect", lambda *a, **kw: connect(*a, **kw, factory=FailingConnection))
            with pytest.raises(edit_store.StoreUnavailable):
                append(2, 1)
        locker.rollback()
    assert dump(db) == before
    assert history()["recipe"]["settings"] == value(1)


def test_actual_sqlite_full_rolls_back_history_and_recipe(db, monkeypatch):
    append(1, baseline=value())
    before = dump(db)
    connect = sqlite3.connect
    class FullConnection(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            if sql == "BEGIN IMMEDIATE":
                pages = super().execute("PRAGMA page_count").fetchone()[0]
                super().execute(f"PRAGMA max_page_count={pages}")
            return super().execute(sql, parameters)
    with monkeypatch.context() as patch:
        patch.setattr(edit_store.sqlite3, "connect", lambda *a, **kw: connect(*a, **kw, factory=FullConnection))
        with pytest.raises(edit_store.StoreUnavailable) as caught:
            raw.append_raw_history(identity(), 1, uuid4(), settings(profile={"id": "x" * 200000}), kind="allReset")
        assert caught.value.__cause__.sqlite_errorcode == sqlite3.SQLITE_FULL
    assert dump(db) == before


def test_duplicate_uuid_is_detected_even_without_db_unique_constraint(db):
    append(1, baseline=value())
    with closing(sqlite3.connect(db)) as connection:
        connection.execute("CREATE TABLE broken_steps AS SELECT * FROM asset_raw_history_steps")
        connection.execute("UPDATE broken_steps SET position=2")
        connection.execute("INSERT INTO broken_steps SELECT * FROM asset_raw_history_steps")
        connection.execute("DROP TABLE asset_raw_history_steps")
        connection.execute("ALTER TABLE broken_steps RENAME TO asset_raw_history_steps")
        connection.commit()
    with pytest.raises(edit_store.StoreUnavailable):
        history()


@pytest.mark.parametrize("field,invalid", [
    ("revision", True), ("revision", -1), ("revision", 2**63 - 1),
    ("save_id", "bad"), ("step_id", "bad"), ("settings", settings(version=2)),
    ("settings", settings(light={"exposure": float("nan")})),
    ("settings", settings(profile={"id": "x" * raw.MAX_SETTINGS_BYTES})),
    ("baseline", settings(wb={})),
])
def test_invalid_history_inputs_do_not_create_database(db, field, invalid):
    args = {"revision": 0, "save_id": uuid4(), "settings": value(1), "baseline": value(), "step_id": uuid4()}
    args[field] = invalid
    with pytest.raises(raw.InvalidRawRecipe):
        raw.append_raw_history(identity(), args["revision"], args["save_id"], args["settings"],
            kind="control", metadata={"control": "light.exposure"}, baseline_settings=args["baseline"], step_id=args["step_id"])
    assert not db.exists()


def test_revision_and_global_save_id_reuse_preserve_rows(db):
    receipt_id = uuid4()
    original = append(1, save_id=receipt_id, baseline=value())
    before = dump(db)
    with pytest.raises(edit_store.StoreConflict, match="revision_conflict"):
        append(2, 0)
    with pytest.raises(edit_store.StoreConflict, match="save_id_reused"):
        append(1, save_id=receipt_id, baseline=value(9))
    with pytest.raises(edit_store.StoreConflict, match="save_id_reused"):
        append(1, key=identity(assetId=str(uuid4())), save_id=receipt_id, baseline=value())
    assert append(1, save_id=receipt_id, baseline=value())["ack"] == original["ack"]
    assert dump(db) == before


def test_concurrent_identical_requests_are_one_save(db):
    edit_store.initialize_database()
    receipt_id = uuid4()
    barrier = Barrier(2)
    def attempt(_):
        barrier.wait()
        return append(1, save_id=receipt_id, baseline=value())
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, [0, 1]))
    assert results[0]["ack"] == results[1]["ack"]
    assert sorted(result["replayed"] for result in results) == [False, True]
    assert history()["revision"] == 1
    assert len(rows(db, "asset_raw_history_steps")) == len(rows(db, "raw_history_saves")) == 1


def test_replay_after_redo_branch_removed_does_not_recreate_step(db):
    first = append(1, baseline=value())
    receipt_id = uuid4()
    second = append(2, 1, save_id=receipt_id)
    move(first["ack"]["stepId"], 2, 1)
    append(3, 3)
    before = dump(db)
    replay = append(2, 1, save_id=receipt_id)
    assert replay["ack"] == second["ack"]
    assert replay["ack"]["revision"] == 2 and replay["current"]["revision"] == 4
    assert dump(db) == before


@pytest.mark.parametrize("phase", ["recipe", "history-receipt", "parent", "commit", "renumber", "initial-step"])
def test_cursor_initial_insert_and_renumber_failures_are_atomic(db, monkeypatch, phase):
    monkeypatch.setattr(raw, "HISTORY_LIMIT", 2)
    edit_store.initialize_database()
    if phase != "initial-step":
        append(1, baseline=value())
        append(2, 1)
    before = dump(db)
    connect = sqlite3.connect
    prefix = {"recipe": "UPDATE asset_raw_recipes", "history-receipt": "INSERT INTO raw_history_saves",
              "parent": "INSERT INTO asset_raw_histories", "renumber": "UPDATE asset_raw_history_steps SET position",
              "initial-step": "INSERT INTO asset_raw_history_steps"}
    class FailingConnection(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            if phase in prefix and sql.startswith(prefix[phase]):
                raise sqlite3.OperationalError("injected write failure")
            return super().execute(sql, parameters)
        def commit(self):
            if phase == "commit":
                raise sqlite3.OperationalError("injected commit failure")
            return super().commit()
    with monkeypatch.context() as patch:
        patch.setattr(edit_store.sqlite3, "connect", lambda *a, **kw: connect(*a, **kw, factory=FailingConnection))
        with pytest.raises(edit_store.StoreUnavailable):
            if phase == "initial-step":
                append(1, baseline=value())
            elif phase == "renumber":
                append(3, 2)
            else:
                move(None, 2, 0)
    assert dump(db) == before


@pytest.mark.parametrize("damage", ["baseline-value", "cursor-same-settings", "oversized-metadata", "duplicate-json", "receipt-shape"])
def test_semantic_corruption_is_not_certified(db, damage):
    append(1, baseline=value())
    append(0, 1)
    with closing(sqlite3.connect(db)) as connection:
        if damage == "baseline-value":
            connection.execute("UPDATE asset_raw_histories SET baseline_settings_json=?", (edit_store._json(value(9)),))
        elif damage == "cursor-same-settings":
            connection.execute("UPDATE asset_raw_histories SET history_cursor=0")
        elif damage == "oversized-metadata":
            connection.execute("UPDATE asset_raw_history_steps SET metadata_json=?", (" " * 1025,))
        elif damage == "duplicate-json":
            connection.execute('UPDATE asset_raw_history_steps SET metadata_json=?', ('{"control":"light.exposure","control":"light.exposure"}',))
        else:
            row = connection.execute("SELECT save_id,result_json FROM raw_history_saves ORDER BY recipe_revision DESC LIMIT 1").fetchone()
            result = json.loads(row[1])
            result["historyCursor"] = True
            encoded = edit_store._json(result)
            connection.execute("UPDATE raw_history_saves SET result_json=?,result_hash=? WHERE save_id=?",
                               (encoded, raw._digest(encoded), row[0]))
        connection.commit()
    with pytest.raises(edit_store.StoreUnavailable):
        history()


def test_history_does_not_change_jpeg_history_queue_or_raw_recipe_identity(db):
    jpeg = edit_store.put_edit_state(A, 0, uuid4(), snapshot())
    edit_store.enqueue_export_assets([A])
    before = {table: rows(db, table) for table in ("asset_edit_states", "export_queue")}
    append(1, baseline=value())
    move(None, 1, 0)
    assert edit_store.get_edit_state(A) == jpeg
    assert all(rows(db, table) == content for table, content in before.items())
    assert history()["recipe"] == {**identity(), "settings": value()}


def test_transport_receipt_fingerprint_replays_without_historical_snapshot(db):
    request_id = uuid4()
    result = raw.append_raw_history(identity(), 0, request_id, value(1), kind="control",
        metadata={"control": "light.exposure"}, baseline_settings=value(), request_fingerprint="a" * 64)
    move(None, 1, 0)
    append(2, 2)
    replay = raw.get_raw_history_save(identity(), request_id, request_fingerprint="a" * 64)
    assert replay["ack"] == result["ack"]
    assert replay["current"]["revision"] == 3 and replay["replayed"]
    with pytest.raises(edit_store.StoreConflict, match="save_id_reused"):
        raw.get_raw_history_save(identity(), request_id, request_fingerprint="b" * 64)
    assert raw.get_raw_history_save(identity(), uuid4(), request_fingerprint="a" * 64) is None


def test_transport_receipt_cannot_reuse_a_legacy_or_other_identity_save(db):
    request_id = uuid4()
    save(save_id=request_id)
    with pytest.raises(edit_store.StoreConflict, match="save_id_reused"):
        raw.get_raw_history_save(identity(), request_id, request_fingerprint="a" * 64)
    result = raw.initialize_raw_history(identity(), 1, uuid4(), settings(), request_fingerprint="a" * 64)
    with pytest.raises(edit_store.StoreConflict, match="save_id_reused"):
        raw.get_raw_history_save(identity(assetId=str(uuid4())), result["ack"]["saveId"], request_fingerprint="a" * 64)


@pytest.mark.parametrize("fingerprint", ["", "a" * 63, "A" * 64, 3, [], "x" * 64])
def test_invalid_transport_fingerprint_does_not_open_db(db, fingerprint):
    with pytest.raises(raw.InvalidRawHistory):
        raw.initialize_raw_history(identity(), 0, uuid4(), value(), request_fingerprint=fingerprint)
    assert not db.exists()
