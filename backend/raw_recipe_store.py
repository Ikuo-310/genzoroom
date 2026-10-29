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


def _import_defaults_fingerprint(value):
    if value is None:
        return None
    if type(value) is not str or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise InvalidRawRecipe()
    return value


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
        defaults_fingerprint = _import_defaults_fingerprint(row["import_defaults_fingerprint"])
        save_id = _uuid(row["last_save_id"])
        if save_id != row["last_save_id"]:
            raise InvalidRawRecipe()
        receipt = connection.execute("SELECT * FROM raw_recipe_saves WHERE save_id=?", (save_id,)).fetchone()
        if receipt is None or _metadata(receipt) != (revision, updated) or \
                receipt["request_hash"] != _request_hash(identity, encoded, revision - 1):
            raise InvalidRawRecipe()
        return _result(identity, encoded, revision, save_id, updated) | {
            "importDefaultsFingerprint": defaults_fingerprint}
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
            _read_history(connection, identity, result)
            connection.commit()
            return {"recipe": None} if result is None else result
        except Exception:
            connection.rollback()
            raise


RAW_EXPORT_PROCESSING_VERSION = "raw-lightcraft-v1"


def select_raw_export_state(connection, asset_id):
    """Share the badge's latest saved row and verified-default meaning under the caller's transaction."""
    row = connection.execute("""SELECT * FROM asset_raw_recipes WHERE asset_id=?
        ORDER BY updated_at DESC, recipe_revision DESC LIMIT 1""", (str(asset_id),)).fetchone()
    if row is None:
        return None
    identity = dict(zip(IDENTITY_FIELDS, (row[column] for column in IDENTITY_COLUMNS)))
    current = _read_row(connection, identity)
    history = _read_history(connection, identity, current)
    if current is None:
        raise StoreUnavailable()
    fingerprint = current.get("importDefaultsFingerprint")
    eligible = (_digest(_settings_json(current["recipe"]["settings"], identity["settingsSchemaVersion"])) != fingerprint
                if fingerprint is not None else None if history is None else
                _json(current["recipe"]["settings"]) != _json(history["baselineSettings"]))
    return {"currentRecipe": current["recipe"], "revision": current["revision"],
            "recipeVersion": identity["settingsSchemaVersion"],
            "processingVersion": RAW_EXPORT_PROCESSING_VERSION, "exportEligible": eligible}


def get_raw_edit_statuses(asset_ids: list[UUID]) -> dict[str, bool | None]:
    if not asset_ids:
        return {}
    with _connection() as connection:
        connection.execute("BEGIN")
        result = {}
        for asset_id in asset_ids:
            state = select_raw_export_state(connection, asset_id)
            result[str(asset_id)] = state["exportEligible"] if state is not None else False
        connection.commit()
        return result


def validate_raw_recipe(recipe: dict) -> dict:
    """Revalidate a DB recipe at the engine boundary using the C3-A format and limits."""
    if type(recipe) is not dict or set(recipe) != {*IDENTITY_FIELDS, "settings"}:
        raise InvalidRawRecipe()
    identity = normalize_identity({key: recipe[key] for key in IDENTITY_FIELDS})
    encoded = _settings_json(recipe["settings"], identity["settingsSchemaVersion"])
    return {**identity, "settings": json.loads(encoded)}


