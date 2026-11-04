import type { CropPresentation } from './rawCropDisplay';
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import type { RawCrop, RawCropDisplay, RawGeometry, RawGeometryOperation } from './rawApi';
import { CROP_HANDLES, cropMoveAxis, cropMoveTarget, cropPoint, projectRawCrop, type CropHandle, type CropMatrix, type CropMoveAxis } from './rawCropMath';
import type { Point } from './viewerMath';
import { straightenFromLine } from './rawStraightenTool';
import { cropOverlayPaths,type CropOverlay } from './rawCropOverlay';
import { provisionalCrop } from './rawCropDisplay';
export type RawCropBinding = { active: boolean; canStart: boolean; presentation?: CropPresentation;
  straightenTool?:boolean;setStraightenTool?:(active:boolean)=>void;
  overlay?:CropOverlay;
  surface?: { url: string; frame: RawGeometry; display: RawCropDisplay };
  begin: (type?:'drag'|'straighten') => Promise<void>; update: (operation: RawGeometryOperation) => void; cancel?: () => Promise<void>; end: () => Promise<void> };
type CropPointerGesture = { id:number;matrix:CropMatrix;bounds:DOMRect;handle:CropHandle;view:{viewport:Point;scale:number;pan:Point};cursor:string;
  from:[number,number];start:[number,number,number,number];startCrop:RawCrop;frame:RawGeometry;owner:RawCropBinding;kind:'drag'|'straighten';center:Point;startAngle:number;lastAngle:number;previousPointerAngle:number;
  lastScreen:Point;lastTo:Point;shift:boolean;axis:CropMoveAxis;axisStartScreen:Point;axisStartTo:Point;freeStartScreen:Point;freeStartTo:Point };
