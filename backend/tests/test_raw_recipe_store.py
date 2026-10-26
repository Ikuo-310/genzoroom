import ast
import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
import sqlite3
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4

import pytest

import edit_store
import raw_recipe_store as raw
import storage
from tests.test_export_queue import A, db, snapshot
from tests.test_lightcraft_raw import DEFAULT


def identity(**changes):
    return {"assetId": str(A), "sourceContentHash": "abcdef0123456789",
            "engineName": "lightcraft", "engineVersion": "0.10.0",
            "engineCommit": "a2a41383c4fd62fa85a46ccd00998639221f2d3c",
            "settingsSchemaVersion": 1, **changes}


def settings(**changes):
    return {**copy.deepcopy(DEFAULT), **changes}


def save(key=None, value=None, revision=0, save_id=None):
    return raw.put_raw_recipe(key or identity(), revision, save_id or uuid4(), value or settings())


def rows(path, table):
    with closing(sqlite3.connect(path)) as connection:
        return connection.execute(f"SELECT * FROM {table}").fetchall()


def old_database(path, version):
    with closing(sqlite3.connect(path)) as connection:
        for previous in range(version):
            edit_store.MIGRATIONS[previous](connection)
        connection.execute(f"PRAGMA user_version={version}")
        state = snapshot()
        state["history"] = [{"kind": "temperature", "before": snapshot(edited=False)["currentRecipe"],
                             "after": copy.deepcopy(state["currentRecipe"])}]
        connection.execute("INSERT INTO asset_edit_states VALUES (?,2,18,?,?,?,1,?,7,?,?)",
                           (str(A), state["processingVersion"], edit_store._json(state["currentRecipe"]),
                            edit_store._json(state["history"]), edit_store._json(state["sourceIdentity"]),
                            "2026-10-22T00:00:00.000Z", str(uuid4())))
        if version >= 2:
            connection.execute("INSERT INTO export_queue VALUES (42,?,'queued',?,?)",
                               (str(A), "2026-10-22T00:00:00.000Z", "2026-10-22T00:00:00.000Z"))
        if version >= 3:
            connection.execute("""INSERT INTO export_runs (run_id,status,created_at,updated_at)
                VALUES ('run','completed','2026-10-22T00:00:00.000Z','2026-10-22T00:00:00.000Z')""")
            connection.execute("""INSERT INTO export_run_items (run_id,position,asset_id,queue_id,
                frozen_revision,recipe_version,processing_version,frozen_recipe_json,status,updated_at)
                VALUES ('run',0,?,42,7,18,?,?,'succeeded','2026-10-22T00:00:00.000Z')""",
                (str(A), state["processingVersion"], edit_store._json(state["currentRecipe"])))
        if version >= 5:
            connection.execute("INSERT INTO development_exclusions VALUES ('asset',?,NULL,NULL,?)",
                               (str(A), "2026-10-22T00:00:00.000Z"))
        connection.commit()
        before = {}
        for table, in connection.execute("SELECT name FROM sqlite_master WHERE type='table'"):
            columns = [row[1] for row in connection.execute(f"PRAGMA table_info({table})")]
            before[table] = (columns, connection.execute(f"SELECT * FROM {table}").fetchall())
        return before


@pytest.mark.parametrize("version", range(1, 7))
def test_old_versions_migrate_without_changing_existing_columns(db, version):
    before = old_database(db, version)
    storage.validate_existing_database(db)
    edit_store.initialize_database()
    storage.validate_existing_database(db)
    with closing(sqlite3.connect(db)) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == edit_store.SCHEMA_VERSION
        for table, (columns, values) in before.items():
            assert connection.execute(f"SELECT {','.join(columns)} FROM {table}").fetchall() == values
        assert connection.execute("SELECT count(*) FROM asset_raw_recipes").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM raw_recipe_saves").fetchone()[0] == 0
        assert not connection.execute("PRAGMA foreign_key_check").fetchall()
    assert len(edit_store.get_edit_state(A)["state"]["history"]) == 1
    assert save()["revision"] == 1


@pytest.mark.parametrize("version", range(1, 7))
def test_failed_v7_migration_rolls_back_all_schema_and_data(db, monkeypatch, version):
    before = old_database(db, version)
    migration = edit_store.MIGRATIONS[6]
    def fail(connection):
        migration(connection)
        raise sqlite3.OperationalError("injected private migration error")
    monkeypatch.setitem(edit_store.MIGRATIONS, 6, fail)
    with pytest.raises(storage.StorageInitializationError, match="persistence_unavailable"):
        edit_store.initialize_database()
    with closing(sqlite3.connect(db)) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == version
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        assert set(tables) == set(before)
        for table, (_, values) in before.items():
            assert connection.execute(f"SELECT * FROM {table}").fetchall() == values


