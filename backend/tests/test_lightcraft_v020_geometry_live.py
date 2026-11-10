"""Opt-in integration check against the receipt-verified Native executable."""

import asyncio
import os
from pathlib import Path
import shutil

import pytest

from lightcraft_mcp import LightCraftError
from lightcraft_raw import LightCraftRawSession
from lightcraft_runtime import LightCraftManager


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
