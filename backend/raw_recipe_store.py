"""RAW-only SQLite recipes; callers supply complete, confirmed engine readback.

This storage contract does not authorize engine compatibility or apply settings.
"""

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from uuid import UUID

from edit_store import StoreConflict, StoreUnavailable, _connection, _json

MAX_SETTINGS_BYTES = 256 * 1024
MAX_SETTINGS_DEPTH = 32
MAX_SETTINGS_NODES = 32768
MAX_REVISION = 2**63 - 1
IDENTITY_FIELDS = ("assetId", "sourceContentHash", "engineName", "engineVersion",
                   "engineCommit", "settingsSchemaVersion")
IDENTITY_COLUMNS = ("asset_id", "source_content_hash", "engine_name", "engine_version",
                    "engine_commit", "settings_schema_version")
KEY_WHERE = " AND ".join(f"{column}=?" for column in IDENTITY_COLUMNS)
PRIVATE_FIELDS = frozenset(("handle", "photoid", "path", "cachepath", "sourcepath", "fingerprint",
                            "sourcefingerprint", "documenttoken", "workspaceid", "credentials",
                            "authorization", "cookie", "rawhandle", "documenthandle", "originalpath",
                            "cachedir", "cachedirectory"))


class InvalidRawRecipe(ValueError):
    code = "invalid_raw_recipe"

    def __init__(self):
        super().__init__(self.code)


def _uuid(value):
    if not isinstance(value, (str, UUID)) or (isinstance(value, str) and len(value) > 45):
        raise InvalidRawRecipe()
    try:
        return str(UUID(str(value)))
    except ValueError:
        raise InvalidRawRecipe() from None


def normalize_identity(identity: dict) -> dict:
    if type(identity) is not dict or set(identity) != set(IDENTITY_FIELDS):
        raise InvalidRawRecipe()
    result = {**identity, "assetId": _uuid(identity["assetId"])}
    for field, pattern in (("sourceContentHash", r"[0-9a-fA-F]{16,128}"),
                           ("engineCommit", r"[0-9a-fA-F]{40}"),
                           ("engineName", r"[a-zA-Z][a-zA-Z0-9_.-]{0,63}")):
        value = identity[field]
        if not isinstance(value, str) or re.fullmatch(pattern, value) is None:
            raise InvalidRawRecipe()
        result[field] = value.lower()
    version = identity["engineVersion"]
    if not isinstance(version, str) or re.fullmatch(r"[0-9][a-zA-Z0-9.+-]{0,63}", version) is None:
        raise InvalidRawRecipe()
    # Engine version is opaque and case-sensitive; restoration decides compatibility later.
    schema = identity["settingsSchemaVersion"]
    if type(schema) is not int or not 1 <= schema <= 0xffffffff:
        raise InvalidRawRecipe()
    return {field: result[field] for field in IDENTITY_FIELDS}


def _settings_json(settings: dict, schema: int) -> str:
    nodes, string_bytes = 0, 0

    def visit(value, depth):
        nonlocal nodes, string_bytes
        nodes += 1
        if depth > MAX_SETTINGS_DEPTH or nodes > MAX_SETTINGS_NODES:
            raise InvalidRawRecipe()
        if type(value) is dict:
            for key, item in value.items():
                if not isinstance(key, str) or key.replace("_", "").lower() in PRIVATE_FIELDS:
                    raise InvalidRawRecipe()
                visit(key, depth + 1)
                visit(item, depth + 1)
        elif type(value) is list:
            for item in value:
                visit(item, depth + 1)
        elif type(value) is str:
            if len(value) > MAX_SETTINGS_BYTES:
                raise InvalidRawRecipe()
            string_bytes += len(value.encode("utf-8"))
            if string_bytes > MAX_SETTINGS_BYTES:
                raise InvalidRawRecipe()
        elif type(value) is float:
            if not math.isfinite(value):
                raise InvalidRawRecipe()
        elif type(value) is int:
            if abs(value) > 2**64 - 1:
                raise InvalidRawRecipe()
        elif value is not None and type(value) is not bool:
            raise InvalidRawRecipe()

    try:
        if type(settings) is not dict:
            raise InvalidRawRecipe()
        visit(settings, 0)
        if type(settings.get("version")) is not int or settings["version"] != schema:
            raise InvalidRawRecipe()
        process = settings.get("process")
        if type(process) is not int or not 0 <= process <= 0xffffffff:
            raise InvalidRawRecipe()
        wb = settings.get("wb")
        if type(wb) is not dict or wb.get("mode") not in (
                "asShot", "auto", "daylight", "cloudy", "shade", "tungsten", "fluorescent", "flash", "custom"):
            raise InvalidRawRecipe()
        if wb.get("scale", "legacy") not in ("legacy", "kelvin"):
            raise InvalidRawRecipe()
        if any(type(wb.get(field)) not in (int, float) for field in ("temp", "tint")):
            raise InvalidRawRecipe()
        # Preserve every field, including controls absent from the C2 UI; never project a Recipe v18.
        encoded = _json(settings)
        if len(encoded.encode("utf-8")) > MAX_SETTINGS_BYTES:
            raise InvalidRawRecipe()
        return encoded
    except (TypeError, ValueError, OverflowError, RecursionError, UnicodeError):
        raise InvalidRawRecipe() from None


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidRawRecipe()
        result[key] = value
    return result


