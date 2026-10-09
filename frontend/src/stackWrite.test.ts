import { expect, it, vi, afterEach } from 'vitest';
import type { RecentAsset } from './assets';
import { detectStackCandidates, type DraftStack } from './stackCandidateDetection';
import { buildStackWritePlan, sendStackWritePlan, type StackWriteResult } from './stackWrite';
import { emptyStackDraft, stackDraftReducer as reduce } from './useEditableStackDraft';
const asset=(id:string):RecentAsset=>({id,filename:id+'.jpg',format:'JPEG',is_raw:false,date:'2026-01-01',thumbnail_url:'/thumb'});
const a=asset('a'),b=asset('b'),c=asset('c'),d=asset('d');
const evidence={name:'unavailable',nameReason:'filename-family',time:'unavailable',camera:'unavailable',gps:'unavailable'} as const;
const original:DraftStack={id:'old',origin:'immich',immichStackId:'stack',members:[a,b],coverAssetId:'a',originalMemberIds:['a','b'],originalPrimaryAssetId:'a',evidence};
const singleton:DraftStack={...original,members:[a],originalMemberIds:['a']};
const manual:DraftStack={id:'new',origin:'manual',members:[a,c],coverAssetId:'a',evidence};
const initial=()=>reduce(emptyStackDraft,{type:'initialize',source:{groups:[original],unmatched:[c,d]},assets:[a,b,c,d]});
const sources=(draft:ReturnType<typeof initial>)=>draft.sourceGroups!.filter(g=>!draft.completedSourceIds.has(g.id));
const result=(operationId:string,status:StackWriteResult['status'],extra={})=>({operationId,status,...extra});
afterEach(()=>vi.unstubAllGlobals());
it('keeps an unchanged singleton outside write and completion while normal unchanged Stacks still complete',async()=>{
 let draft=reduce(emptyStackDraft,{type:'initialize',source:{groups:[singleton],unmatched:[c]},assets:[a,c]});
 const plan=buildStackWritePlan(draft.groups,[singleton]);
 expect(plan).toEqual({operations:[],unchanged:[]});
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 const results=await sendStackWritePlan(plan.operations,new AbortController().signal);
 expect(fetch).not.toHaveBeenCalled();
 draft=reduce(draft,{type:'writeResults',plan,results});
 expect(draft.groups).toHaveLength(1);expect(draft.completedSourceIds.size).toBe(0);expect(draft.modified).toBe(false);
 expect(buildStackWritePlan([original],[original]).unchanged).toEqual(['old']);
});
it('purges singleton sources using existing delete completion and Undo',()=>{
  let draft=reduce(emptyStackDraft,{type:'initialize',source:{groups:[singleton],unmatched:[c]},assets:[a,c]});
  draft=reduce(draft,{type:'purgeGroup',groupId:'old'});
  const plan=buildStackWritePlan(draft.groups,[singleton]);
  expect(plan.operations).toEqual([{operationId:'delete:stack',type:'delete',stackId:'stack'}]);
  expect(draft.unmatched).toEqual([a,c]);
  const undone=reduce(draft,{type:'undo'});expect(undone.groups[0].members).toEqual([a]);
  draft=reduce(draft,{type:'writeResults',plan,results:[result(plan.operations[0].operationId,'success')]});
  expect(draft.groups).toEqual([]);expect(draft.completedSourceIds.has('old')).toBe(true);expect(draft.modified).toBe(false);
});
it('rejects modified singleton and local one-member drafts',()=>{
 expect(()=>buildStackWritePlan([{...singleton,members:[c],coverAssetId:'c'}],[singleton])).toThrow('Singleton Stack is dissolve-only');
 expect(()=>buildStackWritePlan([{...singleton,members:[a,c]}],[singleton])).toThrow('Singleton Stack is dissolve-only');
 expect(()=>buildStackWritePlan([{...singleton,origin:'manual'}],[])).toThrow('Invalid draft membership');
});
it('classifies current sets and Cover, ignoring history, order and modified flag',()=>{
 expect(buildStackWritePlan([{...original,members:[b,a],modified:true}],[original])).toEqual({unchanged:['old'],operations:[]});
 for(const changed of [{...original,members:[a,b,c]},{...original,coverAssetId:'b'}]) expect(buildStackWritePlan([changed],[original]).operations[0].type).toBe('update');
 expect(buildStackWritePlan([{...original,id:'restored'}],[original]).unchanged).toEqual(['restored']);
 expect(buildStackWritePlan([{...manual,origin:'auto'}],[]).operations[0].type).toBe('create');
 expect(buildStackWritePlan([manual],[original]).operations.map(op=>op.type)).toEqual(['create','delete']);
 expect(()=>buildStackWritePlan([{...manual,members:[a,a]}],[])).toThrow();
});
it('removes unchanged including restored local IDs without planning an accidental delete',()=>{
 let draft=initial();draft={...draft,groups:[{...original,id:'restored'}]};
 draft=reduce(draft,{type:'writeResults',plan:buildStackWritePlan(draft.groups,sources(draft)),results:[]});
 expect(draft.groups).toEqual([]);expect(draft.unmatched).toEqual([c,d]);expect(draft.modified).toBe(false);
 expect(buildStackWritePlan(draft.groups,sources(draft)).operations).toEqual([]);
});
it('cleans successful create/update, preserves unmatched and only keeps failed work',()=>{
 let draft=initial();draft={...draft,groups:[{...original,coverAssetId:'b'},{...manual,members:[c,d],coverAssetId:'c'}],unmatched:[]};
 const plan=buildStackWritePlan(draft.groups,sources(draft));
 draft=reduce(draft,{type:'writeResults',plan,results:[result('old','success'),result('new','failed')]});
 expect(draft.groups.map(g=>g.id)).toEqual(['new']);expect(draft.writeResults.new.status).toBe('failed');
 expect(buildStackWritePlan(draft.groups,sources(draft)).operations.map(op=>op.type)).toEqual(['create']);
});
it('preserves unused deleted members and does not return members absorbed by successful creates',()=>{
 let draft=reduce(initial(),{type:'purgeGroup',groupId:'old'});
 for(const id of ['a','c']) draft=reduce(draft,{type:'select',assetId:id});
 draft=reduce(draft,{type:'create'});const plan=buildStackWritePlan(draft.groups,sources(draft));
 draft=reduce(draft,{type:'writeResults',plan,results:plan.operations.map(op=>result(op.operationId,'success'))});
 expect(draft.groups).toEqual([]);expect(draft.unmatched.map(a=>a.id)).toEqual(['b','d']);
 for(const id of ['b','d']) draft=reduce(draft,{type:'select',assetId:id});
 draft=reduce(draft,{type:'create'});expect(buildStackWritePlan(draft.groups,sources(draft)).operations[0].type).toBe('create');
});
it.each(['failed','unknown','blocked'] as const)('retains %s delete and dependent draft',status=>{
 let draft=reduce(initial(),{type:'purgeGroup',groupId:'old'});draft={...draft,groups:[manual],unmatched:[b,d]};
 const plan=buildStackWritePlan(draft.groups,sources(draft));
 draft=reduce(draft,{type:'writeResults',plan,results:[result('delete:stack',status),result('new','blocked')]});
 expect(draft.groups[0]).toEqual(manual);expect(sources(draft)).toHaveLength(1);expect(draft.unmatched).toEqual([b,d]);
 expect(buildStackWritePlan(draft.groups,sources(draft)).operations.map(op=>op.type)).toEqual(['create','delete']);
});
it('rebases failed or unknown replacement after committed release to create without repeating delete',()=>{
 for(const status of ['failed','unknown'] as const) {
  let draft=initial();draft={...draft,groups:[{...original,members:[a,b,c]}],unmatched:[d]};
  draft=reduce(draft,{type:'writeResults',plan:buildStackWritePlan(draft.groups,sources(draft)),results:[result('old',status,{releasedStackId:'stack'})]});
  expect(draft.groups[0].origin).toBe('manual');expect(sources(draft)).toHaveLength(0);
  expect(buildStackWritePlan(draft.groups,sources(draft)).operations.map(op=>op.type)).toEqual(['create']);
 }
});
it('validates complete result mapping and treats malformed or lost responses as unknown to the caller',async()=>{
 const operation={operationId:'x',type:'create' as const,memberIds:['a','b'],primaryAssetId:'a'};
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 fetch.mockResolvedValue(new Response(JSON.stringify({results:[{operationId:'x',status:'success',stackId:'12345678-1234-4234-8234-123456789abc'}]})));
 expect((await sendStackWritePlan([operation],new AbortController().signal))[0].status).toBe('success');
 for(const body of [{results:[]},{results:[{operationId:'other',status:'success'}]},{results:[{operationId:'x',status:'success',stackId:'bad'}]}]) {
  fetch.mockResolvedValue(new Response(JSON.stringify(body)));await expect(sendStackWritePlan([operation],new AbortController().signal)).rejects.toThrow();
 }
 fetch.mockRejectedValue(new Error('lost'));await expect(sendStackWritePlan([operation],new AbortController().signal)).rejects.toThrow();
});
it('uses a bounded backend operation ID for long filename families and maps completion to that draft group',()=>{
 const basename='x'.repeat(190);
 const detected=detectStackCandidates([
  {...asset('long-raw'),filename:`${basename}.dng`,format:'DNG',is_raw:true},
  {...asset('long-jpeg'),filename:`${basename}.jpg`,format:'JPEG',is_raw:false},
 ]);
 const group=detected.groups[0];expect(group.id.length).toBeGreaterThan(200);
 const plan=buildStackWritePlan(detected.groups,[]);
 expect(plan.operations).toHaveLength(1);expect(plan.operations[0].operationId.length).toBeLessThanOrEqual(200);
 expect(plan.operationGroupIds?.[plan.operations[0].operationId]).toBe(group.id);
 let draft=reduce(emptyStackDraft,{type:'initialize',source:detected,assets:detected.groups[0].members});
 draft=reduce(draft,{type:'writeResults',plan,results:[result(plan.operations[0].operationId,'success',{stackId:'12345678-1234-4234-8234-123456789abc'})]});
 expect(draft.groups).toHaveLength(0);expect(draft.writeResults[group.id].status).toBe('success');
});

