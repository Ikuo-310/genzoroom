import asyncio
import copy
from pathlib import Path
from uuid import uuid4

import pytest

import edit_store
import main
import storage
from export_runtime_store import (
    begin_export_item, create_export_run, get_export_run, recoverable_export_run,
    request_export_stop, transition_export_item,
)
from tests.test_export_queue import A, snapshot


@pytest.fixture
def mounted_storage(tmp_path, monkeypatch):
    root = tmp_path / "genzoroom"
    root.mkdir()
    monkeypatch.setattr(storage, "STORAGE_ROOT", root)
    monkeypatch.setattr(storage, "DB_PATH", root / "data" / "genzoroom.db")
    monkeypatch.setattr(edit_store, "DB_PATH", storage.DB_PATH)
    monkeypatch.setattr(storage, "storage_root_is_mounted", lambda: True)
    return root


def test_default_layout_has_one_internal_root():
    assert storage.STORAGE_ROOT == Path("/genzoroom")
    assert storage.DB_PATH == storage.STORAGE_ROOT / "data" / "genzoroom.db"
    assert edit_store.DB_PATH == storage.DB_PATH


@pytest.mark.parametrize("mountinfo,expected", [
    ("10 1 0:1 / / rw - overlay overlay rw\n", False),
    ("11 1 0:2 /host/genzoroom /genzoroom rw - ext4 /dev/sda rw\n", True),
    ("12 1 0:2 /host/data /genzoroom/data rw - ext4 /dev/sda rw\n", False),
    ("malformed", False),
])
def test_mount_detection_requires_parent_bind(mountinfo, expected, monkeypatch):
    monkeypatch.setattr(Path, "read_text", lambda _: mountinfo)
    assert storage.storage_root_is_mounted() is expected


def test_unavailable_mount_information_fails_closed(monkeypatch):
    def unreadable(_):
        raise PermissionError()
    monkeypatch.setattr(Path, "read_text", unreadable)
    assert not storage.storage_root_is_mounted()


def test_startup_creates_only_data_and_does_not_create_db(mounted_storage):
    storage.initialize_storage()
    assert list(mounted_storage.iterdir()) == [mounted_storage / "data"]
    assert list((mounted_storage / "data").iterdir()) == []
    storage.initialize_storage()


@pytest.mark.parametrize("existing_data", [False, True])
def test_unmounted_root_never_creates_empty_database(mounted_storage, monkeypatch, existing_data):
    if existing_data:
        (mounted_storage / "data").mkdir()
    monkeypatch.setattr(storage, "storage_root_is_mounted", lambda: False)
    before = list(mounted_storage.iterdir())
    with pytest.raises(storage.StorageInitializationError, match="storage_root_not_mounted"):
        storage.initialize_storage()
    assert list(mounted_storage.iterdir()) == before
    assert not storage.DB_PATH.exists()


@pytest.mark.parametrize("failure", ["mkdir", "write", "database"])
def test_storage_permission_failures_are_explicit(mounted_storage, monkeypatch, failure):
    if failure == "mkdir":
        def denied(*args, **kwargs):
            raise PermissionError("private host detail")
        monkeypatch.setattr(Path, "mkdir", denied)
    elif failure == "write":
        def denied(*args, **kwargs):
            raise PermissionError("private host detail")
        monkeypatch.setattr(storage.tempfile, "NamedTemporaryFile", denied)
    else:
        (mounted_storage / "data").mkdir()
        import sqlite3
        with sqlite3.connect(storage.DB_PATH) as connection:
            connection.execute("PRAGMA user_version=4")
        monkeypatch.setattr(storage.sqlite3, "connect", lambda *args, **kwargs:
                            (_ for _ in ()).throw(storage.sqlite3.OperationalError("unable to open database file")))
    code = "storage_database_unavailable" if failure == "database" else "storage_data_not_writable"
    with pytest.raises(storage.StorageInitializationError, match=code) as caught:
        storage.validate_existing_database() if failure == "database" else storage.initialize_storage()
    assert "private host detail" not in str(caught.value)
    if failure == "database":
        assert storage.DB_PATH.exists()
    else:
        assert not storage.DB_PATH.exists()


def test_existing_database_edit_history_queue_and_runtime_survive_initialization(mounted_storage):
    storage.initialize_storage()
    saved = snapshot()
    before = snapshot(edited=False)["currentRecipe"]
    saved["history"] = [{"kind": "temperature", "before": before,
                         "after": copy.deepcopy(saved["currentRecipe"])}]
    saved["historyCursor"] = 1
    edit_store.put_edit_state(A, 0, uuid4(), saved)
    edit_store.enqueue_export_assets([A])
    owner = uuid4()
    run = create_export_run([A], worker_id=owner)
    begin_export_item(run.run_id, owner)
    transition_export_item(run.run_id, A, owner, "waiting", "encoding")
    request_export_stop(run.run_id)
    original_bytes = storage.DB_PATH.read_bytes()
    original_edit = edit_store.get_edit_state(A)
    original_queue = edit_store.list_export_queue()
    original_run = get_export_run(run.run_id)

    storage.initialize_storage()

    assert storage.DB_PATH.read_bytes() == original_bytes
    assert edit_store.get_edit_state(A) == original_edit
    assert original_edit["state"] == saved
    assert edit_store.list_export_queue() == original_queue
    assert recoverable_export_run() == original_run
    assert original_run.stop_requested
    with edit_store._connection() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == edit_store.SCHEMA_VERSION == 4
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert storage.DB_PATH.with_name("genzoroom.db-wal").exists()
        assert storage.DB_PATH.with_name("genzoroom.db-shm").exists()
    # Initialization and subsequent reads have no implicit alternate database path.
    assert list(mounted_storage.glob("**/genzoroom.db")) == [storage.DB_PATH]


