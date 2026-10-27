import asyncio
import copy
import re
from pathlib import Path
from uuid import UUID

import pytest

import raw_recipe_store as store
from raw_controls import CONTROLS, CONTROL_PATHS, DETAIL_RESET_DEFAULTS, SECTIONS, validate_controls
from lightcraft_mcp import LightCraftError
from edit_store import StoreUnavailable
from tests.test_windows_local import local, client
from tests.test_windows_raw_api import setup
from tests.test_raw_controls import identity
from tests.test_raw_category_operations import open_history, patch, edit
from tests.test_raw_history_api import operation, body, url
from tests.test_raw_recipe_api import headers
from tests.test_raw_recipe_restore import open_asset

NR_SPECS = [
    ('detail.nrLuminance', 'nr_luminance', 0, 0),
    ('detail.nrDetail', 'nr_detail', 50, 50),
    ('detail.nrColor', 'nr_color', 0, 25),
    ('detail.nrColorDetail', 'nr_color_detail', 50, 50),
    ('detail.nrColorSmoothness', 'nr_color_smoothness', 50, 50),
]


def test_history_listing_limit_remains_bounded():
    from windows_raw_api import RawPreviewApi, MAX_HISTORY_RESPONSE_BYTES
    assert MAX_HISTORY_RESPONSE_BYTES == 512 * 1024
    response = RawPreviewApi._history_json({'data': 'x' * (400 * 1024)}, MAX_HISTORY_RESPONSE_BYTES)
    assert len(response.body) < MAX_HISTORY_RESPONSE_BYTES
    with pytest.raises(LightCraftError, match='raw_history_response_too_large'):
        RawPreviewApi._history_json({'data': 'x' * MAX_HISTORY_RESPONSE_BYTES}, MAX_HISTORY_RESPONSE_BYTES)


@pytest.mark.parametrize('control,field,default,initial', NR_SPECS)
def test_nr_spec_mapping_and_numeric_boundaries(control, field, default, initial):
    assert CONTROLS[control] == (0, 100, 1, default, 0)
    assert CONTROL_PATHS[control] == ('detail', field)
    for value in (0, 100):
        assert validate_controls({control: value}, False) == {control: value}
    for value in (-1, 101, True, None, '50', float('nan'), float('inf')):
        with pytest.raises(LightCraftError, match='raw_invalid_controls'):
            validate_controls({control: value}, True)


@pytest.mark.parametrize('control,field,default,initial', NR_SPECS)
def test_nr_history_retry_reset_off_reopen_and_hidden_state(local, tmp_path, monkeypatch, control, field, default, initial):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                assert doc['values'][control] == initial
                native = child.photos[child.active]['settings']
                native['detail'].update(sharpen_radius=2.2, sharpen_detail=71, nr_contrast=33)
                native['enhance'].update(denoise=68, denoise_on=False, raw_details=True)
                doc = (await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))).json()
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': 'light.exposure'}})
                baseline = copy.deepcopy(native)
                seed_step = doc['history']['selectedStepId']
                doc = await patch(http, doc, {control: 73})
                assert doc['values'][control] == 73 and child.photos[child.active]['settings']['detail'][field] == 73
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': control}})
                doc = await edit(http, doc, 'controlReset', {'control': control})
                expected = copy.deepcopy(baseline)
                expected['detail'][field] = default
                assert child.photos[child.active]['settings'] == expected
                doc = await operation(http, doc, 'undo')
                assert doc['values'][control] == 73
                length = doc['history']['length']
                doc = await patch(http, doc, {control: 73})
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': control}})
                assert doc['history']['length'] == length and doc['history']['cursor'] == length - 1
                doc = await operation(http, doc, 'redo')
                assert doc['values'][control] == default
                doc = await operation(http, doc, 'jump', body(doc) | {'targetStepId': seed_step})
                assert child.photos[child.active]['settings'] == baseline
                doc = await patch(http, doc, {control: 99})
                attempts = api.raw.status().edits
                writer = store.append_raw_history
                monkeypatch.setattr(store, 'append_raw_history', lambda *a, **kw: (_ for _ in ()).throw(StoreUnavailable()))
                request = body(doc) | {'kind': 'control', 'metadata': {'control': control}}
                response = await http.post(url(doc, 'commit'), json=request)
                assert response.status_code >= 500
                monkeypatch.setattr(store, 'append_raw_history', writer)
                doc = await operation(http, doc, 'commit', request)
                assert api.raw.status().edits == attempts
                assert doc['history']['cursor'] == doc['history']['length'] == 2
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert page['steps'][-1]['changes'] == [{'control': control, 'before': initial, 'after': 99}]
                doc = await edit(http, doc, 'sectionToggle', {'section': 'detail', 'enabled': False})
                expected['detail'][field] = 99
                expected['disabled_sections'] = ['detail']
                assert child.photos[child.active]['settings'] == expected
                await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')
                _, response = await open_asset(http, doc['assetId'])
                assert response.status_code == 200, response.text
                doc = await operation(http, response.json(), 'initialize')
                assert not doc['sections']['detail'] and doc['values'][control] == 99
                assert children[-1].photos[children[-1].active]['settings'] == expected
        finally:
            await api.close()
    asyncio.run(run())


