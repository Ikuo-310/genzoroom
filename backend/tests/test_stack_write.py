import asyncio
import json
from uuid import UUID
from unittest.mock import patch
import httpx
import pytest
from pydantic import ValidationError
from stack_write import StackApplyRequest, apply_stacks
from main import app
from test_stack_assets import IDS, STACK_ID, SECOND_STACK_ID, stack
A,B,C,D=IDS[:4]
NEW=str(UUID(int=100))
def op(kind='create',name='one',**values):
    return {'operationId':name,'type':kind,**({} if kind=='create' else {'stackId':STACK_ID}),**({} if kind=='delete' else {'memberIds':[A,B],'primaryAssetId':A}),**values}
def written(ids=(A,B),primary=A,stack_id=NEW,code=201):
    return httpx.Response(code,json={'id':stack_id,'primaryAssetId':primary,'assets':[{'id':i} for i in reversed(ids)]})
def execute(operations,existing=(),outcomes=()):
    calls=[];responses=iter(outcomes)
    def handler(request):
        assert request.headers['x-api-key']=='key'
        if request.method=='GET': return httpx.Response(200,json=list(existing))
        calls.append((request.method,request.url.path,json.loads(request.content) if request.content else None))
        result=next(responses)
        if isinstance(result,Exception): raise result
        return result
    result=asyncio.run(apply_stacks('http://immich.example/api','key',StackApplyRequest(operations=operations),transport=httpx.MockTransport(handler)))
    return result.results,calls
@pytest.mark.parametrize('kind',['create','update','delete'])
def test_valid(kind): assert StackApplyRequest(operations=[op(kind)]).operations[0].type==kind
def test_operation_id_length_boundary():
    assert len(StackApplyRequest(operations=[op(name='x'*200)]).operations[0].operationId)==200
    with pytest.raises(ValidationError): StackApplyRequest(operations=[op(name='x'*201)])
@pytest.mark.parametrize('invalid',[op(memberIds=[A]),op('update',memberIds=[A]),op(memberIds=[A,A]),op(primaryAssetId=C),op(stackId=STACK_ID),op('delete',memberIds=[A,B]),op('delete',primaryAssetId=A),op('update',stackId=None),op(memberIds=['bad',B]),op('delete',stackId='bad'),op(operationId=''),op(extra=True)])
def test_invalid_operation(invalid):
    with pytest.raises(ValidationError): StackApplyRequest(operations=[invalid])
@pytest.mark.parametrize('operations',[[op(),op(name='one',memberIds=[C,D],primaryAssetId=C)],[op('delete'),op('update',name='two')],[op(),op(name='two',memberIds=[B,C],primaryAssetId=B)],[op('delete',name=str(i),stackId=str(UUID(int=100+i))) for i in range(501)]])
def test_invalid_batch(operations):
    with pytest.raises(ValidationError): StackApplyRequest(operations=operations)
def test_empty_and_route():
    assert asyncio.run(apply_stacks(None,None,StackApplyRequest(operations=[]))).results==[]
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            assert (await client.post('/stacks/apply',json={'operations':[op(memberIds=[A])]})).status_code==422
            assert (await client.post('/stacks/apply',json={'operations':[]})).json()=={'results':[]}
    asyncio.run(run())
def test_create_primary_first_and_response_set_order():
    results,calls=execute([op(primaryAssetId=B)],outcomes=[written(primary=B)])
    assert results[0].status=='success' and str(results[0].stackId)==NEW
    assert calls==[('POST','/api/stacks',{'assetIds':[B,A]})]
def test_cover_update_and_delete():
    results,calls=execute([op('update',primaryAssetId=B)],[stack(member_ids=[A,B])],[written(primary=B,stack_id=STACK_ID,code=200)])
    assert results[0].status=='success' and calls==[('PUT',f'/api/stacks/{STACK_ID}',{'primaryAssetId':B})]
    results,calls=execute([op('delete')],[stack(member_ids=[A,B])],[httpx.Response(204)])
    assert results[0].status=='success' and str(results[0].releasedStackId)==STACK_ID
def test_partial_replacement_reports_committed_delete():
    results,calls=execute([op('update',memberIds=[A,C])],[stack(member_ids=[A,B])],[httpx.Response(204),httpx.Response(500)])
    assert [c[0] for c in calls]==['DELETE','POST']
    assert results[0].status=='failed' and str(results[0].releasedStackId)==STACK_ID
def test_dependency_delete_before_create():
    results,calls=execute([op(memberIds=[A,C]),op('delete',name='release')],[stack(member_ids=[A,B])],[httpx.Response(204),written(ids=[A,C])])
    assert [c[0] for c in calls]==['DELETE','POST'] and all(r.status=='success' for r in results)
