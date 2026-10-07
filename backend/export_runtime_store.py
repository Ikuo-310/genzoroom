"""Transactional run snapshots and owned Queue transitions; no image binaries."""

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from uuid import UUID, uuid4

from backend_logging import backend_logger
from edit_state import InvalidEditState, PROCESSING_VERSION, RECIPE_VERSION, _recipe, has_non_default_recipe
from edit_store import StoreUnavailable, _connection, _json, _queue_items, _snapshot


ACTIVE_ITEM_STATUSES = frozenset(("waiting", "encoding", "registering"))
FAILURE_CODES = frozenset(("source_fetch_failed", "source_not_jpeg", "family_context_failed",
                           "encoding_failed", "registration_failed", "invalid_registration_result",
                           "invalid_jpeg", "not_jpeg", "invalid_icc_profile", "unsupported_jpeg_color_space",
                           "jpeg_encode_failed", "invalid_export_filename", "invalid_export_timestamp",
                           "metadata_encode_failed", "metadata_too_large", "worker_failed"))


class RuntimeRejected(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def runtime_log(event: str, *, level="info", **context):
    try:
        backend_logger.add(level=level, component="exportRuntime", event=event, context=context)
    except Exception:
        # Logging is outside the consistency contract and must not affect committed work.
        pass


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _timestamp(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not value.endswith("Z") or parsed.tzinfo is None \
            or parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") != value:
        raise ValueError("invalid_timestamp")
    return value


@dataclass(frozen=True)
class ExportRunItem:
    position: int
    asset_id: UUID
    queue_id: int
    frozen_revision: int
    recipe_version: int
    processing_version: str
    recipe: dict
    status: str
    error_code: str | None
    registered_asset_id: UUID | None
    updated_at: str


@dataclass(frozen=True)
class ExportRun:
    run_id: UUID
    status: str
    worker_id: UUID | None
    created_at: str
    updated_at: str
    items: tuple[ExportRunItem, ...]
    stop_requested: bool
    current_position: int | None


def _read_run(connection, run_id):
    row = connection.execute("SELECT * FROM export_runs WHERE run_id=?", (str(run_id),)).fetchone()
    if row is None:
        raise RuntimeRejected("run_not_found")
    try:
        if row["status"] not in ("active", "completed", "failed", "stopped") or row["stop_requested"] not in (0, 1):
            raise ValueError()
        items = []
        for item in connection.execute("SELECT * FROM export_run_items WHERE run_id=? ORDER BY position", (str(run_id),)):
            recipe = _recipe(json.loads(item["frozen_recipe_json"]), RECIPE_VERSION)
            if item["position"] != len(items) or item["frozen_revision"] < 1 or item["queue_id"] < 1 \
                    or item["recipe_version"] != RECIPE_VERSION or item["processing_version"] != PROCESSING_VERSION \
                    or item["status"] not in (*ACTIVE_ITEM_STATUSES, "succeeded", "failed", "released") \
                    or (item["status"] == "failed") != (item["error_code"] in FAILURE_CODES) \
                    or (item["status"] != "failed" and item["error_code"] is not None) \
                    or (item["status"] == "succeeded") != (item["registered_asset_id"] is not None):
                raise ValueError()
            items.append(ExportRunItem(item["position"], UUID(item["asset_id"]), item["queue_id"],
                                       item["frozen_revision"], item["recipe_version"], item["processing_version"],
                                       recipe, item["status"], item["error_code"],
                                       UUID(item["registered_asset_id"]) if item["registered_asset_id"] else None,
                                       _timestamp(item["updated_at"])))
        if not 1 <= len(items) <= 100 or len({item.asset_id for item in items}) != len(items):
            raise ValueError()
        active = any(item.status in ACTIVE_ITEM_STATUSES for item in items)
        if (row["status"] == "active") != active \
                or (row["status"] == "completed" and any(item.status != "succeeded" for item in items)) \
                or (row["status"] == "failed" and (not any(item.status == "failed" for item in items) or any(item.status == "released" for item in items))) \
                or (row["status"] == "stopped" and (not row["stop_requested"] or not any(item.status == "released" for item in items))) \
                or (any(item.status == "released" for item in items) and row["status"] != "stopped"):
            raise ValueError()
        current = row["current_position"]
        if current is not None and (type(current) is not int or not 0 <= current < len(items)
                                    or items[current].status not in ACTIVE_ITEM_STATUSES):
            raise ValueError()
        if not active and current is not None:
            raise ValueError()
        if active and row["stop_requested"] and current is None:
            raise ValueError()
        released = next((item.position for item in items if item.status == "released"), None)
        if released is not None and any(item.status != "released" for item in items[released:]):
            raise ValueError()
        if active:
            first = next(item.position for item in items if item.status in ACTIVE_ITEM_STATUSES)
            if current is not None and current != first or items[first].status != "waiting" and current != first:
                raise ValueError()
            if any(item.status != "waiting" for item in items[first + 1:]):
                raise ValueError()
            for item in items[first:]:
                queue = connection.execute("SELECT id, status, updated_at FROM export_queue WHERE asset_id=?", (str(item.asset_id),)).fetchone()
                if queue is None or queue["id"] != item.queue_id or queue["status"] != item.status \
                        or queue["updated_at"] != item.updated_at:
                    raise ValueError()
        return ExportRun(UUID(row["run_id"]), row["status"], UUID(row["worker_id"]) if row["worker_id"] else None,
                         _timestamp(row["created_at"]), _timestamp(row["updated_at"]), tuple(items), bool(row["stop_requested"]), current)
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, RecursionError, InvalidEditState) as error:
        raise StoreUnavailable() from error


def get_export_run(run_id: UUID) -> ExportRun:
    with _connection() as connection:
        # Keep run lifecycle and its items on the same SQLite read snapshot.
        connection.execute("BEGIN")
        return _read_run(connection, run_id)


def recoverable_export_run() -> ExportRun | None:
    """Read a consistent checkpoint without claiming or replaying it."""
    with _connection() as connection:
        connection.execute("BEGIN")
        row = connection.execute("SELECT run_id FROM export_runs WHERE status='active'").fetchone()
        return _read_run(connection, row["run_id"]) if row else None


def create_export_run(asset_ids: list[UUID], *, worker_id: UUID | None = None) -> ExportRun:
    runtime_log("run.createStarted", level="debug", targetCount=len(asset_ids))
    try:
        if not 1 <= len(asset_ids) <= 100 or any(type(asset_id) is not UUID for asset_id in asset_ids):
            raise RuntimeRejected("invalid_asset_ids")
        if len(set(asset_ids)) != len(asset_ids):
            raise RuntimeRejected("duplicate_asset_ids")
        if worker_id is not None and type(worker_id) is not UUID:
            raise RuntimeRejected("invalid_worker_id")
        with _connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                if connection.execute("SELECT 1 FROM export_runs WHERE status='active'").fetchone():
                    raise RuntimeRejected("run_active")
                _queue_items(connection)
                snapshots = []
                for asset_id in asset_ids:
                    queue = connection.execute("SELECT * FROM export_queue WHERE asset_id=?", (str(asset_id),)).fetchone()
                    if queue is None:
                        raise RuntimeRejected("queue_item_missing")
                    if queue["status"] != "queued":
                        raise RuntimeRejected("queue_item_not_queued")
                    saved = connection.execute("SELECT * FROM asset_edit_states WHERE asset_id=?", (str(asset_id),)).fetchone()
                    if saved is None:
                        raise RuntimeRejected("saved_recipe_missing")
                    state = _snapshot(saved, asset_id)
                    if not has_non_default_recipe(state):
                        raise RuntimeRejected("asset_not_eligible")
                    if state["recipeVersion"] != RECIPE_VERSION:
                        raise RuntimeRejected("unsupported_recipe_version")
                    if type(saved["revision"]) is not int or saved["revision"] < 1:
                        raise StoreUnavailable()
                    snapshots.append((queue, saved, state))
                run_id, now = uuid4(), _now()
                connection.execute("INSERT INTO export_runs (run_id,status,worker_id,created_at,updated_at) VALUES (?, 'active', ?, ?, ?)",
                                   (str(run_id), str(worker_id) if worker_id else None, now, now))
                # Targets, frozen recipes and waiting locks become visible at one commit.
                for position, (queue, saved, state) in enumerate(snapshots):
                    inserted = connection.execute("""INSERT INTO export_run_items
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, NULL, ?)""",
                        (str(run_id), position, queue["asset_id"], queue["id"], saved["revision"],
                         state["recipeVersion"], state["processingVersion"], _json(state["currentRecipe"]), now)).rowcount
                    locked = connection.execute("UPDATE export_queue SET status='waiting', updated_at=? WHERE id=? AND status='queued'",
                                                (now, queue["id"])).rowcount
                    if inserted != 1 or locked != 1:
                        raise StoreUnavailable()
                result = _read_run(connection, run_id)
                connection.commit()
            except Exception:
                connection.rollback()
                raise
        runtime_log("run.created", runId=str(run_id), targetCount=len(asset_ids))
        return result
    except (RuntimeRejected, StoreUnavailable) as error:
        runtime_log("run.createFailed", level="error", errorCode=error.code, targetCount=len(asset_ids))
        raise


def claim_export_run(run_id: UUID, worker_id: UUID) -> None:
    if type(run_id) is not UUID or type(worker_id) is not UUID:
        raise RuntimeRejected("invalid_runtime_ownership")
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        run = _read_run(connection, run_id)
        if run.status != "active" or run.worker_id is not None:
            connection.rollback()
            raise RuntimeRejected("run_owned")
        if connection.execute("""UPDATE export_runs SET worker_id=?, updated_at=?
            WHERE run_id=? AND status='active' AND worker_id IS NULL""",
                              (str(worker_id), _now(), str(run_id))).rowcount != 1:
            connection.rollback()
            raise RuntimeRejected("run_owned")
        connection.commit()


def _owned_item(connection, run_id, asset_id, worker_id, expected):
    run = _read_run(connection, run_id)
    item = next((item for item in run.items if item.asset_id == asset_id), None)
    if run.status != "active" or run.worker_id != worker_id or item is None or item.status != expected:
        raise RuntimeRejected("stale_runtime_ownership")
    queue = connection.execute("SELECT id, status FROM export_queue WHERE asset_id=?", (str(asset_id),)).fetchone()
    if queue is None or queue["id"] != item.queue_id or queue["status"] != expected:
        raise RuntimeRejected("stale_runtime_ownership")
    # Even an owned worker cannot process the next item before its predecessor is terminal.
    if any(previous.status in ACTIVE_ITEM_STATUSES for previous in run.items[:item.position]):
        raise RuntimeRejected("item_out_of_order")
    return item


def _change_item(run_id, asset_id, worker_id, expected, target, *, error_code=None, registered_asset_id=None):
    if any(type(value) is not UUID for value in (run_id, asset_id, worker_id)):
        raise RuntimeRejected("invalid_runtime_ownership")
    allowed = (expected, target) in (("waiting", "encoding"), ("encoding", "registering"), ("registering", "succeeded")) \
        or (expected in ACTIVE_ITEM_STATUSES and target == "failed")
    if not allowed:
        raise RuntimeRejected("invalid_runtime_transition")
    if (target == "failed" and error_code not in FAILURE_CODES) or (target != "failed" and error_code is not None) \
            or (target == "succeeded" and type(registered_asset_id) is not UUID) \
            or (target != "succeeded" and registered_asset_id is not None):
        raise RuntimeRejected("invalid_completion")
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            item = _owned_item(connection, run_id, asset_id, worker_id, expected)
            now = _now()
            run = _read_run(connection, run_id)
            if run.current_position is None:
                if run.stop_requested:
                    raise RuntimeRejected("stale_runtime_ownership")
                _write(connection, "UPDATE export_runs SET current_position=? WHERE run_id=?", (item.position, str(run_id)))
            elif run.current_position != item.position:
                raise RuntimeRejected("stale_runtime_ownership")
            if target == "succeeded":
                changed_queue = connection.execute("DELETE FROM export_queue WHERE id=? AND status='registering'", (item.queue_id,)).rowcount
            else:
                changed_queue = connection.execute("UPDATE export_queue SET status=?, updated_at=? WHERE id=? AND status=?",
                                                   (target, now, item.queue_id, expected)).rowcount
            changed_item = connection.execute("""UPDATE export_run_items SET status=?, error_code=?, registered_asset_id=?, updated_at=?
                WHERE run_id=? AND asset_id=? AND status=?""",
                (target, error_code, str(registered_asset_id) if registered_asset_id else None, now,
                 str(run_id), str(asset_id), expected)).rowcount
            # Zero-row writes must not certify a partial start/transition as committed work.
            if changed_queue != 1 or changed_item != 1:
                raise StoreUnavailable()
            terminal = target in ("succeeded", "failed")
            if terminal:
                _write(connection, "UPDATE export_runs SET current_position=NULL WHERE run_id=?", (str(run_id),))
                if run.stop_requested:
                    _release_waiting(connection, run_id, now)
            states = [row[0] for row in connection.execute("SELECT status FROM export_run_items WHERE run_id=?", (str(run_id),))]
            run_status = "active" if any(status in ACTIVE_ITEM_STATUSES for status in states) \
                else "stopped" if "released" in states else "failed" if "failed" in states else "completed"
            if connection.execute("UPDATE export_runs SET status=?, updated_at=? WHERE run_id=? AND status='active'",
                                  (run_status, now, str(run_id))).rowcount != 1:
                raise StoreUnavailable()
            _read_run(connection, run_id)
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    runtime_log("item.transition", runId=str(run_id), assetId=str(asset_id), fromStatus=expected, status=target)
    if target == "failed":
        runtime_log("item.failed", level="error", runId=str(run_id), assetId=str(asset_id), errorCode=error_code)
    if run_status != "active":
        if run.stop_requested:
            runtime_log("run.stopCompleted", runId=str(run_id), status=run_status)
        runtime_log("run.terminal", level="error" if run_status == "failed" else "info", runId=str(run_id), status=run_status)


def transition_export_item(run_id: UUID, asset_id: UUID, worker_id: UUID, expected: str, target: str):
    if target not in ("encoding", "registering"):
        raise RuntimeRejected("invalid_runtime_transition")
    _change_item(run_id, asset_id, worker_id, expected, target)


def fail_export_item(run_id: UUID, asset_id: UUID, worker_id: UUID, expected: str, error_code: str):
    _change_item(run_id, asset_id, worker_id, expected, "failed", error_code=error_code)


def complete_export_item(run_id: UUID, asset_id: UUID, worker_id: UUID, registered_asset_id: UUID):
    _change_item(run_id, asset_id, worker_id, "registering", "succeeded", registered_asset_id=registered_asset_id)


def _write(connection, sql, parameters):
    if connection.execute(sql, parameters).rowcount != 1:
        raise StoreUnavailable()


def _release_waiting(connection, run_id, now):
    # Called only with no current item, under the same write lock as Stop/completion.
    for item in connection.execute("SELECT * FROM export_run_items WHERE run_id=? AND status='waiting'", (str(run_id),)).fetchall():
        _write(connection, "UPDATE export_queue SET status='queued', updated_at=? WHERE id=? AND status='waiting'",
               (now, item["queue_id"]))
        _write(connection, "UPDATE export_run_items SET status='released', updated_at=? WHERE run_id=? AND position=? AND status='waiting'",
               (now, str(run_id), item["position"]))


def request_export_stop(run_id: UUID) -> ExportRun:
    if type(run_id) is not UUID:
        raise RuntimeRejected("invalid_run_id")
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            run = _read_run(connection, run_id)
            if run.stop_requested:
                return run
            if run.status != "active":
                raise RuntimeRejected("run_not_active")
            now = _now()
            _write(connection, "UPDATE export_runs SET stop_requested=1, updated_at=? WHERE run_id=? AND status='active'",
                   (now, str(run_id)))
            if run.current_position is None:
                _release_waiting(connection, run_id, now)
                _write(connection, "UPDATE export_runs SET status='stopped' WHERE run_id=?", (str(run_id),))
            result = _read_run(connection, run_id)
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    runtime_log("run.stopRequested", runId=str(run_id))
    if result.status == "stopped":
        runtime_log("run.stopCompleted", runId=str(run_id), status=result.status)
    return result


def begin_export_item(run_id: UUID, worker_id: UUID) -> ExportRunItem | None:
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            run = _read_run(connection, run_id)
            if run.worker_id != worker_id:
                raise RuntimeRejected("stale_runtime_ownership")
            if run.status != "active":
                return None
            if run.current_position is not None:
                return run.items[run.current_position]
            if run.stop_requested:
                raise StoreUnavailable()
            item = next(item for item in run.items if item.status in ACTIVE_ITEM_STATUSES)
            _write(connection, "UPDATE export_runs SET current_position=?, updated_at=? WHERE run_id=? AND current_position IS NULL",
                   (item.position, _now(), str(run_id)))
            _read_run(connection, run_id)
            connection.commit()
            return item
        except Exception:
            connection.rollback()
            raise


def reclaim_export_run(run_id: UUID, previous_worker: UUID | None, worker_id: UUID) -> ExportRun:
    if type(run_id) is not UUID or type(worker_id) is not UUID or previous_worker is not None and type(previous_worker) is not UUID:
        raise RuntimeRejected("invalid_runtime_ownership")
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            run = _read_run(connection, run_id)
            if run.status != "active" or run.worker_id != previous_worker or worker_id == previous_worker:
                raise RuntimeRejected("run_owned")
            now = _now()
            _write(connection, "UPDATE export_runs SET worker_id=?, updated_at=? WHERE run_id=? AND status='active' AND worker_id IS ?",
                   (str(worker_id), now, str(run_id), str(previous_worker) if previous_worker else None))
            # Artifacts are never persisted: regenerate even before replaying registration.
            if run.current_position is not None:
                item = run.items[run.current_position]
                if item.status != "waiting":
                    _write(connection, "UPDATE export_queue SET status='waiting', updated_at=? WHERE id=? AND status=?",
                           (now, item.queue_id, item.status))
                    _write(connection, "UPDATE export_run_items SET status='waiting', updated_at=? WHERE run_id=? AND position=? AND status=?",
                           (now, str(run_id), item.position, item.status))
            result = _read_run(connection, run_id)
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    runtime_log("recovery.claimed", runId=str(run_id), workerId=str(worker_id))
    return result


def retry_export_assets(asset_ids: list[UUID]) -> list[dict]:
    if not 1 <= len(asset_ids) <= 100 or any(type(asset_id) is not UUID for asset_id in asset_ids):
        raise RuntimeRejected("invalid_asset_ids")
    if len(set(asset_ids)) != len(asset_ids):
        raise RuntimeRejected("duplicate_asset_ids")
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            _queue_items(connection)
            targets = []
            for asset_id in asset_ids:
                queue = connection.execute("SELECT * FROM export_queue WHERE asset_id=?", (str(asset_id),)).fetchone()
                if queue is None or queue["status"] != "failed":
                    raise RuntimeRejected("queue_item_not_failed")
                saved = connection.execute("SELECT * FROM asset_edit_states WHERE asset_id=?", (str(asset_id),)).fetchone()
                if saved is None:
                    raise RuntimeRejected("saved_recipe_missing")
                state = _snapshot(saved, asset_id)
                if not has_non_default_recipe(state):
                    raise RuntimeRejected("asset_not_eligible")
                if state["recipeVersion"] != RECIPE_VERSION:
                    raise RuntimeRejected("unsupported_recipe_version")
                if connection.execute("SELECT 1 FROM export_run_items WHERE asset_id=? AND status IN ('waiting','encoding','registering')", (str(asset_id),)).fetchone():
                    raise StoreUnavailable()
                targets.append(queue["id"])
            now = _now()
            for queue_id in targets:
                _write(connection, "UPDATE export_queue SET status='queued', updated_at=? WHERE id=? AND status='failed'", (now, queue_id))
            result = _queue_items(connection)
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    for asset_id in asset_ids:
        runtime_log("item.retryQueued", assetId=str(asset_id))
    runtime_log("retry.batchCompleted", targetCount=len(asset_ids))
    return result
