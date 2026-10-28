import asyncio
import copy

import pytest

import raw_recipe_store as store
from edit_store import StoreUnavailable
from lightcraft_mcp import LightCraftError
from raw_controls import CONTROLS, CONTROL_PATHS, validate_controls
from tests.test_windows_local import local, client
from tests.test_windows_raw_api import setup
from tests.test_raw_category_operations import open_history, patch, edit
from tests.test_raw_history_api import operation, body, url
from tests.test_raw_controls import identity
from tests.test_raw_recipe_api import headers
from tests.test_raw_recipe_restore import open_asset


@pytest.mark.parametrize('control', ['vignette.style', 'grain.amount', 'grain.seed'])
def test_effects_does_not_publish_style_as_numeric_or_grain(control):
    with pytest.raises(LightCraftError, match='raw_invalid_controls'):
        validate_controls({control: 1}, True)


@pytest.mark.parametrize('control', ['effects.texture', 'effects.clarity', 'effects.dehaze'])
def test_effects_specs_and_boundaries(control):
    assert CONTROLS[control] == (-100, 100, 1, 0, 0)
    assert CONTROL_PATHS[control] == tuple(control.split('.'))
    for value in (-100, 0, 100):
        assert validate_controls({control: value}, False) == {control: value}
    for value in (-101, 101, True, None, '50', float('nan'), float('inf')):
        with pytest.raises(LightCraftError, match='raw_invalid_controls'):
            validate_controls({control: value}, True)


@pytest.mark.parametrize('control', ['effects.texture', 'effects.clarity', 'effects.dehaze'])
def test_effects_history_retry_reset_branch_reopen_and_hidden_values(local, tmp_path, monkeypatch, control):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                native = child.photos[child.active]['settings']
                native['vignette'].update(amount=-61, midpoint=39, feather=73, roundness=-24, highlights=67, style='paintOverlay')
                native['grain'].update(amount=46, size=83, roughness=28, seed=4294967295)
                doc = (await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))).json()
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': 'light.exposure'}})
                baseline = copy.deepcopy(native)
                seed_step = doc['history']['selectedStepId']
                doc = await patch(http, doc, {control: -73})
                assert doc['values'][control] == -73
                assert ('develop.set', {'values': {control: -73}}) in child.commands
                writer = store.append_raw_history
                monkeypatch.setattr(store, 'append_raw_history', lambda *a, **kw: (_ for _ in ()).throw(StoreUnavailable()))
                request = body(doc) | {'kind': 'control', 'metadata': {'control': control}}
                assert (await http.post(url(doc, 'commit'), json=request)).status_code >= 500
                attempts = api.raw.status().edits
                monkeypatch.setattr(store, 'append_raw_history', writer)
                doc = await operation(http, doc, 'commit', request)
                assert api.raw.status().edits == attempts
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert page['steps'][-1]['changes'] == [{'control': control, 'before': 0, 'after': -73}]
                doc = await edit(http, doc, 'controlReset', {'control': control})
                assert child.photos[child.active]['settings'] == baseline
                doc = await operation(http, doc, 'undo')
                length = doc['history']['length']
                doc = await patch(http, doc, {control: -73})
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': control}})
                assert doc['history']['length'] == length and doc['history']['cursor'] == length - 1
                doc = await operation(http, doc, 'redo')
                assert child.photos[child.active]['settings'] == baseline
                doc = await operation(http, doc, 'jump', body(doc) | {'targetStepId': seed_step})
                doc = await patch(http, doc, {control: 100})
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': control}})
                assert doc['history']['cursor'] == doc['history']['length'] == 2
                expected = copy.deepcopy(baseline)
                expected['effects'][control.split('.')[1]] = 100
                doc = await edit(http, doc, 'sectionToggle', {'section': 'effects', 'enabled': False})
                assert not doc['sections']['effects']
                assert child.photos[child.active]['settings'] == expected | {'disabled_sections': ['effects']}
                doc = await edit(http, doc, 'sectionToggle', {'section': 'effects', 'enabled': True})
                assert child.photos[child.active]['settings'] == expected
                doc = await patch(http, doc, {'effects.texture': 31, 'effects.clarity': -62, 'effects.dehaze': 93})
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': control}})
                doc = await edit(http, doc, 'sectionToggle', {'section': 'effects', 'enabled': False})
                before = copy.deepcopy(child.photos[child.active]['settings'])
                length = doc['history']['length']
                commands = len(child.commands)
                doc = await edit(http, doc, 'sectionReset', {'section': 'effects'})
                assert doc['history']['length'] == length + 1
                assert [name for name, _ in child.commands[commands:] if name.startswith('develop.') and name != 'develop.get'] == ['develop.resetSection']
                reset = baseline | {'disabled_sections': ['effects']}
                assert child.photos[child.active]['settings'] == reset
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert {change['control'] for change in page['steps'][-1]['changes']} == {
                    'effects.texture', 'effects.clarity', 'effects.dehaze'}
                doc = await operation(http, doc, 'undo')
                assert child.photos[child.active]['settings'] == before
                doc = await operation(http, doc, 'redo')
                assert child.photos[child.active]['settings'] == reset
                doc = await edit(http, doc, 'sectionReset', {'section': 'effects'})
                assert doc['history']['length'] == length + 1
                await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')
                _, response = await open_asset(http, doc['assetId'])
                assert response.status_code == 200, response.text
                doc = await operation(http, response.json(), 'initialize')
                assert not doc['sections']['effects']
                assert children[-1].photos[children[-1].active]['settings'] == reset
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('corrupt', ['vignette', 'grain', 'light', 'disabled_sections', 'boolean', 'unreset'])
def test_effects_section_reset_rejects_side_effects_and_restores(local, tmp_path, monkeypatch, corrupt):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                doc = await patch(http, doc, {'effects.clarity': 75})
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': 'effects.clarity'}})
                before = copy.deepcopy(child.photos[child.active]['settings'])
                durable = store.get_raw_history(api._history_identity)
                tool = child.tool
                def corrupt_result(message, value=None, error=False):
                    if child.commands[-1][0] == 'develop.resetSection':
                        settings = child.photos[child.active]['settings']
                        if corrupt == 'vignette': settings['vignette']['style'] = 'colorPriority'
                        elif corrupt == 'grain': settings['grain']['seed'] = 17
                        elif corrupt == 'light': settings['light']['exposure'] = 1
                        elif corrupt == 'disabled_sections': settings['disabled_sections'] = ['effects']
                        else: settings['effects']['clarity'] = False if corrupt == 'boolean' else 1
                    tool(message, value, error)
                monkeypatch.setattr(child, 'tool', corrupt_result)
                request = body(doc) | {'kind': 'sectionReset', 'metadata': {'section': 'effects'}}
                response = await http.post(url(doc, 'operate'), json=request)
                assert response.json()['code'] == 'raw_operation_readback_mismatch'
                assert store.get_raw_history(api._history_identity) == durable
                assert child.photos[child.active]['settings'] == before and api.raw.status().state == 'synced'
                monkeypatch.setattr(child, 'tool', tool)
                doc = await operation(http, doc, 'operate', request)
                assert doc['values']['effects.clarity'] == 0
        finally:
            await api.close()
    asyncio.run(run())
