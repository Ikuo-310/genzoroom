// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect,it,vi } from 'vitest';
import { provisionalCrop,type CropSnapshot } from './rawCropDisplay';
import { rawSettings } from './test/rawSettings';
import { RawCropSurface, type RawCropBinding } from './RawCropSurface';
it.each(['topLeft','topRight','bottomRight','bottomLeft','top','right','bottom','left','move','cancel'])('captures %s and freezes start/inverse across readback until final point',async(handle)=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const host=document.createElement('div'),root=createRoot(host),busy=vi.fn();
  const binding:RawCropBinding={active:true,canStart:true,begin:vi.fn(async()=>{}),update:vi.fn(),end:vi.fn(async()=>{}),surface:{url:'blob:edit',
    frame:{geometryId:'edit',nativeWidth:1000,nativeHeight:500,aspect:2,fullWidth:200,fullHeight:100,window:null},
    display:{settingsFingerprint:'fp',bitmapSpace:'oriented-warped-unstraightened-flipped',canonicalGeometry:{orientation:'Normal',crop:{geometry:{rect:{x0:.2,y0:.2,x1:.8,y1:.8},angle:0},aspect:[4,3],flip_h:false,flip_v:false}}}}};
  const render=()=>root.render(<RawCropSurface binding={binding} viewport={{x:800,y:600}} scale={1} pan={{x:0,y:0}} busy={busy}/>);
  await act(async()=>render());
  const surface=host.firstElementChild as HTMLDivElement;
  surface.setPointerCapture=vi.fn();surface.hasPointerCapture=()=>true;surface.releasePointerCapture=vi.fn();
  const pointer=(target:Element,type:string,x:number,y:number)=>{const event=new Event(type,{bubbles:true});Object.assign(event,{pointerId:1,button:0,clientX:x,clientY:y,shiftKey:true});target.dispatchEvent(event);};
  const target=handle==='move'||handle==='cancel'?surface:host.querySelector(`[data-crop-handle="${handle}"]`)!;
  await act(async()=>pointer(target,'pointerdown',400,300));
  expect(surface.setPointerCapture).toHaveBeenCalledWith(1);expect(binding.begin).toHaveBeenCalledOnce();
  await act(async()=>pointer(surface,'pointermove',410,310));
  binding.surface=structuredClone(binding.surface);binding.surface!.display.canonicalGeometry.crop.geometry.rect={x0:.3,y0:.3,x1:.7,y1:.7};
  await act(async()=>render());await act(async()=>pointer(surface,handle==='cancel'?'pointercancel':'pointerup',420,320));
  expect(binding.update).toHaveBeenLastCalledWith({type:'drag',params:{handle:handle==='cancel'?'move':handle,from:[.5,.5],to:handle==='cancel'?[.51,.52]:[.52,.54],start:[.2,.2,.8,.8],keepRatio:true}});
  expect(binding.end).toHaveBeenCalledOnce();expect(surface.releasePointerCapture).toHaveBeenCalledWith(1);
  await act(async()=>root.unmount());vi.unstubAllGlobals();
});
it('does not claim outside pan and ends cancellation without an extra mutation',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div'),root=createRoot(host);
  const binding:RawCropBinding={active:true,canStart:false,begin:vi.fn(async()=>{}),update:vi.fn(),end:vi.fn(async()=>{})};
  await act(async()=>root.render(<RawCropSurface binding={binding} viewport={{x:800,y:600}} scale={1} pan={{x:0,y:0}} busy={()=>{}}/>));
  const event=new Event('pointerdown',{bubbles:true});Object.assign(event,{pointerId:1,button:0,clientX:0,clientY:0});
  await act(async()=>host.firstElementChild!.dispatchEvent(event));expect(binding.begin).not.toHaveBeenCalled();
  await act(async()=>root.unmount());vi.unstubAllGlobals();
});

