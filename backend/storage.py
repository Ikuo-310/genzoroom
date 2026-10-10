"""Container storage layout shared by persistence features."""

import os
import sqlite3
import stat
import tempfile
from pathlib import Path
from urllib.parse import quote

from backend_logging import backend_logger


# Host paths belong to Compose; application paths stay identical in both images.
STORAGE_ROOT = Path("/genzoroom")
DB_PATH = STORAGE_ROOT / "data" / "genzoroom.db"


class StorageInitializationError(RuntimeError):
    MESSAGES = {
        "storage_root_not_mounted": "storage root is not mounted; check GENZOROOM_PERSIST_ROOT",
        "storage_root_may_be_data_directory":
            "a database exists at the mount root; check GENZOROOM_PERSIST_ROOT points to its parent",
        "storage_data_not_writable": "storage data directory is not writable by UID/GID 10001:10001",
        "storage_database_empty": "an existing SQLite database is empty; preserve it for recovery",
        "storage_database_uninitialized": "an existing SQLite database has no GenzoRoom schema version",
        "storage_database_corrupt": "existing SQLite database failed integrity or schema validation",
        "storage_database_unavailable": "SQLite database or WAL/SHM files are not usable for writes",
        "unsupported_db_schema": "SQLite database schema is newer than this GenzoRoom version",
        "persistence_unavailable": "SQLite initialization or migration failed; existing data was preserved",
    }

    def __init__(self, code: str):
        self.code = code
        super().__init__(f"{self.MESSAGES.get(code, 'persistent storage initialization failed')} ({code})")


def storage_root_is_mounted() -> bool:
    # ismount() can miss same-filesystem bind mounts; Linux mountinfo lists them explicitly.
    try:
        return any(line.split()[4] == STORAGE_ROOT.as_posix()
                   for line in Path("/proc/self/mountinfo").read_text().splitlines())
    except (OSError, IndexError):
        return False


def initialize_storage() -> None:
    try:
        if not storage_root_is_mounted():
            raise StorageInitializationError("storage_root_not_mounted")
        try:
            data = STORAGE_ROOT / "data"
            if not DB_PATH.exists() and (STORAGE_ROOT / "genzoroom.db").is_file():
                raise StorageInitializationError("storage_root_may_be_data_directory")
            data.mkdir(exist_ok=True)
            # A disposable file leaves the DB untouched; explicit unlink verifies deletion rights too.
            with tempfile.NamedTemporaryFile(dir=data, delete_on_close=False) as probe:
                probe.write(b"genzoroom")
                probe.flush()
                os.fsync(probe.fileno())
        except OSError:
            raise StorageInitializationError("storage_data_not_writable") from None
    except StorageInitializationError:
        raise


def log_storage_failure(error: StorageInitializationError) -> None:
    try:
        backend_logger.add(level="error", component="storage", event="initialization.failed",
                           context={"errorCode": error.code, "detail": str(error)})
    except Exception:
        # Logging must not obscure the actionable startup failure.
        pass


def validate_existing_database(database_path: Path | None = None) -> None:
    """Check existing SQLite integrity/schema and writer availability before migrations."""
    database_path = DB_PATH if database_path is None else database_path
    try:
        metadata = database_path.stat()
    except FileNotFoundError:
        return
    except OSError:
        raise StorageInitializationError("storage_database_unavailable") from None
    if not stat.S_ISREG(metadata.st_mode):
        raise StorageInitializationError("storage_database_corrupt")
    if metadata.st_size == 0:
        raise StorageInitializationError("storage_database_empty")

    try:
        uri = f"file:{quote(database_path.resolve().as_posix(), safe='/')}?mode=rw"
    except OSError:
        raise StorageInitializationError("storage_database_unavailable") from None
    connection = None
    try:
        # mode=rw forbids SQLite from replacing a missing/wrong path with a blank DB.
        connection = sqlite3.connect(uri, uri=True, timeout=3.0, isolation_level=None)
        connection.execute("PRAGMA busy_timeout=3000")
        # quick_check scans database structure with less work than full index-integrity checking.
        check = connection.execute("PRAGMA quick_check(1)").fetchone()
        if check != ("ok",):
            raise StorageInitializationError("storage_database_corrupt")

        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version <= 0:
            raise StorageInitializationError("storage_database_uninitialized")
        if version > 4:
            raise StorageInitializationError("unsupported_db_schema")
        required = {
            0: {},
            1: {"asset_edit_states": ("asset_id", "state_format_version", "recipe_version", "processing_version",
                                       "current_recipe_json", "history_json", "history_cursor", "source_identity_json",
                                       "revision", "updated_at", "last_save_id")},
            2: {"asset_edit_states": ("asset_id", "state_format_version", "recipe_version", "processing_version",
                                       "current_recipe_json", "history_json", "history_cursor", "source_identity_json",
                                       "revision", "updated_at", "last_save_id"),
                "export_queue": ("id", "asset_id", "status", "queued_at", "updated_at")},
            3: {"asset_edit_states": ("asset_id", "state_format_version", "recipe_version", "processing_version",
                                       "current_recipe_json", "history_json", "history_cursor", "source_identity_json",
                                       "revision", "updated_at", "last_save_id"),
                "export_queue": ("id", "asset_id", "status", "queued_at", "updated_at"),
                "export_runs": ("run_id", "status", "worker_id", "created_at", "updated_at"),
                "export_run_items": ("run_id", "position", "asset_id", "queue_id", "frozen_revision",
                                     "recipe_version", "processing_version", "frozen_recipe_json", "status",
                                     "error_code", "registered_asset_id", "updated_at")},
            4: {"asset_edit_states": ("asset_id", "state_format_version", "recipe_version", "processing_version",
                                       "current_recipe_json", "history_json", "history_cursor", "source_identity_json",
                                       "revision", "updated_at", "last_save_id"),
                "export_queue": ("id", "asset_id", "status", "queued_at", "updated_at"),
                "export_runs": ("run_id", "status", "worker_id", "created_at", "updated_at",
                                "stop_requested", "current_position"),
                "export_run_items": ("run_id", "position", "asset_id", "queue_id", "frozen_revision",
                                     "recipe_version", "processing_version", "frozen_recipe_json", "status",
                                     "error_code", "registered_asset_id", "updated_at")},
        }[version]
        for table, columns in required.items():
            # SQLite can interpret missing double-quoted identifiers as string literals.
            projection = ", ".join(f'[{column}]' for column in columns)
            connection.execute(f'SELECT {projection} FROM "{table}" LIMIT 0')

        # This acquires SQLite's real writer lock (including WAL shared-memory locks) without pages changed.
        connection.execute("BEGIN IMMEDIATE")
        connection.rollback()
    except StorageInitializationError:
        raise
    except (sqlite3.Error, OSError, ValueError) as error:
        sqlite_code = getattr(error, "sqlite_errorcode", None)
        if sqlite_code is not None:
            sqlite_code &= 0xFF
        corrupt_codes = {sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB}
        code = ("storage_database_corrupt"
                if sqlite_code in corrupt_codes or getattr(error, "sqlite_errorname", None) == "SQLITE_ERROR"
                else "storage_database_unavailable")
        raise StorageInitializationError(code) from None
    finally:
        if connection is not None:
            connection.close()