def test_roundtrip_full_settings_and_jpeg_queue_are_independent(db):
    jpeg = edit_store.put_edit_state(A, 0, uuid4(), snapshot())
    edit_store.enqueue_export_assets([A])
    before = {table: rows(db, table) for table in ("asset_edit_states", "export_queue")}
    value = settings(profile={"id": "lc.color", "amount": 100.0},
                     detail={"sharpen_amount": 17.5}, disabled_sections=["effects"])
    result = save(value=value)
    assert result == raw.get_raw_recipe(identity())
    assert result["recipe"] == {**identity(), "settings": value}
    value["detail"]["sharpen_amount"] = 99
    assert raw.get_raw_recipe(identity())["recipe"]["settings"]["detail"]["sharpen_amount"] == 17.5
    assert edit_store.get_edit_state(A) == jpeg
    assert edit_store.get_edit_statuses([A]) == {str(A): True}
    assert {table: rows(db, table) for table in before} == before


def test_raw_only_does_not_create_jpeg_edit_status_or_queue(db):
    assert raw.get_raw_recipe(identity()) == {"recipe": None}
    save()
    assert edit_store.get_edit_statuses([A]) == {str(A): False}
    assert rows(db, "export_queue") == rows(db, "asset_edit_states") == []


def test_lookup_distinguishes_absence_source_and_engine_without_mutation(db):
    saved = save()
    save(identity(sourceContentHash="b" * 16))
    before = {table: rows(db, table) for table in ("asset_raw_recipes", "raw_recipe_saves")}
    assert raw.lookup_raw_recipe(identity()) == {"status": "matched", **saved}
    assert raw.lookup_raw_recipe(identity(sourceContentHash="c" * 16)) == {"status": "source_mismatch"}
    assert raw.lookup_raw_recipe(identity(engineCommit="b" * 40)) == {"status": "matched", **saved}
    assert raw.lookup_raw_recipe(identity(assetId=str(uuid4()))) == {"status": "none"}
    assert {table: rows(db, table) for table in before} == before


@pytest.mark.parametrize("change", [
    {"assetId": str(uuid4())}, {"sourceContentHash": "b" * 16}, {"engineName": "other"},
    {"engineVersion": "0.10.1"}, {"engineCommit": "b" * 40}, {"settingsSchemaVersion": 2},
])
def test_different_identity_is_preserved_in_separate_rows(db, change):
    original = save()
    key = identity(**change)
    second = save(key, settings(version=key["settingsSchemaVersion"], process=1))
    assert raw.get_raw_recipe(identity()) == original
    assert raw.get_raw_recipe(key) == second
    assert len(rows(db, "asset_raw_recipes")) == 2


def test_identifiers_are_canonical_and_canonical_replay_is_inert(db):
    key = identity(assetId="ABCDEFAB-1234-1234-1234-123456789ABC", sourceContentHash="A" * 16,
                   engineName="LightCraft", engineCommit="B" * 40)
    save_id = str(uuid4()).upper()
    first = save(key, save_id=save_id)
    canonical = raw.normalize_identity(key)
    assert canonical["engineName"] == "lightcraft"
    assert canonical["sourceContentHash"] == "a" * 16
    assert canonical["engineCommit"] == "b" * 40
    assert first["lastSaveId"] == save_id.lower()
    assert first == save(canonical, dict(reversed(list(settings().items()))), save_id=save_id.lower())
    assert len(rows(db, "asset_raw_recipes")) == len(rows(db, "raw_recipe_saves")) == 1


def test_revision_conflict_and_save_id_replay_after_later_saves(db):
    save_id = uuid4()
    first = save(save_id=save_id)
    second = save(value=settings(process=1), revision=1)
    assert second["revision"] == 2
    assert save(save_id=save_id) == first
    assert raw.get_raw_recipe(identity()) == second
    with pytest.raises(edit_store.StoreConflict, match="revision_conflict"):
        save()
    for key, value, revision in ((identity(), settings(process=1), 0),
                                  (identity(), settings(), 2),
                                  (identity(sourceContentHash="c" * 16), settings(), 0)):
        with pytest.raises(edit_store.StoreConflict, match="save_id_reused"):
            save(key, value, revision, save_id)
    assert raw.get_raw_recipe(identity()) == second
    assert len(rows(db, "raw_recipe_saves")) == 2