function effectiveMoveTo(g:CropPointerGesture):Point{
  const effective=provisionalCrop(g.startCrop,{type:'drag',params:{handle:'move',from:g.from,to:[g.lastTo.x,g.lastTo.y]}},g.frame).geometry.rect;
  return {x:g.from[0]+(effective.x0-g.startCrop.geometry.rect.x0),y:g.from[1]+(effective.y0-g.startCrop.geometry.rect.y0)};
}
function setMoveShift(g:CropPointerGesture|null,active:boolean){
  if(!g||g.kind!=='drag'||g.handle!=='move'||g.shift===active)return;
  // Modifier transitions use the last rendered pointer target as the new origin, avoiding a jump.
  const anchor=effectiveMoveTo(g);
  g.shift=active;g.axis=null;
  if(active){g.axisStartScreen=g.lastScreen;g.axisStartTo=anchor;}
  else {g.freeStartScreen=g.lastScreen;g.freeStartTo=anchor;}
}
export function RawCropSurface({ binding, viewport, scale, pan, busy, handTool=false, panning=false }: {
  binding: RawCropBinding; viewport: Point; scale: number; pan: Point; busy: (value: boolean) => void; handTool?:boolean;panning?:boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const clipId=useId();
  const [line,setLine]=useState<{id:number;start:Point;end:Point}|null>(null);
  const gesture = useRef<CropPointerGesture | null>(null);
  const surface = binding.surface;
  const crop=binding.presentation && binding.presentation.snapshot===surface?binding.presentation.crop:surface?.display.canonicalGeometry.crop;
  const view=gesture.current?.view ?? {viewport,scale,pan};
  const projection = surface && crop && projectRawCrop(crop,surface.frame,view.viewport,view.scale,view.pan,
    {imageCentered:true,provisional:binding.presentation?.phase==='provisional'});
  const cursor=(handle:CropHandle)=>{
    if(handle==='move')return 'move';if(handle==='left'||handle==='right')return 'ew-resize';if(handle==='top'||handle==='bottom')return 'ns-resize';
    const p=projection!.handles[handle],r=projection!.rect;
    return (p.x<r.left+r.width/2)===(p.y<r.top+r.height/2)?'nwse-resize':'nesw-resize';
  };
  const finish = (cancel=false) => {
    const g = gesture.current; if (!g) return;
    gesture.current = null;
    if (root.current?.hasPointerCapture(g.id)) root.current.releasePointerCapture(g.id);
    busy(false); void (cancel && g.owner.cancel ? g.owner.cancel() : g.owner.end()).catch(() => {});
  };
  useEffect(()=>{const blur=()=>{setLine(null);finish(true);};const key=(e:KeyboardEvent)=>{if(e.key==='Shift')setMoveShift(gesture.current,true);if(e.key!=='Escape'||e.isComposing||e.defaultPrevented)return;
    if(line){const id=line.id;setLine(null);if(root.current?.hasPointerCapture(id))root.current.releasePointerCapture(id);e.preventDefault();e.stopPropagation();return;}
    if(gesture.current){e.preventDefault();e.stopPropagation();finish(true);return;}
    if(binding.straightenTool){setLine(null);binding.setStraightenTool?.(false);e.preventDefault();e.stopPropagation();}};
    const keyUp=(e:KeyboardEvent)=>{if(e.key==='Shift')setMoveShift(gesture.current,e.shiftKey);};window.addEventListener('blur',blur);window.addEventListener('keydown',key);window.addEventListener('keyup',keyUp);return ()=>{window.removeEventListener('blur',blur);window.removeEventListener('keydown',key);window.removeEventListener('keyup',keyUp);};},[binding,line]);
  useEffect(() => () => { const g = gesture.current; if (g) { gesture.current = null;
    if (root.current?.hasPointerCapture(g.id)) root.current.releasePointerCapture(g.id);
    busy(false); void (g.owner.cancel?.() ?? g.owner.end()).catch(() => {}); } }, [busy]);
  const update = (event: PointerEvent) => {
    const g = gesture.current; if (!g || g.id !== event.pointerId) return;
    event.stopPropagation();
    if(g.kind==='straighten'){
      const x=event.clientX-g.center.x,y=event.clientY-g.center.y,r=Math.hypot(x,y);
      if(r<12)return;
      const a=Math.atan2(y,x),delta=Math.atan2(Math.sin(a-g.previousPointerAngle),Math.cos(a-g.previousPointerAngle));
      g.previousPointerAngle=a;g.lastAngle=Math.max(-45,Math.min(45,Math.round((g.lastAngle+delta*180/Math.PI)*10)/10));
      g.owner.update({type:'straighten',params:{angle:g.lastAngle}});return;
    }
    const screen={x:event.clientX-g.bounds.left,y:event.clientY-g.bounds.top};
    const pointer=cropPoint(g.matrix,screen);
    let to:Point=pointer;
    if(g.handle==='move'){
      setMoveShift(g,event.shiftKey);
      if(g.shift){
        g.axis??=cropMoveAxis({x:screen.x-g.axisStartScreen.x,y:screen.y-g.axisStartScreen.y});
        to=g.axis?cropMoveTarget(g.matrix,g.axisStartScreen,g.axisStartTo,screen,g.axis):g.axisStartTo;
      }else to=cropMoveTarget(g.matrix,g.freeStartScreen,g.freeStartTo,screen,null);
    }
    g.lastScreen=screen;g.lastTo=to;
    g.owner.update({ type: 'drag', params: { handle: g.handle, from: g.from, to: [to.x,to.y], start: g.start, keepRatio: event.shiftKey } });
  };
  const straightenCursor='url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2732%27 height=%2732%27 viewBox=%270 0 32 32%27%3E%3Cpath d=%27M7 20a10 10 0 1 1 3 5%27 fill=%27none%27 stroke=%27white%27 stroke-width=%273%27/%3E%3Cpath d=%27m5 17 2 5 5-2%27 fill=%27none%27 stroke=%27white%27 stroke-width=%272%27/%3E%3C/svg%3E") 16 16, crosshair';
  const completeLine=()=>{const current=line;setLine(null);if(!current||!surface)return;const angle=straightenFromLine(current.start,current.end,surface.display.canonicalGeometry.crop.geometry.angle);if(angle===null)return;
    void binding.begin('straighten').then(()=>{binding.update({type:'straighten',params:{angle}});return binding.end();}).then(()=>binding.setStraightenTool?.(false)).catch(()=>{});};
  const effectiveCursor=gesture.current?.cursor ?? (handTool?(panning?'grabbing':'grab'):binding.straightenTool?'crosshair':undefined);
  return <div ref={root} data-testid="raw-crop-surface" style={{ position: 'absolute', inset: 0, touchAction: 'none', cursor:effectiveCursor ?? 'default' }}
    onPointerDown={event => {
      if(handTool)return;
      if(binding.straightenTool){if(!projection||!surface||!binding.canStart||event.button!==0)return;
        const imageCorners=[[0,0],[surface.frame.fullWidth,0],[0,surface.frame.fullHeight],[surface.frame.fullWidth,surface.frame.fullHeight]].map(([x,y])=>cropPoint(projection.bitmapToViewport,{x,y}));
        const left=Math.min(...imageCorners.map(p=>p.x)),right=Math.max(...imageCorners.map(p=>p.x)),top=Math.min(...imageCorners.map(p=>p.y)),bottom=Math.max(...imageCorners.map(p=>p.y));
        const b=event.currentTarget.getBoundingClientRect(),p={x:event.clientX-b.left,y:event.clientY-b.top};if(p.x<left||p.x>right||p.y<top||p.y>bottom)return;
        event.preventDefault();event.stopPropagation();setLine({id:event.pointerId,start:p,end:p});event.currentTarget.setPointerCapture(event.pointerId);return;}
      if (!projection || !surface || !crop || !binding.canStart || gesture.current || event.button !== 0) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX-bounds.left, y = event.clientY-bounds.top, r = projection.rect;
      const handle = (event.target as HTMLElement).dataset.cropHandle as CropHandle | undefined;
      const inside = x >= r.left && x <= r.left+r.width && y >= r.top && y <= r.top+r.height;
      const onHandle=!!handle;
      const kind: 'drag'|'straighten'=onHandle||inside?'drag':'straighten';
      if(kind==='straighten'&&(x<0||y<0||x>bounds.width||y>bounds.height))return;
      event.preventDefault(); event.stopPropagation();
      const from = cropPoint(projection.viewportToCanonical,{x,y}), rect = crop.geometry.rect;
      // Freeze the inverse and Native start rectangle across intermediate readbacks.
      const center={x:bounds.left+bounds.width/2+pan.x,y:bounds.top+bounds.height/2+pan.y};
      const startAngle=surface.display.canonicalGeometry.crop.geometry.angle;
      const pointerAngle=Math.atan2(event.clientY-center.y,event.clientX-center.x);
      const screen={x,y},moveTo={x:from.x,y:from.y},shift=handle==='move'&&event.shiftKey;
      gesture.current = { id: event.pointerId, matrix: projection.viewportToCanonical, bounds, handle: handle ?? 'move',
        view:{viewport:{...viewport},scale,pan:{...pan}},cursor:kind==='straighten'?straightenCursor:cursor(handle ?? 'move'), from: [from.x,from.y], start: [rect.x0,rect.y0,rect.x1,rect.y1], owner: binding,
        kind,center,startAngle,lastAngle:startAngle,previousPointerAngle:pointerAngle,startCrop:structuredClone(crop),frame:surface.frame,lastScreen:screen,lastTo:moveTo,shift,axis:null,
        axisStartScreen:screen,axisStartTo:moveTo,freeStartScreen:screen,freeStartTo:moveTo };
      event.currentTarget.setPointerCapture(event.pointerId); busy(true);
      void binding.begin(kind).catch(() => finish(true));
    }} onPointerMove={event=>{if(line?.id===event.pointerId){const b=event.currentTarget.getBoundingClientRect();setLine({...line,end:{x:event.clientX-b.left,y:event.clientY-b.top}});return;}update(event);if(!gesture.current&&projection){const b=event.currentTarget.getBoundingClientRect(),x=event.clientX-b.left,y=event.clientY-b.top,r=projection.rect;
      const target=event.target as HTMLElement,handle=target.dataset.cropHandle as CropHandle|undefined;
      event.currentTarget.style.cursor=handTool?'grab':binding.straightenTool?'crosshair':handle?cursor(handle):x>=r.left&&x<=r.left+r.width&&y>=r.top&&y<=r.top+r.height?'move':x>=0&&y>=0&&x<=b.width&&y<=b.height?straightenCursor:'default';}}} onPointerUp={event => { if(line?.id===event.pointerId){event.stopPropagation();completeLine();}else if (gesture.current?.id === event.pointerId) { update(event); finish(); } }}
    onPointerCancel={event => { if(line?.id===event.pointerId){setLine(null);}else if (gesture.current?.id === event.pointerId) { event.stopPropagation(); finish(true); } }}
    onLostPointerCapture={event => { if(line?.id===event.pointerId)setLine(null);else if (gesture.current?.id === event.pointerId) finish(true); }}>
    {line&&<svg aria-hidden="true" style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:20}}><line x1={line.start.x} y1={line.start.y} x2={line.end.x} y2={line.end.y} stroke="black" strokeWidth="5"/><line x1={line.start.x} y1={line.start.y} x2={line.end.x} y2={line.end.y} stroke="#00e5ff" strokeWidth="2"/><circle cx={line.start.x} cy={line.start.y} r="4" fill="white" stroke="black"/></svg>}
    {surface && projection && <>
      <img src={surface.url} alt="" draggable={false} style={{ position:'absolute', width:surface.frame.fullWidth,
        height:surface.frame.fullHeight, maxWidth:'none', transformOrigin:'0 0', transform:`matrix(${projection.bitmapToViewport.join(',')})`, pointerEvents:'none' }} />
      <div data-crop-move="true" style={{position:'absolute',...projection.rect,cursor:effectiveCursor ?? 'move'}} />
      <svg width="100%" height="100%" style={{ position:'absolute', inset:0, pointerEvents:'none' }}>
        <path fill="rgba(0,0,0,.55)" fillRule="evenodd" d={`M0 0H${viewport.x}V${viewport.y}H0Z M${projection.rect.left} ${projection.rect.top}h${projection.rect.width}v${projection.rect.height}h${-projection.rect.width}Z`} />
        <rect x={projection.rect.left} y={projection.rect.top} width={projection.rect.width} height={projection.rect.height} fill="none" stroke="white" />
        <defs><clipPath id={clipId}><rect x={projection.rect.left} y={projection.rect.top} width={projection.rect.width} height={projection.rect.height}/></clipPath></defs>
        <g clipPath={`url(#${clipId})`} fill="none" stroke="rgba(255,255,255,.62)" strokeWidth="1" vectorEffect="non-scaling-stroke" pointerEvents="none">
          {cropOverlayPaths(binding.overlay??'thirds',projection.rect.width,projection.rect.height).map((d,i)=><path key={i} d={d} transform={`translate(${projection.rect.left} ${projection.rect.top})`}/>)}
        </g>
      </svg>
      {CROP_HANDLES.filter(h => h !== 'move').map(handle => <div key={handle} data-crop-handle={handle}
        style={{ position:'absolute', left:projection.handles[handle].x-12, top:projection.handles[handle].y-12,
          width:24, height:24, display:'grid', placeItems:'center', cursor:effectiveCursor ?? cursor(handle) }}>
        <span style={{ width:8,height:8,background:'white',border:'1px solid #333',pointerEvents:'none' }} />
      </div>)}
    </>}
  </div>;
}
