import { expect, it } from 'vitest';
import { canCreateStackFromUnmatchedDrop, canDropStackPayload, isStackDrag, parseStackDragPayload, readStackDragPayload, STACK_DRAG_TYPE } from './stackDragDrop';
const members=[{id:'a'},{id:'b'}], other=[{id:'c'},{id:'d'}], outside=[{id:'e'}];
const groups=[{id:'one',members},{id:'two',members:other}], unmatched=outside;
it('rejects singleton drop destinations and member drags while normal destinations remain eligible',()=>{
 const singleton={id:'singleton',members:[{id:'s'}],origin:'immich',originalMemberIds:['s']};
 const all=[...groups,singleton];
 expect(canDropStackPayload({assetId:'e',sourceGroupId:null},'singleton',all,unmatched)).toBe(false);
 expect(canDropStackPayload({assetId:'a',sourceGroupId:'one'},'singleton',all,unmatched)).toBe(false);
 expect(canDropStackPayload({assetId:'s',sourceGroupId:'singleton'},'one',all,unmatched)).toBe(false);
 expect(canDropStackPayload({assetId:'s',sourceGroupId:'singleton'},null,all,unmatched)).toBe(false);
 expect(canDropStackPayload({assetId:'e',sourceGroupId:null},'one',all,unmatched)).toBe(true);
});
const transfer=(types:string[],data:string,files:File[]=[])=>(
 ({types,files,getData:(type:string)=>type===STACK_DRAG_TYPE?data:''}) as unknown as DataTransfer
);
it('accepts only a compact exact internal payload and handles malformed serialization',()=>{
 const payload={assetId:'e',sourceGroupId:null};const value=transfer([STACK_DRAG_TYPE],JSON.stringify(payload));
 expect(readStackDragPayload(value)).toEqual(payload);
 for(const raw of ['', '{', 'null', '[]', JSON.stringify({...payload,filename:'private.jpg'}), JSON.stringify({assetId:'',sourceGroupId:null}), JSON.stringify({assetId:'e',sourceGroupId:3})]) expect(parseStackDragPayload(raw)).toBeNull();
 expect(isStackDrag(transfer(['text/uri-list'],'url'))).toBe(false);
 expect(isStackDrag(transfer([STACK_DRAG_TYPE],JSON.stringify(payload),[new File(['x'],'photo.jpg')]))).toBe(false);
 expect(readStackDragPayload(transfer([STACK_DRAG_TYPE],'{'))).toBeNull();
});
it('allows only live assets moved between eligible distinct targets',()=>{
 expect(canDropStackPayload({assetId:'e',sourceGroupId:null},'one',groups,unmatched)).toBe(true);
 expect(canDropStackPayload({assetId:'a',sourceGroupId:'one'},'two',groups,unmatched)).toBe(true);
 expect(canDropStackPayload({assetId:'a',sourceGroupId:'one'},null,groups,unmatched)).toBe(true);
 expect(canDropStackPayload({assetId:'a',sourceGroupId:'one'},'one',groups,unmatched)).toBe(false);
 expect(canDropStackPayload({assetId:'missing',sourceGroupId:'one'},'two',groups,unmatched)).toBe(false);
 expect(canDropStackPayload({assetId:'e',sourceGroupId:null},null,groups,unmatched)).toBe(false);
 expect(canDropStackPayload({assetId:'e',sourceGroupId:null},'missing',groups,unmatched)).toBe(false);
 expect(canDropStackPayload({assetId:'a',sourceGroupId:'one'},'two',groups,[...unmatched,{id:'a'}])).toBe(false);
});
it('matches reserved-member D&D rules while preserving Add-compatible unmatched drops',()=>{
 const reserved={id:'one',members,trashAssetIds:['a']};
 const all=[reserved,{...groups[1]}];
 expect(canDropStackPayload({assetId:'a',sourceGroupId:'one'},'two',all,unmatched)).toBe(false);
 expect(canDropStackPayload({assetId:'a',sourceGroupId:'one'},null,all,unmatched)).toBe(false);
 expect(canDropStackPayload({assetId:'c',sourceGroupId:'two'},'one',all,unmatched)).toBe(false);
 expect(canDropStackPayload({assetId:'e',sourceGroupId:null},'one',all,unmatched)).toBe(true);
});
it('accepts only distinct, uniquely unmatched photo targets for unmatched-to-unmatched creation',()=>{
 const payload={assetId:'e',sourceGroupId:null};
 expect(canCreateStackFromUnmatchedDrop(payload,'f',groups,[...unmatched,{id:'f'}])).toBe(true);
 expect(canCreateStackFromUnmatchedDrop(payload,'e',groups,unmatched)).toBe(false);
 expect(canCreateStackFromUnmatchedDrop({assetId:'a',sourceGroupId:'one'},'e',groups,unmatched)).toBe(false);
 expect(canCreateStackFromUnmatchedDrop(payload,'missing',groups,unmatched)).toBe(false);
 expect(canCreateStackFromUnmatchedDrop(payload,'f',groups,[...unmatched,{id:'e'},{id:'f'}])).toBe(false);
 expect(canCreateStackFromUnmatchedDrop(payload,'a',groups,[...unmatched,{id:'a'}])).toBe(false);
 expect(canCreateStackFromUnmatchedDrop(payload,'f',[...groups,{id:'three',members:[{id:'f'}]}],[...unmatched,{id:'f'}])).toBe(false);
});
