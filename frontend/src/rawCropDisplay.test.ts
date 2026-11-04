import { expect,it } from 'vitest';
import { provisionalCrop,reusableCropBitmap,type CropSnapshot } from './rawCropDisplay';
import { CROP_HANDLES,cropFitScale,projectRawCrop } from './rawCropMath';
import { rawSettings } from './test/rawSettings';
import type { RawCrop } from './rawApi';
const crop:RawCrop={geometry:{rect:{x0:.2,y0:.3,x1:.8,y1:.7},angle:0},aspect:null,flip_h:false,flip_v:false};
const frame={geometryId:'e'.repeat(64),nativeWidth:4000,nativeHeight:3000,aspect:4/3,fullWidth:400,fullHeight:300,window:null};
it.each(CROP_HANDLES)('computes display-only %s feedback from a frozen start without mutating canonical data',handle=>{
 const draft=provisionalCrop(crop,{type:'drag',params:{handle,from:[.5,.5],to:[.55,.55]}}),r=draft.geometry.rect;
 expect(draft).not.toEqual(crop);expect(crop.geometry.rect).toEqual({x0:.2,y0:.3,x1:.8,y1:.7});
 if(handle==='move'){expect(r.x0).toBeCloseTo(.25);expect(r.y0).toBeCloseTo(.35);expect(r.x1-r.x0).toBeCloseTo(.6);}
 else expect(r.x1>r.x0 && r.y1>r.y0).toBe(true);
});
const nativeMoveCases=[
 ['A',100,0,150],['B',100,2,150],['C',100,-2,150],['D',-100,2,0],
] as const;
it.each(nativeMoveCases)('matches LightCraft v0.18.0 unrotated Move fixture %s with a full-height 1:1 crop',(_name,dx,dy,nativeX0)=>{
 const w=3990,h=3000,left=50,right=left+h;
 const f={...frame,nativeWidth:w,nativeHeight:h,fullWidth:w,fullHeight:h,aspect:w/h};
 for(const aspect of [null,[1,1] as [number,number]]){
  const start:RawCrop={geometry:{rect:{x0:left/w,y0:0,x1:right/w,y1:1},angle:0},aspect,flip_h:false,flip_v:false};
  const operation={type:'drag' as const,params:{handle:'move' as const,from:[.5,.5] as [number,number],to:[.5+dx/w,.5+dy/h] as [number,number]}};
  const result=provisionalCrop(start,operation,f),r=result.geometry.rect;
  expect(r.x0*w).toBeCloseTo(nativeX0,5);expect(r.x1*w).toBeCloseTo(nativeX0+h,5);
  expect(r.y0*h).toBeCloseTo(0,5);expect(r.y1*h).toBeCloseTo(h,5);
  expect((r.x1-r.x0)*w).toBeCloseTo(h,5);expect((r.y1-r.y0)*h).toBeCloseTo(h,5);
  expect((r.x1-r.x0)*w/((r.y1-r.y0)*h)).toBeCloseTo(1,8);
 }
});
it.each([[false,false],[true,false],[false,true],[true,true]])('keeps Move constraints identical under flips %s/%s',(flip_h,flip_v)=>{
 const w=3990,h=3000,start:RawCrop={geometry:{rect:{x0:50/w,y0:0,x1:(50+h)/w,y1:1},angle:0},aspect:[1,1],flip_h,flip_v};
 const result=provisionalCrop(start,{type:'drag',params:{handle:'move',from:[.5,.5],to:[.5+100/w,.5+2/h]}},{...frame,nativeWidth:w,nativeHeight:h});
 expect(result.geometry.rect.x0*w).toBeCloseTo(150,5);expect(result.geometry.rect.y0).toBe(0);
});
it.each([[0,-100],[1,100]])('keeps vertical Move free when horizontal boundary %s blocks dx=%s', (edge,dx)=>{
 const w=3990,h=3000,x0=edge===0?0:.5,x1=edge===0?.5:1;
 const start:RawCrop={geometry:{rect:{x0,y0:.3,x1,y1:.7},angle:0},aspect:null,flip_h:false,flip_v:false};
 const result=provisionalCrop(start,{type:'drag',params:{handle:'move',from:[.5,.5],to:[.5+dx/w,.5+100/h]}},{...frame,nativeWidth:w,nativeHeight:h});
 expect(result.geometry.rect.x0).toBeCloseTo(x0,8);expect(result.geometry.rect.x1).toBeCloseTo(x1,8);
 expect((result.geometry.rect.y0-.3)*h).toBeCloseTo(100,5);expect((result.geometry.rect.y1-.7)*h).toBeCloseTo(100,5);
});
it('does not translate a full-frame crop beyond any of its four edges',()=>{
 const start:RawCrop={geometry:{rect:{x0:0,y0:0,x1:1,y1:1},angle:0},aspect:null,flip_h:false,flip_v:false};
 for(const [dx,dy] of [[100,100],[-100,100],[100,-100],[-100,-100]]){
  const result=provisionalCrop(start,{type:'drag',params:{handle:'move',from:[.5,.5],to:[.5+dx/4000,.5+dy/3000]}},{...frame,nativeWidth:4000,nativeHeight:3000});
  expect(result.geometry.rect).toEqual(start.geometry.rect);
 }
});
it('matches LightCraft v0.18.0 rotated Move fixtures, including sliding along the tilted image edge',()=>{
 const w=600,h=400,f={...frame,nativeWidth:w,nativeHeight:h,fullWidth:w,fullHeight:h,aspect:w/h};
 const start:RawCrop={geometry:{rect:{x0:.35,y0:.35,x1:.55,y1:.65},angle:6},aspect:null,flip_h:false,flip_v:false};
 const move=(dx:number)=>provisionalCrop(start,{type:'drag',params:{handle:'move',from:[.45,.5],to:[.45+dx/w,.5]}},f);
 const inside=move(-120),edge=move(-360),past=move(-600);
 expect(inside.geometry.rect.x0).toBeCloseTo(.15,8);expect(inside.geometry.rect.y0).toBeCloseTo(.35,8);
 expect(projectRawCrop(edge,f,{x:800,y:600},.1,{x:0,y:0})).toBeTruthy();
 expect(edge.geometry.rect.x0).toBeLessThan(.01);expect(edge.geometry.rect.y0).toBeGreaterThan(start.geometry.rect.y0);
 expect(past.geometry.rect.x0).toBeLessThan(.01);expect(past.geometry.rect.y0).toBeGreaterThan(edge.geometry.rect.y0+.01);
 for(const result of [inside,edge,past]){
  expect(result.geometry.rect.x1-result.geometry.rect.x0).toBeCloseTo(.2,8);
  expect(result.geometry.rect.y1-result.geometry.rect.y0).toBeCloseTo(.3,8);
 }
});
it('keeps locked display aspect, accepts a provisional angle before Native refit, and does not fit saved geometry',()=>{
 const locked={...crop,aspect:[4,3] as [number,number]};const draft=provisionalCrop(locked,{type:'drag',params:{handle:'right',from:[.8,.5],to:[1.2,.5]}}),r=draft.geometry.rect;
 expect((r.x1-r.x0)/(r.y1-r.y0)).toBeCloseTo(.6/.4);expect(r.x1).toBeGreaterThan(1);
 const full={...crop,geometry:{rect:{x0:0,y0:0,x1:1,y1:1},angle:0}};
 const rotated=provisionalCrop(full,{type:'straighten',params:{angle:45}});
 expect(projectRawCrop(rotated,frame,{x:800,y:600},.1,{x:0,y:0})).toBeNull();
 expect(projectRawCrop(rotated,frame,{x:800,y:600},.1,{x:0,y:0},{imageCentered:true,provisional:true})).toBeTruthy();
 expect(full.geometry.angle).toBe(0);
});
it.each([[4000,3000],[3000,4000]])('fits the full image with CSS handle gutters and preserves bitmap scale across aspect changes %s/%s',(w,h)=>{
 const f={...frame,nativeWidth:w,nativeHeight:h},viewport={x:800,y:600},scale=cropFitScale(viewport,f);
 const crops=[crop,{...crop,geometry:{rect:{x0:.4,y0:.1,x1:.6,y1:.9},angle:0}}];
 const ps=crops.map(c=>projectRawCrop(c,f,viewport,scale,{x:0,y:0},{imageCentered:true})!);
 expect(ps[0].bitmapToViewport).toEqual(ps[1].bitmapToViewport);
 for(const p of ps)for(const q of Object.values(p.handles)){expect(q.x).toBeGreaterThanOrEqual(12);expect(q.y).toBeGreaterThanOrEqual(12);expect(q.x).toBeLessThanOrEqual(788);expect(q.y).toBeLessThanOrEqual(588);}
});
it('rejects bitmap rebinding across owner/orientation/flip/development changes',()=>{
 const doc={...rawSettings({workspaceId:'w',handle:'h',assetId:'a',generation:1,documentToken:'t',revision:1}),crop,orientation:'Normal'};
 const snapshot:CropSnapshot={url:'blob:one',frame,doc,mode:'crop-edit',display:{canonicalGeometry:{crop,orientation:'Normal'},bitmapSpace:'oriented-warped-unstraightened-flipped',settingsFingerprint:doc.settingsFingerprint}};
 expect(reusableCropBitmap(snapshot,{...doc,crop:provisionalCrop(crop,{type:'straighten',params:{angle:20}})})).toBe(true);
 for(const patch of [{assetId:'b'},{documentToken:'other'},{generation:2},{orientation:'Rotate90'},{crop:{...crop,flip_h:true}},{values:{...doc.values,'light.exposure':1}}])expect(reusableCropBitmap(snapshot,{...doc,...patch})).toBe(false);
});

it.each([0,30,-45])('conservatively bounds out-of-photo provisional dragging at %s degrees without changing the Native intent',angle=>{
 const start={...crop,geometry:{rect:{x0:.4,y0:.4,x1:.6,y1:.6},angle},aspect:[4,3] as [number,number]};
 const operation={type:'drag' as const,params:{handle:'move' as const,from:[.5,.5] as [number,number],to:[100,-100] as [number,number]}};
 const draft=provisionalCrop(start,operation,frame);
 expect(projectRawCrop(draft,frame,{x:800,y:600},.1,{x:0,y:0})).toBeTruthy();expect(operation.params.to).toEqual([100,-100]);
 expect(draft.geometry.rect.x1-draft.geometry.rect.x0).toBeCloseTo(.2);expect(draft.geometry.rect.y1-draft.geometry.rect.y0).toBeCloseTo(.2);
});