@pytest.mark.parametrize('failure',[httpx.Response(400),httpx.Response(401),httpx.Response(403),httpx.Response(500),httpx.ReadTimeout('timeout'),httpx.ConnectError('offline')])
def test_dependency_failure_blocks_only_dependent(failure):
    results,calls=execute([op('delete'),op(name='dependent',memberIds=[A,C]),op(name='independent',memberIds=[D,IDS[4]],primaryAssetId=D)],[stack(member_ids=[A,B])],[failure,written(ids=[D,IDS[4]],primary=D)])
    assert results[0].status==('unknown' if isinstance(failure,Exception) else 'failed')
    assert results[1].status=='blocked' and results[2].status=='success' and len(calls)==2
    if isinstance(failure,httpx.Response) and failure.status_code in (401,403): assert results[0].errorCode=='authentication_failed'
@pytest.mark.parametrize('response',[httpx.Response(201,json={}),written(ids=[A,C]),written(primary=B),httpx.Response(200,json={}),httpx.ReadTimeout('timeout')])
def test_unknown_not_retried(response):
    results,calls=execute([op()],outcomes=[response]);assert results[0].status=='unknown' and len(calls)==1
def test_cycle_releases_all_before_creating():
    results,calls=execute([op('update',memberIds=[A,C]),op('update',name='two',stackId=SECOND_STACK_ID,memberIds=[B,D],primaryAssetId=B)],[stack(member_ids=[A,B]),stack(SECOND_STACK_ID,C,[C,D])],[httpx.Response(204),httpx.Response(204),written(ids=[A,C]),written(ids=[B,D],primary=B,stack_id=str(UUID(int=101)))])
    assert [c[0] for c in calls]==['DELETE','DELETE','POST','POST'] and all(r.status=='success' for r in results)
def test_active_membership_and_missing_stack():
    results,calls=execute([op()],[stack(member_ids=[A,B])],[]);assert results[0].status=='blocked' and not calls
    results,calls=execute([op('delete')],[],[]);assert results[0].status=='failed' and not calls
def test_client_settings():
    real=httpx.AsyncClient;settings=[]
    def factory(**kwargs): settings.append(kwargs);return real(**kwargs)
    with patch('httpx.AsyncClient',side_effect=factory): execute([op()],outcomes=[written()])
    assert len(settings)==2
    for options in settings:
        assert options['trust_env'] is False and options['follow_redirects'] is False
        assert options['timeout'].connect==3 and options['timeout'].read==5

def test_multiple_creates_deletes_and_updates_keep_independent_partial_success():
    results,calls=execute([op(),op(name='second',memberIds=[C,D],primaryAssetId=C)],outcomes=[written(),httpx.Response(500)])
    assert [r.status for r in results]==['success','failed'] and [c[0] for c in calls]==['POST','POST']
    results,calls=execute([op('delete'),op('delete',name='second',stackId=SECOND_STACK_ID)],
        [stack(member_ids=[A,B]),stack(SECOND_STACK_ID,C,[C,D])],[httpx.Response(500),httpx.Response(204)])
    assert [r.status for r in results]==['failed','success'] and [c[0] for c in calls]==['DELETE','DELETE']
    results,calls=execute([op('update',primaryAssetId=B),op('update',name='second',stackId=SECOND_STACK_ID,memberIds=[C,D],primaryAssetId=D)],
        [stack(member_ids=[A,B]),stack(SECOND_STACK_ID,C,[C,D])],[written(primary=B,stack_id=STACK_ID,code=200),written(ids=[C,D],primary=D,stack_id=SECOND_STACK_ID,code=200)])
    assert all(r.status=='success' for r in results) and [c[0] for c in calls]==['PUT','PUT']

def test_update_release_before_dependent_create():
    results,calls=execute([op(name='new',memberIds=[B,D],primaryAssetId=B),op('update',memberIds=[A,C])],[stack(member_ids=[A,B])],
        [httpx.Response(204),written(ids=[B,D],primary=B),written(ids=[A,C])])
    assert all(r.status=='success' for r in results) and [c[0] for c in calls]==['DELETE','POST','POST']

def test_malformed_update_success_and_unexpected_delete_status_are_unknown():
    results,_=execute([op('update')],[stack(member_ids=[A,B])],[written(ids=[A,C],stack_id=STACK_ID,code=200)])
    assert results[0].status=='unknown'
    results,_=execute([op('delete')],[stack(member_ids=[A,B])],[httpx.Response(200)])
    assert results[0].status=='unknown'

def test_preflight_failure_per_operation_never_writes():
    calls=[]
    def handler(request):
        calls.append(request.method)
        return httpx.Response(403,json={'message':'private upstream body'})
    result=asyncio.run(apply_stacks('http://immich.example','key',StackApplyRequest(operations=[op(),op('delete',name='old')]),transport=httpx.MockTransport(handler)))
    assert calls==['GET']
    assert all(r.status=='failed' and r.errorCode=='authentication_failed' for r in result.results)
    assert 'private upstream body' not in result.model_dump_json()

@pytest.mark.parametrize('body',[
 {'id':NEW,'primaryAssetId':A,'assets':[{'id':A},{'id':A}]},
 {'id':True,'primaryAssetId':A,'assets':[{'id':A},{'id':B}]},
 {'id':NEW,'primaryAssetId':A,'assets':None},
])
def test_malformed_committed_write_response_remains_unknown(body):
    results,calls=execute([op()],outcomes=[httpx.Response(201,json=body)])
    assert results[0].status=='unknown' and len(calls)==1
