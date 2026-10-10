import asyncio
import copy
import json
import sqlite3
from contextlib import contextmanager
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
import pytest

import edit_store
from backend_logging import backend_logger
from edit_state import BOUNDS, FLAGS, has_edits, has_non_default_recipe, validate_snapshot
from main import app

A, B, C = (UUID(int=value) for value in (1, 2, 3))


def snapshot(asset_id=A, edited=True):
    recipe = {"version": 18, "adjustments": dict.fromkeys(BOUNDS, 0),
              **dict.fromkeys(FLAGS, True), "adjustmentEnabled": dict.fromkeys(BOUNDS, True)}
    if edited:
        recipe["adjustments"]["temperature"] = 12
    return {"stateFormatVersion": 2, "recipeVersion": 18, "processingVersion": "jpeg-preview-srgb8-v1",
            "currentRecipe": recipe, "history": [], "historyCursor": 0,
            "sourceIdentity": {"provider": "immich", "assetId": str(asset_id), "inputKind": "immich-preview"}}


def save(asset_id=A, edited=True, revision=0, save_id=None):
    return edit_store.put_edit_state(asset_id, revision, save_id or uuid4(), snapshot(asset_id, edited))


def request(method="GET", path="/export/queue", body=None):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            return await client.request(method, path, json=body)
    return asyncio.run(run())


def enqueue(*ids):
    return request("POST", body={"assetIds": [str(asset_id) for asset_id in ids]})


@pytest.fixture
def db(tmp_path, monkeypatch):
    # These tests inject a local DB; Linux mount validation is covered by storage tests.
    monkeypatch.setattr("main.initialize_storage", lambda: None)
    monkeypatch.setattr("main.validate_existing_database", lambda: None)
    monkeypatch.setattr("main.initialize_database", lambda: None)
    path = tmp_path / "genzoroom.db"
    monkeypatch.setattr(edit_store, "DB_PATH", path)
    return path


@contextmanager
def database(path):
    with sqlite3.connect(path) as connection:
        yield connection


def test_fresh_db_current_schema_and_empty_list(db):
    response = request()
    assert response.status_code == 200 and response.json() == {"items": []}
    with database(db) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == edit_store.SCHEMA_VERSION
        assert connection.execute("SELECT count(*) FROM asset_edit_states").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM export_queue").fetchone()[0] == 0


def test_v1_migration_preserves_every_edit_column_and_retry(db):
    state, save_id = snapshot(), uuid4()
    with database(db) as connection:
        connection.execute(edit_store.SCHEMA)
        connection.execute("PRAGMA user_version=1")
        connection.execute("INSERT INTO asset_edit_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                           (str(A), 2, 18, state["processingVersion"], json.dumps(state["currentRecipe"]), "[]", 0,
                            json.dumps(state["sourceIdentity"]), 7, "2026-10-06T01:02:03.000Z", str(save_id)))
        before = connection.execute("SELECT * FROM asset_edit_states").fetchone()
    assert request().json() == {"items": []}
    assert enqueue(A).status_code == 200
    assert edit_store.put_edit_state(A, 6, save_id, state)["revision"] == 7
    with database(db) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == edit_store.SCHEMA_VERSION
        assert connection.execute("SELECT * FROM asset_edit_states").fetchone() == before
    with patch("edit_store._migrate", side_effect=AssertionError("must not migrate again")):
        assert request().status_code == 200
        assert edit_store.get_edit_state(A)["revision"] == 7


def test_failed_v1_migration_rolls_back_schema_and_keeps_data(db):
    with database(db) as connection:
        connection.execute(edit_store.SCHEMA)
        connection.execute("CREATE TABLE export_queue (marker TEXT)")
        connection.execute("INSERT INTO export_queue VALUES ('keep')")
        connection.execute("PRAGMA user_version=1")
    assert request().status_code == 503
    with database(db) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 1
        assert connection.execute("SELECT marker FROM export_queue").fetchone()[0] == "keep"