def test_published_control_and_section_contract_matches_frontend_and_history():
    source = (Path(__file__).parents[2] / 'frontend/src/rawApi.ts').read_text(encoding='utf-8')
    ids = source.split('export const RAW_CONTROL_IDS = [', 1)[1].split('] as const', 1)[0]
    sections = source.split('export const RAW_SECTION_IDS = [', 1)[1].split('] as const', 1)[0]
    assert set(re.findall(r"'([^']+)'", ids)) == set(CONTROLS) == store.HISTORY_CONTROLS
    assert set(re.findall(r"'([^']+)'", sections)) == set(SECTIONS) == store.HISTORY_SECTIONS
    assert CONTROL_PATHS['detail.sharpenAmount'] == ('detail', 'sharpen_amount')
    assert CONTROL_PATHS['detail.sharpenMasking'] == ('detail', 'sharpen_masking')


@pytest.mark.parametrize('values', [
    {'detail.sharpenAmount': -1}, {'detail.sharpenAmount': 151}, {'detail.sharpenMasking': 101},
    {'detail.sharpenMasking': True}, {'detail.sharpenAmount': float('nan')},
    {'detail.sharpen_amount': 1}, {'detail.sharpenRadius': 1}, {'enhance.denoise': 1},
])
def test_detail_rejects_invalid_or_unpublished_controls(values):
    with pytest.raises(LightCraftError, match='raw_invalid_controls'):
        validate_controls(values, True)


def test_detail_native_operations_history_reopen_and_unpublished_values(local, tmp_path, monkeypatch):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        child.as_shot_wb = [4875., 13.]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                assert doc['values']['detail.sharpenAmount'] == 40
                native = child.photos[child.active]['settings']
                native['detail'].update(sharpen_radius=2.3, sharpen_detail=71, nr_luminance=37,
                    nr_detail=65, nr_contrast=29, nr_color=44, nr_color_detail=61, nr_color_smoothness=83)
                native['enhance'].update(denoise=68, denoise_on=True, raw_details=True, super_resolution=True)
                doc = (await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json=identity(doc))).json()
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': 'light.exposure'}})
                seeded = copy.deepcopy(native)
                seeded_step = doc['history']['selectedStepId']
                assert seeded_step is not None
                assert store.get_raw_history(api._history_identity)['history']['steps'][-1]['settings'] == seeded
                doc = await patch(http, doc, {'detail.sharpenAmount': 120, 'detail.sharpenMasking': 75})
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': 'detail.sharpenAmount'}})
                assert ('develop.set', {'values': {'detail.sharpenAmount': 120, 'detail.sharpenMasking': 75}}) in child.commands
                saved = copy.deepcopy(child.photos[child.active]['settings'])
                assert saved['detail'] == seeded['detail'] | {'sharpen_amount': 120, 'sharpen_masking': 75}
                assert saved['enhance'] == seeded['enhance']
                doc = await edit(http, doc, 'sectionToggle', {'section': 'detail', 'enabled': False})
                assert not doc['sections']['detail'] and child.photos[child.active]['settings'] == saved | {'disabled_sections': ['detail']}
                length = doc['history']['length']
                same = await edit(http, doc, 'sectionToggle', {'section': 'detail', 'enabled': False})
                assert same['history']['length'] == length
                doc = await edit(http, same, 'sectionReset', {'section': 'detail'})
                reset = copy.deepcopy(child.photos[child.active]['settings'])
                assert reset['detail'] == DETAIL_RESET_DEFAULTS
                assert reset['enhance'] == {'denoise': 0, 'raw_details': True, 'super_resolution': True}
                assert reset['disabled_sections'] == ['detail'] and not doc['sections']['detail']
                assert {k: v for k, v in reset.items() if k not in ('detail', 'enhance', 'disabled_sections')} == {
                    k: v for k, v in seeded.items() if k not in ('detail', 'enhance', 'disabled_sections')}
                undone = await operation(http, doc, 'undo')
                assert child.photos[child.active]['settings'] == saved | {'disabled_sections': ['detail']}
                doc = await operation(http, undone, 'redo')
                assert child.photos[child.active]['settings'] == reset
                doc = await edit(http, doc, 'sectionToggle', {'section': 'detail', 'enabled': True})
                doc = await edit(http, doc, 'allReset', {})
                assert doc['values']['detail.sharpenAmount'] == 40 and doc['values']['detail.sharpenMasking'] == 0
                doc = await operation(http, doc, 'undo')
                await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')
                _, response = await open_asset(http, doc['assetId'])
                assert response.status_code == 200, response.text
                doc = await operation(http, response.json(), 'initialize')
                child = children[-1]
                assert child.photos[child.active]['settings'] == reset | {'disabled_sections': []}
                doc = await operation(http, doc, 'jump', body(doc) | {'targetStepId': seeded_step})
                assert child.photos[child.active]['settings'] == seeded
                doc = await patch(http, doc, {'detail.sharpenMasking': 50})
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': 'detail.sharpenMasking'}})
                assert doc['history']['length'] == doc['history']['cursor'] == 2
                page = (await http.get(url(doc), headers=headers(doc))).json()
                assert page['steps'][-1]['changes'] == [{'control': 'detail.sharpenMasking', 'before': 0, 'after': 50}]
        finally:
            await api.close()
    asyncio.run(run())


