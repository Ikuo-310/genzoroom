import { afterEach, expect, it, vi } from 'vitest';
import { fetchSelectedImmichStacks, refreshSelectedImmichStacks } from './api';

const id = '12345678-1234-4234-9234-123456789abc';
const other = '22345678-1234-4234-9234-123456789abc';
const stackId = '32345678-1234-4234-9234-123456789abc';
const asset = (assetId: string) => ({ id: assetId, filename:'photo.dng', date:'2026-10-01', thumbnail_url:'/thumb', format:'DNG', is_raw:true, stackId, primaryAssetId:id, stackAssetCount:2 });
const stack = () => ({ id:stackId, primaryAssetId:id, assets:[asset(other), asset(id)] });
const generatedStackIds=(count:number)=>Array.from({length:count},(_,index)=>`52345678-1234-4234-9234-${String(index+100).padStart(12,'0')}`);
const resolvedStack=(requestedStackId:string,index:number)=>{
 const primary=`62345678-1234-4234-9234-${String(index+500).padStart(12,'0')}`;
 const member=`72345678-1234-4234-9234-${String(index+900).padStart(12,'0')}`;
 const photo=(assetId:string)=>({id:assetId,filename:'photo.jpg',date:'2026-10-01',thumbnail_url:'/thumb',format:'JPEG',is_raw:false,stackId:requestedStackId,primaryAssetId:primary,stackAssetCount:2});
 return {id:requestedStackId,primaryAssetId:primary,assets:[photo(member),photo(primary)]};
};
afterEach(() => vi.unstubAllGlobals());