def lookup_raw_recipe(identity: dict) -> dict:
    """Find a recipe for the same source and settings schema, preferring the current tuple."""
    identity = normalize_identity(identity)
    with _connection() as connection:
        connection.execute("BEGIN")
        try:
            result = _read_row(connection, identity)
            _read_history(connection, identity, result)
            if result is not None:
                outcome = {"status": "matched", **result}
            else:
                candidates = connection.execute("""SELECT asset_id, source_content_hash, engine_name,
                    engine_version, engine_commit, settings_schema_version FROM asset_raw_recipes
                    WHERE asset_id=? AND source_content_hash=? AND engine_name=? AND settings_schema_version=?
                    ORDER BY updated_at DESC, recipe_revision DESC""",
                    (identity["assetId"], identity["sourceContentHash"], identity["engineName"],
                     identity["settingsSchemaVersion"])).fetchall()
                for row in candidates:
                    candidate_identity = dict(zip(IDENTITY_FIELDS, row))
                    candidate = _read_row(connection, candidate_identity)
                    if candidate is not None:
                        outcome = {"status": "matched", **candidate}
                        break
                else:
                    if connection.execute("""SELECT 1 FROM asset_raw_recipes
                            WHERE asset_id=? AND source_content_hash=? LIMIT 1""",
                            (identity["assetId"], identity["sourceContentHash"])).fetchone():
                        outcome = {"status": "engine_incompatible"}
                    elif connection.execute("SELECT 1 FROM asset_raw_recipes WHERE asset_id=? LIMIT 1",
                                            (identity["assetId"],)).fetchone():
                        outcome = {"status": "source_mismatch"}
                    else:
                        outcome = {"status": "none"}
            connection.commit()
            return outcome
        except Exception:
            connection.rollback()
            raise


def delete_raw_edits(asset_id: str) -> dict:
    """Atomically remove this Asset's persisted RAW Recipe and History rows."""
    asset_id = _uuid(asset_id)
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            recipe_receipts = {row[0] for row in connection.execute(
                "SELECT last_save_id FROM asset_raw_recipes WHERE asset_id=?", (asset_id,))}
            history_receipts = {row[0] for row in connection.execute(
                "SELECT save_id FROM raw_history_saves WHERE asset_id=?", (asset_id,))}
            steps = connection.execute("DELETE FROM asset_raw_history_steps WHERE asset_id=?", (asset_id,)).rowcount
            histories = connection.execute("DELETE FROM asset_raw_histories WHERE asset_id=?", (asset_id,)).rowcount
            history_saves = connection.execute("DELETE FROM raw_history_saves WHERE asset_id=?", (asset_id,)).rowcount
            recipes = connection.execute("DELETE FROM asset_raw_recipes WHERE asset_id=?", (asset_id,)).rowcount
            for save_id in recipe_receipts | history_receipts:
                connection.execute("DELETE FROM raw_recipe_saves WHERE save_id=?", (save_id,))
            connection.commit()
            return {"recipes": recipes, "histories": histories, "steps": steps,
                    "historyReceipts": history_saves}
        except Exception:
            connection.rollback()
            raise


def put_raw_recipe(identity: dict, expected_revision: int, save_id: UUID | str, settings: dict,
                   *, import_defaults_fingerprint: str | None = None) -> dict:
    """Atomically save confirmed readback; a saveId binds the entire normalized request forever."""
    identity = normalize_identity(identity)
    if type(expected_revision) is not int or not 0 <= expected_revision < MAX_REVISION:
        raise InvalidRawRecipe()
    save_id = _uuid(save_id)
    import_defaults_fingerprint = _import_defaults_fingerprint(import_defaults_fingerprint)
    encoded = _settings_json(settings, identity["settingsSchemaVersion"])
    digest = _request_hash(identity, encoded, expected_revision)
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            current = _read_row(connection, identity)
            history = _read_history(connection, identity, current)
            receipt = connection.execute("SELECT * FROM raw_recipe_saves WHERE save_id=?", (save_id,)).fetchone()
            if receipt is not None:
                if connection.execute("SELECT 1 FROM raw_history_saves WHERE save_id=?", (save_id,)).fetchone():
                    raise StoreConflict("save_id_reused")
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
                return _result(identity, encoded, revision, save_id, updated) | {
                    "importDefaultsFingerprint": current.get("importDefaultsFingerprint")}
            if (0 if current is None else current["revision"]) != expected_revision:
                raise StoreConflict()
            # A checkpoint may advance the receipt, but cannot rewrite an immutable History step.
            if history is not None and encoded != _settings_json(current["recipe"]["settings"], identity["settingsSchemaVersion"]):
                raise StoreConflict("raw_history_requires_operation")
            _write_recipe(connection, identity, current, expected_revision, save_id, encoded, digest,
                          import_defaults_fingerprint)
            result = _read_row(connection, identity)
            connection.commit()
            return result
        except Exception:
            connection.rollback()
            raise