def test_concurrent_expected_revision_has_one_winner(db):
    edit_store.initialize_database()
    barrier = Barrier(2)
    def attempt(process):
        barrier.wait()
        try:
            return save(value=settings(process=process))
        except edit_store.StoreConflict:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, [1, 2]))
    assert sum(result is not None for result in results) == 1
    assert len(rows(db, "raw_recipe_saves")) == 1


@pytest.mark.parametrize("change", [
    {"assetId": True}, {"assetId": "bad"}, {"sourceContentHash": "x" * 16},
    {"sourceContentHash": "a" * 129}, {"sourceContentHash": "a" * 15},
    {"engineCommit": "a" * 39}, {"engineName": "../lightcraft"}, {"engineVersion": "0.10.0/path"},
    {"engineVersion": "1" * 65}, {"settingsSchemaVersion": True}, {"settingsSchemaVersion": 0},
    {"settingsSchemaVersion": 2**32}, {"path": "PRIVATE"},
])
def test_invalid_identity_does_not_create_database(db, change):
    with pytest.raises(raw.InvalidRawRecipe, match="^invalid_raw_recipe$"):
        save(identity(**change))
    assert not db.exists()


@pytest.mark.parametrize("revision,save_id", [(True, None), (-1, None), (2**63 - 1, None),
                                             (0.0, None), (0, "bad"), (0, True)])
def test_invalid_save_metadata(db, revision, save_id):
    with pytest.raises(raw.InvalidRawRecipe):
        raw.put_raw_recipe(identity(), revision, save_id, settings())
    assert not db.exists()