def _request_hash(identity, settings_json, expected_revision):
    return hashlib.sha256(_json([identity, expected_revision, json.loads(settings_json)]).encode("utf-8")).hexdigest()


def _metadata(row):
    revision, updated = row["recipe_revision"], row["updated_at"]
    if type(revision) is not int or not 1 <= revision <= MAX_REVISION or not isinstance(updated, str):
        raise InvalidRawRecipe()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", updated) is None:
        raise InvalidRawRecipe()
    datetime.fromisoformat(updated)
    return revision, updated


def _result(identity, encoded, revision, save_id, updated):
    return {"recipe": {**identity, "settings": json.loads(encoded)}, "revision": revision,
            "lastSaveId": save_id, "updatedAt": updated}


def _read_row(connection, identity):
    row = connection.execute(f"SELECT * FROM asset_raw_recipes WHERE {KEY_WHERE}",
                             tuple(identity.values())).fetchone()
    if row is None:
        return None
    try:
        stored_identity = dict(zip(IDENTITY_FIELDS, (row[key] for key in IDENTITY_COLUMNS)))
        if normalize_identity(stored_identity) != stored_identity or stored_identity != identity:
            raise InvalidRawRecipe()
        encoded = row["develop_settings_json"]
        if not isinstance(encoded, str) or len(encoded.encode("utf-8")) > MAX_SETTINGS_BYTES:
            raise InvalidRawRecipe()
        settings = json.loads(encoded, object_pairs_hook=_pairs)
        encoded = _settings_json(settings, identity["settingsSchemaVersion"])
        revision, updated = _metadata(row)
        save_id = _uuid(row["last_save_id"])
        if save_id != row["last_save_id"]:
            raise InvalidRawRecipe()
        receipt = connection.execute("SELECT * FROM raw_recipe_saves WHERE save_id=?", (save_id,)).fetchone()
        if receipt is None or _metadata(receipt) != (revision, updated) or \
                receipt["request_hash"] != _request_hash(identity, encoded, revision - 1):
            raise InvalidRawRecipe()
        return _result(identity, encoded, revision, save_id, updated)
    except (ValueError, TypeError, KeyError, IndexError, RecursionError, UnicodeError):
        # Corrupt persisted content must not authorize an overwrite or leak its contents.
        raise StoreUnavailable() from None


def get_raw_recipe(identity: dict) -> dict:
    """Read an exact source/engine identity; no fallback, application or migration of settings."""
    identity = normalize_identity(identity)
    with _connection() as connection:
        # The recipe and its receipt must come from one SQLite read snapshot.
        connection.execute("BEGIN")
        try:
            result = _read_row(connection, identity)
            connection.commit()
            return {"recipe": None} if result is None else result
        except Exception:
            connection.rollback()
            raise


def put_raw_recipe(identity: dict, expected_revision: int, save_id: UUID | str, settings: dict) -> dict:
    """Atomically save confirmed readback; a saveId binds the entire normalized request forever."""
    identity = normalize_identity(identity)
    if type(expected_revision) is not int or not 0 <= expected_revision < MAX_REVISION:
        raise InvalidRawRecipe()
    save_id = _uuid(save_id)
    encoded = _settings_json(settings, identity["settingsSchemaVersion"])
    digest = _request_hash(identity, encoded, expected_revision)
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            current = _read_row(connection, identity)
            receipt = connection.execute("SELECT * FROM raw_recipe_saves WHERE save_id=?", (save_id,)).fetchone()
            if receipt is not None:
                try:
                    revision, updated = _metadata(receipt)
                    if re.fullmatch(r"[0-9a-f]{64}", receipt["request_hash"]) is None:
                        raise InvalidRawRecipe()
                except (TypeError, ValueError):
                    raise StoreUnavailable() from None
                if receipt["request_hash"] != digest:
                    raise StoreConflict("save_id_reused")
                if revision != expected_revision + 1 or current is None or current["revision"] < revision:
                    raise StoreUnavailable()
                connection.commit()
                # Return the original ack even after newer saves, without rolling the current row back.
                return _result(identity, encoded, revision, save_id, updated)
            if (0 if current is None else current["revision"]) != expected_revision:
                raise StoreConflict()
            revision = expected_revision + 1
            updated = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            connection.execute("INSERT INTO raw_recipe_saves VALUES (?, ?, ?, ?)",
                               (save_id, digest, revision, updated))
            if current is None:
                connection.execute("INSERT INTO asset_raw_recipes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                   (*identity.values(), encoded, revision, save_id, updated))
            else:
                changed = connection.execute(f"""UPDATE asset_raw_recipes SET develop_settings_json=?,
                    recipe_revision=?, last_save_id=?, updated_at=? WHERE {KEY_WHERE} AND recipe_revision=?""",
                    (encoded, revision, save_id, updated, *identity.values(), expected_revision)).rowcount
                if changed != 1:
                    raise StoreConflict()
            result = _read_row(connection, identity)
            connection.commit()
            return result
        except Exception:
            connection.rollback()
            raise