def _write_recipe(connection, identity, current, expected_revision, save_id, encoded, digest,
                  import_defaults_fingerprint=None):
    """Share the existing CAS write without owning a second transaction."""
    revision = expected_revision + 1
    updated = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    connection.execute("INSERT INTO raw_recipe_saves VALUES (?, ?, ?, ?)",
                       (save_id, digest, revision, updated))
    if current is None:
        columns = ",".join((*IDENTITY_COLUMNS, "develop_settings_json", "recipe_revision", "last_save_id",
                            "updated_at", "import_defaults_fingerprint"))
        connection.execute(f"INSERT INTO asset_raw_recipes ({columns}) VALUES ({','.join(['?'] * 11)})",
                           (*identity.values(), encoded, revision, save_id, updated, import_defaults_fingerprint))
    else:
        changed = connection.execute(f"""UPDATE asset_raw_recipes SET develop_settings_json=?,
            recipe_revision=?, last_save_id=?, updated_at=?,
            import_defaults_fingerprint=COALESCE(import_defaults_fingerprint, ?)
            WHERE {KEY_WHERE} AND recipe_revision=?""",
            (encoded, revision, save_id, updated, import_defaults_fingerprint, *identity.values(), expected_revision)).rowcount
        if changed != 1:
            raise StoreConflict()
    return revision, updated


HISTORY_LIMIT = 200
MAX_HISTORY_METADATA_BYTES = 1024
MAX_HISTORY_RECEIPT_BYTES = 4096
HISTORY_CONTROLS = frozenset(("wb.temp", "wb.tint", "color.vibrance", "color.saturation",
                            "effects.texture", "effects.clarity", "effects.dehaze",
                            "vignette.amount", "vignette.midpoint", "vignette.feather", "vignette.roundness", "vignette.highlights",
                            "light.exposure", "light.contrast", "light.highlights", "light.whites",
                            "light.shadows", "light.blacks", "detail.sharpenAmount", "detail.sharpenMasking",
                            "detail.nrLuminance", "detail.nrDetail", "detail.nrColor", "detail.nrColorDetail",
                            "detail.nrColorSmoothness"))
HISTORY_SECTIONS = frozenset(("light", "color", "effects", "detail"))
HISTORY_RESET_SECTIONS = HISTORY_SECTIONS | {"vignette"}


class InvalidRawHistory(InvalidRawRecipe):
    code = "invalid_raw_history"


def _digest(encoded):
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _history_uuid(value):
    try:
        return _uuid(value)
    except InvalidRawRecipe:
        raise InvalidRawHistory() from None


def _history_metadata(kind, metadata):
    if type(kind) is not str or type(metadata) is not dict:
        raise InvalidRawHistory()
    if kind in ("control", "controlReset"):
        valid = set(metadata) == {"control"} and type(metadata["control"]) is str and metadata["control"] in HISTORY_CONTROLS
    elif kind == "sectionToggle":
        valid = (set(metadata) == {"section", "enabled"} and type(metadata["section"]) is str
                 and metadata["section"] in HISTORY_SECTIONS and type(metadata["enabled"]) is bool)
    elif kind == "sectionReset":
        valid = set(metadata) == {"section"} and type(metadata["section"]) is str and metadata["section"] in HISTORY_RESET_SECTIONS
    elif kind == "vignetteStyle":
        valid = (set(metadata) == {"style"} and type(metadata["style"]) is str
                 and metadata["style"] in ("highlightPriority", "colorPriority", "paintOverlay"))
    else:
        valid = kind in ("allReset", "wbAuto", "wbPick") and not metadata
    if not valid:
        raise InvalidRawHistory()
    encoded = _json(metadata)
    if len(encoded.encode("utf-8")) > MAX_HISTORY_METADATA_BYTES:
        raise InvalidRawHistory()
    return json.loads(encoded)