@pytest.mark.parametrize("value", [
    [], "{}", {}, settings(version=True), settings(version=2), settings(process=True),
    settings(process=-1), settings(process=2**32), settings(wb={}),
    settings(wb={"mode": "custom", "temp": True, "tint": 0}),
    settings(wb={"mode": "custom", "temp": 6500, "tint": 0, "scale": "unknown"}),
    settings(light={"exposure": float("nan")}), settings(light={"exposure": float("inf")}),
    settings(light={"exposure": 10**400}), settings(light={1: 0}), settings(light={"x": (1, 2)}),
    settings(profile={"id": "x" * raw.MAX_SETTINGS_BYTES}),
    settings(profile={"id": "写" * (raw.MAX_SETTINGS_BYTES // 2)}),
    settings(profile={"id": "\ud800"}), settings(PhotoId=1), settings(cache_path="PRIVATE"),
    settings(profile={"path": "PRIVATE"}), settings(light={"x": [0] * raw.MAX_SETTINGS_NODES}),
])
def test_invalid_settings_leave_existing_recipe_unchanged(db, value):
    original = save()
    with pytest.raises(raw.InvalidRawRecipe, match="^invalid_raw_recipe$"):
        raw.put_raw_recipe(identity(), 1, uuid4(), value)
    assert raw.get_raw_recipe(identity()) == original
    assert len(rows(db, "raw_recipe_saves")) == 1


def test_depth_cycle_and_exact_utf8_size_boundary(db):
    value = settings()
    branch = value
    for _ in range(raw.MAX_SETTINGS_DEPTH + 1):
        branch["nested"] = {}
        branch = branch["nested"]
    with pytest.raises(raw.InvalidRawRecipe):
        save(value=value)
    value["cycle"] = value
    with pytest.raises(raw.InvalidRawRecipe):
        save(value=value)
    value = settings(profile={"id": ""})
    overhead = len(edit_store._json(value).encode("utf-8"))
    value["profile"]["id"] = "x" * (raw.MAX_SETTINGS_BYTES - overhead)
    assert len(edit_store._json(value).encode("utf-8")) == raw.MAX_SETTINGS_BYTES
    original = save(value=value)
    value["profile"]["id"] += "x"
    with pytest.raises(raw.InvalidRawRecipe):
        save(value=value, revision=1)
    assert raw.get_raw_recipe(identity()) == original


@pytest.mark.parametrize("column,value", [
    ("develop_settings_json", "{"), ("develop_settings_json", "[]"),
    ("develop_settings_json", edit_store._json(settings()).replace('"process":2', '"process":2,"process":2')),
    ("develop_settings_json", "[" * 2000 + "]" * 2000),
    ("develop_settings_json", " " * (raw.MAX_SETTINGS_BYTES + 1)),
    ("develop_settings_json", edit_store._json(settings(version=2))),
    ("develop_settings_json", edit_store._json(settings(cache_path="PRIVATE"))),
    ("recipe_revision", 2), ("updated_at", "invalid"), ("last_save_id", str(uuid4())),
], ids=["syntax", "array", "duplicate-key", "depth", "size", "schema", "private-field",
        "revision", "timestamp", "save-id"])
def test_corrupt_persisted_recipe_is_rejected_without_repair(db, column, value):
    save()
    with closing(sqlite3.connect(db)) as connection:
        connection.execute(f"UPDATE asset_raw_recipes SET {column}=?", (value,))
        connection.commit()
    corrupted = rows(db, "asset_raw_recipes")
    with pytest.raises(edit_store.StoreUnavailable, match="^$"):
        raw.get_raw_recipe(identity())
    with pytest.raises(edit_store.StoreUnavailable):
        save(revision=1)
    assert rows(db, "asset_raw_recipes") == corrupted


@pytest.mark.parametrize("column,value", [("request_hash", "c" * 64), ("updated_at", "bad"),
                                         ("recipe_revision", 2)])
def test_corrupt_receipt_is_not_certified(db, column, value):
    save()
    with closing(sqlite3.connect(db)) as connection:
        connection.execute(f"UPDATE raw_recipe_saves SET {column}=?", (value,))
        connection.commit()
    with pytest.raises(edit_store.StoreUnavailable):
        raw.get_raw_recipe(identity())


@pytest.mark.parametrize("phase", ["receipt", "recipe", "commit", "busy"])
def test_write_failure_rolls_back_recipe_and_receipt(db, monkeypatch, phase):
    original = save()
    before = rows(db, "raw_recipe_saves")
    connect = sqlite3.connect
    class FailingConnection(sqlite3.Connection):
        def execute(self, sql, parameters=()):
            if phase == "busy" and sql == "PRAGMA busy_timeout=3000":
                sql = "PRAGMA busy_timeout=0"
            if (phase == "receipt" and sql.startswith("INSERT INTO raw_recipe_saves")) or \
                    (phase == "recipe" and sql.startswith("UPDATE asset_raw_recipes")):
                raise sqlite3.OperationalError("database or disk is full PRIVATE")
            return super().execute(sql, parameters)
        def commit(self):
            if phase == "commit":
                raise sqlite3.OperationalError("disk I/O error PRIVATE")
            return super().commit()
    with closing(connect(db, isolation_level=None)) as locker:
        if phase == "busy":
            locker.execute("BEGIN IMMEDIATE")
        with monkeypatch.context() as patch:
            patch.setattr(edit_store.sqlite3, "connect", lambda *a, **kw: connect(*a, **kw, factory=FailingConnection))
            with pytest.raises(edit_store.StoreUnavailable) as caught:
                save(value=settings(process=1), revision=1)
            assert str(caught.value) == ""
        locker.rollback()
    assert raw.get_raw_recipe(identity()) == original
    assert rows(db, "raw_recipe_saves") == before


def test_failed_initial_insert_leaves_no_recipe_or_receipt(db):
    edit_store.initialize_database()
    with closing(sqlite3.connect(db)) as connection:
        connection.execute("""CREATE TRIGGER fail_raw BEFORE INSERT ON asset_raw_recipes
            BEGIN SELECT RAISE(ABORT, 'injected failure'); END""")
        connection.commit()
    with pytest.raises(edit_store.StoreUnavailable):
        save()
    assert rows(db, "asset_raw_recipes") == rows(db, "raw_recipe_saves") == []


def test_real_sqlite_full_rolls_back_without_losing_original(db, monkeypatch):
    original = save()
    before = rows(db, "raw_recipe_saves")
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
            save(value=settings(profile={"id": "x" * 200000}), revision=1)
        assert caught.value.__cause__.sqlite_errorcode == sqlite3.SQLITE_FULL
    assert raw.get_raw_recipe(identity()) == original
    assert rows(db, "raw_recipe_saves") == before


def test_release_smoke_sqlite_assertions_against_current_database(db):
    edit_store.initialize_database()
    script = (Path(__file__).resolve().parents[2] / "release" / "smoke-test.sh").read_text()
    # Execute the release script's actual SQLite block without Docker/build-info/network probes.
    embedded = script.split("python -c '\n", 1)[1].split("\n' ", 1)[0]
    block = next(node for node in ast.parse(embedded).body if isinstance(node, ast.With))
    module = ast.Module(body=[block], type_ignores=[])
    client = SimpleNamespace(connect=lambda *a, **kw: sqlite3.connect(db))
    exec(compile(module, "release-smoke-sqlite", "exec"), {"sqlite3": client})