it('resolves duplicate selected Stack IDs in one read-only batch and preserves order', async () => {
 const fetch = vi.fn(async () => new Response(JSON.stringify([stack()]))); vi.stubGlobal('fetch', fetch);
 const signal = new AbortController().signal;
 expect(await fetchSelectedImmichStacks([stackId, stackId], signal)).toEqual([stack()]);
 expect(fetch).toHaveBeenCalledOnce();
 expect(fetch.mock.calls[0]).toEqual(['/api/stacks/resolve', expect.objectContaining({method:'POST', signal, body:JSON.stringify({stackIds:[stackId]}), cache:'no-store'})]);
});
it('does not request empty input and rejects invalid UUIDs before fetching', async () => {
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
 expect(await fetchSelectedImmichStacks([], new AbortController().signal)).toEqual([]);
 for (const ids of [['bad'], [...generatedStackIds(101),'bad']]) await expect(fetchSelectedImmichStacks(ids, new AbortController().signal)).rejects.toThrow('Invalid');
 expect(fetch).not.toHaveBeenCalled();
});
it.each([1,100])('resolves %i requested Stacks in one request',async(count)=>{
 const ids=generatedStackIds(count),signal=new AbortController().signal;
 const fetch=vi.fn(async(_url:string,init:RequestInit)=>{
  const requested=(JSON.parse(init.body as string) as {stackIds:string[]}).stackIds;
  return new Response(JSON.stringify(requested.map(id=>resolvedStack(id,ids.indexOf(id)))));
 });vi.stubGlobal('fetch',fetch);
 expect((await fetchSelectedImmichStacks(ids,signal)).map(value=>value.id)).toEqual(ids);
 expect(fetch).toHaveBeenCalledOnce();expect(JSON.parse(fetch.mock.calls[0][1].body as string).stackIds).toHaveLength(count);
 expect(fetch.mock.calls[0][1].signal).toBe(signal);
});
it('resolves 101 unique Stack IDs as sequential 100 plus 1 requests',async()=>{
 const ids=generatedStackIds(101),signal=new AbortController().signal;
 const fetch=vi.fn(async(_url:string,init:RequestInit)=>{
  const requested=(JSON.parse(init.body as string) as {stackIds:string[]}).stackIds;
  return new Response(JSON.stringify(requested.map(id=>resolvedStack(id,ids.indexOf(id)))));
 });vi.stubGlobal('fetch',fetch);
 expect((await fetchSelectedImmichStacks(ids,signal)).map(value=>value.id)).toEqual(ids);
 expect(fetch.mock.calls.map(call=>JSON.parse(call[1].body as string).stackIds.length)).toEqual([100,1]);
 expect(fetch.mock.calls.every(call=>call[1].signal===signal)).toBe(true);
});
it('deduplicates before chunking, caps every resolve body at 100 IDs, and restores requested order',async()=>{
 const ids=generatedStackIds(205),signal=new AbortController().signal;
 const fetch=vi.fn(async(_url:string,init:RequestInit)=>{
  const requested=(JSON.parse(init.body as string) as {stackIds:string[]}).stackIds;
  return new Response(JSON.stringify([...requested].reverse().map(id=>resolvedStack(id,ids.indexOf(id)))));
 });vi.stubGlobal('fetch',fetch);
 const result=await fetchSelectedImmichStacks([...ids,ids[0].toUpperCase(),ids[80]],signal);
 expect(fetch.mock.calls.map(call=>JSON.parse(call[1].body as string).stackIds.length)).toEqual([100,100,5]);
 expect(fetch.mock.calls.every(call=>call[1].signal===signal)).toBe(true);
 expect(fetch.mock.calls.every(call=>JSON.parse(call[1].body as string).stackIds.length<=100)).toBe(true);
 expect(result.map(value=>value.id)).toEqual(ids);
});
it('fails the complete resolve when a later chunk has an HTTP, JSON, or validation error',async()=>{
 const ids=generatedStackIds(101);
 const firstChunk=ids.slice(0,100).map((id,index)=>resolvedStack(id,index));
 const secondChunk=[resolvedStack(ids[100],100)];
 const failedHttp=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(firstChunk))).mockResolvedValueOnce(new Response('',{status:502}));
 vi.stubGlobal('fetch',failedHttp);
 await expect(fetchSelectedImmichStacks(ids,new AbortController().signal)).rejects.toThrow('Stacks request failed');
 expect(failedHttp).toHaveBeenCalledTimes(2);
 for(const response of [new Response('{'),new Response(JSON.stringify([{...secondChunk[0],id:stackId}]))]){
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(firstChunk))).mockResolvedValueOnce(response);vi.stubGlobal('fetch',fetch);
  await expect(fetchSelectedImmichStacks(ids,new AbortController().signal)).rejects.toMatchObject({code:'unexpected_stack_response'});
  expect(fetch).toHaveBeenCalledTimes(2);
 }
});
it('stops after the active resolve is aborted and sends no later chunk',async()=>{
 const ids=generatedStackIds(205),controller=new AbortController();
 const fetch=vi.fn(async()=>{controller.abort();return new Response('[]');});vi.stubGlobal('fetch',fetch);
 await expect(fetchSelectedImmichStacks(ids,controller.signal)).rejects.toMatchObject({name:'AbortError'});
 expect(fetch).toHaveBeenCalledOnce();
});
it('rejects malformed, missing, duplicated or inconsistent full memberships', async () => {
 const bad = [null, {}, [], [stack(), stack()], [{...stack(), id:'bad'}], [{...stack(), primaryAssetId:'bad'}],
  [{...stack(), assets:{}}], [{...stack(), assets:[asset(id)]}], [{...stack(), primaryAssetId:stackId}],
  [{...stack(), assets:[asset(id),asset(id)]}], [{...stack(), assets:[asset(id),{...asset(other), stackId:other}]}],
  [{...stack(), assets:[asset(id),{...asset(other), stackAssetCount:null}]}],
  [{...stack(), assets:[asset(id),{...asset(other), id:'bad'}]}],
  [{...stack(), assets:[asset(id),{...asset(other), primaryAssetId:other}]}],
  [{...stack(), id:other}],
  [stack(), {...stack(),id:other, assets:[{...asset(id),stackId:other},{...asset(other),stackId:other}]}],
 ];
 for (const body of bad) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
  await expect(fetchSelectedImmichStacks(body === bad[bad.length-1] ? [stackId,other] : [stackId], new AbortController().signal)).rejects.toThrow('Unexpected');
 }
});
it('resolves and refreshes a valid singleton but still rejects omitted requested Stacks',async()=>{
 const singleton={...stack(),assets:[{...asset(id),stackAssetCount:1}]};
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify([singleton]))));
 expect(await fetchSelectedImmichStacks([stackId],new AbortController().signal)).toEqual([singleton]);
 expect(await refreshSelectedImmichStacks([id],new AbortController().signal)).toEqual([singleton]);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('[]')));
 await expect(fetchSelectedImmichStacks([stackId],new AbortController().signal)).rejects.toMatchObject({
  code:'requested_stack_missing',details:{missingStackIds:[stackId]},
 });
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify([{}]))));
 await expect(fetchSelectedImmichStacks([stackId],new AbortController().signal)).rejects.toMatchObject({code:'unexpected_stack_response'});
});