def _stored_json(encoded, limit):
    if type(encoded) is not str or len(encoded.encode("utf-8")) > limit:
        raise InvalidRawHistory()
    return json.loads(encoded, object_pairs_hook=_pairs)


def _stored_settings(encoded, schema):
    return json.loads(_settings_json(_stored_json(encoded, MAX_SETTINGS_BYTES), schema))


def _history_hash(history):
    # Receipts seal ordering and the rolling baseline without duplicating snapshot bodies.
    return _digest(_json([history["baselineSettings"], history["cursor"], [
        [step["stepId"], step["kind"], step["metadata"], _digest(_json(step["settings"])),
         step["createdAt"], step["saveId"]] for step in history["steps"]]]))


def _operation(operation):
    if type(operation) is not dict:
        raise InvalidRawHistory()
    if operation.get("type") == "initialize" and set(operation) == {"type"}:
        return {"type": "initialize"}
    if operation.get("type") == "append" and set(operation) == {"type", "kind", "metadata", "stepId"}:
        return {"type": "append", "kind": operation["kind"],
                "metadata": _history_metadata(operation["kind"], operation["metadata"]),
                "stepId": _history_uuid(operation["stepId"])}
    if operation.get("type") == "move" and set(operation) == {"type", "targetStepId"}:
        target = operation["targetStepId"]
        return {"type": "move", "targetStepId": None if target is None else _history_uuid(target)}
    raise InvalidRawHistory()


def _history_receipt(connection, save_id):
    row = connection.execute("SELECT * FROM raw_history_saves WHERE save_id=?", (save_id,)).fetchone()
    if row is None:
        return None
    try:
        if _history_uuid(row["save_id"]) != row["save_id"]:
            raise InvalidRawHistory()
        request = _stored_json(row["request_json"], MAX_HISTORY_RECEIPT_BYTES)
        keys = {"identity", "expectedRevision", "operation", "settingsFingerprint", "baselineFingerprint", "recipeRequestHash"}
        if type(request) is not dict or set(request) not in (keys, keys | {"requestFingerprint"}):
            raise InvalidRawHistory()
        if "requestFingerprint" in request:
            _request_fingerprint(request["requestFingerprint"])
        identity = normalize_identity(request["identity"])
        if identity != request["identity"] or any(row[column] != identity[field]
                                                for column, field in zip(IDENTITY_COLUMNS, IDENTITY_FIELDS)):
            raise InvalidRawHistory()
        expected = request["expectedRevision"]
        if type(expected) is not int or not 0 <= expected < MAX_REVISION or _operation(request["operation"]) != request["operation"]:
            raise InvalidRawHistory()
        if row["step_id"] != request["operation"].get("stepId"):
            raise InvalidRawHistory()
        for field in ("settingsFingerprint", "recipeRequestHash", "baselineFingerprint"):
            value = request[field]
            if field == "baselineFingerprint" and value is None:
                continue
            if type(value) is not str or re.fullmatch(r"[0-9a-f]{64}", value) is None:
                raise InvalidRawHistory()
        result = _stored_json(row["result_json"], MAX_HISTORY_RECEIPT_BYTES)
        if type(result) is not dict or set(result) != {
                "saveId", "revision", "updatedAt", "settingsFingerprint", "historyFingerprint",
                "historyCursor", "historyLength", "stepId", "changed"}:
            raise InvalidRawHistory()
        revision, updated = _metadata(row)
        if (revision != expected + 1 or result["revision"] != revision or result["updatedAt"] != updated
                or result["saveId"] != save_id or result["settingsFingerprint"] != request["settingsFingerprint"]
                or type(result["changed"]) is not bool):
            raise InvalidRawHistory()
        cursor, length = result["historyCursor"], result["historyLength"]
        if (type(result["revision"]) is not int or type(cursor) is not int or type(length) is not int
                or not 0 <= cursor <= length <= MAX_REVISION
                or type(result["historyFingerprint"]) is not str
                or re.fullmatch(r"[0-9a-f]{64}", result["historyFingerprint"]) is None):
            raise InvalidRawHistory()
        if cursor == 0:
            if result["stepId"] is not None:
                raise InvalidRawHistory()
        elif _history_uuid(result["stepId"]) != result["stepId"]:
            raise InvalidRawHistory()
        recipe_receipt = connection.execute("SELECT * FROM raw_recipe_saves WHERE save_id=?", (save_id,)).fetchone()
        if (recipe_receipt is None or _metadata(recipe_receipt) != (revision, updated)
                or recipe_receipt["request_hash"] != request["recipeRequestHash"]
                or _digest(_json(request)) != row["request_hash"]
                or _digest(_json(result)) != row["result_hash"]):
            raise InvalidRawHistory()
        return request, result
    except (ValueError, TypeError, KeyError, IndexError, RecursionError, UnicodeError):
        raise StoreUnavailable() from None