def test_future_schema_is_refused_without_modification(db):
    with database(db) as connection:
        connection.execute("PRAGMA user_version=99")
    response = request()
    assert response.status_code == 503 and response.json()["detail"]["code"] == "unsupported_db_schema"
    with database(db) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 99
        assert connection.execute("SELECT name FROM sqlite_master WHERE name='export_queue'").fetchone() is None


def test_enqueue_order_timestamps_and_reenqueue_preserve_existing_state(db):
    for asset_id in (A, B, C):
        save(asset_id)
    first = enqueue(B, A)
    assert first.status_code == 200
    items = first.json()["items"]
    assert [item["assetId"] for item in items] == [str(B), str(A)]
    assert all(set(item) == {"assetId", "status", "queuedAt", "updatedAt"} for item in items)
    assert all(item["status"] == "queued" and item["queuedAt"].endswith("Z") for item in items)
    assert all(item["queuedAt"] == item["updatedAt"] for item in items)
    # Equal timestamps must not determine insertion order, and re-enqueue must preserve runtime status.
    assert items[0]["queuedAt"] == items[1]["queuedAt"]
    with database(db) as connection:
        connection.execute("UPDATE export_queue SET status='waiting' WHERE asset_id=?", (str(B),))
        before = connection.execute("SELECT * FROM export_queue ORDER BY id").fetchall()
    result = enqueue(A, C, B).json()["items"]
    assert [item["assetId"] for item in result] == [str(B), str(A), str(C)]
    assert result[0] == {**items[0], "status": "waiting"} and result[1] == items[1]
    with database(db) as connection:
        assert connection.execute("SELECT * FROM export_queue ORDER BY id LIMIT 2").fetchall() == before
    assert request().json()["items"] == result


@pytest.mark.parametrize("timestamp", [
    "2026-10-06T01:02:03.004+09:00",
    "2026-10-06T01:02:03.004+00:00",
])
def test_queue_get_rejects_noncanonical_non_utc_timestamps(db, timestamp):
    save(A)
    assert enqueue(A).status_code == 200
    with database(db) as connection:
        connection.execute("UPDATE export_queue SET queued_at=?, updated_at=?", (timestamp, timestamp))

    response = request()
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "persistence_unavailable"


@pytest.mark.parametrize("case", ["missing", "no_edits", "invalid"])
def test_ineligible_batch_is_atomic(db, case):
    save(A)
    if case != "missing":
        save(B, edited=case == "invalid")
    if case == "invalid":
        with database(db) as connection:
            connection.execute("UPDATE asset_edit_states SET current_recipe_json='{}' WHERE asset_id=?", (str(B),))
    response = enqueue(A, B)
    assert response.status_code == (503 if case == "invalid" else 422)
    assert response.json()["detail"]["code"] == ("persistence_unavailable" if case == "invalid" else "asset_not_eligible")
    assert request().json() == {"items": []}


def test_queue_eligibility_uses_current_recipe_with_or_without_history(db):
    non_default = snapshot(A)
    default_before = copy.deepcopy(non_default["currentRecipe"])
    changed = copy.deepcopy(default_before)
    changed["adjustments"]["temperature"] = 12
    non_default["history"] = [{"kind": "temperature", "before": default_before, "after": changed}]
    non_default["historyCursor"] = 1
    non_default["currentRecipe"] = changed

    reset_with_history = snapshot(B, edited=False)
    reset_after = copy.deepcopy(reset_with_history["currentRecipe"])
    reset_before = copy.deepcopy(reset_after)
    reset_before["adjustments"]["temperature"] = 12
    reset_with_history["history"] = [{"kind": "temperature", "before": reset_before, "after": reset_after}]
    reset_with_history["historyCursor"] = 1

    assert has_non_default_recipe(validate_snapshot(snapshot(A, edited=False), A)) is False
    assert has_non_default_recipe(validate_snapshot(non_default, A)) is True
    assert has_non_default_recipe(validate_snapshot(reset_with_history, B)) is False
    assert has_edits(validate_snapshot(reset_with_history, B)) is True

    edit_store.put_edit_state(A, 0, uuid4(), snapshot(A, edited=False))
    with pytest.raises(edit_store.QueueRejected) as no_history:
        edit_store.enqueue_export_assets([A])
    assert no_history.value.code == "asset_not_eligible"
    edit_store.put_edit_state(A, 1, uuid4(), non_default)
    assert enqueue(A).status_code == 200

    edit_store.put_edit_state(B, 0, uuid4(), reset_with_history)
    with pytest.raises(edit_store.QueueRejected) as with_history:
        edit_store.enqueue_export_assets([B])
    assert with_history.value.code == "asset_not_eligible"


