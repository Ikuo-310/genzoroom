import asyncio
import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from contextlib import contextmanager
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
from edit_state import BOUNDS, FLAGS, has_edits, has_non_default_recipe, validate_snapshot
from edit_store import get_edit_statuses, put_edit_state
from main import app

CASES = json.loads((Path(__file__).resolve().parents[2] / 'frontend' / 'src' / 'test-fixtures' / 'edit-status.json').read_text())
ASSET = UUID('12345678-1234-4234-9234-123456789abc')


def snapshot(case):
    version = case.get('version', 18)
    recipe = {'version': version, 'adjustments': dict.fromkeys(BOUNDS, 0), **dict.fromkeys(FLAGS, True)}
    if version == 18:
        recipe['adjustmentEnabled'] = dict.fromkeys(BOUNDS, True)
    before = copy.deepcopy(recipe)
    recipe['adjustments'].update(case.get('adjustments', {}))
    recipe.update(case.get('flags', {}))
    if version == 18:
        recipe['adjustmentEnabled'].update(case.get('adjustmentEnabled', {}))
    after = copy.deepcopy(before)
    after['adjustments']['temperature'] = 12
    return {'stateFormatVersion': case.get('stateFormatVersion', 2), 'recipeVersion': version,
            'processingVersion': 'jpeg-preview-srgb8-v1', 'currentRecipe': recipe,
            'history': [{'kind': 'temperature', 'before': before, 'after': after}] if case.get('history') else [],
            'historyCursor': 0, 'sourceIdentity': {'provider': 'immich', 'assetId': str(ASSET), 'inputKind': 'immich-preview'}}


class EditStatusTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'edits.db'
        db_patch = patch('edit_store.DB_PATH', self.path)
        db_patch.start(); self.addCleanup(db_patch.stop)

    def request(self, body):
        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                return await client.post('/assets/edit-status', json=body)
        return asyncio.run(run())

    @contextmanager
    def database(self):
        connection = sqlite3.connect(self.path)
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def test_shared_cases_and_saved_initial_records(self):
        for case in CASES:
            with self.subTest(case=case['name']):
                state = validate_snapshot(snapshot(case), ASSET)
                self.assertEqual(has_edits(state), case['edited'])
                if case['name'] == 'redo-only':
                    self.assertTrue(has_edits(state))
                    self.assertFalse(has_non_default_recipe(state))
                # Replace only the test database row; production read never rewrites v17.
                if self.path.exists():
                    with self.database() as connection:
                        connection.execute('DELETE FROM asset_edit_states')
                put_edit_state(ASSET, 0, uuid4(), state)
                response = self.request({'assetIds': [str(ASSET)]})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {'edited': {str(ASSET): case.get('recipeEdited', case['edited'])}})
                with self.database() as connection:
                    self.assertEqual(connection.execute('SELECT recipe_version FROM asset_edit_states').fetchone()[0], case.get('version', 18))

    def test_all_numeric_and_enabled_fields(self):
        for key in BOUNDS:
            self.assertTrue(has_edits(validate_snapshot(snapshot({'adjustments': {key: 1}}))))
            self.assertTrue(has_edits(validate_snapshot(snapshot({'adjustmentEnabled': {key: False}}))))
        for key in FLAGS:
            self.assertTrue(has_edits(validate_snapshot(snapshot({'flags': {key: False}}))))

    def test_bulk_status_uses_current_recipe_independently_of_history(self):
        for non_default, history in [(False, False), (False, True), (True, False), (True, True)]:
            with self.subTest(non_default=non_default, history=history):
                state = snapshot({'history': history, 'adjustments': {'temperature': 12} if non_default else {}})
                if non_default and history:
                    state['historyCursor'] = 1
                if self.path.exists():
                    with self.database() as connection:
                        connection.execute('DELETE FROM asset_edit_states')
                put_edit_state(ASSET, 0, uuid4(), state)
                self.assertEqual(self.request({'assetIds': [str(ASSET)]}).json(),
                                 {'edited': {str(ASSET): non_default}})
                self.assertEqual(has_edits(validate_snapshot(state, ASSET)), non_default or history)

    def test_bulk_100_ids_missing_and_no_unrequested_results(self):
        put_edit_state(ASSET, 0, uuid4(), snapshot({'adjustments': {'temperature': 12}}))
        ids = [str(uuid4()) for _ in range(100)]
        response = self.request({'assetIds': ids})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'edited': dict.fromkeys(ids, False)})
        expected = {}
        for index, asset_id in enumerate(ids):
            saved = snapshot({'adjustments': {'exposure': 1}} if index % 2 else {})
            saved['sourceIdentity']['assetId'] = asset_id
            put_edit_state(UUID(asset_id), 0, uuid4(), saved)
            expected[asset_id] = bool(index % 2)
        self.assertEqual(self.request({'assetIds': ids}).json(), {'edited': expected})
        self.assertEqual(self.request({'assetIds': []}).json(), {'edited': {}})

    def test_invalid_ids_duplicates_and_limit(self):
        for body in [{'assetIds': ['invalid']}, {'assetIds': [str(ASSET), str(ASSET).upper()]},
                     {'assetIds': [str(uuid4()) for _ in range(101)]}, {'assetIds': 'wrong'},
                     {'assetIds': [1]}, {'assetIds': [], 'extra': 1}, {}]:
            self.assertEqual(self.request(body).status_code, 422)

    def test_unavailable_and_corrupt_database_do_not_return_false(self):
        with patch('edit_store.DB_PATH', self.path / 'missing' / 'db'):
            response = self.request({'assetIds': [str(ASSET)]})
            self.assertEqual(response.status_code, 503)
        put_edit_state(ASSET, 0, uuid4(), snapshot({}))
        with self.database() as connection:
            connection.execute("UPDATE asset_edit_states SET current_recipe_json='{}'")
        response = self.request({'assetIds': [str(ASSET)]})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('edited', response.json())

    def test_store_uses_one_parameterized_asset_query(self):
        from edit_store import _connection
        statements = []
        with _connection() as connection:
            connection.set_trace_callback(statements.append)
            with patch('edit_store._connection') as opened:
                opened.return_value.__enter__.return_value = connection
                self.assertEqual(len(get_edit_statuses([ASSET, uuid4()])), 2)
        queries = [sql for sql in statements if 'FROM asset_edit_states WHERE' in sql]
        self.assertEqual(len(queries), 1)
        self.assertIn(' IN (', queries[0])
