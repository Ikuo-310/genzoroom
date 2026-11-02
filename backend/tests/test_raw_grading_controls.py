import asyncio
import copy

import pytest

import raw_recipe_store as store
from lightcraft_mcp import LightCraftError
from raw_controls import CONTROLS, CONTROL_PATHS, validate_controls, control_location
from tests.test_windows_local import local, client
from tests.test_windows_raw_api import setup
from tests.test_raw_category_operations import open_history, patch, edit
from tests.test_raw_history_api import operation, body, url
from tests.test_raw_controls import identity
from tests.test_raw_recipe_api import headers
from tests.test_raw_recipe_restore import open_asset

SPECS = [(f"grading.{band}.{field}", lo, hi, 0) for band in ("shadows", "midtones", "highlights") for field, lo, hi in (("hue", 0, 360), ("sat", 0, 100), ("lum", -100, 100))] + [("grading.blending", 0, 100, 50), ("grading.balance", -100, 100, 0)]

@pytest.mark.parametrize('control,lo,hi,default', SPECS)
def test_grading_contract(control, lo, hi, default):
    assert CONTROLS[control] == (lo, hi, 1, default, 0)
    assert CONTROL_PATHS[control] == tuple(control.split('.'))
    assert control in store.HISTORY_CONTROLS
    for value in (lo, default, hi):
        assert validate_controls({control: value}, False) == {control: value}
    for value in (lo - 1, hi + 1, True, None, '50', float('nan'), float('inf'), -float('inf')):
        with pytest.raises(LightCraftError, match='raw_invalid_controls'):
            validate_controls({control: value}, True)


@pytest.mark.parametrize('control,lo,hi,default', SPECS)
def test_grading_history_reset_and_reopen(local, tmp_path, monkeypatch, control, lo, hi, default):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                child = children[0]
                original = copy.deepcopy(child.photos[child.active]['settings'])
                doc = await patch(http, doc, {control: 73})
                parent, key = control_location(child.photos[child.active]['settings'], control)
                assert parent[key] == 73
                assert ('develop.set', {'values': {control: 73}}) in child.commands
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': control}})
                doc = await edit(http, doc, 'controlReset', {'control': control})
                assert child.photos[child.active]['settings'] == original
                doc = await operation(http, doc, 'undo')
                assert doc['values'][control] == 73
                length = doc['history']['length']
                doc = await patch(http, doc, {control: 73})
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': control}})
                assert doc['history']['length'] == length and doc['history']['cursor'] == length - 1
                doc = await operation(http, doc, 'redo')
                assert doc['values'][control] == default
                doc = await patch(http, doc, {control: 91})
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': control}})
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert page['steps'][-1]['changes'] == [{'control': control, 'before': default, 'after': 91}]
                await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')
                _, response = await open_asset(http, doc['assetId'])
                assert response.status_code == 200, response.text
                doc = await operation(http, response.json(), 'initialize')
                assert doc['values'][control] == 91
        finally:
            await api.close()
    asyncio.run(run())


def test_grading_category_reset_preserves_global_and_undo(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                child = children[0]
                child.photos[child.active]['settings']['grading']['global'].update(hue=12, sat=7, lum=-2)
                doc = (await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))).json()
                values = {control: 73 for control, *_ in SPECS}
                doc = await patch(http, doc, values)
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': 'grading.blending'}})
                original = copy.deepcopy(child.photos[child.active]['settings'])
                doc = await edit(http, doc, 'sectionToggle', {'section': 'grading', 'enabled': False})
                assert not doc['sections']['grading'] and all(doc['values'][key] == 73 for key in values)
                doc = await edit(http, doc, 'sectionReset', {'section': 'grading'})
                assert all(doc['values'][control] == default for control, lo, hi, default in SPECS)
                assert child.photos[child.active]['settings']['grading']['global'] == original['grading']['global']
                assert not doc['sections']['grading']
                doc = await operation(http, doc, 'undo')
                assert all(doc['values'][key] == 73 for key in values)
                doc = await operation(http, doc, 'redo')
                assert doc['values']['grading.blending'] == 50
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('control', ['grading.global.hue', 'grading.unknown.hue', 'grading.shadows.unknown'])
def test_unexposed_grading_controls_are_rejected(control):
    with pytest.raises(LightCraftError, match='raw_invalid_controls'):
        validate_controls({control: 0}, True)
