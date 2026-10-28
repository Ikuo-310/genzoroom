import asyncio
import copy
import re
from pathlib import Path

import pytest

import raw_recipe_store as store
from edit_store import StoreUnavailable
from lightcraft_mcp import LightCraftError
from raw_controls import CONTROLS, CONTROL_PATHS, RESET_SECTIONS, SECTIONS, VIGNETTE_STYLES, validate_controls
from tests.test_windows_local import local, client
from tests.test_windows_raw_api import setup
from tests.test_raw_category_operations import open_history, patch, edit
from tests.test_raw_history_api import operation, body, url
from tests.test_raw_controls import identity
from tests.test_raw_recipe_api import headers
from tests.test_raw_recipe_restore import open_asset

SPECS = [('amount', -100, 0), ('midpoint', 0, 50), ('feather', 0, 50), ('roundness', -100, 0), ('highlights', 0, 0)]


@pytest.mark.parametrize('field,lo,default', SPECS)
def test_vignette_mapping_boundaries(field, lo, default):
    control = f'vignette.{field}'
    assert CONTROLS[control] == (lo, 100, 1, default, 0)
    assert CONTROL_PATHS[control] == ('vignette', field)
    for value in (lo, default, 100):
        assert validate_controls({control: value}, False) == {control: value}
    for value in (lo - 1, 101, True, None, '50', float('nan'), float('inf')):
        with pytest.raises(LightCraftError, match='raw_invalid_controls'):
            validate_controls({control: value}, True)


def test_vignette_contracts_match_history_and_frontend():
    source = (Path(__file__).parents[2] / 'frontend/src/rawApi.ts').read_text(encoding='utf-8')
    styles = source.split('export const RAW_VIGNETTE_STYLES = [', 1)[1].split('] as const', 1)[0]
    assert set(re.findall(r"'([^']+)'", styles)) == set(VIGNETTE_STYLES)
    assert set(RESET_SECTIONS) == store.HISTORY_RESET_SECTIONS == set(SECTIONS) | {'vignette'}
    assert 'vignette' not in SECTIONS


@pytest.mark.parametrize('field,lo,default', SPECS)
def test_vignette_numbers_history_reset_and_reopen(local, tmp_path, monkeypatch, field, lo, default):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                control = f'vignette.{field}'
                child = children[0]
                original = copy.deepcopy(child.photos[child.active]['settings'])
                doc = await patch(http, doc, {control: 73})
                assert child.photos[child.active]['settings']['vignette'][field] == 73
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


@pytest.mark.parametrize('style', VIGNETTE_STYLES)
def test_vignette_style_history_noop_resets_retry_and_recipe(local, tmp_path, monkeypatch, style):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                native = child.photos[child.active]['settings']
                native['vignette'].update(amount=-71, midpoint=23, feather=87, roundness=-34, highlights=89,
                    style='paintOverlay' if style != 'paintOverlay' else 'colorPriority')
                native['grain'].update(amount=63, size=94, roughness=17, seed=4294967295)
                native['effects'].update(texture=23, clarity=-48, dehaze=76)
                doc = (await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))).json()
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': 'light.exposure'}})
                original = copy.deepcopy(native)
                seed_step = doc['history']['selectedStepId']
                writer = store.append_raw_history
                monkeypatch.setattr(store, 'append_raw_history', lambda *a, **kw: (_ for _ in ()).throw(StoreUnavailable()))
                request = body(doc) | {'kind': 'vignetteStyle', 'metadata': {'style': style}}
                assert (await http.post(url(doc, 'operate'), json=request)).status_code >= 500
                attempts = api.raw.status().edits
                monkeypatch.setattr(store, 'append_raw_history', writer)
                doc = await operation(http, doc, 'operate', request)
                assert doc['vignetteStyle'] == style and api.raw.status().edits == attempts
                assert ('develop.merge', {'settings': {'vignette': {'style': style}}}) in child.commands
                changed = copy.deepcopy(original)
                changed['vignette']['style'] = style
                assert child.photos[child.active]['settings'] == changed
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert page['steps'][-1]['metadata'] == {'style': style} and page['steps'][-1]['changes'] == []
                length = doc['history']['length']
                doc = await edit(http, doc, 'vignetteStyle', {'style': style})
                assert doc['history']['length'] == length and api.raw.status().edits == attempts
                doc = await operation(http, doc, 'undo')
                assert child.photos[child.active]['settings'] == original
                doc = await edit(http, doc, 'vignetteStyle', {'style': original['vignette']['style']})
                assert doc['history']['cursor'] == length - 1 and doc['history']['length'] == length
                doc = await operation(http, doc, 'redo')
                assert child.photos[child.active]['settings'] == changed
                doc = await edit(http, doc, 'sectionToggle', {'section': 'effects', 'enabled': False})
                changed['disabled_sections'] = ['effects']
                assert child.photos[child.active]['settings'] == changed
                doc = await edit(http, doc, 'sectionReset', {'section': 'effects'})
                changed['effects'].update(texture=0, clarity=0, dehaze=0)
                assert child.photos[child.active]['settings'] == changed
                count = doc['history']['length']
                doc = await edit(http, doc, 'sectionReset', {'section': 'vignette'})
                changed['vignette'].update({field: default for field, _, default in SPECS})
                assert child.photos[child.active]['settings'] == changed and doc['history']['length'] == count + 1
                assert changed['vignette']['style'] == style
                assert changed['grain'] == original['grain']
                doc = await operation(http, doc, 'undo')
                assert doc['values']['vignette.amount'] == -71
                doc = await operation(http, doc, 'redo')
                assert doc['values']['vignette.amount'] == 0
                await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')
                _, response = await open_asset(http, doc['assetId'])
                assert response.status_code == 200, response.text
                doc = await operation(http, response.json(), 'initialize')
                child = children[-1]
                assert child.photos[child.active]['settings'] == changed
                doc = await operation(http, doc, 'jump', body(doc) | {'targetStepId': seed_step})
                assert child.photos[child.active]['settings'] == original
                doc = await edit(http, doc, 'vignetteStyle', {'style': style})
                assert doc['history']['cursor'] == doc['history']['length'] == 2
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('kind,metadata', [('vignetteStyle', {'style': value}) for value in
    ('invalid', 'Highlight', 1, None, True, [], {})] + [('vignetteStyle', {}),
    ('vignetteStyle', {'style': 'paintOverlay', 'extra': 0}), ('sectionToggle', {'section': 'vignette', 'enabled': False})])
