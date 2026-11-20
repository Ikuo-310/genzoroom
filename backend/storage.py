"""Explicit runtime storage layout shared by persistence features."""

import os
import sqlite3
import stat
import tempfile
from pathlib import Path
from urllib.parse import quote
import re

from backend_logging import backend_logger


# Host paths belong to the deployment; each process selects exactly one Immich profile.
DEPLOYMENT_ROOT = Path("/genzoroom")
STORAGE_ROOT = DEPLOYMENT_ROOT
DB_PATH = STORAGE_ROOT / "data" / "genzoroom.db"
WINDOWS_STORAGE = False
PROFILE_ID: str | None = None


def development_engine() -> str:
    """Keep renderer selection tied to the startup-selected deployment, not Native health."""
    return "lightcraft" if WINDOWS_STORAGE else "jpeg"


def configure_profile(deployment_root: Path, url: str, user_id: str, *, windows: bool = False) -> str:
    """Bind one process to a deterministic connection-owned database and cache root."""
    from connection_identity import ConnectionIdentityError, profile_id
    try:
        selected = profile_id(url, user_id)
    except ConnectionIdentityError:
        raise StorageInitializationError("storage_identity_unavailable") from None
    configure_profile_id(deployment_root, selected, windows=windows)
    return selected


def configure_profile_id(deployment_root: Path, selected: str, *, windows: bool = False) -> None:
    global DEPLOYMENT_ROOT, STORAGE_ROOT, DB_PATH, WINDOWS_STORAGE, PROFILE_ID
    if not re.fullmatch(r"[0-9a-f]{64}", selected):
        raise StorageInitializationError("storage_identity_unavailable")
    try:
        supplied_root = Path(deployment_root)
        if windows and (not supplied_root.is_absolute() or supplied_root.drive.startswith("\\\\")):
            raise ValueError()
        root = supplied_root.resolve()
    except (OSError, ValueError):
        raise StorageInitializationError("windows_storage_location_invalid" if windows else "storage_identity_unavailable") from None
    DEPLOYMENT_ROOT = root
    PROFILE_ID = selected
    STORAGE_ROOT = root / "profiles" / selected
    DB_PATH = STORAGE_ROOT / "data" / "genzoroom.db"
    WINDOWS_STORAGE = windows
    # Persistence modules may be imported before the host finishes validating its connection.
    import sys
    edit_store = sys.modules.get("edit_store")
    if edit_store is not None:
        edit_store.DB_PATH = DB_PATH


def profile_configured() -> bool:
    return PROFILE_ID is not None


def clear_profile(deployment_root: Path, *, windows: bool = False) -> None:
    """Keep connection setup available without exposing an unscoped persistent database."""
    global DEPLOYMENT_ROOT, STORAGE_ROOT, DB_PATH, WINDOWS_STORAGE, PROFILE_ID
    supplied_root = Path(deployment_root)
    if windows and (not supplied_root.is_absolute() or supplied_root.drive.startswith("\\\\")):
        raise StorageInitializationError("windows_storage_location_invalid")
    DEPLOYMENT_ROOT = supplied_root.resolve()
    STORAGE_ROOT = DEPLOYMENT_ROOT
    DB_PATH = STORAGE_ROOT / "data" / "genzoroom.db"
    WINDOWS_STORAGE = windows
    PROFILE_ID = None
    import sys
    edit_store = sys.modules.get("edit_store")
    if edit_store is not None:
        edit_store.DB_PATH = DB_PATH


class StorageInitializationError(RuntimeError):
    MESSAGES = {
        "storage_identity_unavailable": "Immich connection identity must be verified before opening persistent data",
        "storage_root_not_mounted": "storage root is not mounted; check GENZOROOM_PERSIST_ROOT",
        "windows_storage_location_invalid": "LOCALAPPDATA must identify a local absolute user directory",
        "windows_storage_not_writable": "Windows PoC user storage is not writable",
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
        return any(line.split()[4] == DEPLOYMENT_ROOT.as_posix()
                   for line in Path("/proc/self/mountinfo").read_text().splitlines())
    except (OSError, IndexError):
        return False


def initialize_storage() -> None:
    try:
        if not WINDOWS_STORAGE and not storage_root_is_mounted():
            raise StorageInitializationError("storage_root_not_mounted")
        try:
            if not profile_configured():
                raise StorageInitializationError("storage_identity_unavailable")
            data = DB_PATH.parent
            data.mkdir(parents=True, exist_ok=True)
            # A disposable file leaves the DB untouched; explicit unlink verifies deletion rights too.
            with tempfile.NamedTemporaryFile(dir=data, delete_on_close=False) as probe:
                probe.write(b"genzoroom")
                probe.flush()
                os.fsync(probe.fileno())
        except OSError:
            code = "windows_storage_not_writable" if WINDOWS_STORAGE else "storage_data_not_writable"
            raise StorageInitializationError(code) from None
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
        if version > 9:
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
        }[min(version, 4)]
        if version >= 5:
            required["development_exclusions"] = ("kind", "target_id", "primary_asset_id", "member_ids_json", "registered_at")
        if version >= 6:
            required["export_run_items"] += ("export_timestamp",)
        if version >= 7:
            required["asset_raw_recipes"] = (
                "asset_id", "source_content_hash", "engine_name", "engine_version", "engine_commit",
                "settings_schema_version", "develop_settings_json", "recipe_revision", "last_save_id", "updated_at")
            required["raw_recipe_saves"] = ("save_id", "request_hash", "recipe_revision", "updated_at")
        if version >= 8:
            identity = ("asset_id", "source_content_hash", "engine_name", "engine_version",
                        "engine_commit", "settings_schema_version")
            required["asset_raw_histories"] = (*identity, "baseline_settings_json", "history_cursor", "last_save_id")
            required["asset_raw_history_steps"] = (*identity, "position", "step_id", "kind", "metadata_json",
                                                   "develop_settings_json", "created_at", "save_id")
            required["raw_history_saves"] = (*identity, "save_id", "request_hash", "request_json", "result_json",
                                             "result_hash", "step_id", "recipe_revision", "updated_at")
        if version >= 9:
            required["asset_raw_recipes"] += ("import_defaults_fingerprint",)
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