def _read_history(connection, identity, current):
    try:
        parent = connection.execute(f"SELECT * FROM asset_raw_histories WHERE {KEY_WHERE}", tuple(identity.values())).fetchone()
        if parent is None:
            # Missing parents must not turn a damaged initialized History into a legacy recipe.
            for table in ("asset_raw_history_steps", "raw_history_saves"):
                if connection.execute(f"SELECT 1 FROM {table} WHERE {KEY_WHERE} LIMIT 1", tuple(identity.values())).fetchone():
                    raise InvalidRawHistory()
            return None
        if current is None:
            raise InvalidRawHistory()
        history = {"baselineSettings": _stored_settings(parent["baseline_settings_json"], identity["settingsSchemaVersion"]),
                   "cursor": parent["history_cursor"], "steps": []}
        cursor = history["cursor"]
        if type(cursor) is not int or cursor < 0:
            raise InvalidRawHistory()
        rows = connection.execute(f"SELECT * FROM asset_raw_history_steps WHERE {KEY_WHERE} ORDER BY position",
                                  tuple(identity.values())).fetchmany(HISTORY_LIMIT + 1)
        if len(rows) > HISTORY_LIMIT or cursor > len(rows):
            raise InvalidRawHistory()
        seen = set()
        for position, row in enumerate(rows, 1):
            step_id = _history_uuid(row["step_id"])
            if row["position"] != position or type(row["position"]) is not int or step_id != row["step_id"] or step_id in seen:
                raise InvalidRawHistory()
            seen.add(step_id)
            metadata = _history_metadata(row["kind"], _stored_json(row["metadata_json"], MAX_HISTORY_METADATA_BYTES))
            step = {"stepId": step_id, "kind": row["kind"], "metadata": metadata,
                    "settings": _stored_settings(row["develop_settings_json"], identity["settingsSchemaVersion"]),
                    "createdAt": row["created_at"], "saveId": row["save_id"]}
            receipt = _history_receipt(connection, step["saveId"])
            if receipt is None:
                raise InvalidRawHistory()
            request, ack = receipt
            if (request["identity"] != identity or request["operation"] != {
                    "type": "append", "kind": step["kind"], "metadata": metadata, "stepId": step_id}
                    or request["settingsFingerprint"] != _digest(_json(step["settings"]))
                    or ack["revision"] > current["revision"] or ack["stepId"] != step_id
                    or not ack["changed"] or ack["updatedAt"] != step["createdAt"]):
                raise InvalidRawHistory()
            history["steps"].append(step)
        selected = history["steps"][cursor - 1]["settings"] if cursor else history["baselineSettings"]
        if _json(selected) != _json(current["recipe"]["settings"]):
            raise InvalidRawHistory()
        receipt = _history_receipt(connection, parent["last_save_id"])
        if receipt is None:
            raise InvalidRawHistory()
        request, ack = receipt
        if (request["identity"] != identity or ack["revision"] > current["revision"]
                or ack["settingsFingerprint"] != _digest(_json(selected))
                or ack["historyFingerprint"] != _history_hash(history)
                or ack["historyCursor"] != cursor or ack["historyLength"] != len(rows)
                or ack["stepId"] != (history["steps"][cursor - 1]["stepId"] if cursor else None)):
            raise InvalidRawHistory()
        return history
    except (ValueError, TypeError, KeyError, IndexError, RecursionError, UnicodeError):
        raise StoreUnavailable() from None


