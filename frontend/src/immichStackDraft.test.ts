import { expect, it } from 'vitest';
import type { ImmichStack, RecentAsset } from './assets';
import { mergeImmichStackSource } from './immichStackDraft';
import { detectStackCandidates } from './stackCandidateDetection';
import { emptyStackDraft, stackDraftReducer as reduce } from './useEditableStackDraft';
const asset=(id:string,filename:string,raw=false):RecentAsset=>({id,filename,is_raw:raw,format:raw?'DNG':'JPEG',date:'2026-10-01',thumbnail_url:'/thumb'});
const full=[asset('hidden-first','one.jpg'),asset('primary','one.dng',true),asset('hidden-last','one.png')];
const stack:ImmichStack={id:'stack',primaryAssetId:'primary',assets:full.map(a=>({...a,stackId:'stack',primaryAssetId:'primary',stackAssetCount:3}))};
const selected=[stack.assets[1],asset('a','two.dng',true),asset('single','single.jpg'),asset('b','two.jpg')];
const source=()=>mergeImmichStackSource(detectStackCandidates(selected),[stack],selected);
const initial=()=>{const combined=source();return reduce(emptyStackDraft,{type:'initialize',source:combined.source,assets:combined.assets});};
const groupId='draft:immich:stack';
it('expands full membership beside auto groups and uses original primary and member order',()=>{
 const draft=initial();expect(draft.groups.map(g=>g.origin)).toEqual(['immich','auto']);
 expect(draft.groups[0].members.map(a=>a.id)).toEqual(['hidden-first','primary','hidden-last']);
 expect(draft.groups[0].coverAssetId).toBe('primary');expect(draft.unmatched.map(a=>a.id)).toEqual(['single']);
 const ids=[...draft.groups.flatMap(g=>g.members),...draft.unmatched].map(a=>a.id);expect(new Set(ids).size).toBe(ids.length);
});
it('retains Immich origin, Cover and original snapshot after Add and Cover changes',()=>{
 let draft=reduce(initial(),{type:'select',assetId:'single'});draft=reduce(draft,{type:'add',targetGroupId:groupId});
 expect(draft.groups[0]).toMatchObject({origin:'immich',modified:true,coverAssetId:'primary',originalMemberIds:['hidden-first','primary','hidden-last']});
 draft=reduce(draft,{type:'cover',groupId,assetId:'single'});expect(draft.groups[0].coverAssetId).toBe('single');
 expect(draft.sourceGroups![0].coverAssetId).toBe('primary');expect(draft.sourceGroups![0].members).toHaveLength(3);
});
it('marks Cover-only changes, chooses a fallback on primary Purge and keeps original primary',()=>{
 const cover=reduce(initial(),{type:'cover',groupId,assetId:'hidden-first'});expect(cover.groups[0].modified).toBe(true);
 const draft=reduce(initial(),{type:'purgeMember',groupId,assetId:'primary'});
 expect(draft.groups[0]).toMatchObject({origin:'immich',modified:true,originalPrimaryAssetId:'primary',coverAssetId:'hidden-first'});
 expect(draft.unmatched.map(a=>a.id)).toEqual(['primary','single']);
});
it('retains source information after full Purge and dissolution and supports new manual groups',()=>{
 const purged=reduce(initial(),{type:'purgeGroup',groupId});
 expect(purged.unmatched.map(a=>a.id)).toEqual(['primary','single','hidden-first','hidden-last']);
 expect(purged.sourceGroups![0]).toMatchObject({immichStackId:'stack',originalMemberIds:['hidden-first','primary','hidden-last']});
 let dissolved=reduce(initial(),{type:'purgeMember',groupId,assetId:'hidden-last'});
 dissolved=reduce(dissolved,{type:'purgeMember',groupId,assetId:'hidden-first'});
 expect(dissolved.groups.some(g=>g.id===groupId)).toBe(false);expect(dissolved.sourceGroups![0].members).toHaveLength(3);
 let recreated=reduce(purged,{type:'select',assetId:'hidden-first'});recreated=reduce(recreated,{type:'select',assetId:'primary'});
 recreated=reduce(recreated,{type:'create'});expect(recreated.groups.at(-1)?.origin).toBe('manual');
 expect(recreated.sourceGroups![0].origin).toBe('immich');
});
it('resolves overlap with Home assets without splitting a stale auto group or losing remaining assets',()=>{
 const home=[asset('hidden-first','same.dng',true),asset('free','same.jpg')];
 const combined=mergeImmichStackSource(detectStackCandidates(home),[stack],home);
 expect(combined.source.groups).toHaveLength(1);expect(combined.source.unmatched.map(a=>a.id)).toEqual(['free']);
});
