import { expect, it, vi, afterEach } from 'vitest';
import type { RecentAsset } from './assets';
import type { DraftStack } from './stackCandidateDetection';
import { buildStackWritePlan, sendStackWritePlan, type StackWriteResult } from './stackWrite';
import { emptyStackDraft, stackDraftReducer as reduce } from './useEditableStackDraft';
const asset=(id:string):RecentAsset=>({id,filename:id+'.jpg',format:'JPEG',is_raw:false,date:'2026-01-01',thumbnail_url:'/thumb'});
const a=asset('a'),b=asset('b'),c=asset('c'),d=asset('d');
const evidence={name:'unavailable',nameReason:'exact',time:'unavailable',camera:'unavailable',gps:'unavailable'} as const;
const original:DraftStack={id:'old',origin:'immich',immichStackId:'stack',members:[a,b],coverAssetId:'a',originalMemberIds:['a','b'],originalPrimaryAssetId:'a',evidence};
const manual:DraftStack={id:'new',origin:'manual',members:[a,c],coverAssetId:'a',evidence};
const initial=()=>reduce(emptyStackDraft,{type:'initialize',source:{groups:[original],unmatched:[c,d]},assets:[a,b,c,d]});
const sources=(draft:ReturnType<typeof initial>)=>draft.sourceGroups!.filter(g=>!draft.completedSourceIds.has(g.id));
const result=(operationId:string,status:StackWriteResult['status'],extra={})=>({operationId,status,...extra});
afterEach(()=>vi.unstubAllGlobals());
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