def get_raw_history(identity: dict, *, initial_settings: dict | None = None) -> dict:
    """Read a verified History; a legacy recipe supplies a baseline without creating rows."""
    identity = normalize_identity(identity)
    initial = None if initial_settings is None else json.loads(_settings_json(initial_settings, identity["settingsSchemaVersion"]))
    with _connection() as connection:
        connection.execute("BEGIN")
        try:
            current = _read_row(connection, identity)
            history = _read_history(connection, identity, current)
            initialized = history is not None
            if history is None:
                baseline = current["recipe"]["settings"] if current else initial
                history = None if baseline is None else {"baselineSettings": baseline, "cursor": 0, "steps": []}
            connection.commit()
            return {"recipe": None, "revision": 0, "history": history, "initialized": initialized} if current is None else {
                **current, "history": history, "initialized": initialized}
        except Exception:
            connection.rollback()
            raise


def initialize_raw_history(identity, expected_revision, save_id, settings, *, request_fingerprint=None,
                           import_defaults_fingerprint=None):
    """Persist a baseline checkpoint, not an invented editing operation."""
    return _save_history(identity, expected_revision, save_id, settings, {"type": "initialize"}, None,
                         request_fingerprint, import_defaults_fingerprint)


def append_raw_history(identity, expected_revision, save_id, settings, *, kind, metadata=None,
                       step_id=None, baseline_settings=None, request_fingerprint=None,
                       import_defaults_fingerprint=None):
    """Append one confirmed operation; supply the initial readback for an unsaved RAW."""
    operation = {"type": "append", "kind": kind, "metadata": {} if metadata is None else metadata,
                 "stepId": _history_uuid(save_id if step_id is None else step_id)}
    return _save_history(identity, expected_revision, save_id, settings, operation, baseline_settings,
                         request_fingerprint, import_defaults_fingerprint)


def move_raw_history_cursor(identity, expected_revision, save_id, settings, *, target_step_id, request_fingerprint=None,
                            import_defaults_fingerprint=None):
    """Confirm Undo/Redo/jump readback against a stable step UUID; None selects baseline."""
    return _save_history(identity, expected_revision, save_id, settings,
                         {"type": "move", "targetStepId": target_step_id}, None, request_fingerprint,
                         import_defaults_fingerprint)


def _history_summary(current, history):
    return {"revision": current["revision"], "historyCursor": history["cursor"],
            "historyLength": len(history["steps"]), "settingsFingerprint": _digest(_json(current["recipe"]["settings"]))}


def _request_fingerprint(value):
    if type(value) is not str or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise InvalidRawHistory()
    return value


