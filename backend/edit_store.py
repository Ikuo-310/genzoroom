"""SQLite persistence for asset edit states and the asset-level Export Queue."""

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from time import monotonic
from uuid import UUID

from backend_logging import backend_logger
from edit_state import InvalidEditState, validate_snapshot, has_non_default_recipe
from storage import DB_PATH, StorageInitializationError

SCHEMA_VERSION = 4

SCHEMA = """
CREATE TABLE asset_edit_states (
    asset_id TEXT PRIMARY KEY NOT NULL,
    state_format_version INTEGER NOT NULL CHECK (state_format_version >= 1),
    recipe_version INTEGER NOT NULL CHECK (recipe_version >= 1),
    processing_version TEXT NOT NULL,
    current_recipe_json TEXT NOT NULL,
    history_json TEXT NOT NULL,
    history_cursor INTEGER NOT NULL CHECK (history_cursor >= 0),
    source_identity_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    updated_at TEXT NOT NULL,
    last_save_id TEXT NOT NULL
)
"""


class StoreUnavailable(Exception):
    code = "persistence_unavailable"


class UnsupportedSchema(StoreUnavailable):
    code = "unsupported_db_schema"


class StoreConflict(Exception):
    def __init__(self, code: str = "revision_conflict"):
        super().__init__(code)
        self.code = code


def _create_v1(connection: sqlite3.Connection) -> None:
    # An unversioned existing table is not ours to replace.
    existing = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='asset_edit_states'"
    ).fetchone()
    if existing:
        raise StoreUnavailable()
    connection.execute(SCHEMA)


QUEUE_STATUSES = frozenset(("queued", "waiting", "encoding", "registering", "failed"))


