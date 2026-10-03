import { expect, it } from 'vitest';
import type { ImmichStack, RecentAsset } from './assets';
import { mergeImmichStackSource, reconcileImmichLineage } from './immichStackDraft';
import { detectStackCandidates } from './stackCandidateDetection';
import { emptyStackDraft, stackDraftReducer as reduce } from './useEditableStackDraft';
import { buildStackWritePlan } from './stackWrite';
const asset=(id:string,filename:string,raw=false):RecentAsset=>({id,filename,is_raw:raw,format:raw?'DNG':'JPEG',date:'2026-10-01',thumbnail_url:'/thumb'});
const full=[asset('hidden-first','one.jpg'),asset('primary','one.dng',true),asset('hidden-last','one.png')];
const stack:ImmichStack={id:'stack',primaryAssetId:'primary',assets:full.map(a=>({...a,stackId:'stack',primaryAssetId:'primary',stackAssetCount:3}))};
const selected=[stack.assets[1],asset('a','two.dng',true),asset('single','single.jpg'),asset('b','two.jpg')];
const source=()=>mergeImmichStackSource(detectStackCandidates(selected),[stack],selected);
const initial=()=>{const combined=source();return reduce(emptyStackDraft,{type:'initialize',source:combined.source,assets:combined.assets});};
const groupId='draft:immich:stack';
it('clears member and Cover differences on restoration, regardless of member order',()=>{
 const original=initial();
 let draft=reduce(original,{type:'purgeMember',groupId,assetId:'hidden-first'});
 expect(draft.groups[0].modified).toBe(true);expect(draft.modified).toBe(true);
 draft=reduce(reduce(draft,{type:'select',assetId:'hidden-first'}),{type:'add',targetGroupId:groupId});
 expect(draft.groups[0].members.map(a=>a.id)).toEqual(['primary','hidden-last','hidden-first']);
 expect(draft.groups[0].modified).toBe(false);expect(draft.modified).toBe(false);
 draft=reduce(draft,{type:'cover',groupId,assetId:'hidden-last'});expect(draft.groups[0].modified).toBe(true);
 draft=reduce(draft,{type:'cover',groupId,assetId:'primary'});
 expect(draft.groups[0].modified).toBe(false);expect(draft.modified).toBe(false);
 expect(draft.sourceGroups).toBe(original.sourceGroups);
});
const recreate=(ids:string[])=>{
 let draft=reduce(initial(),{type:'purgeGroup',groupId});expect(draft.modified).toBe(true);
 for(const assetId of ids) draft=reduce(draft,{type:'select',assetId});
 return reduce(draft,{type:'create'});
};
it('restores exact lineage on recreation and preserves current Cover until explicitly restored',()=>{
 let draft=recreate(full.map(a=>a.id));const recreated=draft.groups.at(-1)!;
 expect(recreated).toMatchObject({origin:'immich',immichStackId:'stack',originalPrimaryAssetId:'primary',
  originalMemberIds:full.map(a=>a.id),modified:true,coverAssetId:'hidden-first'});
 draft=reduce(draft,{type:'cover',groupId:recreated.id,assetId:'primary'});
 expect(draft.groups.at(-1)?.modified).toBe(false);expect(draft.modified).toBe(false);
});
it('recreates an unchanged two-member lineage when automatic Cover equals the original primary',()=>{
 const pair={...stack,primaryAssetId:'hidden-first',assets:stack.assets.slice(0,2)};
 const combined=mergeImmichStackSource({groups:[],unmatched:[]},[pair],pair.assets);
 let draft=reduce(emptyStackDraft,{type:'initialize',source:combined.source,assets:combined.assets});
 draft=reduce(draft,{type:'purgeGroup',groupId});
 for(const asset of pair.assets) draft=reduce(draft,{type:'select',assetId:asset.id});
 draft=reduce(draft,{type:'create'});
 expect(draft.groups[0]).toMatchObject({origin:'immich',immichStackId:'stack',modified:false,coverAssetId:'hidden-first'});
 expect(draft.modified).toBe(false);
});
it('leaves subsets and supersets manual and rechecks their lineage after Add or Purge',()=>{
 let subset=recreate(['primary','hidden-first']);expect(subset.groups.at(-1)?.origin).toBe('manual');
 subset=reduce(reduce(subset,{type:'select',assetId:'hidden-last'}),{type:'add',targetGroupId:subset.groups.at(-1)!.id});
 expect(subset.groups.at(-1)?.origin).toBe('immich');
 let extra=recreate([...full.map(a=>a.id),'single']);expect(extra.groups.at(-1)?.origin).toBe('manual');
 extra=reduce(extra,{type:'purgeMember',groupId:extra.groups.at(-1)!.id,assetId:'single'});
 expect(extra.groups.at(-1)?.origin).toBe('immich');
});
it('rejects ambiguous snapshots, active lineage and duplicate member IDs',()=>{
 const snapshot=initial().groups[0];
 if(snapshot.origin!=='immich') throw new Error('Expected imported snapshot');
 const manual={...snapshot,id:'manual',origin:'manual' as const};
 expect(reconcileImmichLineage([manual],[snapshot,{...snapshot,id:'other',origin:'immich',immichStackId:'other'}])[0].origin).toBe('manual');
 expect(reconcileImmichLineage([snapshot,manual],[snapshot])[1].origin).toBe('manual');
 expect(reconcileImmichLineage([{...manual,members:[full[0],full[0],full[1]]}],[snapshot])[0].origin).toBe('manual');
 expect(reconcileImmichLineage([{...snapshot,members:[full[0],full[0],full[1]]}],[snapshot])[0].modified).toBe(true);
});
it('retains aggregate changes from other auto edits and manual groups',()=>{
 let draft=initial();const auto=draft.groups[1];
 draft=reduce(draft,{type:'cover',groupId:auto.id,assetId:'a'});
 draft=reduce(draft,{type:'cover',groupId,assetId:'hidden-first'});
 draft=reduce(draft,{type:'cover',groupId,assetId:'primary'});
 expect(draft.groups[0].modified).toBe(false);expect(draft.modified).toBe(true);
 expect(recreate(['primary','hidden-first']).modified).toBe(true);
});
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

