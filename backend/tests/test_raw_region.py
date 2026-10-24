import asyncio
import ast
import base64
import copy
from dataclasses import replace
import json
from pathlib import Path
import threading
from uuid import uuid4

import pytest

import raw_region as region
from lightcraft_mcp import LightCraftError, LightCraftMCP, MCPTransportError
from lightcraft_raw import SUPERSEDED
from tests.test_lightcraft_raw import create, png
from tests.test_lightcraft_mcp import until, reply, PipeWriter
from tests.test_windows_local import local, client, authenticate
from tests.test_windows_raw_api import setup, open_document
from tests.test_raw_adaptive_preview import target as whole_target


def tool():
    return {'name':'render_region_preview','inputSchema':{'type':'object','required':['id','region_contract','operation','target'],
        'properties':{'id':{'type':'string'},'region_contract':{'type':'integer','enum':[1]},
        'operation':{'type':'string','enum':['plan','render']},'target':{'oneOf':[region.SCHEMA['$defs']['frameRequest'],region.SCHEMA['$defs']['request']]}}}}


def target(raw, handle, *, operation='render', kind='after', view=1):
    t = {'contractVersion':1,'mode':'region','quality':'full','geometryId':'a'*64,
         'identity':raw.region_identity(handle,kind),'documentRevision':raw._photo(handle).applied_revision,
         'viewGeneration':view,'requestId':f'{view:032x}'}
    if operation == 'plan':
        return t | {'desiredLongEdge':16}
    return t | {'fullWidth':16,'fullHeight':12,'window':{'x':0,'y':0,'w':8,'h':8},
                'validRegion':{'x':0,'y':0,'w':8,'h':8},'context':0,'prefetch':0}


def result(t, operation, *, cache='off', budget=0):
    r = t | {'kind':t['identity']['kind']}
    d = {'sourceLevel':'Preview','sourceHostBytes':4096,'sourceCacheBytes':4096,'nativeMs':1.25}
    if r['kind'] == 'before':
        d.update(beforeFingerprint='b'*16,effectiveBeforeFingerprint='c'*16)
    if operation == 'plan':
        r.update(nativeWidth=32,nativeHeight=24,fullWidth=16,fullHeight=12)
    else:
        r.update(width=t['window']['w'],height=t['window']['h'])
        d.update(workWindow=t['window'],execution={'outcome':'cpu_not_tried','backend':'cpu','reason':'gpu_disabled'},
                 stageCache={'mode':cache,'applied':cache=='on','reason':'none','cpuBytes':0,'gpuBytes':0,'retainedBytes':0,'budgetBytes':budget})
    meta = {'response':r,'diagnostics':d}
    output = {'isError':False,'content':[{'type':'text','text':json.dumps(meta)}]}
    if operation == 'plan':
        output['structuredContent'] = meta
    else:
        output['content'].insert(0,{'type':'image','data':base64.b64encode(png(r['width'],r['height'])).decode(),'mimeType':'image/png'})
    return output


def enable(child):
    old = child.stdin.respond
    child.region_arguments = []
    def respond(message):
        if message['method'] == 'tools/list':
            properties = {'before': {'type': 'boolean'}}
            if child.adaptive_supported:
                properties.update(quality={'type':'string','enum':['draft','full']},
                    preview_contract={'type':'integer','enum':[1]}, stage_cache={'type':'string','enum':['off','on']},
                    stage_cache_budget_bytes={'type':'integer'})
            return reply(child.stdout,message,{'tools':[tool(),{'name':'render_preview','inputSchema':{'properties':properties}}]})
        if message['method'] != 'tools/call' or message['params']['name'] != 'render_region_preview':
            return old(message)
        args = message['params']['arguments']
        child.region_arguments.append(copy.deepcopy(args))
        async def render():
            child.inflight += 1
            child.max_inflight = max(child.inflight, child.max_inflight)
            child.render_started.set()
            try:
                if child.gate is not None:
                    await child.gate.wait()
                reply(child.stdout,message,result(args['target'],args['operation'],cache=args['stage_cache'],budget=args.get('stage_cache_budget_bytes',0)))
            finally:
                child.inflight -= 1
        task = asyncio.create_task(render())
        child.deferred.add(task)
        task.add_done_callback(child.deferred.discard)
    child.stdin.respond = respond
    child.before_supported = True


def test_c0_schema_and_native_copies_are_the_same_contract():
    root = Path(__file__).parents[2]
    assert region.SCHEMA == json.loads((root/'frontend/src/rawRegion.schema.json').read_text())
    assert region.supports_region({'tools':[tool()]})
    for value in ({}, {'tools':[]}, {'tools':[tool(),tool()]}, {'tools':[{'name':'render_region_preview','inputSchema':None}]}):
        assert not region.supports_region(value)
    bad = copy.deepcopy(tool());bad['inputSchema']['properties']['region_contract']['enum'] = [True]
    assert not region.supports_region({'tools':[bad]})
    assert not region.matches(1, {'type':'integer','unknownConstraint':True})