class QueueRejected(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _create_v2(connection: sqlite3.Connection) -> None:
    # Refuse a damaged v1 table rather than marking an unusable database as upgraded.
    connection.execute("""SELECT asset_id, state_format_version, recipe_version, processing_version,
        current_recipe_json, history_json, history_cursor, source_identity_json, revision,
        updated_at, last_save_id FROM asset_edit_states LIMIT 0""")
    connection.execute("""CREATE TABLE export_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'waiting', 'encoding', 'registering', 'failed')),
        queued_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""")


def _create_v3(connection: sqlite3.Connection) -> None:
    connection.execute("SELECT id, asset_id, status, queued_at, updated_at FROM export_queue LIMIT 0")
    connection.execute("""CREATE TABLE export_runs (
        run_id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed')),
        worker_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""")
    # A DB guard complements process ownership, including concurrent coordinator instances.
    connection.execute("CREATE UNIQUE INDEX export_one_active_run ON export_runs(status) WHERE status='active'")
    connection.execute("""CREATE TABLE export_run_items (
        run_id TEXT NOT NULL REFERENCES export_runs(run_id),
        position INTEGER NOT NULL CHECK (position >= 0),
        asset_id TEXT NOT NULL,
        queue_id INTEGER NOT NULL,
        frozen_revision INTEGER NOT NULL CHECK (frozen_revision >= 1),
        recipe_version INTEGER NOT NULL,
        processing_version TEXT NOT NULL,
        frozen_recipe_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('waiting', 'encoding', 'registering', 'succeeded', 'failed')),
        error_code TEXT,
        registered_asset_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, position),
        UNIQUE (run_id, asset_id)
    )""")
    connection.execute("""CREATE UNIQUE INDEX export_one_active_asset ON export_run_items(asset_id)
        WHERE status IN ('waiting', 'encoding', 'registering')""")


def _create_v4(connection: sqlite3.Connection) -> None:
    # Rebuild CHECK constraints in the existing migration transaction; never disable foreign keys.
    connection.execute("SELECT run_id, position, asset_id, queue_id, frozen_revision, recipe_version, processing_version, frozen_recipe_json, status, error_code, registered_asset_id, updated_at FROM export_run_items LIMIT 0")
    for table in ("export_runs", "export_run_items"):
        sql = connection.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
        sql = sql.replace(table, table + "_v4", 1)
        if table == "export_runs":
            sql = sql.replace("'completed', 'failed'", "'completed', 'failed', 'stopped'")
            sql = sql[:-1] + ", stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0,1)), current_position INTEGER)"
        else:
            sql = sql.replace("REFERENCES export_runs(", "REFERENCES export_runs_v4(")
            sql = sql.replace("'succeeded', 'failed'", "'succeeded', 'failed', 'released'")
        connection.execute(sql)
    connection.execute("INSERT INTO export_runs_v4 SELECT *, 0, NULL FROM export_runs")
    connection.execute("INSERT INTO export_run_items_v4 SELECT * FROM export_run_items")
    connection.execute("""UPDATE export_runs_v4 SET current_position=(SELECT position FROM export_run_items
        WHERE export_run_items.run_id=export_runs_v4.run_id AND status IN ('encoding','registering'))""")
    connection.execute("DROP TABLE export_run_items")
    connection.execute("DROP TABLE export_runs")
    connection.execute("ALTER TABLE export_runs_v4 RENAME TO export_runs")
    connection.execute("ALTER TABLE export_run_items_v4 RENAME TO export_run_items")
    connection.execute("CREATE UNIQUE INDEX export_one_active_run ON export_runs(status) WHERE status='active'")
    connection.execute("CREATE UNIQUE INDEX export_one_active_asset ON export_run_items(asset_id) WHERE status IN ('waiting','encoding','registering')")


MIGRATIONS = {0: _create_v1, 1: _create_v2, 2: _create_v3, 3: _create_v4}


def _queue_log(event: str, *, level: str = "info", **context) -> None:
    try:
        backend_logger.add(level=level, component="exportQueue", event=event, context=context)
    except Exception:
        # Diagnostics must never turn a committed queue/save operation into a failure.
        pass


def _migrate(connection: sqlite3.Connection) -> None:
    connection.execute("BEGIN IMMEDIATE")
    try:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise UnsupportedSchema()
        while version < SCHEMA_VERSION:
            migration = MIGRATIONS.get(version)
            if migration is None:
                raise UnsupportedSchema()
            migration(connection)
            version += 1
            connection.execute(f"PRAGMA user_version={version}")
        connection.commit()
    except Exception:
        connection.rollback()
        raise


@contextmanager
def _connection():
    try:
        connection = sqlite3.connect(DB_PATH, timeout=3.0, isolation_level=None)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA busy_timeout=3000")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise UnsupportedSchema()
            mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
            if mode.lower() != "wal":
                raise StoreUnavailable()
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA foreign_keys=ON")
            if version < SCHEMA_VERSION:
                _migrate(connection)
            yield connection
        finally:
            connection.close()
    except sqlite3.Error as error:
        raise StoreUnavailable() from error


def initialize_database() -> None:
    """Run the existing schema initialization only after storage.py validates existing files."""
    try:
        with _connection():
            pass
    except StoreUnavailable as error:
        raise StorageInitializationError(error.code) from None


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _snapshot(row: sqlite3.Row, asset_id: UUID) -> dict:
    try:
        state = {
            "stateFormatVersion": row["state_format_version"],
            "recipeVersion": row["recipe_version"],
            "processingVersion": row["processing_version"],
            "currentRecipe": json.loads(row["current_recipe_json"]),
            "history": json.loads(row["history_json"]),
            "historyCursor": row["history_cursor"],
            "sourceIdentity": json.loads(row["source_identity_json"]),
        }
        return validate_snapshot(state, asset_id)
    except (ValueError, TypeError, KeyError, IndexError, RecursionError, InvalidEditState) as error:
        raise StoreUnavailable() from error


def _result(row: sqlite3.Row, asset_id: UUID) -> dict:
    try:
        return {
            "state": _snapshot(row, asset_id),
            "revision": row["revision"],
            "updatedAt": row["updated_at"],
            "lastSaveId": row["last_save_id"],
        }
    except (IndexError, KeyError, TypeError, ValueError, RecursionError) as error:
        raise StoreUnavailable() from error


def get_edit_state(asset_id: UUID) -> dict:
    with _connection() as connection:
        row = connection.execute("SELECT * FROM asset_edit_states WHERE asset_id=?", (str(asset_id),)).fetchone()
        return {"state": None} if row is None else _result(row, asset_id)


def get_edit_statuses(asset_ids: list[UUID]) -> dict[str, bool]:
    result = {str(asset_id): False for asset_id in asset_ids}
    if not asset_ids:
        return result
    # Read all requested rows together; validate stored data before certifying any status.
    placeholders = ",".join("?" for _ in asset_ids)
    with _connection() as connection:
        rows = connection.execute(
            f"""SELECT asset_id, state_format_version, recipe_version, processing_version,
            current_recipe_json, history_json, history_cursor, source_identity_json
            FROM asset_edit_states WHERE asset_id IN ({placeholders})""", tuple(result)
        )
        for row in rows:
            asset_id = UUID(row["asset_id"])
            result[str(asset_id)] = has_non_default_recipe(_snapshot(row, asset_id))
    return result


def put_edit_state(asset_id: UUID, expected_revision: int, save_id: UUID, state: dict) -> dict:
    validate_snapshot(state, asset_id)
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    fields = (
        state["stateFormatVersion"], state["recipeVersion"], state["processingVersion"],
        _json(state["currentRecipe"]), _json(state["history"]), state["historyCursor"],
        _json(state["sourceIdentity"]),
    )
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            row = connection.execute("SELECT * FROM asset_edit_states WHERE asset_id=?", (str(asset_id),)).fetchone()
            if row is not None and row["last_save_id"] == str(save_id):
                if expected_revision != row["revision"] - 1 or _snapshot(row, asset_id) != state:
                    raise StoreConflict("save_id_reused")
                connection.commit()
                return _result(row, asset_id)
            if row is None:
                if expected_revision != 0:
                    raise StoreConflict()
                connection.execute(
                    "INSERT INTO asset_edit_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                    (str(asset_id), *fields, now, str(save_id)),
                )
            else:
                if row["revision"] != expected_revision:
                    raise StoreConflict()
                changed = connection.execute(
                    """UPDATE asset_edit_states SET state_format_version=?, recipe_version=?,
                    processing_version=?, current_recipe_json=?, history_json=?, history_cursor=?,
                    source_identity_json=?, revision=revision+1, updated_at=?, last_save_id=?
                    WHERE asset_id=? AND revision=?""",
                    (*fields, now, str(save_id), str(asset_id), expected_revision),
                ).rowcount
                if changed != 1:
                    raise StoreConflict()
            removed = 0
            # Frozen active work survives later edits, even a default Recipe save.
            # Replay/conflict branches above must not mutate a queue changed since that save.
            if not has_non_default_recipe(state):
                removed = connection.execute("""DELETE FROM export_queue WHERE asset_id=?
                    AND status IN ('queued', 'failed')""", (str(asset_id),)).rowcount
            result = connection.execute("SELECT * FROM asset_edit_states WHERE asset_id=?", (str(asset_id),)).fetchone()
            connection.commit()
            if removed:
                _queue_log("removedNoEdits", assetId=str(asset_id), revision=result["revision"], count=removed)
            return _result(result, asset_id)
        except Exception:
            connection.rollback()
            raise


def _queue_items(connection: sqlite3.Connection) -> list[dict]:
    items = []
    for row in connection.execute("SELECT asset_id, status, queued_at, updated_at FROM export_queue ORDER BY id"):
        try:
            asset_id = str(UUID(row["asset_id"]))
            if asset_id != row["asset_id"] or row["status"] not in QUEUE_STATUSES:
                raise ValueError()
            for key in ("queued_at", "updated_at"):
                timestamp = row[key]
                parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                if parsed.tzinfo is None or not timestamp.endswith("Z") \
                    or parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") != timestamp:
                    raise ValueError()
            items.append({"assetId": asset_id, "status": row["status"],
                          "queuedAt": row["queued_at"], "updatedAt": row["updated_at"]})
        except (ValueError, TypeError, AttributeError, KeyError, IndexError) as error:
            raise StoreUnavailable() from error
    return items


def list_export_queue() -> list[dict]:
    try:
        with _connection() as connection:
            return _queue_items(connection)
    except StoreUnavailable as error:
        _queue_log("listFailed", level="error", errorCode=error.code)
        raise


def enqueue_export_assets(asset_ids: list[UUID]) -> list[dict]:
    started = monotonic()
    try:
        if len(set(asset_ids)) != len(asset_ids):
            raise QueueRejected("duplicate_asset_ids")
        if not 1 <= len(asset_ids) <= 100:
            raise QueueRejected("invalid_asset_ids")
        with _connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                placeholders = ",".join("?" for _ in asset_ids)
                ids = [str(asset_id) for asset_id in asset_ids]
                rows = {row["asset_id"]: row for row in connection.execute(
                    f"SELECT * FROM asset_edit_states WHERE asset_id IN ({placeholders})", ids)}
                # Validate the entire batch under the writer lock before inserting any item.
                for asset_id in asset_ids:
                    row = rows.get(str(asset_id))
                    if row is None or not has_non_default_recipe(_snapshot(row, asset_id)):
                        raise QueueRejected("asset_not_eligible")
                now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                added = 0
                for asset_id in ids:
                    added += connection.execute("""INSERT INTO export_queue (asset_id, status, queued_at, updated_at)
                        VALUES (?, 'queued', ?, ?) ON CONFLICT(asset_id) DO NOTHING""", (asset_id, now, now)).rowcount
                items = _queue_items(connection)
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        _queue_log("enqueued", count=len(asset_ids), addedCount=added, durationMs=round((monotonic() - started) * 1000))
        return items
    except (QueueRejected, StoreUnavailable) as error:
        _queue_log("enqueueFailed", level="error" if isinstance(error, StoreUnavailable) else "warn",
                   count=len(asset_ids), errorCode=error.code)
        raise


def dequeue_export_asset(asset_id: UUID) -> None:
    try:
        with _connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute("SELECT status FROM export_queue WHERE asset_id=?", (str(asset_id),)).fetchone()
                if row is not None:
                    if row["status"] not in QUEUE_STATUSES:
                        raise StoreUnavailable()
                    if row["status"] not in ("queued", "failed"):
                        raise QueueRejected("queue_item_locked")
                    connection.execute("DELETE FROM export_queue WHERE asset_id=?", (str(asset_id),))
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        _queue_log("dequeued", assetId=str(asset_id), count=int(row is not None))
    except (QueueRejected, StoreUnavailable) as error:
        _queue_log("dequeueFailed", level="error" if isinstance(error, StoreUnavailable) else "warn",
                   assetId=str(asset_id), errorCode=error.code)
        raise