it('moves one unmatched asset into a group with the same reducer rules as Add',()=>{
 const original=initial(), group=original.groups[0];
 let draft=reduce(original,{type:'dropUnmatched',assetId:'single',targetGroupId:group.id});
 expect(draft.unmatched.some(a=>a.id==='single')).toBe(false);expect(draft.groups[0].members.map(a=>a.id)).toContain('single');
 expect(draft.groups[0].coverAssetId).toBe(group.coverAssetId);expect(draft.groups[0].modified).toBe(true);
 expect(draft.groups[0].origin).toBe('immich');expect(draft.groups[0].modified).toBe(true);
 expect(new Set([...draft.groups.flatMap(g=>g.members),...draft.unmatched].map(a=>a.id)).size).toBe(draft.groups.flatMap(g=>g.members).length+draft.unmatched.length);
 expect(draft.selectedIds.has('single')).toBe(false);expect(draft.addTargetStackId).toBeNull();
 expect(reduce(original,{type:'dropUnmatched',assetId:'absent',targetGroupId:group.id})).toBe(original);
 expect(reduce(original,{type:'dropUnmatched',assetId:'single',targetGroupId:'missing'})).toBe(original);
});
it('moves members atomically, restores Immich lineage on return and leaves Cover unchanged',()=>{
 const original=initial(), immich=original.groups[0],auto=original.groups[1];
 let draft=reduce(original,{type:'moveMember',assetId:'hidden-last',sourceGroupId:immich.id,targetGroupId:auto.id});
 expect(draft.groups[0].members.map(a=>a.id)).toEqual(['hidden-first','primary']);expect(draft.groups[0].modified).toBe(true);
 expect(draft.groups[1].members.at(-1)?.id).toBe('hidden-last');expect(draft.groups[1].modified).toBe(true);
 expect(draft.groups[0].coverAssetId).toBe('primary');
 draft=reduce(draft,{type:'moveMember',assetId:'hidden-last',sourceGroupId:auto.id,targetGroupId:immich.id});
 expect(draft.groups.find(g=>g.origin==='immich')?.modified).toBe(false);
 expect(draft.groups.find(g=>g.origin==='immich')?.coverAssetId).toBe('primary');
 expect(new Set([...draft.groups.flatMap(g=>g.members),...draft.unmatched].map(a=>a.id)).size).toBe(6);
 const pending=(value:typeof draft)=>value.sourceGroups!.filter(g=>!value.completedSourceIds.has(g.id));
 expect(buildStackWritePlan(draft.groups,pending(draft)).operations.map(op=>op.type)).toEqual(['create']);
 expect(reduce(draft,{type:'moveMember',assetId:'hidden-last',sourceGroupId:immich.id,targetGroupId:immich.id})).toBe(draft);
 expect(reduce(draft,{type:'moveMember',assetId:'absent',sourceGroupId:immich.id,targetGroupId:auto.id})).toBe(draft);
});
it('uses Cover fallback and dissolves a source with one member without an intermediate unmatched copy',()=>{
 const auto=initial().groups.find(g=>g.origin==='auto')!;
 let draft=reduce(initial(),{type:'moveMember',assetId:'primary',sourceGroupId:groupId,targetGroupId:auto.id});
 const source=draft.groups.find(g=>g.id===groupId)!;
 expect(source.coverAssetId).toBe('hidden-first');expect(source.members.map(a=>a.id)).toEqual(['hidden-first','hidden-last']);
 draft=reduce(draft,{type:'moveMember',assetId:'hidden-last',sourceGroupId:groupId,targetGroupId:auto.id});
 expect(draft.groups.some(g=>g.id===groupId)).toBe(false);
 expect(draft.unmatched.map(a=>a.id)).toEqual(['single','hidden-first']);
 expect(draft.groups.find(g=>g.id===auto.id)!.members.map(a=>a.id).slice(-2)).toEqual(['primary','hidden-last']);
 expect(draft.sourceGroups![0].members).toHaveLength(3);
});
it('drops a Stack member into unmatched in Home order and preserves the send plan',async()=>{
 let draft=reduce(initial(),{type:'purgeMember',groupId,assetId:'primary'});
 expect(draft.unmatched.map(a=>a.id)).toEqual(['primary','single']);
 const {buildStackWritePlan}=await import('./stackWrite');
 const source=draft.sourceGroups!.filter(g=>!draft.completedSourceIds.has(g.id));
 expect(buildStackWritePlan(draft.groups,source).operations.map(op=>op.type)).toEqual(['update','create']);
});
