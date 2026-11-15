"""Opt-in integration check against the receipt-verified Native executable."""

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
from uuid import uuid4

import pytest
from PIL import Image

from lightcraft_mcp import LightCraftError
from lightcraft_raw import LightCraftRawSession
from lightcraft_runtime import LightCraftManager
from raw_white_balance import result_fingerprint


def region_target(raw, handle, frame, revision, *, kind, quality, operation, view=1):
    target = {'contractVersion':1,'mode':'region','quality':quality,'geometryId':frame['geometryId'],
        'identity':raw.region_identity(handle, kind), 'documentRevision':revision,
        'viewGeneration':view,'requestId':uuid4().hex}
    if operation == 'plan':
        target['desiredLongEdge'] = 512
    else:
        full_width, full_height = frame['fullWidth'], frame['fullHeight']
        width, height = min(128, full_width), min(128, full_height)
        window = {'x':(full_width-width)//2,'y':(full_height-height)//2,'w':width,'h':height}
        target.update(fullWidth=full_width,fullHeight=full_height,window=window,validRegion=window,context=0,prefetch=0)
    return target


@pytest.mark.skipif(not os.environ.get('GENZOROOM_TEST_LIGHTCRAFT_EXE'), reason='real Native executable not requested')
def test_real_native_snapshot_nr_outliers_false_and_true_round_trip(tmp_path):
    async def run():
        source = tmp_path / 'sample.jpg'
        shutil.copyfile(Path(__file__).resolve().parents[2] / 'docs/images/Anshitsu_Sakura.jpg', source)
        manager = LightCraftManager(environment={**os.environ,
            'GENZOROOM_LIGHTCRAFT_EXE': os.environ['GENZOROOM_TEST_LIGHTCRAFT_EXE']}, platform='win32', gpu_backend='off')
        raw = LightCraftRawSession(manager)
        try:
            await manager.start()
            async with asyncio.timeout(30):
                while manager.status().state in ('starting', 'initializing'):
                    await asyncio.sleep(.05)
            assert manager.status().state == 'ready'
            handle, state = await raw.open_raw(str(uuid4()), str(source))
            assert state.settings['detail'].get('nr_outliers', False) is False
            other_settings = {key: value for key, value in state.settings.items() if key != 'detail'}
            reset = await raw.apply_history_operation(
                handle, 'sectionReset', {'section': 'detail'}, state.revision)
            assert reset.settings['detail'].get('nr_outliers', False) is False
            assert {key: value for key, value in reset.settings.items() if key != 'detail'} == other_settings

            partial = await raw.merge_settings(handle, {'detail': {'nr_luminance': 12}}, reset.revision)
            assert partial.settings['detail'].get('nr_outliers', False) is False
            false_snapshot = partial.settings
            false_snapshot['detail'].pop('nr_outliers', None)
            identity = raw.recipe_identity(handle)
            restored_false = await raw.restore_persisted_settings(
                handle, identity | {'settings': false_snapshot}, partial.revision)
            assert restored_false.settings['detail'].get('nr_outliers', False) is False

            true_snapshot = restored_false.settings
            true_snapshot['detail']['nr_outliers'] = True
            restored_true = await raw.restore_persisted_settings(
                handle, identity | {'settings': true_snapshot}, restored_false.revision)
            assert restored_true.settings['detail']['nr_outliers'] is True
        finally:
            await raw.close()
    asyncio.run(run())


@pytest.mark.skipif(not os.environ.get('GENZOROOM_TEST_LIGHTCRAFT_EXE'), reason='real Native executable not requested')
def test_real_native_geometry_and_targeted_curve(tmp_path):
    async def run():
        source = tmp_path / 'sample.jpg'
        shutil.copyfile(Path(__file__).resolve().parents[2] / 'docs/images/Anshitsu_Sakura.jpg', source)
        manager = LightCraftManager(environment={**os.environ,
            'GENZOROOM_LIGHTCRAFT_EXE': os.environ['GENZOROOM_TEST_LIGHTCRAFT_EXE']}, platform='win32', gpu_backend='off')
        raw = LightCraftRawSession(manager)
        try:
            await manager.start()
            async with asyncio.timeout(30):
                while manager.status().state in ('starting', 'initializing'):
                    await asyncio.sleep(.05)
            assert manager.status().state == 'ready'
            handle, state = await raw.open_raw('geometry-live', str(source))
            old_revision = state.revision
            actions = [
                ('set', {'rect': [.1, .1, .9, .9]}), ('aspect', {'aspect': '4x3'}),
                ('straighten', {'angle': 3}), ('rotateRight', {}),
                ('flipHorizontal', {}), ('flipVertical', {}), ('reset', {}),
            ]
            for kind, params in actions:
                state = await raw.apply_geometry(handle, {'type': kind, 'params': params}, state.revision)
                frame = await raw.request_preview(handle, state.revision, max_side=512, quality='full')
                assert frame.data.startswith(b'\x89PNG\r\n\x1a\n')
                assert frame.frame and (frame.width, frame.height) == (frame.frame['fullWidth'], frame.frame['fullHeight'])
            for handle_name in ('topLeft', 'topRight', 'bottomRight', 'bottomLeft', 'top', 'right', 'bottom', 'left'):
                state = await raw.apply_geometry(handle, {'type': 'set', 'params': {'rect': [.2, .2, .8, .8]}}, state.revision)
                state = await raw.apply_geometry(handle, {'type': 'drag', 'params': {
                    'handle': handle_name, 'from': [.5, .5], 'to': [.51, .51]}}, state.revision)
            with pytest.raises(LightCraftError, match='raw_revision_conflict'):
                await raw.apply_geometry(handle, {'type': 'rotateLeft', 'params': {}}, old_revision)
            interaction = await raw.begin_curve_interaction(handle, 'master', state.revision, 'targeted')
            update = await raw.update_targeted_curve_interaction(handle, interaction, state.revision,
                {'x': .4, 'y': .6}, [10], max_side=512)
            frame = await update.preview_ticket
            assert len(update.settings['curve']['master']) >= 3
            assert frame.interaction_id == interaction and frame.interaction_sequence == update.sequence
            assert frame.quality == 'draft' and frame.frame is not None
            await raw.cancel_curve_interaction(handle, interaction, state.revision)
        finally:
            await raw.close()
            await manager.close()

    asyncio.run(run())


@pytest.mark.skipif(not os.environ.get('GENZOROOM_TEST_LIGHTCRAFT_EXE'), reason='real Native executable not requested')
def test_real_native_mixer_target_hsl_readback_and_interaction(tmp_path):
    async def run():
        source = tmp_path / 'sample.jpg'
        shutil.copyfile(Path(__file__).resolve().parents[2] / 'docs/images/Anshitsu_Sakura.jpg', source)
        manager = LightCraftManager(environment={**os.environ,
            'GENZOROOM_LIGHTCRAFT_EXE': os.environ['GENZOROOM_TEST_LIGHTCRAFT_EXE']}, platform='win32', gpu_backend='off')
        raw = LightCraftRawSession(manager)
        try:
            await manager.start()
            async with asyncio.timeout(30):
                while manager.status().state in ('starting', 'initializing'):
                    await asyncio.sleep(.05)
            handle, state = await raw.open_raw('mixer-target-live', str(source))
            for target in ('hue', 'sat', 'lum'):
                interaction = await raw.begin_mixer_interaction(handle, target, .5, .5, state.revision)
                update = await raw.update_mixer_interaction(handle, interaction, state.revision, 1, 5.5, max_side=512)
                assert update.changes and all(control.startswith('mixer.') and control.endswith(f'.{target}')
                    for control in update.changes)
                assert all(update.settings['mixer'][control.split('.')[1]][target] == value
                    for control, value in update.changes.items())
                preview = await update.preview_ticket
                assert preview.quality in ('draft', 'full') and preview.interaction_id == interaction
                result = await raw.end_mixer_interaction(handle, interaction, state.revision, target)
                state = raw.confirm_mixer_interaction(handle, interaction, state.revision)
                assert state.settings == result.settings
        finally:
            await raw.close()
            await manager.close()

    asyncio.run(run())


@pytest.mark.skipif(not os.environ.get('GENZOROOM_TEST_LIGHTCRAFT_EXE'), reason='real Native executable not requested')
@pytest.mark.parametrize('source_kind', ['jpeg', 'dng'])
def test_real_native_point_color_interaction_round_trip_on_synthetic_images(tmp_path, source_kind):
    async def run():
        if source_kind == 'jpeg':
            source = tmp_path / 'synthetic-point-color.jpg'
            Image.new('RGB', (64, 64), (180, 90, 40)).save(source, quality=95)
        else:
            source = tmp_path / 'synthetic-point-color.dng'
            probe_path = Path(__file__).resolve().parents[2] / 'native/lightcraft/settings_export_probe.py'
            spec = importlib.util.spec_from_file_location('point_color_synthetic_dng', probe_path)
            probe = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(probe)
            source.write_bytes(probe.synthetic_dng())
        manager = LightCraftManager(environment={**os.environ,
            'GENZOROOM_LIGHTCRAFT_EXE': os.environ['GENZOROOM_TEST_LIGHTCRAFT_EXE']}, platform='win32', gpu_backend='off')
        raw = LightCraftRawSession(manager)
        try:
            await manager.start()
            async with asyncio.timeout(30):
                while manager.status().state in ('starting', 'initializing'):
                    await asyncio.sleep(.05)
            assert manager.status().state == 'ready'
            handle, state = await raw.open_raw('point-color-synthetic', str(source))
            state = await raw.apply_history_operation(handle, 'pointColorPick', {'x': .5, 'y': .5}, state.revision)
            controls = [('hueShift', 25), ('satShift', 0), ('lumShift', 8.5), ('variance', -5.5),
                ('range', 63.25), ('hueRange', 45.5), ('satRange', 38.25), ('lumRange', 62.75)]
            for field, value in controls:
                control = f'pointColor.0.{field}'
                interaction = await raw.begin_point_color_interaction(handle, control, state.revision)
                update = await raw.update_point_color_interaction(handle, interaction, state.revision, 1, value,
                    max_side=512)
                preview = await update.preview_ticket
                assert preview.interaction_id == interaction and preview.interaction_sequence == 1
                actual = json.loads(await raw._read_settings(raw._photo(handle, active=True),
                    asyncio.get_running_loop().time() + 30))
                native_field = {'hueShift':'hue_shift','satShift':'sat_shift','lumShift':'lum_shift','hueRange':'hue_range',
                    'satRange':'sat_range','lumRange':'lum_range'}.get(field, field)
                assert actual['point_colors'][0][native_field] == value
                if type(value) is int:
                    assert type(actual['point_colors'][0][native_field]) is float
                result = await raw.end_point_color_interaction(handle, interaction, state.revision, control, value)
                state = raw.confirm_point_color_interaction(handle, interaction, state.revision)
                assert state.settings['point_colors'][0][native_field] == value
                assert state.settings == result.settings
        finally:
            await raw.close()
            await manager.close()

    asyncio.run(run())


@pytest.mark.skipif(not os.environ.get('GENZOROOM_TEST_LIGHTCRAFT_EXE'), reason='real Native executable not requested')
def test_real_native_before_after_and_draft_full(tmp_path):
    async def run():
        source = tmp_path / 'sample.jpg'
        shutil.copyfile(Path(__file__).resolve().parents[2] / 'docs/images/Anshitsu_Sakura.jpg', source)
        manager = LightCraftManager(environment={**os.environ,
            'GENZOROOM_LIGHTCRAFT_EXE': os.environ['GENZOROOM_TEST_LIGHTCRAFT_EXE']}, platform='win32', gpu_backend='off')
        raw = LightCraftRawSession(manager)
        try:
            await manager.start()
            async with asyncio.timeout(30):
                while manager.status().state in ('starting', 'initializing'):
                    await asyncio.sleep(.05)
            handle, state = await raw.open_raw('before-draft-live', str(source))
            before = await raw.request_preview(handle, state.revision, kind='before')
            state = await raw.set_controls(handle, {'light.exposure': 1.0}, state.revision)
            after = await raw.request_preview(handle, state.revision, quality='full')
            assert before.kind == 'before' and before.quality == 'full'
            assert after.kind == 'after' and after.quality == 'full'
            assert before.frame and after.frame
            assert before.frame['geometryId'] == after.frame['geometryId']
            assert before.data != after.data
            interaction = await raw.begin_curve_interaction(handle, 'master', state.revision, 'targeted')
            update = await raw.update_targeted_curve_interaction(handle, interaction, state.revision,
                {'x': .4, 'y': .6}, [10], max_side=512)
            draft = await update.preview_ticket
            assert draft.kind == 'after' and draft.quality == 'draft'
            assert draft.interaction_id == interaction and draft.interaction_sequence == update.sequence
            assert draft.frame and draft.frame['geometryId'] == after.frame['geometryId']
            await raw.cancel_curve_interaction(handle, interaction, state.revision)
        finally:
            await raw.close()
            await manager.close()

    asyncio.run(run())


@pytest.mark.skipif(not os.environ.get('GENZOROOM_TEST_LIGHTCRAFT_EXE'), reason='real Native executable not requested')
def test_real_native_region_before_after_draft_and_rotated_geometry(tmp_path):
    async def run():
        source = tmp_path / 'sample.jpg'
        shutil.copyfile(Path(__file__).resolve().parents[2] / 'docs/images/Anshitsu_Sakura.jpg', source)
        manager = LightCraftManager(environment={**os.environ,
            'GENZOROOM_LIGHTCRAFT_EXE': os.environ['GENZOROOM_TEST_LIGHTCRAFT_EXE']}, platform='win32', gpu_backend='off')
        raw = LightCraftRawSession(manager)
        try:
            await manager.start()
            async with asyncio.timeout(30):
                while manager.status().state in ('starting', 'initializing'):
                    await asyncio.sleep(.05)
            assert manager.status().state == 'ready'
            handle, state = await raw.open_raw(str(uuid4()), str(source))

            before = await raw.request_preview(handle, state.revision, kind='before', max_side=512, quality='full')
            before_plan_target = region_target(raw, handle, before.frame, state.revision,
                kind='before', quality='full', operation='plan')
            before_plan = await raw.request_region(handle, before_plan_target, operation='plan')
            before_meta = before_plan.metadata['response']
            assert before_meta['kind'] == 'before' and before_meta['quality'] == 'full'
            window = {'x':(before_meta['fullWidth']-128)//2,'y':(before_meta['fullHeight']-128)//2,
                'w':min(128,before_meta['fullWidth']),'h':min(128,before_meta['fullHeight'])}
            before_render_target = region_target(raw, handle, before.frame, state.revision,
                kind='before', quality='full', operation='render')
            before_render_target.update(fullWidth=before_meta['fullWidth'],fullHeight=before_meta['fullHeight'],
                window=window,validRegion=window)
            before_region = await raw.request_region(handle, before_render_target)
            assert before_region.data.startswith(b'\x89PNG\r\n\x1a\n')
            assert (before_region.metadata['response']['width'],before_region.metadata['response']['height']) == (window['w'],window['h'])
            assert before_region.metadata['response']['window'] == window

            state = await raw.set_controls(handle, {'light.exposure':.5}, state.revision)
            for kind, quality in (('after','draft'),('after','full')):
                whole = await raw.request_preview(handle, state.revision, kind=kind, max_side=512, quality=quality)
                plan_target = region_target(raw, handle, whole.frame, state.revision,
                    kind=kind, quality=quality, operation='plan')
                plan = await raw.request_region(handle, plan_target, operation='plan')
                plan_meta = plan.metadata['response']
                assert plan_meta['kind'] == kind and plan_meta['quality'] == quality
                render_target = region_target(raw, handle, whole.frame, state.revision,
                    kind=kind, quality=quality, operation='render')
                width, height = min(128,plan_meta['fullWidth']), min(128,plan_meta['fullHeight'])
                window = {'x':(plan_meta['fullWidth']-width)//2,'y':(plan_meta['fullHeight']-height)//2,
                    'w':width,'h':height}
                render_target.update(fullWidth=plan_meta['fullWidth'],fullHeight=plan_meta['fullHeight'],
                    window=window,validRegion=window)
                region = await raw.request_region(handle,render_target)
                assert region.data.startswith(b'\x89PNG\r\n\x1a\n')
                assert region.metadata['response']['kind'] == kind
                assert region.metadata['response']['quality'] == quality
                assert region.metadata['response']['window'] == window
                assert (region.metadata['response']['width'],region.metadata['response']['height']) == (width,height)

            state = await raw.apply_geometry(handle, {'type':'rotateRight','params':{}}, state.revision)
            state = await raw.apply_geometry(handle, {'type':'flipHorizontal','params':{}}, state.revision)
            state = await raw.apply_geometry(handle, {'type':'set','params':{'rect':[.1,.1,.9,.9]}}, state.revision)
            whole = await raw.request_preview(handle,state.revision,max_side=512,quality='full')
            plan = await raw.request_region(handle,region_target(raw,handle,whole.frame,state.revision,
                kind='after',quality='full',operation='plan'),operation='plan')
            plan_meta = plan.metadata['response']
            assert plan_meta['geometryId'] == whole.frame['geometryId']
            assert (plan_meta['fullWidth'],plan_meta['fullHeight']) == (whole.frame['fullWidth'],whole.frame['fullHeight'])
            width, height = min(128,plan_meta['fullWidth']), min(128,plan_meta['fullHeight'])
            window = {'x':(plan_meta['fullWidth']-width)//2,'y':(plan_meta['fullHeight']-height)//2,
                'w':width,'h':height}
            render_target = region_target(raw,handle,whole.frame,state.revision,kind='after',quality='full',operation='render')
            render_target.update(fullWidth=plan_meta['fullWidth'],fullHeight=plan_meta['fullHeight'],
                window=window,validRegion=window)
            region = await raw.request_region(handle,render_target)
            assert region.data.startswith(b'\x89PNG\r\n\x1a\n')
            assert region.metadata['response']['geometryId'] == whole.frame['geometryId']
            assert region.metadata['response']['window'] == window
        finally:
            await raw.close()
            await manager.close()

    asyncio.run(run())


@pytest.mark.skipif(not os.environ.get('GENZOROOM_TEST_LIGHTCRAFT_EXE'), reason='real Native executable not requested')
def test_real_native_wb_pick_candidate_is_read_only_until_confirmed(tmp_path):
    async def run():
        source = tmp_path / 'sample.jpg'
        shutil.copyfile(Path(__file__).resolve().parents[2] / 'docs/images/Anshitsu_Sakura.jpg', source)
        manager = LightCraftManager(environment={**os.environ,
            'GENZOROOM_LIGHTCRAFT_EXE': os.environ['GENZOROOM_TEST_LIGHTCRAFT_EXE']}, platform='win32', gpu_backend='off')
        raw = LightCraftRawSession(manager)
        try:
            await manager.start()
            async with asyncio.timeout(30):
                while manager.status().state in ('starting', 'initializing'):
                    await asyncio.sleep(.05)
            handle, state = await raw.open_raw('wb-picker-live', str(source))
            photo = raw._photos[handle.source_key]
            generation = manager.status().generation
            preview = await raw.request_preview(handle, state.revision, max_side=512, quality='full')
            native_settings = await manager._raw_native_settings(generation, photo.photo_id, timeout=30)
            identity = {'id': str(photo.photo_id), 'wb_contract': 1, 'operation': 'pick',
                'settingsFingerprint': result_fingerprint(native_settings), 'requestId': uuid4().hex,
                'frame': {'kind': 'after', 'geometryId': preview.frame['geometryId'], 'maxSide': 512,
                    'quality': 'full', 'x': .5, 'y': .5}}
            result = await manager._raw_estimate_wb(generation, identity, timeout=60)
            candidate = result['candidate']
            assert candidate['mode'] == 'custom' and candidate['scale'] == 'legacy'
            assert result['identity'] == identity
            unchanged = await manager._raw_native_settings(generation, photo.photo_id, timeout=30)
            assert result_fingerprint(unchanged) == result_fingerprint(native_settings)

            # The existing history owner applies only the frozen candidate after confirmation.
            expected = state.settings
            expected['wb'].update(candidate)
            applied = await raw.apply_wb_candidate(handle, state.settings, expected, state.revision, verify=lambda: None)
            assert applied.revision == state.revision + 1
            assert applied.settings['wb']['mode'] == 'custom'
            assert applied.settings['wb']['temp'] == candidate['temp']
        finally:
            await raw.close()
            await manager.close()

    asyncio.run(run())