def test_frozen_backend_includes_the_same_runtime_schema(tmp_path):
    root=Path(__file__).parents[2]
    source=root/'desktop/packaging/backend.spec'
    tree=ast.parse(source.read_text(encoding='utf-8'))
    analysis=next(n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='Analysis')
    data_node=next(k.value for k in analysis.keywords if k.arg=='datas')
    data=eval(compile(ast.Expression(data_node),str(source),'eval'),
              {'repository':root,'frontend':root/'frontend/dist','manifest':tmp_path/'manifest.json','str':str})
    assert (str(root/'backend/raw_region_schema.json'),'.') in data
    assert json.loads((root/'backend/raw_region_schema.json').read_text())==region.SCHEMA


@pytest.mark.parametrize('operation,kind', [('plan','after'),('render','after'),('plan','before'),('render','before')])
def test_region_protocol_owner_and_settings_unchanged(tmp_path,operation,kind):
    async def run():
        raw,manager,children,files = await create(tmp_path)
        enable(children[0])
        try:
            handle, initial = await raw.open_raw(str(uuid4()),files[0])
            before = raw._photo(handle).settings_json
            t = target(raw,handle,operation=operation,kind=kind)
            ticket = raw.request_region(handle,t,operation=operation)
            t['viewGeneration'] = 999
            output = await ticket
            assert output.metadata['response']['kind'] == kind
            assert output.metadata['response']['viewGeneration'] == 1
            assert bool(output.data) == (operation == 'render')
            assert raw._photo(handle).settings_json == before
            assert raw._photo(handle).applied_revision == initial.revision
            assert children[0].max_inflight == 1
            assert await manager._raw_region_supported(handle.generation)
            assert children[0].region_arguments[-1]['region_contract'] == 1
            assert not any(command.startswith('develop.') and command != 'develop.get' for command,_ in children[0].commands)
        finally:
            await raw.close();await manager.close()
    asyncio.run(run())


def test_region_latest_pending_cancel_and_whole_share_one_owner(tmp_path):
    async def run():
        raw,manager,children,files = await create(tmp_path)
        child = children[0];enable(child)
        try:
            handle,_ = await raw.open_raw(str(uuid4()),files[0])
            child.gate = asyncio.Event()
            first = raw.request_region(handle,target(raw,handle))
            waiter = asyncio.create_task(first.wait())
            await child.render_started.wait()
            waiter.cancel();await asyncio.gather(waiter,return_exceptions=True)
            pending = [raw.request_region(handle,target(raw,handle,view=v)) for v in range(2,102)]
            for p in pending[:-1]:
                assert (await p) is SUPERSEDED
            assert child.inflight == child.max_inflight == 1 and first.abandoned
            assert raw._before_pending is None
            child.gate.set()
            last = await pending[-1]
            assert last.metadata['response']['viewGeneration'] == 101
            assert len(child.region_arguments) == 2 and child.max_inflight == 1
            whole = await raw.request_preview(handle,raw._photo(handle).applied_revision)
            assert whole.width == 16 and child.max_inflight == 1
        finally:
            child.gate.set();await raw.close();await manager.close()
    asyncio.run(run())


def test_region_validation_is_joined_on_shutdown(tmp_path,monkeypatch):
    async def run():
        raw,manager,children,files = await create(tmp_path)
        enable(children[0]);started=threading.Event();gate=threading.Event()
        validate=region.validate_result
        def blocked(*args):
            started.set();gate.wait(5);return validate(*args)
        monkeypatch.setattr(region,'validate_result',blocked)
        try:
            handle,_ = await raw.open_raw(str(uuid4()),files[0])
            ticket=raw.request_region(handle,target(raw,handle))
            await until(started.is_set)
            closing=asyncio.create_task(raw.close());await asyncio.sleep(.02)
            assert not closing.done() and raw._validation is not None
            gate.set();await closing
            assert raw._validation is None and raw._worker.done()
            assert ticket._future.done()
        finally:
            gate.set();await raw.close();await manager.close()
    asyncio.run(run())


def test_region_request_rejects_bad_shapes_and_spoofed_owner(tmp_path):
    async def run():
        raw,manager,children,files=await create(tmp_path);enable(children[0])
        try:
            handle,_=await raw.open_raw(str(uuid4()),files[0]);t=target(raw,handle)
            for patch in ({'quality':'fast'},{'fullWidth':True},{'extra':1},{'context':2**53},{'requestId':'private path'},
                          {'window':{'x':0,'y':0,'w':2048,'h':2048}}, {'validRegion':{'x':1,'y':0,'w':7,'h':8}}):
                with pytest.raises(LightCraftError):
                    raw.request_region(handle,t|patch)
            with pytest.raises(LightCraftError,match='raw_revision_conflict'):
                raw.request_region(handle,t|{'identity':t['identity']|{'sourceId':'f'*64}})
            assert not children[0].region_arguments
        finally:
            await raw.close();await manager.close()
    asyncio.run(run())


