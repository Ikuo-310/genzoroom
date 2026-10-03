// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImmichStack, RecentAsset } from './assets';
import { useSelectedImmichStacks } from './useSelectedImmichStacks';
const fetchStacks = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ fetchSelectedImmichStacks: fetchStacks }));
const stackId = '32345678-1234-4234-9234-123456789abc';
const photos: RecentAsset[] = ['12345678-1234-4234-9234-123456789abc','22345678-1234-4234-9234-123456789abc'].map(id => ({id,filename:'photo.jpg',date:'2026-10-01',format:'JPEG',is_raw:false,thumbnail_url:'/thumb',stackId,primaryAssetId:'12345678-1234-4234-9234-123456789abc',stackAssetCount:2}));
const stacks: ImmichStack[] = [{id:stackId,primaryAssetId:photos[0].id,assets:photos}];
let root: Root, host: HTMLDivElement, current: ReturnType<typeof useSelectedImmichStacks>;
let pending: Array<{signal:AbortSignal;resolve:(value:ImmichStack[])=>void;reject:(reason:Error)=>void}>;
function Probe({assets}:{assets:RecentAsset[]}) { current=useSelectedImmichStacks(assets); return null; }
async function render(assets:RecentAsset[],strict=false) { await act(async()=>root.render(strict ? <StrictMode><Probe assets={assets}/></StrictMode> : <Probe assets={assets}/>)); }
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true); pending=[];
 fetchStacks.mockReset().mockImplementation((_ids:string[],signal:AbortSignal)=>new Promise<ImmichStack[]>((resolve,reject)=>pending.push({signal,resolve,reject})));
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it('extracts unique Stack IDs for one request and skips non-Stack selections',async()=>{
 await render(photos);expect(fetchStacks.mock.calls[0][0]).toEqual([stackId]);expect(fetchStacks).toHaveBeenCalledOnce();
 expect(current.loading).toBe(true);await act(async()=>pending.shift()!.resolve(stacks));expect(current.stacks).toEqual(stacks);
 await render(photos.map(({stackId: _s,primaryAssetId: _p,...asset})=>asset));expect(fetchStacks).toHaveBeenCalledOnce();expect(current.loading).toBe(false);
});
it('aborts superseded and unmounted requests and rejects late publications',async()=>{
 await render(photos);const old=pending.shift()!;
 await render([...photos]);expect(old.signal.aborted).toBe(true);
 await act(async()=>pending.shift()!.resolve(stacks));expect(current.stacks).toEqual(stacks);
 await act(async()=>old.resolve([]));expect(current.error).toBe(false);expect(current.stacks).toEqual(stacks);
 await act(async()=>current.retry());const exit=pending.shift()!;await act(async()=>root.render(null));expect(exit.signal.aborted).toBe(true);
 await act(async()=>exit.resolve(stacks));
});
it('handles StrictMode cleanup and remains retryable after a failure',async()=>{
 await render(photos,true);expect(pending.filter(p=>!p.signal.aborted)).toHaveLength(1);
 await act(async()=>pending.filter(p=>!p.signal.aborted)[0].reject(new Error('offline')));
 expect(current.error).toBe(true);expect(current.stacks).toEqual([]);
 const calls=fetchStacks.mock.calls.length;
 await act(async()=>{current.retry();current.retry();});expect(fetchStacks).toHaveBeenCalledTimes(calls+1);
 expect(pending.filter(p=>!p.signal.aborted)).toHaveLength(1);
 await act(async()=>pending[pending.length-1].resolve(stacks));expect(current.error).toBe(false);expect(current.stacks).toEqual(stacks);
});
it('fails safely if the selected representative no longer belongs to the resolved Stack',async()=>{
 await render([{...photos[0],id:'42345678-1234-4234-9234-123456789abc'}]);
 await act(async()=>pending.shift()!.resolve(stacks));expect(current.error).toBe(true);expect(current.stacks).toEqual([]);
});
