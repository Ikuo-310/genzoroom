"""Opt-in reset/persistence regression against the receipt-verified Native."""
import asyncio
import os
from pathlib import Path

import pytest

import edit_store
import windows_raw_api as module
from lightcraft_raw import LightCraftRawSession
from lightcraft_runtime import LightCraftManager
from raw_source import RawSourceCache
from tests.test_raw_source import Original
from tests.test_windows_local import local, client
from tests.test_raw_category_operations import open_history, patch, edit
from tests.test_raw_history_api import operation, body, url
from tests.test_raw_recipe_api import headers
from tests.test_raw_recipe_restore import open_asset


@pytest.mark.skipif(not os.environ.get('GENZOROOM_TEST_LIGHTCRAFT_EXE'), reason='real Native not requested')
@pytest.mark.parametrize('material', ['jpeg', 'pixel', 'pentax'])
def test_native_all_reset_history_recipe_restore(local, tmp_path, monkeypatch, material):
    source = (Path(__file__).resolve().parents[2] / 'docs/images/Anshitsu_Sakura.jpg'
              if material == 'jpeg' else Path(os.environ.get('GENZOROOM_TEST_RESET_' + material.upper(), '')))
    if not source.is_file():
        pytest.skip('DNG material not supplied')

    async def run():
        edit_store.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        edit_store.initialize_database()
        manager = LightCraftManager(environment={**os.environ, 'GENZOROOM_LIGHTCRAFT_EXE':
            os.environ['GENZOROOM_TEST_LIGHTCRAFT_EXE']}, platform='win32', gpu_backend='off')
        raw = LightCraftRawSession(manager)
        api = local.raw_api
        api.bind(raw, manager)
        (tmp_path/'sources').mkdir()
        async def acquire(_):
            return Original(source.read_bytes()), source.suffix.lstrip('.')
        monkeypatch.setattr(module, 'RawSourceCache', lambda: RawSourceCache(root=tmp_path/'sources', acquire=acquire))
        try:
            await manager.start()
            async with asyncio.timeout(30):
                while manager.status().state in ('starting', 'initializing'):
                    await asyncio.sleep(.05)
            async with client(local) as http:
                doc = await open_history(http, local, api)
                baseline = raw.confirmed_settings(api._raw_handle, doc['revision']).settings
                if material != 'jpeg':
                    assert baseline['detail'].get('nr_outliers') is True
                doc = await edit(http, doc, 'sectionToggle', {'section':'effects','enabled':False})
                doc = await edit(http, doc, 'opticsFlag', {'control':'optics.lens_profile',
                    'enabled':not baseline['optics']['lens_profile']})
                values = {'light.exposure':1.25, 'light.contrast':8, 'color.vibrance':11,
                    'detail.nrLuminance':13, 'effects.clarity':7, 'vignette.amount':-9,
                    'optics.distortion':12}
                if material != 'jpeg':
                    values.update({'wb.temp':6000, 'wb.tint':25})
                doc = await patch(http, doc, values)
                doc = await operation(http, doc, 'commit', body(doc) | {'kind':'control','metadata':{'control':'light.exposure'}})
                await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')
                _, response = await open_asset(http, doc['assetId'])
                doc = response.json()
                doc = (await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json={k:doc[k] for k in ('workspaceId','generation','documentToken')})).json()
                doc.update((await http.get(url(doc), headers=headers(doc))).json())
                doc = await operation(http, doc, 'initialize')
                restored_edit = raw.confirmed_settings(api._raw_handle, doc['revision']).settings
                assert doc['nativeMatchesRecipe']
                for path, value in values.items():
                    category, field = path.split('.')
                    if path == 'detail.nrLuminance':
                        field = 'nr_luminance'
                    assert restored_edit[category][field] == value
                assert doc['history']['cursor'] == 3 and doc['history']['length'] == 3
                if material != 'jpeg':
                    history_length = doc['history']['length']
                    doc = await edit(http, doc, 'sectionReset', {'section':'detail'})
                    detail_reset = raw.confirmed_settings(api._raw_handle, doc['revision']).settings
                    assert detail_reset['detail'].get('nr_outliers', False) is False
                    assert doc['history']['length'] == history_length + 1
                    await http.delete(f'/api/raw/workspaces/{doc["workspaceId"]}')
                    _, response = await open_asset(http, doc['assetId'])
                    doc = response.json()
                    doc = (await http.post(f'/api/raw/documents/{doc["handle"]}/settings', json={k:doc[k] for k in ('workspaceId','generation','documentToken')})).json()
                    doc.update((await http.get(url(doc), headers=headers(doc))).json())
                    doc = await operation(http, doc, 'initialize')
                    detail_restored = raw.confirmed_settings(api._raw_handle, doc['revision']).settings
                    assert doc['nativeMatchesRecipe'] and detail_restored['detail'].get('nr_outliers', False) is False
                request = body(doc) | {'kind':'allReset','metadata':{}}
                reset = await operation(http, doc, 'operate', request)
                actual = raw.confirmed_settings(api._raw_handle, reset['revision']).settings
                if material != 'jpeg':
                    assert actual['detail'].get('nr_outliers') is True
                assert actual['optics'] == baseline['optics']
                assert actual['wb'] == baseline['wb']
                assert actual['disabled_sections'] == ['effects']
                assert reset['nativeMatchesRecipe'] and reset['history']['length'] == doc['history']['length'] + 1
                replay = await operation(http, doc, 'operate', request)
                assert replay['replayed']
                for exposure in (0, .75):
                    if exposure:
                        reset = await patch(http, reset, {'light.exposure':exposure})
                        reset = await operation(http, reset, 'commit', body(reset) | {'kind':'control','metadata':{'control':'light.exposure'}})
                    await http.delete(f'/api/raw/workspaces/{reset["workspaceId"]}')
                    _, response = await open_asset(http, reset['assetId'])
                    reset = response.json()
                    reset = (await http.post(f'/api/raw/documents/{reset["handle"]}/settings', json={k:reset[k] for k in ('workspaceId','generation','documentToken')})).json()
                    reset.update((await http.get(url(reset), headers=headers(reset))).json())
                    reset = await operation(http, reset, 'initialize')
                    assert reset['nativeMatchesRecipe'] and reset['values']['light.exposure'] == exposure
                    restored = raw.confirmed_settings(api._raw_handle, reset['revision']).settings
                    if material != 'jpeg':
                        assert restored['detail'].get('nr_outliers') is True
                    assert restored['light']['contrast'] == 0
                    assert restored['color']['vibrance'] == 0
                    assert restored['detail']['nr_luminance'] == 0
                    assert restored['effects']['clarity'] == 0
                    assert restored['vignette']['amount'] == 0
                    assert reset['opticsFlags']['lens_profile'] == baseline['optics']['lens_profile']
        finally:
            await api.close()
            await manager.close()
    asyncio.run(run())
