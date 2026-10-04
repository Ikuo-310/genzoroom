// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ImmichStack, RecentAsset } from './assets';
import { ImmichStacksError } from './api';
import { frontendLogger } from './frontendLogging';
import { useSelectedImmichStacks } from './useSelectedImmichStacks';
const fetchStacks = vi.hoisted(() => vi.fn());
vi.mock('./api', async importOriginal => ({ ...(await importOriginal<typeof import('./api')>()), fetchSelectedImmichStacks: fetchStacks }));
const stackId = '32345678-1234-4234-9234-123456789abc';
const photos: RecentAsset[] = ['12345678-1234-4234-9234-123456789abc','22345678-1234-4234-9234-123456789abc'].map(id => ({id,filename:'photo.jpg',date:'2026-10-01',format:'JPEG',is_raw:false,thumbnail_url:'/thumb',stackId,primaryAssetId:'12345678-1234-4234-9234-123456789abc',stackAssetCount:2}));
const stacks: ImmichStack[] = [{id:stackId,primaryAssetId:photos[0].id,assets:photos}];
let root: Root, host: HTMLDivElement, current: ReturnType<typeof useSelectedImmichStacks>;
let pending: Array<{signal:AbortSignal;resolve:(value:ImmichStack[])=>void;reject:(reason:Error)=>void}>;
function Probe({assets}:{assets:RecentAsset[]}) { current=useSelectedImmichStacks(assets); return null; }
async function render(assets:RecentAsset[],strict=false) { await act(async()=>root.render(strict ? <StrictMode><Probe assets={assets}/></StrictMode> : <Probe assets={assets}/>)); }
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true); pending=[];
 frontendLogger.clear();frontendLogger.setLevel('off');
 fetchStacks.mockReset().mockImplementation((_ids:string[],signal:AbortSignal)=>new Promise<ImmichStack[]>((resolve,reject)=>pending.push({signal,resolve,reject})));
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();frontendLogger.clear();frontendLogger.setLevel('off');vi.unstubAllGlobals();vi.restoreAllMocks();});
it('extracts unique Stack IDs for one request and skips non-Stack selections',async()=>{
 await render(photos);expect(fetchStacks.mock.calls[0][0]).toEqual([stackId]);expect(fetchStacks).toHaveBeenCalledOnce();
 expect(current.loading).toBe(true);await act(async()=>pending.shift()!.resolve(stacks));expect(current.stacks).toEqual(stacks);
 await render(photos.map(({stackId: _s,primaryAssetId: _p,...asset})=>asset));expect(fetchStacks).toHaveBeenCalledOnce();expect(current.loading).toBe(false);
});
it('accepts singleton resolution and logs successful memberCount 1',async()=>{
 frontendLogger.setLevel('debug');
 const member={...photos[0],stackAssetCount:1};
 const snapshot={id:stackId,primaryAssetId:member.id,assets:[member]};
 await render([member]);await act(async()=>pending.shift()!.resolve([snapshot]));
 expect(current.error).toBe(false);expect(current.stacks).toEqual([snapshot]);
 expect(frontendLogger.getEntries().find(entry=>entry.event==='resolve.success')).toMatchObject({context:{memberCount:1,returnedStackCount:1}});
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
it('logs successful Stack resolution only at DEBUG',async()=>{
 frontendLogger.setLevel('debug');await render(photos);
 await act(async()=>pending.shift()!.resolve(stacks));
 expect(current.error).toBe(false);
 expect(frontendLogger.getEntries().map(entry=>[entry.level,entry.event])).toEqual([['debug','resolve.start'],['debug','resolve.success']]);
 expect(frontendLogger.getEntries()[0].context).toMatchObject({mode:'resolve',selectedAssetCount:2,requestedStackCount:1});
});
it('logs requested Stack absence as a WARN mismatch and terminal ERROR',async()=>{
 frontendLogger.setLevel('warn');await render(photos);
 await act(async()=>pending.shift()!.reject(new ImmichStacksError('requested_stack_missing',{missingStackIds:[stackId]})));
 expect(current.error).toBe(true);
 expect(frontendLogger.getEntries()).toHaveLength(3);
 const warnings=frontendLogger.getEntries().filter(entry=>entry.event==='validation.mismatch');
 expect(warnings.map(entry=>entry.context?.selectedAssetId).sort()).toEqual(photos.map(asset=>asset.id).sort());
 expect(warnings.every(entry=>entry.level==='warn'&&entry.context?.errorCode==='requested_stack_missing'
  &&entry.context?.expectedStackId===stackId&&entry.context?.returnedStackFound===false
  &&entry.context?.returnedMemberCount===0&&entry.context?.selectedAssetPresent===false)).toBe(true);
 expect(frontendLogger.getEntries().at(-1)).toMatchObject({level:'error',event:'operation.failed',context:{mode:'resolve',errorCode:'requested_stack_missing',selectedAssetCount:2,requestedStackCount:1}});
 expect(frontendLogger.getEntries().some(entry=>entry.level==='debug')).toBe(false);
});
it('logs singleton validation before failure with the returned member and primary IDs',async()=>{
 frontendLogger.setLevel('debug');await render(photos);
 await act(async()=>pending.shift()!.reject(new ImmichStacksError('singleton_stack',{
  stackId,primaryAssetId:photos[0].id,memberCount:1,memberIds:[photos[0].id],
 })));
 const warning=frontendLogger.getEntries().find(entry=>entry.event==='validation.mismatch')!;
 expect(warning).toMatchObject({level:'warn',context:{errorCode:'singleton_stack',expectedStackId:stackId,returnedStackFound:true,
  returnedStackId:stackId,returnedPrimaryAssetId:photos[0].id,returnedMemberCount:1,returnedMemberIds:[photos[0].id],selectedAssetPresent:true}});
 expect(frontendLogger.getEntries().at(-1)).toMatchObject({level:'error',event:'operation.failed',context:{errorCode:'singleton_stack'}});
 expect(frontendLogger.getEntries().some(entry=>entry.event==='resolve.start'&&entry.level==='debug')).toBe(true);
});
it('logs selected-member mismatch IDs and terminal failure while preserving failure state if logging throws',async()=>{
 frontendLogger.setLevel('warn');const selected={...photos[0],id:'42345678-1234-4234-9234-123456789abc'};
 await render([selected]);await act(async()=>pending.shift()!.resolve(stacks));
 expect(current.error).toBe(true);expect(current.stacks).toEqual([]);
 expect(frontendLogger.getEntries()).toHaveLength(2);
 expect(frontendLogger.getEntries()[0]).toMatchObject({level:'warn',event:'validation.mismatch',context:{
  selectedAssetId:selected.id,expectedStackId:stackId,returnedStackFound:true,returnedStackId:stackId,
  returnedPrimaryAssetId:photos[0].id,returnedMemberCount:2,returnedMemberIds:photos.map(asset=>asset.id),selectedAssetPresent:false,
 }});
 expect(frontendLogger.getEntries()[1]).toMatchObject({level:'error',event:'operation.failed',context:{errorCode:'selected_member_missing'}});

 frontendLogger.clear();const add=vi.spyOn(frontendLogger,'add').mockImplementation(()=>{throw new Error('logger unavailable');});
 await render([selected]);await act(async()=>pending.shift()!.resolve(stacks));
 expect(current.error).toBe(true);expect(current.stacks).toEqual([]);expect(add).toHaveBeenCalled();
});
it('keeps logging disabled at OFF and does not log stale or aborted generations as failures',async()=>{
 await render(photos);const old=pending.shift()!;
 await render([...photos]);const currentRequest=pending.shift()!;
 await act(async()=>old.reject(new DOMException('Aborted','AbortError')));
 await act(async()=>currentRequest.resolve(stacks));
 expect(current.error).toBe(false);expect(frontendLogger.getEntries()).toEqual([]);
 await render([{...photos[0],id:'42345678-1234-4234-9234-123456789abc'}]);
 await act(async()=>pending.shift()!.resolve(stacks));
 expect(current.error).toBe(true);expect(frontendLogger.getEntries()).toEqual([]);

 frontendLogger.setLevel('warn');await render(photos);const stale=pending.shift()!;
 await render([...photos]);const latest=pending.shift()!;
 await act(async()=>stale.reject(new Error('stale')));
 await act(async()=>latest.resolve(stacks));
 expect(frontendLogger.getEntries().some(entry=>entry.event==='operation.failed')).toBe(false);
});
