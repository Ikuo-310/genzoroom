import asyncio
import copy
from uuid import uuid4

import pytest

import edit_store
import raw_recipe_store as raw
import export_runtime as runtime_module
from edit_store import enqueue_export_assets, list_export_queue
from export_artifact import ExportArtifact
from export_runtime import ExportRuntime, RegistrationResult
from export_runtime_store import (create_export_run, get_export_run, fail_export_item,
    retry_export_assets, begin_export_item, transition_export_item, request_export_stop)
from tests.test_export_queue import A, B, C, db, save as save_jpeg
from tests.test_raw_recipe_store import identity, settings
from tests.test_export_runtime import Source, Family


def save_raw(asset=A, exposure=.7, revision=0, engine=None):
    key = identity(assetId=str(asset), **(engine or {}))
    defaults = settings()
    value = copy.deepcopy(defaults)
    value['light']['exposure'] = float(exposure)
    return raw.put_raw_recipe(key, revision, uuid4(), value,
        import_defaults_fingerprint=raw._digest(raw._settings_json(defaults, 1)))


class MixedSource(Source):
    async def detail(self, asset_id):
        detail = await super().detail(asset_id)
        return detail.model_copy(update={'format':'PEF', 'is_raw':True, 'filename':'IMG.PEF'}) if asset_id in (A,C) else detail


class Recorder:
    def __init__(self, fail=False):
        self.calls=[]
        self.fail=fail
    async def register(self, source, artifact, context):
        self.calls.append((source,artifact,context))
        if self.fail:
            raise RuntimeError('registration failure')
        return RegistrationResult(uuid4())


def test_raw_eligibility_and_start_freeze(db):
    save_raw(exposure=0)
    with pytest.raises(edit_store.QueueRejected): enqueue_export_assets([A])
    save_raw(revision=1)
    enqueue_export_assets([A])
    save_raw(exposure=1.1,revision=2)
    run=create_export_run([A])
    item=run.items[0]
    assert item.kind=='raw' and item.frozen_revision==3
    assert item.recipe['settings']['light']['exposure']==1.1
    save_raw(exposure=2,revision=3)
    assert get_export_run(run.run_id).items[0].recipe==item.recipe


@pytest.mark.parametrize('fail_raw',[False,True])
def test_mixed_serial_pipeline_and_snapshot(db,monkeypatch,fail_raw):
    save_raw();save_jpeg(B);save_raw(C)
    enqueue_export_assets([A,B,C])
    calls=[];registrar=Recorder();source=MixedSource()
    async def artifact(request):
        calls.append(copy.deepcopy(request.settings))
        assert request.source and request.source_filename=='IMG.PEF'
        assert request.expected_content_hash==identity()['sourceContentHash']
        assert request.family_filenames==('IMG-Genzo03.jpg',)
        if len(calls)==1:
            save_raw(exposure=3,revision=1)
        if fail_raw and len(calls)==1:
            raise RuntimeError('native failure')
        return ExportArtifact('IMG-Genzo04.jpg',b'raw-jpeg')
    monkeypatch.setattr(runtime_module,'export_raw_artifact',artifact)
    async def run():
        runtime=ExportRuntime(source=source,family=Family(),registrar=registrar)
        run_id=await runtime.start([A,B,C]);await runtime.wait()
        return get_export_run(run_id)
    result=asyncio.run(run())
    assert calls[0]['light']['exposure']==.7
    assert [r[0].id for r in registrar.calls]==([B,C] if fail_raw else [A,B,C])
    assert result.items[0].status==('failed' if fail_raw else 'succeeded')
    assert result.items[0].error_code==('encoding_failed' if fail_raw else None)
    assert result.items[1].kind=='jpeg' and result.items[1].status=='succeeded'
    assert result.items[2].status=='succeeded'
    assert all(o.closed==1 for o in source.originals)


def test_raw_retry_uses_current_recipe_without_jpeg_identity(db):
    save_raw();enqueue_export_assets([A]);run=create_export_run([A],worker_id=uuid4())
    begin_export_item(run.run_id,run.worker_id)
    fail_export_item(run.run_id,A,run.worker_id,'waiting','registration_failed')
    retry_export_assets([A]);second=create_export_run([A],worker_id=uuid4())
    assert second.items[0].export_timestamp!=run.items[0].export_timestamp
    begin_export_item(second.run_id,second.worker_id)
    fail_export_item(second.run_id,A,second.worker_id,'waiting','registration_failed')
    save_raw(exposure=1.5,revision=1)
    retry_export_assets([A]);third=create_export_run([A])
    assert third.items[0].recipe['settings']['light']['exposure']==1.5


def test_raw_recovery_keeps_frozen_recipe_after_reset(db):
    save_raw();save_jpeg(B);enqueue_export_assets([A,B])
    run=create_export_run([A,B],worker_id=uuid4())
    begin_export_item(run.run_id,run.worker_id)
    transition_export_item(run.run_id,A,run.worker_id,'waiting','encoding')
    transition_export_item(run.run_id,A,run.worker_id,'encoding','registering')
    raw.delete_raw_edits(str(A))
    calls=[]
    async def artifact(request):
        calls.append(request.settings)
        return ExportArtifact('IMG-Genzo04.jpg',b'different-on-recovery')
    async def recover():
        runtime=ExportRuntime(source=MixedSource(),family=Family(),registrar=Recorder(),raw_artifact=artifact)
        assert await runtime.recover()==run.run_id
        await runtime.wait()
    asyncio.run(recover())
    result=get_export_run(run.run_id)
    assert result.status=='completed' and result.worker_id!=run.worker_id
    assert calls[0]==run.items[0].recipe['settings']