@pytest.mark.parametrize('corrupt', ['nr_detail', 'denoise', 'denoise_on', 'raw_details', 'super_resolution', 'unrelated', 'radius_type', 'denoise_type'])
def test_detail_reset_rejects_wrong_hidden_readback_and_rolls_back(local, tmp_path, monkeypatch, corrupt):
    async def run():
        api, _, children, _ = await setup(tmp_path, local, monkeypatch)
        child = children[0]
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                doc = await patch(http, doc, {'detail.sharpenAmount': 120})
                doc = await operation(http, doc, 'commit', body(doc) | {'kind': 'control', 'metadata': {'control': 'detail.sharpenAmount'}})
                original = copy.deepcopy(child.photos[child.active]['settings'])
                durable = store.get_raw_history(api._history_identity)
                tool = child.tool
                def corrupt_result(message, value=None, error=False):
                    if child.commands[-1][0] == 'develop.resetSection':
                        settings = child.photos[child.active]['settings']
                        if corrupt == 'nr_detail': settings['detail'][corrupt] = 49
                        elif corrupt == 'radius_type': settings['detail']['sharpen_radius'] = True
                        elif corrupt == 'denoise_type': settings['enhance']['denoise'] = False
                        elif corrupt == 'unrelated': settings['light']['exposure'] = 2
                        else: settings['enhance'][corrupt] = True if corrupt != 'denoise' else 1
                    tool(message, value, error)
                monkeypatch.setattr(child, 'tool', corrupt_result)
                request = body(doc) | {'kind': 'sectionReset', 'metadata': {'section': 'detail'}}
                response = await http.post(url(doc, 'operate'), json=request)
                assert response.json()['code'] == 'raw_operation_readback_mismatch'
                assert store.get_raw_history(api._history_identity) == durable
                assert child.photos[child.active]['settings'] == original and api.raw.status().state == 'synced'
                monkeypatch.setattr(child, 'tool', tool)
                await operation(http, doc, 'operate', request)
        finally:
            await api.close()
    asyncio.run(run())


def test_two_hundred_full_detail_history_deltas_fit_response_budget(local, tmp_path, monkeypatch):
    async def run():
        api, _, _, _ = await setup(tmp_path, local, monkeypatch)
        try:
            async with client(local) as http:
                doc = await open_history(http, local, api)
                baseline = store.get_raw_history(api._history_identity)
                async def full_history(_):
                    state = copy.deepcopy(baseline)
                    before = state['history']['baselineSettings']
                    steps = []
                    for index in range(200):
                        after = copy.deepcopy(before)
                        for control, (lo, hi, *_) in CONTROLS.items():
                            group, key = CONTROL_PATHS[control]
                            after[group][key] = (lo if index % 2 else hi) + (hi - lo) * (.00000001234567 if index % 2 else -.00000001234567)
                        steps.append({'stepId': str(UUID(int=index + 1)), 'kind': 'allReset', 'metadata': {},
                            'createdAt': '2026-10-27T00:00:00Z', 'settings': after})
                        before = after
                    state['history'] = {'baselineSettings': state['history']['baselineSettings'], 'cursor': 200, 'steps': steps}
                    return state
                monkeypatch.setattr(api, '_history_load', full_history)
                response = await http.get(url(doc), headers=headers(doc))
                assert response.status_code == 200 and 256 * 1024 < len(response.content) <= 512 * 1024
                steps = response.json()['steps']
                assert len(steps) == 200 and all(len(step['changes']) == 17 for step in steps)
                assert all('settings' not in step for step in steps)
        finally:
            await api.close()
    asyncio.run(run())