def test_region_response_png_metadata_and_identity_are_validated(tmp_path):
    async def run():
        raw,manager,children,files=await create(tmp_path)
        try:
            handle,_=await raw.open_raw(str(uuid4()),files[0]);t=target(raw,handle)
            good=result(t,'render')
            assert region.validate_result(good,t,'render',1)[0].startswith(b'\x89PNG')
            for patch in ({'width':7},{'geometryId':'f'*64},{'viewGeneration':2},{'quality':'draft'}):
                bad=copy.deepcopy(good);meta=json.loads(bad['content'][1]['text']);meta['response'].update(patch);bad['content'][1]['text']=json.dumps(meta)
                with pytest.raises(LightCraftError):region.validate_result(bad,t,'render',1)
            bad=copy.deepcopy(good);bad['content'][0]['data']='A'*(4*((region.MAX_PNG_BYTES+2)//3)+4)
            with pytest.raises(LightCraftError):region.validate_result(bad,t,'render',1)
            bad=copy.deepcopy(good);bad['content'][1]['text']=' '* (region.MAX_METADATA_BYTES+1)
            with pytest.raises(LightCraftError):region.validate_result(bad,t,'render',1)
        finally:
            await raw.close();await manager.close()
    asyncio.run(run())


def test_method_aware_region_line_limit_does_not_use_whole_envelope():
    async def run():
        reader=asyncio.StreamReader(limit=24*1024**2)
        def respond(message):
            reply(reader,message,{'isError':False,'content':[{'type':'image','data':'A'*(region.MAX_LINE_BYTES+1)}]})
        client=LightCraftMCP(reader,PipeWriter(respond),1)
        try:
            with pytest.raises(MCPTransportError,match='lightcraft_response_too_large'):
                await client.call_tool_result('render_region_preview',{'operation':'render'},timeout=5)
        finally:
            await client.close()
    asyncio.run(run())


def test_region_timeout_reaps_native_and_old_generation_is_unusable(tmp_path):
    async def run():
        raw,manager,children,files=await create(tmp_path);child=children[0];enable(child)
        try:
            handle,_=await raw.open_raw(str(uuid4()),files[0]);child.gate=asyncio.Event()
            raw._timeouts=replace(raw._timeouts,preview=.03)
            ticket=raw.request_region(handle,target(raw,handle))
            with pytest.raises(LightCraftError):await ticket
            await until(lambda: child.returncode is not None)
            assert child.returncode is not None and not child.inflight
            with pytest.raises(LightCraftError):raw.request_region(handle,target(raw,handle))
        finally:
            child.gate.set();await raw.close();await manager.close()
    asyncio.run(run())


def test_region_cache_mode_and_budget_reach_the_same_owner(tmp_path):
    async def run():
        raw,manager,children,files=await create(tmp_path);enable(children[0])
        try:
            handle,_=await raw.open_raw(str(uuid4()),files[0])
            raw._stage_mode='on';raw._stage_budget=512*1024**2
            output=await raw.request_region(handle,target(raw,handle))
            assert output.metadata['diagnostics']['stageCache']['budgetBytes']==512*1024**2
            assert children[0].region_arguments[-1]['stage_cache']=='on'
        finally:
            await raw.close();await manager.close()
    asyncio.run(run())


def test_region_can_echo_a_document_token_attested_by_the_public_owner(tmp_path):
    async def run():
        raw,manager,children,files=await create(tmp_path);enable(children[0])
        try:
            handle,_=await raw.open_raw(str(uuid4()),files[0]);t=target(raw,handle)
            public_token='e'*32
            t['identity']=raw.region_identity(handle,document_token=public_token)
            with pytest.raises(LightCraftError,match='raw_revision_conflict'):
                raw.request_region(handle,t)
            output=await raw.request_region(handle,t,document_token=public_token)
            assert output.metadata['response']['identity']['documentToken']==public_token
            assert output.handle==handle
        finally:
            await raw.close();await manager.close()
    asyncio.run(run())


def test_region_capability_is_optional_and_does_not_enable_the_existing_viewer_route(local,tmp_path,monkeypatch):
    async def run():
        api,manager,children,_=await setup(tmp_path,local,monkeypatch)
        enable(children[0])
        try:
            async with client(local) as http:
                await authenticate(http,local)
                capability=(await http.get('/api/raw/capabilities')).json()
                assert capability['available'] is True and capability['regionContract']==1
                _,doc=await open_document(http)
                rejected=await http.post(f'/api/raw/documents/{doc["handle"]}/preview',json=whole_target(doc)|{'mode':'region'})
                assert rejected.status_code==400 and not children[0].region_arguments
        finally:
            await api.close()
    asyncio.run(run())
