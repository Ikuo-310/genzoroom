import asyncio
import copy
import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx

from edit_state import validate_snapshot
from edit_store import SCHEMA, SCHEMA_VERSION
from main import app

ASSET_ID = UUID("12345678-1234-4234-9234-123456789abc")
PATH = f"/assets/{ASSET_ID}/edit-state"
FLAGS = (
    "whiteBalanceEnabled", "basicEnabled", "colorGradingEnabled", "gradingShadowsEnabled",
    "gradingMidtonesEnabled", "gradingHighlightsEnabled", "colorEnabled",
)
ADJUSTMENTS = (
    "temperature", "tint", "exposure", "contrast", "highlights", "whites", "shadows", "blacks",
    "shadowsTemperature", "shadowsTint", "midtonesTemperature", "midtonesTint", "highlightsTemperature",
    "highlightsTint", "vibrance", "saturation",
)


def recipe(**changes):
    result = {"version": 17, "adjustments": {key: 0 for key in ADJUSTMENTS}}
    result.update({key: True for key in FLAGS})
    result["adjustments"].update(changes)
    return result


def state():
    before = recipe()
    after = recipe(temperature=12)
    return {
        "stateFormatVersion": 1, "recipeVersion": 17,
        "processingVersion": "jpeg-preview-srgb8-v1",
        "currentRecipe": after,
        "history": [{"kind": "temperature", "before": before, "after": after}],
        "historyCursor": 1,
        "sourceIdentity": {"provider": "immich", "assetId": str(ASSET_ID), "inputKind": "immich-preview"},
    }


def payload(snapshot=None, revision=0, save_id=None):
    return {"expectedRevision": revision, "saveId": str(save_id or uuid4()), **(snapshot or state())}


class EditStateApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.db_path = Path(self.directory.name) / "genzoroom.db"
        db_patch = patch("edit_store.DB_PATH", self.db_path)
        db_patch.start()
        self.addCleanup(db_patch.stop)

    @contextmanager
    def database(self):
        connection = sqlite3.connect(self.db_path)
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def request(self, method, body=None):
        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
                return await client.request(method, PATH, json=body)
        return asyncio.run(run())

    def code(self, response):
        return response.json()["detail"]["code"]

    def test_first_get_creates_schema_and_returns_null(self):
        response = self.request("GET")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"state": None})
        with self.database() as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(connection.execute("SELECT count(*) FROM asset_edit_states").fetchone()[0], 0)

    def test_initial_update_get_and_revision_increment(self):
        original = state()
        first = self.request("PUT", payload(original))
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["state"], original)
        self.assertEqual(first.json()["revision"], 1)
        self.assertTrue(first.json()["updatedAt"].endswith("Z"))
        self.assertEqual(self.request("GET").json(), first.json())
        second_state = copy.deepcopy(original)
        second_state["history"].append({"kind": "temperature", "before": recipe(temperature=12), "after": recipe(temperature=8)})
        second_state["currentRecipe"] = recipe(temperature=8)
        second_state["historyCursor"] = 2
        second = self.request("PUT", payload(second_state, revision=1))
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["revision"], 2)
        self.assertEqual(self.request("GET").json()["state"], second_state)

    def test_revision_conflict_and_save_id_retry(self):
        request = payload()
        first = self.request("PUT", request)
        retry = self.request("PUT", request)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json(), first.json())
        reused = copy.deepcopy(request)
        reused["currentRecipe"] = recipe(temperature=9)
        reused["history"][0]["after"] = recipe(temperature=9)
        response = self.request("PUT", reused)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.code(response), "save_id_reused")
        conflict = self.request("PUT", payload(revision=0))
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(self.code(conflict), "revision_conflict")
        second = self.request("PUT", payload(revision=1))
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["revision"], 2)
        stale_retry = self.request("PUT", request)
        self.assertEqual(stale_retry.status_code, 409)
        self.assertEqual(self.code(stale_retry), "revision_conflict")

    def test_reusing_save_id_with_a_different_expected_revision_is_rejected(self):
        request = payload()
        self.assertEqual(self.request("PUT", request).status_code, 200)
        request["expectedRevision"] = 1
        response = self.request("PUT", request)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.code(response), "save_id_reused")

    def test_initial_save_requires_expected_revision_zero(self):
        response = self.request("PUT", payload(revision=1))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.request("GET").json(), {"state": None})

    def test_versions_and_invalid_payload(self):
        for field, value, code in (
            ("stateFormatVersion", 2, "unsupported_state_format_version"),
            ("recipeVersion", 18, "unsupported_recipe_version"),
            ("processingVersion", "future", "unsupported_processing_version"),
        ):
            with self.subTest(field=field):
                invalid = payload()
                invalid[field] = value
                response = self.request("PUT", invalid)
                self.assertEqual(response.status_code, 422)
                self.assertEqual(self.code(response), code)
        invalid = payload()
        invalid["saveId"] = "not-uuid"
        self.assertEqual(self.request("PUT", invalid).status_code, 422)

    def test_invalid_recipe_history_cursor_and_identity(self):
        cases = []
        invalid = state(); invalid["currentRecipe"]["adjustments"]["exposure"] = 6
        cases.append((invalid, "invalid_recipe"))
        invalid = state(); invalid["history"][0]["kind"] = "unknown"
        cases.append((invalid, "invalid_history"))
        invalid = state(); invalid["history"].append({"kind": "temperature", "before": recipe(), "after": recipe(temperature=8)})
        cases.append((invalid, "history_discontinuity"))
        invalid = state(); invalid["historyCursor"] = 2
        cases.append((invalid, "invalid_history_cursor"))
        invalid = state(); invalid["currentRecipe"] = recipe(temperature=8)
        cases.append((invalid, "current_recipe_mismatch"))
        invalid = state(); invalid["sourceIdentity"]["assetId"] = str(uuid4())
        cases.append((invalid, "invalid_source_identity"))
        invalid = state(); invalid["sourceIdentity"]["checksum"] = "abc"
        cases.append((invalid, "invalid_source_identity"))
        invalid = state(); invalid["history"][0]["kind"] = "exposure"
        cases.append((invalid, "invalid_history_semantics"))
        for invalid, code in cases:
            with self.subTest(code=code):
                response = self.request("PUT", payload(invalid))
                self.assertEqual(response.status_code, 422)
                self.assertEqual(self.code(response), code)

    def test_huge_integer_is_rejected_without_changing_saved_state(self):
        original = self.request("PUT", payload()).json()
        invalid = state()
        invalid["currentRecipe"]["adjustments"]["temperature"] = 10**400
        response = self.request("PUT", payload(invalid, revision=1))
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.code(response), "invalid_recipe")
        self.assertEqual(self.request("GET").json(), original)

    def test_deeply_nested_json_is_rejected_without_changing_saved_state(self):
        original = self.request("PUT", payload()).json()
        encoded = json.dumps(payload(revision=1), separators=(",", ":")).encode()
        marker = b'"temperature":0'
        self.assertIn(marker, encoded)
        deeply_nested = b'[' * 20000 + b'0' + b']' * 20000
        body = encoded.replace(marker, b'"temperature":' + deeply_nested, 1)

        async def send():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
                return await client.put(PATH, content=body, headers={"content-type": "application/json"})

        response = asyncio.run(send())
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.code(response), "invalid_payload")
        self.assertEqual(self.request("GET").json(), original)

    def test_missing_column_in_version_one_database_returns_503_without_repair(self):
        schema = SCHEMA.replace("    history_cursor INTEGER NOT NULL CHECK (history_cursor >= 0),\n", "")
        with self.database() as connection:
            connection.executescript(schema)
            connection.execute("PRAGMA user_version=1")
            connection.execute(
                """INSERT INTO asset_edit_states (
                    asset_id, state_format_version, recipe_version, processing_version,
                    current_recipe_json, history_json, source_identity_json, revision, updated_at, last_save_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (str(ASSET_ID), 1, 17, "jpeg-preview-srgb8-v1", json.dumps(recipe(temperature=12)), "[]",
                 json.dumps(state()["sourceIdentity"]), 1, "2026-09-25T00:00:00Z", str(uuid4())),
            )

        with self.database() as connection:
            columns_before = connection.execute("PRAGMA table_info(asset_edit_states)").fetchall()
            row_before = connection.execute("SELECT * FROM asset_edit_states").fetchone()
        response = self.request("GET")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.code(response), "persistence_unavailable")
        self.assertTrue(self.db_path.exists())
        with self.database() as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(connection.execute("PRAGMA table_info(asset_edit_states)").fetchall(), columns_before)
            self.assertEqual(connection.execute("SELECT * FROM asset_edit_states").fetchone(), row_before)

    def test_checksum_pair_is_optional_and_preserved(self):
        saved = state()
        saved["sourceIdentity"].update({"checksum": "abc", "checksumKind": "original"})
        self.assertEqual(self.request("PUT", payload(saved)).status_code, 200)
        self.assertEqual(self.request("GET").json()["state"], saved)

    def test_failed_update_rolls_back_all_columns(self):
        first = self.request("PUT", payload()).json()
        with self.database() as connection:
            connection.execute("CREATE TRIGGER abort_edit BEFORE UPDATE ON asset_edit_states BEGIN SELECT RAISE(ABORT, 'test'); END")
        changed = state()
        changed["currentRecipe"] = recipe(temperature=8)
        changed["history"][0]["after"] = recipe(temperature=8)
        response = self.request("PUT", payload(changed, revision=1))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.request("GET").json(), first)

    def test_future_schema_is_preserved(self):
        with self.database() as connection:
            connection.execute("CREATE TABLE marker (value TEXT)")
            connection.execute("INSERT INTO marker VALUES ('keep')")
            connection.execute("PRAGMA user_version=99")
        response = self.request("GET")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.code(response), "unsupported_db_schema")
        self.assertEqual(self.request("PUT", payload()).status_code, 503)
        with self.database() as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 99)
            self.assertEqual(connection.execute("SELECT value FROM marker").fetchone()[0], "keep")

    def test_unknown_unversioned_table_is_not_replaced(self):
        with self.database() as connection:
            connection.execute("CREATE TABLE asset_edit_states (marker TEXT)")
            connection.execute("INSERT INTO asset_edit_states VALUES ('keep')")
        response = self.request("GET")
        self.assertEqual(response.status_code, 503)
        with self.database() as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT marker FROM asset_edit_states").fetchone()[0], "keep")

    def test_unavailable_db_is_not_reported_as_empty(self):
        with patch("edit_store.DB_PATH", Path(self.directory.name) / "missing" / "genzoroom.db"):
            response = self.request("GET")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(self.code(response), "persistence_unavailable")
            async def health():
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
                    return await client.get("/health")
            self.assertEqual(asyncio.run(health()).status_code, 200)

    def test_oversized_payload_returns_413_without_creating_db(self):
        async def send():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
                return await client.put(PATH, content=b" " * (8 * 1024 * 1024 + 1))
        response = asyncio.run(send())
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.code(response), "payload_too_large")
        self.assertFalse(self.db_path.exists())

    def test_corrupt_row_is_not_reported_as_empty(self):
        self.request("PUT", payload())
        with self.database() as connection:
            connection.execute("UPDATE asset_edit_states SET history_json='not-json'")
        response = self.request("GET")
        self.assertEqual(response.status_code, 503)

    def test_validation_accepts_empty_history_with_current_recipe(self):
        saved = state()
        saved["history"] = []
        saved["historyCursor"] = 0
        self.assertEqual(validate_snapshot(saved, ASSET_ID), saved)


if __name__ == "__main__":
    unittest.main()