it('plans two-member trash as a singleton update and rejects COVER or RAW',()=>{
 const group={...original,trashAssetIds:['b']};
 expect(buildStackWritePlan([group],[original]).operations[0]).toMatchObject({type:'update',memberIds:['a'],trashAssetIds:['b'],expectedMemberIds:['a','b'],expectedPrimaryAssetId:'a'});
 expect(()=>buildStackWritePlan([{...group,trashAssetIds:['a']}],[original])).toThrow();
 expect(()=>buildStackWritePlan([{...group,members:[a,{...b,is_raw:true}]}],[original])).toThrow();
});
it('keeps committed Stack results and blocks duplicate trash submission after a partial outcome',()=>{
 const draft={...initial(),groups:[{...original,trashAssetIds:['b']}]};
 const plan=buildStackWritePlan(draft.groups,sources(draft));
 const next=reduce(draft,{type:'writeResults',plan,results:[{operationId:'old',status:'success',stackId:undefined,releasedStackId:'stack',trashStatus:'failed'}]});
 expect(next.groups).toEqual([]);expect(next.undoSnapshot).toBeNull();
 expect(next.writeResults.old.trashStatus).toBe('failed');
 expect(buildStackWritePlan(next.groups,sources(next)).operations).toEqual([]);
});

it('retains reservations after failed replacement and retries creation without deleting twice',()=>{
 const original3={...original,members:[a,b,c],originalMemberIds:['a','b','c']};
 let draft=reduce(emptyStackDraft,{type:'initialize',source:{groups:[original3],unmatched:[]},assets:[a,b,c]});
 draft=reduce(draft,{type:'trash',groupId:'old',assetId:'b'});
 const plan=buildStackWritePlan(draft.groups,sources(draft));
 draft=reduce(draft,{type:'writeResults',plan,results:[{operationId:'old',status:'failed',releasedStackId:'stack',trashStatus:'blocked'}]});
 expect(draft.groups[0].origin).toBe('manual');expect(draft.groups[0].trashAssetIds).toEqual(['b']);
 const retry=buildStackWritePlan(draft.groups,sources(draft));
 expect(retry.operations).toHaveLength(1);expect(retry.operations[0]).toMatchObject({type:'create',memberIds:['a','c'],trashAssetIds:['b']});
 expect(retry.operations[0].stackId).toBeUndefined();
});