it('rejects empty or inconsistent singleton snapshots', async()=>{
 const member={...asset(id),stackAssetCount:1};
 for(const value of [
  {...stack(),assets:[]}, {...stack(),assets:[{...member,stackAssetCount:2}]},
  {...stack(),assets:[{...member,stackId:other}]}, {...stack(),assets:[{...member,primaryAssetId:other}]},
  {...stack(),primaryAssetId:other,assets:[{...member,primaryAssetId:other}]},
 ]) {
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify([value]))));
  await expect(fetchSelectedImmichStacks([stackId],new AbortController().signal)).rejects.toMatchObject({code:'unexpected_stack_response'});
 }
});
it('propagates backend failure instead of returning a partial success', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => new Response('',{status:502})));
 await expect(fetchSelectedImmichStacks([stackId],new AbortController().signal)).rejects.toThrow('Stacks request failed');
});
it('canonicalizes UUID casing so COVER still identifies a member',async()=>{
 const value=stack();const upper={...value,id:value.id.toUpperCase(),primaryAssetId:value.primaryAssetId.toUpperCase(),
  assets:value.assets.map(a=>({...a,id:a.id.toUpperCase(),stackId:a.stackId.toUpperCase(),primaryAssetId:a.primaryAssetId.toUpperCase()}))};
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify([upper]))));
 expect(await fetchSelectedImmichStacks([stackId],new AbortController().signal)).toEqual([value]);
});

const generatedAssetIds=(count:number)=>Array.from({length:count},(_,index)=>`42345678-1234-4234-9234-${String(index+100).padStart(12,'0')}`);
it.each([1001,2005])('refreshes %i selected assets in sequential chunks of at most 1000 with one abort signal',async(count)=>{
 const ids=generatedAssetIds(count),signal=new AbortController().signal;
 const fetch=vi.fn(async(_url:string,_init:RequestInit)=>new Response('[]'));vi.stubGlobal('fetch',fetch);
 expect(await refreshSelectedImmichStacks(ids,signal)).toEqual([]);
 expect(fetch.mock.calls.map(call=>JSON.parse(call[1].body as string).assetIds.length)).toEqual(count===1001?[1000,1]:[1000,1000,5]);
 expect(fetch.mock.calls.every(call=>call[0]==='/api/stacks/refresh'&&call[1].signal===signal)).toBe(true);
});
it('deduplicates an identical full Stack returned across a refresh chunk boundary and rejects conflicting copies',async()=>{
 const ids=generatedAssetIds(1001);ids[0]=id;ids[1000]=other;const signal=new AbortController().signal;
 const fetch=vi.fn(async(_url:string,_init:RequestInit)=>new Response(JSON.stringify([stack()])));vi.stubGlobal('fetch',fetch);
 expect(await refreshSelectedImmichStacks(ids,signal)).toEqual([stack()]);expect(fetch).toHaveBeenCalledTimes(2);
 const changed=stack();changed.primaryAssetId=other;changed.assets=changed.assets.map(member=>({...member,primaryAssetId:other}));
 fetch.mockResolvedValueOnce(new Response(JSON.stringify([stack()]))).mockResolvedValueOnce(new Response(JSON.stringify([changed])));
 await expect(refreshSelectedImmichStacks(ids,signal)).rejects.toThrow('Unexpected');
});
it('fails a complete refresh on any failed chunk and stops after a shared abort',async()=>{
 const ids=generatedAssetIds(1001),signal=new AbortController().signal;
 const failed=vi.fn().mockResolvedValueOnce(new Response('[]')).mockResolvedValueOnce(new Response('',{status:502}));vi.stubGlobal('fetch',failed);
 await expect(refreshSelectedImmichStacks(ids,signal)).rejects.toThrow('Stacks refresh failed');expect(failed).toHaveBeenCalledTimes(2);
 const controller=new AbortController();let calls=0;
 const aborted=vi.fn(async(_url:string,init:RequestInit)=>{calls++;if(calls===1)controller.abort();if((init.signal as AbortSignal).aborted)throw new DOMException('Aborted','AbortError');return new Response('[]');});vi.stubGlobal('fetch',aborted);
 await expect(refreshSelectedImmichStacks(ids,controller.signal)).rejects.toThrow('Aborted');expect(aborted).toHaveBeenCalledOnce();
});

it('refreshes membership from selected asset IDs and accepts dissolved selections',async()=>{
 const {refreshSelectedImmichStacks}=await import('./api');
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify([stack()])));vi.stubGlobal('fetch',fetch);
 const signal=new AbortController().signal;
 expect(await refreshSelectedImmichStacks([other],signal)).toEqual([stack()]);
 expect(fetch.mock.calls[0][0]).toBe('/api/stacks/refresh');expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({assetIds:[other]});
 fetch.mockResolvedValue(new Response('[]'));expect(await refreshSelectedImmichStacks([id],signal)).toEqual([]);
 fetch.mockResolvedValue(new Response(JSON.stringify([stack()])));
 await expect(refreshSelectedImmichStacks([stackId],signal)).rejects.toThrow('Unexpected');
 await expect(refreshSelectedImmichStacks(['bad'],signal)).rejects.toThrow('Invalid');
 fetch.mockResolvedValue(new Response(JSON.stringify([{...stack(),assets:[asset(id),asset(id)]}])));
 await expect(refreshSelectedImmichStacks([id],signal)).rejects.toThrow('Unexpected');
});
