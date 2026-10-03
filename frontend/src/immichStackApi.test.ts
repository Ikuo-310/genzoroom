import { afterEach, expect, it, vi } from 'vitest';
import { fetchSelectedImmichStacks } from './api';

const id = '12345678-1234-4234-9234-123456789abc';
const other = '22345678-1234-4234-9234-123456789abc';
const stackId = '32345678-1234-4234-9234-123456789abc';
const asset = (assetId: string) => ({ id: assetId, filename:'photo.dng', date:'2026-10-01', thumbnail_url:'/thumb', format:'DNG', is_raw:true, stackId, primaryAssetId:id, stackAssetCount:2 });
const stack = () => ({ id:stackId, primaryAssetId:id, assets:[asset(other), asset(id)] });
afterEach(() => vi.unstubAllGlobals());

it('resolves duplicate selected Stack IDs in one read-only batch and preserves order', async () => {
 const fetch = vi.fn(async () => new Response(JSON.stringify([stack()]))); vi.stubGlobal('fetch', fetch);
 const signal = new AbortController().signal;
 expect(await fetchSelectedImmichStacks([stackId, stackId], signal)).toEqual([stack()]);
 expect(fetch).toHaveBeenCalledOnce();
 expect(fetch.mock.calls[0]).toEqual(['/api/stacks/resolve', expect.objectContaining({method:'POST', signal, body:JSON.stringify({stackIds:[stackId]}), cache:'no-store'})]);
});
it('does not request empty input and rejects invalid or oversized input', async () => {
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
 expect(await fetchSelectedImmichStacks([], new AbortController().signal)).toEqual([]);
 for (const ids of [['bad'], Array(101).fill(stackId)]) await expect(fetchSelectedImmichStacks(ids, new AbortController().signal)).rejects.toThrow('Invalid');
 expect(fetch).not.toHaveBeenCalled();
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
