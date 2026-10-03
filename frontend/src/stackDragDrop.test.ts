import { expect, it } from 'vitest';
import { canDropStackPayload, isStackDrag, parseStackDragPayload, readStackDragPayload, STACK_DRAG_TYPE } from './stackDragDrop';
const members=[{id:'a'},{id:'b'}], other=[{id:'c'},{id:'d'}], outside=[{id:'e'}];
const groups=[{id:'one',members},{id:'two',members:other}], unmatched=outside;
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
