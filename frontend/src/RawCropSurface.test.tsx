// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect,it,vi } from 'vitest';
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
