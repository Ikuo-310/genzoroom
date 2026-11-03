import { useEffect, useRef, type PointerEvent } from 'react';
import type { RawCropDisplay, RawGeometry, RawGeometryOperation } from './rawApi';
import { CROP_HANDLES, cropPoint, projectRawCrop, type CropHandle, type CropMatrix } from './rawCropMath';
import type { Point } from './viewerMath';
export type RawCropBinding = { active: boolean; canStart: boolean;
  surface?: { url: string; frame: RawGeometry; display: RawCropDisplay };
  begin: () => Promise<void>; update: (operation: RawGeometryOperation) => void; end: () => Promise<void> };
export function RawCropSurface({ binding, viewport, scale, pan, busy }: {
  binding: RawCropBinding; viewport: Point; scale: number; pan: Point; busy: (value: boolean) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; matrix: CropMatrix; bounds: DOMRect; handle: CropHandle;
    from: [number, number]; start: [number, number, number, number]; owner: RawCropBinding } | null>(null);
  const surface = binding.surface;
  const projection = surface && projectRawCrop(surface.display.canonicalGeometry.crop, surface.frame, viewport, scale, pan);
  const finish = () => {
    const g = gesture.current; if (!g) return;
    gesture.current = null;
    if (root.current?.hasPointerCapture(g.id)) root.current.releasePointerCapture(g.id);
    busy(false); void g.owner.end().catch(() => {});
  };
  useEffect(() => () => { const g = gesture.current; if (g) { gesture.current = null;
    if (root.current?.hasPointerCapture(g.id)) root.current.releasePointerCapture(g.id);
    busy(false); void g.owner.end().catch(() => {}); } }, [busy]);
  const update = (event: PointerEvent) => {
    const g = gesture.current; if (!g || g.id !== event.pointerId) return;
    event.stopPropagation();
    const to = cropPoint(g.matrix, { x: event.clientX-g.bounds.left, y: event.clientY-g.bounds.top });
    g.owner.update({ type: 'drag', params: { handle: g.handle, from: g.from, to: [to.x,to.y], start: g.start, keepRatio: event.shiftKey } });
  };
  return <div ref={root} data-testid="raw-crop-surface" style={{ position: 'absolute', inset: 0, touchAction: 'none' }}
    onPointerDown={event => {
      if (!projection || !surface || !binding.canStart || gesture.current || event.button !== 0) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX-bounds.left, y = event.clientY-bounds.top, r = projection.rect;
      const handle = (event.target as HTMLElement).dataset.cropHandle as CropHandle | undefined;
      if (!handle && !(x >= r.left && x <= r.left+r.width && y >= r.top && y <= r.top+r.height)) return;
      event.preventDefault(); event.stopPropagation();
      const from = cropPoint(projection.viewportToCanonical,{x,y}), rect = surface.display.canonicalGeometry.crop.geometry.rect;
      // Freeze the inverse and Native start rectangle across intermediate readbacks.
      gesture.current = { id: event.pointerId, matrix: projection.viewportToCanonical, bounds, handle: handle ?? 'move',
        from: [from.x,from.y], start: [rect.x0,rect.y0,rect.x1,rect.y1], owner: binding };
      event.currentTarget.setPointerCapture(event.pointerId); busy(true);
      void binding.begin().catch(() => finish());
    }} onPointerMove={update} onPointerUp={event => { if (gesture.current?.id === event.pointerId) { update(event); finish(); } }}
    onPointerCancel={event => { if (gesture.current?.id === event.pointerId) { event.stopPropagation(); finish(); } }}
    onLostPointerCapture={event => { if (gesture.current?.id === event.pointerId) finish(); }}>
    {surface && projection && <>
      <img src={surface.url} alt="" draggable={false} style={{ position:'absolute', width:surface.frame.fullWidth,
        height:surface.frame.fullHeight, maxWidth:'none', transformOrigin:'0 0', transform:`matrix(${projection.bitmapToViewport.join(',')})`, pointerEvents:'none' }} />
      <svg width="100%" height="100%" style={{ position:'absolute', inset:0, pointerEvents:'none' }}>
        <path fill="rgba(0,0,0,.55)" fillRule="evenodd" d={`M0 0H${viewport.x}V${viewport.y}H0Z M${projection.rect.left} ${projection.rect.top}h${projection.rect.width}v${projection.rect.height}h${-projection.rect.width}Z`} />
        <rect x={projection.rect.left} y={projection.rect.top} width={projection.rect.width} height={projection.rect.height} fill="none" stroke="white" />
        {[1,2].map(n => <g key={n} stroke="rgba(255,255,255,.6)">
          <line x1={projection.rect.left+projection.rect.width*n/3} x2={projection.rect.left+projection.rect.width*n/3} y1={projection.rect.top} y2={projection.rect.top+projection.rect.height} />
          <line y1={projection.rect.top+projection.rect.height*n/3} y2={projection.rect.top+projection.rect.height*n/3} x1={projection.rect.left} x2={projection.rect.left+projection.rect.width} />
        </g>)}
      </svg>
      {CROP_HANDLES.filter(h => h !== 'move').map(handle => <div key={handle} data-crop-handle={handle}
        style={{ position:'absolute', left:projection.handles[handle].x-12, top:projection.handles[handle].y-12,
          width:24, height:24, display:'grid', placeItems:'center', cursor:'crosshair' }}>
        <span style={{ width:8,height:8,background:'white',border:'1px solid #333',pointerEvents:'none' }} />
      </div>)}
    </>}
  </div>;
}