def get_raw_history_save(identity, save_id, *, request_fingerprint):
    """Verify an HTTP retry without retaining or reconstructing its historical settings."""
    identity = normalize_identity(identity)
    save_id = _history_uuid(save_id)
    request_fingerprint = _request_fingerprint(request_fingerprint)
    with _connection() as connection:
        connection.execute("BEGIN")
        try:
            current = _read_row(connection, identity)
            history = _read_history(connection, identity, current)
            receipt = _history_receipt(connection, save_id)
            if receipt is None:
                if connection.execute("SELECT 1 FROM raw_recipe_saves WHERE save_id=?", (save_id,)).fetchone():
                    raise StoreConflict("save_id_reused")
                result = None
            else:
                if receipt[0]["identity"] != identity or receipt[0].get("requestFingerprint") != request_fingerprint:
                    raise StoreConflict("save_id_reused")
                if history is None or current["revision"] < receipt[1]["revision"]:
                    raise StoreUnavailable()
                result = {"ack": receipt[1], "current": _history_summary(current, history), "replayed": True}
            connection.commit()
            return result
        except Exception:
            connection.rollback()
            raise


def _save_history(identity, expected_revision, save_id, settings, operation, baseline_settings, request_fingerprint,
                  import_defaults_fingerprint=None):
    identity = normalize_identity(identity)
    if type(expected_revision) is not int or not 0 <= expected_revision < MAX_REVISION:
        raise InvalidRawHistory()
    save_id = _history_uuid(save_id)
    import_defaults_fingerprint = _import_defaults_fingerprint(import_defaults_fingerprint)
    operation = _operation(operation)
    encoded = _settings_json(settings, identity["settingsSchemaVersion"])
    baseline = None if baseline_settings is None else _settings_json(baseline_settings, identity["settingsSchemaVersion"])
    recipe_digest = _request_hash(identity, encoded, expected_revision)
    request = {"identity": identity, "expectedRevision": expected_revision, "operation": operation,
               "settingsFingerprint": _digest(encoded), "baselineFingerprint": None if baseline is None else _digest(baseline),
               "recipeRequestHash": recipe_digest}
    if request_fingerprint is not None:
        request["requestFingerprint"] = _request_fingerprint(request_fingerprint)
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            current = _read_row(connection, identity)
            history = _read_history(connection, identity, current)
            receipt = _history_receipt(connection, save_id)
            if receipt is not None:
                if receipt[0] != request:
                    raise StoreConflict("save_id_reused")
                if history is None or current["revision"] < receipt[1]["revision"]:
                    raise StoreUnavailable()
                connection.commit()
                # The immutable ack is historical; current metadata is explicitly separate.
                return {"ack": receipt[1], "current": _history_summary(current, history), "replayed": True}
            if connection.execute("SELECT 1 FROM raw_recipe_saves WHERE save_id=?", (save_id,)).fetchone():
                raise StoreConflict("save_id_reused")
            if (0 if current is None else current["revision"]) != expected_revision:
                raise StoreConflict()
            if history is None:
                if current:
                    initial = _json(current["recipe"]["settings"])
                    if baseline is not None and baseline != initial:
                        raise StoreConflict("raw_history_baseline_mismatch")
                else:
                    initial = encoded if operation["type"] == "initialize" else baseline
                    if initial is None:
                        raise InvalidRawHistory()
                history = {"baselineSettings": json.loads(initial), "cursor": 0, "steps": []}
            elif baseline is not None and baseline != _json(current["recipe"]["settings"]):
                raise StoreConflict("raw_history_baseline_mismatch")
            previous_steps = history["steps"][:]
            previous_settings = (history["steps"][history["cursor"] - 1]["settings"] if history["cursor"]
                                 else history["baselineSettings"])
            changed = False
            if operation["type"] == "append":
                if connection.execute("SELECT 1 FROM raw_history_saves WHERE step_id=?", (operation["stepId"],)).fetchone():
                    raise StoreConflict("raw_history_step_id_reused")
                if encoded != _json(previous_settings):
                    changed = True
                    history["steps"] = history["steps"][:history["cursor"]]
                    # Receipt timestamp is assigned below, in the same transaction as the recipe.
                    history["steps"].append({"stepId": operation["stepId"], "kind": operation["kind"],
                        "metadata": operation["metadata"], "settings": json.loads(encoded), "saveId": save_id, "createdAt": None})
                    excess = max(0, len(history["steps"]) - HISTORY_LIMIT)
                    if excess:
                        history["baselineSettings"] = history["steps"][excess - 1]["settings"]
                        history["steps"] = history["steps"][excess:]
                    history["cursor"] = len(history["steps"])
            elif operation["type"] == "move":
                target = operation["targetStepId"]
                positions = {step["stepId"]: i for i, step in enumerate(history["steps"], 1)}
                if target is not None and target not in positions:
                    raise StoreConflict("raw_history_target_missing")
                cursor = 0 if target is None else positions[target]
                selected = history["steps"][cursor - 1]["settings"] if cursor else history["baselineSettings"]
                if encoded != _json(selected):
                    raise StoreConflict("raw_history_readback_mismatch")
                changed = cursor != history["cursor"]
                history["cursor"] = cursor
            elif encoded != _json(previous_settings):
                raise StoreConflict("raw_history_readback_mismatch")
            # A no-op retains the Redo branch, but still receipts its saveId through the shared CAS.
            revision, updated = _write_recipe(connection, identity, current, expected_revision, save_id, encoded,
                                              recipe_digest, import_defaults_fingerprint)
            if changed and operation["type"] == "append":
                history["steps"][-1]["createdAt"] = updated
            ack = {"saveId": save_id, "revision": revision, "updatedAt": updated,
                   "settingsFingerprint": _digest(encoded), "historyFingerprint": _history_hash(history),
                   "historyCursor": history["cursor"], "historyLength": len(history["steps"]),
                   "stepId": history["steps"][history["cursor"] - 1]["stepId"] if history["cursor"] else None,
                   "changed": changed}
            columns = ",".join(IDENTITY_COLUMNS)
            connection.execute(f"INSERT INTO raw_history_saves ({columns},save_id,request_hash,request_json,result_json,result_hash,step_id,recipe_revision,updated_at) VALUES ({','.join(['?'] * 14)})",
                (*identity.values(), save_id, _digest(_json(request)), _json(request), _json(ack), _digest(_json(ack)),
                 operation.get("stepId"), revision, updated))
            connection.execute(f"""INSERT INTO asset_raw_histories VALUES ({','.join(['?'] * 9)})
                ON CONFLICT ({columns}) DO UPDATE SET baseline_settings_json=excluded.baseline_settings_json,
                    history_cursor=excluded.history_cursor, last_save_id=excluded.last_save_id""",
                (*identity.values(), _json(history["baselineSettings"]), history["cursor"], save_id))
            new_ids = {step["stepId"] for step in history["steps"]}
            old_ids = {step["stepId"] for step in previous_steps}
            old_positions = {step["stepId"]: position for position, step in enumerate(previous_steps, 1)}
            for step in previous_steps:
                if step["stepId"] not in new_ids:
                    connection.execute(f"DELETE FROM asset_raw_history_steps WHERE {KEY_WHERE} AND step_id=?",
                                       (*identity.values(), step["stepId"]))
            for position, step in enumerate(history["steps"], 1):
                if step["stepId"] in old_ids and old_positions[step["stepId"]] != position:
                    # Move retained positions downward in order so UNIQUE keys never collide.
                    connection.execute(f"UPDATE asset_raw_history_steps SET position=? WHERE {KEY_WHERE} AND step_id=?",
                                       (position, *identity.values(), step["stepId"]))
                elif step["stepId"] not in old_ids:
                    connection.execute(f"INSERT INTO asset_raw_history_steps VALUES ({','.join(['?'] * 13)})",
                        (*identity.values(), position, step["stepId"], step["kind"], _json(step["metadata"]),
                         _json(step["settings"]), step["createdAt"], step["saveId"]))
            result = _read_row(connection, identity)
            verified = _read_history(connection, identity, result)
            connection.commit()
            return {"ack": ack, "current": _history_summary(result, verified), "replayed": False}
        except Exception:
            connection.rollback()
            raise