@pytest.mark.parametrize("field", ["numeric", "category", "individual"])
def test_any_non_default_current_recipe_field_is_queue_eligible(db, field):
    state = snapshot(edited=False)
    if field == "numeric":
        state["currentRecipe"]["adjustments"]["temperature"] = 12
        state["currentRecipe"]["whiteBalanceEnabled"] = False
        state["currentRecipe"]["adjustmentEnabled"]["temperature"] = False
    elif field == "category":
        state["currentRecipe"]["whiteBalanceEnabled"] = False
    else:
        state["currentRecipe"]["adjustmentEnabled"]["temperature"] = False
    edit_store.put_edit_state(A, 0, uuid4(), state)
    assert enqueue(A).status_code == 200


def test_queue_eligibility_uses_disabled_recipe_flags_and_current_edits(db):
    state = snapshot(edited=False)
    state["currentRecipe"]["adjustmentEnabled"]["temperature"] = False
    edit_store.put_edit_state(A, 0, uuid4(), state)
    assert enqueue(A).status_code == 200
    state = snapshot(B, edited=False)
    before, after = copy.deepcopy(state["currentRecipe"]), copy.deepcopy(state["currentRecipe"])
    after["adjustments"]["temperature"] = 12
    state["history"] = [{"kind": "temperature", "before": before, "after": after}]
    state["historyCursor"] = 1
    state["currentRecipe"] = after
    edit_store.put_edit_state(B, 0, uuid4(), state)
    assert enqueue(B).status_code == 200


def test_duplicate_invalid_ids_limits_and_unexpected_fields(db):
    save(A)
    duplicate = request("POST", body={"assetIds": [str(A), str(A).upper()]})
    assert duplicate.status_code == 422 and duplicate.json()["detail"]["code"] == "duplicate_asset_ids"
    for body in ({}, {"assetIds": []}, {"assetIds": "bad"}, {"assetIds": ["not-uuid"]},
                 {"assetIds": [str(A)], "extra": 1}, {"assetIds": [str(uuid4()) for _ in range(101)]}):
        assert request("POST", body=body).status_code == 422
    assert request().json() == {"items": []}


@pytest.mark.parametrize("status", ["queued", "failed", "waiting", "encoding", "registering"])
def test_dequeue_status_rules(db, status):
    save(A)
    enqueue(A)
    with database(db) as connection:
        connection.execute("UPDATE export_queue SET status=?", (status,))
    assert request().json()["items"][0]["status"] == status
    response = request("DELETE", f"/export/queue/{A}")
    if status in ("queued", "failed"):
        assert response.status_code == 204 and not response.content
        assert request().json() == {"items": []}
    else:
        assert response.status_code == 409 and response.json()["detail"]["code"] == "queue_item_locked"
        assert request().json()["items"][0]["status"] == status


def test_missing_delete_is_idempotent_and_readding_goes_to_end(db):
    assert request("DELETE", f"/export/queue/{A}").status_code == 204
    save(A); save(B)
    enqueue(A, B)
    assert request("DELETE", f"/export/queue/{A}").status_code == 204
    assert request("DELETE", f"/export/queue/{A}").status_code == 204
    assert [item["assetId"] for item in enqueue(A).json()["items"]] == [str(B), str(A)]