it.each(['topLeft','topRight','bottomRight','bottomLeft','top','right','bottom','left','move'])('shows immediate %s feedback while retaining the bitmap and correct cursor',async(handle)=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div'),root=createRoot(host);
 const crop={geometry:{rect:{x0:.2,y0:.2,x1:.8,y1:.8},angle:0},aspect:null,flip_h:false,flip_v:false};
 const snapshot:CropSnapshot={url:'blob:paired',mode:'crop-edit',doc:{...rawSettings({workspaceId:'w',handle:'h',assetId:'a',generation:1,documentToken:'t',revision:1}),crop,orientation:'Normal'},
  frame:{geometryId:'e'.repeat(64),nativeWidth:1000,nativeHeight:500,aspect:2,fullWidth:200,fullHeight:100,window:null},display:{settingsFingerprint:'f'.repeat(64),canonicalGeometry:{crop,orientation:'Normal'},bitmapSpace:'oriented-warped-unstraightened-flipped'}};
 const binding:RawCropBinding={active:true,canStart:true,surface:snapshot,begin:vi.fn(async()=>{}),end:vi.fn(async()=>{}),update:operation=>{
  binding.presentation={snapshot,crop:provisionalCrop(crop,operation),phase:'provisional',revision:1,fingerprint:snapshot.doc.settingsFingerprint};render();}};
 const busy=vi.fn(),render=()=>root.render(<RawCropSurface binding={binding} viewport={{x:800,y:600}} scale={.5} pan={{x:0,y:0}} busy={busy}/>);
 await act(async()=>render());const surface=host.firstElementChild as HTMLDivElement;
 surface.setPointerCapture=vi.fn();surface.hasPointerCapture=()=>true;surface.releasePointerCapture=vi.fn();
 const target=handle==='move'?host.querySelector('[data-crop-move]')!:host.querySelector(`[data-crop-handle="${handle}"]`)!;
 const cursor=handle==='move'?'move':['left','right'].includes(handle)?'ew-resize':['top','bottom'].includes(handle)?'ns-resize':['topLeft','bottomRight'].includes(handle)?'nwse-resize':'nesw-resize';
 expect((target as HTMLElement).style.cursor).toBe(cursor);
 const pointer=(type:string,x:number,y:number)=>{const e=new Event(type,{bubbles:true});Object.assign(e,{pointerId:1,button:0,clientX:x,clientY:y,shiftKey:false});target.dispatchEvent(e);};
 const before=host.querySelector('rect')!.getAttribute('x'),image=host.querySelector('img')!,matrix=image.style.transform;
 await act(async()=>pointer('pointerdown',400,300));await act(async()=>pointer('pointermove',420,310));
 expect(host.querySelector('img')).toBe(image);expect(image.src).toContain('blob:paired');expect(image.style.transform).toBe(matrix);
 expect(host.querySelector('rect')!.outerHTML).not.toContain('NaN');if(['left','topLeft','bottomLeft','move'].includes(handle))expect(host.querySelector('rect')!.getAttribute('x')).not.toBe(before);
 expect(surface.style.cursor).toBe(cursor);
 if(handle==='right')await act(async()=>root.unmount());
 else if(handle==='top')await act(async()=>window.dispatchEvent(new Event('blur')));
 else await act(async()=>surface.dispatchEvent(Object.assign(new Event(handle==='left'?'lostpointercapture':'pointercancel',{bubbles:true}),{pointerId:1})));
 expect(binding.end).toHaveBeenCalledOnce();if(handle!=='right')await act(async()=>root.unmount());vi.unstubAllGlobals();
});

it.each([-45,0,45])('rotates the same bitmap immediately at %s degrees while keeping the frame axis-aligned',async(angle)=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div'),root=createRoot(host);
 const crop={geometry:{rect:{x0:0,y0:0,x1:1,y1:1},angle:0},aspect:null,flip_h:false,flip_v:false};
 const snapshot:CropSnapshot={url:'blob:same',mode:'crop-edit',doc:{...rawSettings({workspaceId:'w',handle:'h',assetId:'a',generation:1,documentToken:'t',revision:1}),crop,orientation:'Normal'},frame:{geometryId:'e'.repeat(64),nativeWidth:1000,nativeHeight:500,aspect:2,fullWidth:200,fullHeight:100,window:null},display:{settingsFingerprint:'f'.repeat(64),canonicalGeometry:{crop,orientation:'Normal'},bitmapSpace:'oriented-warped-unstraightened-flipped'}};
 const binding:RawCropBinding={active:true,canStart:true,surface:snapshot,begin:vi.fn(async()=>{}),update:vi.fn(),end:vi.fn(async()=>{})},busy=vi.fn();
 const render=()=>root.render(<RawCropSurface binding={binding} viewport={{x:800,y:600}} scale={.5} pan={{x:0,y:0}} busy={busy}/>);
 await act(async()=>render());const image=host.querySelector('img')!,before=image.style.transform,rect=host.querySelector('rect')!.outerHTML;
 binding.presentation={snapshot,crop:provisionalCrop(crop,{type:'straighten',params:{angle}}),phase:'provisional',revision:1,fingerprint:snapshot.doc.settingsFingerprint};
 await act(async()=>render());expect(host.querySelector('img')).toBe(image);expect(host.querySelector('rect')!.outerHTML).toBe(rect);
 if(angle!==0)expect(image.style.transform).not.toBe(before);expect(image.src).toContain('blob:same');
 await act(async()=>root.unmount());vi.unstubAllGlobals();
});