def test_vignette_rejects_invalid_operations_before_native(local, tmp_path, monkeypatch, kind, metadata):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                commands = list(children[0].commands)
                response = await http.post(url(doc, 'operate'), json=body(doc) | {'kind': kind, 'metadata': metadata})
                assert response.status_code == 400 and children[0].commands == commands
                with pytest.raises(store.InvalidRawHistory):
                    store._history_metadata(kind, metadata)
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('kind,metadata,corrupt', [
    ('vignetteStyle', {'style': 'colorPriority'}, 'style'),
    ('vignetteStyle', {'style': 'colorPriority'}, 'grain'),
    ('vignetteStyle', {'style': 'colorPriority'}, 'amount'),
    ('sectionReset', {'section': 'vignette'}, 'style'),
    ('sectionReset', {'section': 'vignette'}, 'grain'),
    ('sectionReset', {'section': 'vignette'}, 'boolean'),
    ('sectionReset', {'section': 'vignette'}, 'effects'),
])
def test_vignette_rejects_wrong_readback_and_rolls_back(local, tmp_path, monkeypatch, kind, metadata, corrupt):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                doc = await patch(http, doc, {'vignette.amount': -75})
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': 'vignette.amount'}})
                before = copy.deepcopy(child.photos[child.active]['settings'])
                durable = store.get_raw_history(api._history_identity)
                tool = child.tool
                corrupted = False
                def bad_readback(message, value=None, error=False):
                    nonlocal corrupted
                    if not corrupted and child.commands[-1][0] == ('develop.merge' if kind == 'vignetteStyle' else 'develop.resetSection'):
                        corrupted = True
                        settings = child.photos[child.active]['settings']
                        if corrupt == 'style': settings['vignette']['style'] = 'paintOverlay'
                        elif corrupt == 'grain': settings['grain']['seed'] = 51
                        elif corrupt == 'amount': settings['vignette']['amount'] = -74
                        elif corrupt == 'boolean': settings['vignette']['amount'] = False
                        else: settings['effects']['clarity'] = 38
                    tool(message, value, error)
                monkeypatch.setattr(child, 'tool', bad_readback)
                request = body(doc) | {'kind': kind, 'metadata': metadata}
                response = await http.post(url(doc, 'operate'), json=request)
                assert response.json()['code'] == 'raw_operation_readback_mismatch'
                assert store.get_raw_history(api._history_identity) == durable
                assert child.photos[child.active]['settings'] == before and api.raw.status().state == 'synced'
                monkeypatch.setattr(child, 'tool', tool)
                await operation(http, doc, 'operate', request)
        finally:
            await api.close()
    asyncio.run(run())
