"""Single-row SQLite persistence for one Immich asset's complete edit state."""

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from edit_state import InvalidEditState, validate_snapshot

DB_PATH = Path("/data/genzoroom.db")
SCHEMA_VERSION = 1

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


MIGRATIONS = {0: _create_v1}


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
            if version < SCHEMA_VERSION:
                _migrate(connection)
            yield connection
        finally:
            connection.close()
    except sqlite3.Error as error:
        raise StoreUnavailable() from error


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
    except (ValueError, TypeError, KeyError, InvalidEditState) as error:
        raise StoreUnavailable() from error


def _result(row: sqlite3.Row, asset_id: UUID) -> dict:
    return {
        "state": _snapshot(row, asset_id),
        "revision": row["revision"],
        "updatedAt": row["updated_at"],
        "lastSaveId": row["last_save_id"],
    }


def get_edit_state(asset_id: UUID) -> dict:
    with _connection() as connection:
        row = connection.execute("SELECT * FROM asset_edit_states WHERE asset_id=?", (str(asset_id),)).fetchone()
        return {"state": None} if row is None else _result(row, asset_id)


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
            result = connection.execute("SELECT * FROM asset_edit_states WHERE asset_id=?", (str(asset_id),)).fetchone()
            connection.commit()
            return _result(result, asset_id)
        except Exception:
            connection.rollback()
            raise