def test_raw_stop_finishes_current_releases_suffix(db):
    save_raw();save_jpeg(B);enqueue_export_assets([A,B])
    async def artifact(request):
        active=__import__('export_runtime_store').recoverable_export_run()
        request_export_stop(active.run_id)
        return ExportArtifact('IMG-Genzo04.jpg',b'raw')
    async def run():
        runtime=ExportRuntime(source=MixedSource(),family=Family(),registrar=Recorder(),raw_artifact=artifact)
        run_id=await runtime.start([A,B]);await runtime.wait();return get_export_run(run_id)
    result=asyncio.run(run())
    assert result.status=='stopped'
    assert [i.status for i in result.items]==['succeeded','released']
    assert list_export_queue()[0]['status']=='queued'


def test_raw_default_and_reset_keep_intent_but_start_revalidates(db):
    save_raw();enqueue_export_assets([A]);save_raw(exposure=0,revision=1)
    with pytest.raises(__import__('export_runtime_store').RuntimeRejected,match='asset_not_eligible'):
        create_export_run([A])
    assert list_export_queue()[0]['status']=='queued'
    raw.delete_raw_edits(str(A))
    with pytest.raises(__import__('export_runtime_store').RuntimeRejected,match='saved_recipe_missing'):
        create_export_run([A])


def test_old_recipe_engine_does_not_pin_export_engine(db):
    save_raw(engine={'engineVersion':'0.9.1','engineCommit':'a'*40})
    enqueue_export_assets([A]);run=create_export_run([A])
    assert run.items[0].kind=='raw'
    assert run.items[0].recipe['engineVersion']=='0.9.1'


def test_raw_unknown_baseline_is_not_eligible(db):
    raw.put_raw_recipe(identity(),0,uuid4(),settings())
    with pytest.raises(edit_store.QueueRejected):enqueue_export_assets([A])

@pytest.mark.parametrize('favorite',[True,False])
def test_raw_uses_existing_immich_registrar_with_album_stack_cover(db,favorite):
    import httpx
    from immich_export import ImmichExportRegistrar
    from tests.test_immich_export import Remote, OUT, DATE, stack
    save_raw();enqueue_export_assets([A])
    album=uuid4();remote=Remote([stack([B,A],B)])
    remote.source_albums=[album];remote.album_members[album]={A,B}
    class FavoriteSource(MixedSource):
        async def detail(self,asset_id):
            detail=await super().detail(asset_id)
            return detail.model_copy(update={'is_favorite':favorite,'date':DATE})
    async def artifact(request):
        return ExportArtifact('IMG-Genzo04.jpg',b'native JPEG')
    async def run():
        registrar=ImmichExportRegistrar('http://immich/api','private-key',transport=httpx.MockTransport(remote.handle))
        runtime=ExportRuntime(source=FavoriteSource(),family=Family(),registrar=registrar,raw_artifact=artifact)
        run_id=await runtime.start([A]);await runtime.wait();return get_export_run(run_id)
    result=asyncio.run(run())
    assert result.status=='completed' and result.items[0].registered_asset_id==OUT
    assert remote.uploads[0][3] is favorite
    assert remote.album_members[album]=={OUT}
    assert remote.stacks[0]['primaryAssetId']==str(OUT)
    assert ('PUT','/tags/assets') in remote.calls
    assert not list_export_queue()


def test_raw_source_mismatch_does_not_encode(db):
    save_raw();enqueue_export_assets([A])
    async def artifact(request):raise AssertionError('must not encode incorrect source')
    async def run():
        runtime=ExportRuntime(source=Source(),family=Family(),registrar=Recorder(),raw_artifact=artifact)
        run_id=await runtime.start([A]);await runtime.wait();return get_export_run(run_id)
    assert asyncio.run(run()).items[0].error_code=='source_kind_mismatch'


def test_raw_retry_can_produce_different_bytes_and_use_new_snapshot(db):
    save_raw();enqueue_export_assets([A]);registrar=Recorder(fail=True)
    produced=[]
    async def artifact(request):
        content=b'jpeg-attempt-'+str(request.settings['light']['exposure']).encode()
        produced.append(content)
        return ExportArtifact('IMG-Genzo04.jpg',content)
    async def run():
        first=ExportRuntime(source=MixedSource(),family=Family(),registrar=registrar,raw_artifact=artifact)
        one=await first.start([A]);await first.wait()
        assert get_export_run(one).items[0].error_code=='registration_failed'
        save_raw(exposure=1.8,revision=1)
        retry_export_assets([A]);registrar.fail=False
        second=ExportRuntime(source=MixedSource(),family=Family(),registrar=registrar,raw_artifact=artifact)
        two=await second.start([A]);await second.wait()
        assert get_export_run(two).status=='completed'
    asyncio.run(run())
    assert len(produced)==2 and produced[0]!=produced[1]
    assert registrar.calls[0][1].jpeg!=registrar.calls[1][1].jpeg


def test_mixed_enqueue_rejection_is_atomic_and_raw_api_accepts_saved_recipe(db):
    from tests.test_export_queue import request
    save_raw(exposure=0);save_jpeg(B)
    with pytest.raises(edit_store.QueueRejected):enqueue_export_assets([B,A])
    assert not list_export_queue()
    save_raw(revision=1)
    response=request('POST','/export/queue',{'assetIds':[str(A),str(B)]})
    assert response.status_code==200
    assert {i['assetId'] for i in response.json()['items']}=={str(A),str(B)}