def test_no_edit_save_cleanup_and_lost_response_replay(db):
    first = save()
    enqueue(A)
    save_id = uuid4()
    result = save(edited=False, revision=first["revision"], save_id=save_id)
    assert request().json() == {"items": []}
    assert save(edited=False, revision=1, save_id=save_id) == result
    assert edit_store.get_edit_state(A) == result


def test_reset_to_default_cleans_queue_even_when_history_is_retained(db):
    first = save()
    enqueue(A)
    state = snapshot(edited=False)
    before = copy.deepcopy(state["currentRecipe"])
    before["adjustments"]["temperature"] = 12
    state["history"] = [{"kind": "temperature", "before": before, "after": copy.deepcopy(state["currentRecipe"])}]
    state["historyCursor"] = 1
    assert has_edits(validate_snapshot(state, A)) is True
    saved = edit_store.put_edit_state(A, first["revision"], uuid4(), state)
    assert saved["revision"] == 2
    assert request().json() == {"items": []}
    assert has_non_default_recipe(saved["state"]) is False


def test_edited_update_conflict_reused_save_id_and_replay_do_not_mutate_queue(db):
    save_id = uuid4()
    first = save(save_id=save_id)
    enqueue(A)
    with database(db) as connection:
        connection.execute("UPDATE export_queue SET status='encoding'")
    before = request().json()
    assert save(save_id=save_id) == first
    with pytest.raises(edit_store.StoreConflict) as reused:
        save(edited=False, save_id=save_id)
    assert reused.value.code == "save_id_reused"
    with pytest.raises(edit_store.StoreConflict):
        save(edited=False, revision=0)
    assert request().json() == before
    assert save(revision=1)["revision"] == 2
    assert request().json() == before


def test_cleanup_failure_rolls_back_edit_save_and_queue_together(db):
    before = save()
    enqueue(A)
    with database(db) as connection:
        connection.execute("CREATE TRIGGER abort_cleanup BEFORE DELETE ON export_queue BEGIN SELECT RAISE(ABORT, 'test'); END")
    with pytest.raises(edit_store.StoreUnavailable):
        save(edited=False, revision=1)
    assert edit_store.get_edit_state(A) == before
    assert len(request().json()["items"]) == 1


def test_unavailable_is_never_empty_success(db, monkeypatch):
    monkeypatch.setattr(edit_store, "DB_PATH", db / "missing" / "db")
    for response in (request(), enqueue(A), request("DELETE", f"/export/queue/{A}")):
        assert response.status_code == 503 and response.json()["detail"]["code"] == "persistence_unavailable"


def test_corrupt_queue_timestamp_is_unavailable_and_failed_enqueue_is_atomic(db):
    save(A); save(B)
    enqueue(A)
    with database(db) as connection:
        connection.execute("UPDATE export_queue SET queued_at='not-date'")
    assert request().status_code == 503
    assert enqueue(B).status_code == 503
    with database(db) as connection:
        assert connection.execute("SELECT asset_id FROM export_queue").fetchall() == [(str(A),)]


def test_diagnostics_are_safe_and_logger_failure_cannot_fail_mutations(db):
    save()
    with patch.object(backend_logger, "add") as log:
        assert enqueue(A).status_code == 200
        assert request("DELETE", f"/export/queue/{A}").status_code == 204
        assert enqueue(A).status_code == 200
        save(edited=False, revision=1)
        events = {call.kwargs["event"] for call in log.call_args_list}
        assert {"enqueued", "dequeued", "removedNoEdits"} <= events
        assert all(set(call.kwargs["context"]) <= {"count", "addedCount", "durationMs", "assetId", "revision"}
                   for call in log.call_args_list)
    save(revision=2)
    with patch.object(backend_logger, "add", side_effect=RuntimeError("logger unavailable")):
        assert enqueue(A).status_code == 200
        assert request("DELETE", f"/export/queue/{A}").status_code == 204
        assert enqueue(A).status_code == 200
        assert save(edited=False, revision=3)["revision"] == 4