def test_lifespan_aborts_before_export_recovery_when_unmounted(mounted_storage, monkeypatch):
    monkeypatch.setattr(storage, "storage_root_is_mounted", lambda: False)
    def unexpected_runtime(*args, **kwargs):
        pytest.fail("runtime must not start before storage validation")
    monkeypatch.setattr(main, "ExportRuntime", unexpected_runtime)
    async def start():
        async with main.app.router.lifespan_context(main.app):
            pytest.fail("startup should fail")
    with pytest.raises(RuntimeError, match="storage_root_not_mounted"):
        asyncio.run(start())
    assert not storage.DB_PATH.exists()


def start_lifespan():
    async def start():
        async with main.app.router.lifespan_context(main.app):
            return app_state()
    return asyncio.run(start())


def app_state():
    return main.app.state.export_runtime


def test_lifespan_opens_existing_database_and_preserves_runtime_state(mounted_storage, monkeypatch):
    monkeypatch.delenv("IMMICH_URL", raising=False)
    monkeypatch.delenv("IMMICH_API_KEY", raising=False)
    storage.initialize_storage()
    saved = snapshot()
    edit_store.put_edit_state(A, 0, uuid4(), saved)
    edit_store.enqueue_export_assets([A])
    run = create_export_run([A], worker_id=uuid4())
    db_bytes = storage.DB_PATH.read_bytes()
    result = start_lifespan()
    assert result._task is None
    assert edit_store.get_edit_state(A)["state"] == saved
    assert edit_store.list_export_queue()[0]["status"] == "waiting"
    assert recoverable_export_run().run_id == run.run_id
    assert storage.DB_PATH.read_bytes() == db_bytes


def test_lifespan_initializes_missing_database_for_new_install(mounted_storage, monkeypatch):
    monkeypatch.delenv("IMMICH_URL", raising=False)
    monkeypatch.delenv("IMMICH_API_KEY", raising=False)
    assert not storage.DB_PATH.exists()
    start_lifespan()
    with edit_store._connection() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 4
        assert connection.execute("SELECT count(*) FROM asset_edit_states").fetchone()[0] == 0


@pytest.mark.parametrize("filename,payload,expected_code", [
    ("genzoroom.db", b"old database", "storage_root_may_be_data_directory"),
    ("data/genzoroom.db", b"", "storage_database_empty"),
    ("data/genzoroom.db", b"not a SQLite database", "storage_database_corrupt"),
])
def test_lifespan_rejects_wrong_root_or_invalid_existing_db_without_changes(
        mounted_storage, monkeypatch, filename, payload, expected_code):
    monkeypatch.delenv("IMMICH_URL", raising=False)
    monkeypatch.delenv("IMMICH_API_KEY", raising=False)
    path = mounted_storage / filename
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(payload)
    before = path.read_bytes()
    monkeypatch.setattr(main, "ExportRuntime", lambda **_: pytest.fail("Runtime started before validation"))
    with pytest.raises(RuntimeError, match=expected_code):
        start_lifespan()
    assert path.read_bytes() == before
    assert not storage.DB_PATH.exists() if filename == "genzoroom.db" else storage.DB_PATH.read_bytes() == before


def test_lifespan_rejects_existing_version_zero_sqlite_file(mounted_storage, monkeypatch):
    import sqlite3
    monkeypatch.delenv("IMMICH_URL", raising=False)
    monkeypatch.delenv("IMMICH_API_KEY", raising=False)
    storage.initialize_storage()
    with sqlite3.connect(storage.DB_PATH) as connection:
        connection.execute("CREATE TABLE unrelated (id INTEGER)")
    before = storage.DB_PATH.read_bytes()
    with pytest.raises(RuntimeError, match="storage_database_uninitialized"):
        start_lifespan()
    assert storage.DB_PATH.read_bytes() == before


def test_lifespan_rejects_unusable_wal_locks_before_runtime_recovery(mounted_storage, monkeypatch):
    monkeypatch.delenv("IMMICH_URL", raising=False)
    monkeypatch.delenv("IMMICH_API_KEY", raising=False)
    storage.initialize_storage()
    edit_store.put_edit_state(A, 0, uuid4(), snapshot())
    monkeypatch.setattr(storage.sqlite3, "connect", lambda *args, **kwargs:
                        (_ for _ in ()).throw(storage.sqlite3.OperationalError("disk I/O error")))
    monkeypatch.setattr(main, "ExportRuntime", lambda **_: pytest.fail("Runtime started before SQLite validation"))
    with pytest.raises(RuntimeError, match="storage_database_unavailable"):
        start_lifespan()
    assert edit_store.DB_PATH.exists()


def test_both_compose_files_use_the_same_required_parent_bind():
    for filename in ("docker-compose.yml", "compose.release.yml"):
        content = (Path(__file__).resolve().parents[2] / filename).read_text()
        assert "source: ${GENZOROOM_PERSIST_ROOT:?Set GENZOROOM_PERSIST_ROOT}" in content
        assert "target: /genzoroom" in content
        assert "create_host_path: false" in content
        assert "GENZOROOM_DATA_PATH" not in content
