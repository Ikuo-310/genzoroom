import type { RawCrop, RawGeometry } from './rawApi';
import type { Point } from './viewerMath';

// CSS affine order: x'=a*x+c*y+e, y'=b*x+d*y+f. All pointer coordinates are CSS pixels.
export type CropMatrix = readonly [number, number, number, number, number, number];
export const CROP_HANDLES = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft', 'top', 'right', 'bottom', 'left', 'move'] as const;
export type CropHandle = typeof CROP_HANDLES[number];
export const cropPoint = (m: CropMatrix, p: Point): Point => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
export function cropCompose(a: CropMatrix, b: CropMatrix): CropMatrix {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
export function cropInverse(m: CropMatrix): CropMatrix | null {
  const d = m[0]*m[3]-m[1]*m[2];
  if (!m.every(Number.isFinite) || !Number.isFinite(d) || Math.abs(d) < 1e-15) return null;
  const inv: CropMatrix = [m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];
  return inv.every(Number.isFinite) ? inv : null;
}
const translate = (x: number, y: number): CropMatrix => [1,0,0,1,x,y];
const scaling = (x: number, y = x): CropMatrix => [x,0,0,y,0,0];
const about = (m: CropMatrix, x: number, y: number) => cropCompose(translate(x,y), cropCompose(m,translate(-x,-y)));

export function cropNativeSize(crop: RawCrop, frame: Pick<RawGeometry, 'nativeWidth' | 'nativeHeight'>) {
  const r = crop.geometry.rect;
  return { x: (r.x1-r.x0)*frame.nativeWidth, y: (r.y1-r.y0)*frame.nativeHeight };
}
export type CropProjection = { bitmapToViewport: CropMatrix; canonicalToViewport: CropMatrix; viewportToCanonical: CropMatrix;
  rect: { left: number; top: number; width: number; height: number }; handles: Record<CropHandle, Point>; coverScale: number };
export function projectRawCrop(crop: RawCrop, frame: RawGeometry, viewport: Point, scale: number, pan: Point, options: { provisional?: boolean; imageCentered?: boolean } = {}): CropProjection | null {
  const { nativeWidth: w, nativeHeight: h, fullWidth: bw, fullHeight: bh } = frame;
  const r = crop.geometry.rect, angle = crop.geometry.angle * Math.PI / 180;
  if (![w,h,bw,bh,viewport.x,viewport.y,scale].every(n => Number.isFinite(n) && n > 0)
    || ![...Object.values(r),angle,pan.x,pan.y].every(Number.isFinite)
    || r.x0 >= r.x1 || r.y0 >= r.y1 || Math.abs(crop.geometry.angle) > 45) return null;
  const c = Math.cos(angle), s = Math.sin(angle), center = { x: (r.x0+r.x1)*w/2, y: (r.y0+r.y1)*h/2 };
  const rotation = about([c,s,-s,c,0,0], w/2,h/2), back = cropInverse(rotation);
  if (!back) return null;
  // Validation only: Native owns fitting. Never shrink or move the stored rectangle here.
  if (!options.provisional) for (const x of [r.x0*w,r.x1*w]) for (const y of [r.y0*h,r.y1*h]) {
    const q = cropPoint(back,{x,y});
    if (q.x < -w*1e-6 || q.x > w*(1+1e-6) || q.y < -h*1e-6 || q.y > h*(1+1e-6)) return null;
  }
  const reflect: CropMatrix = [crop.flip_h ? -1 : 1,0,0,crop.flip_v ? -1 : 1,0,0];
  const origin = options.imageCentered ? {x:w/2,y:h/2} : center;
  const view = cropCompose(translate(viewport.x/2+pan.x,viewport.y/2+pan.y), cropCompose(scaling(scale), translate(-origin.x,-origin.y)));
  // Native bitmap already includes orientation/Warp/flips. Undo its image-centered flips,
  // straighten, then reflect in the crop center as the final cropped Native output does.
  const canonicalPixels = cropCompose(view,about(reflect,origin.x,origin.y));
  const canonicalToViewport = cropCompose(canonicalPixels,scaling(w,h));
  const bitmapToViewport = cropCompose(canonicalPixels,cropCompose(rotation,cropCompose(about(reflect,w/2,h/2),scaling(w/bw,h/bh))));
  const inverse = cropInverse(canonicalToViewport);
  if (!inverse || !bitmapToViewport.every(Number.isFinite)) return null;
  const lo = cropPoint(canonicalToViewport,{x:r.x0,y:r.y0}), hi = cropPoint(canonicalToViewport,{x:r.x1,y:r.y1});
  const at = (x: number,y: number) => cropPoint(canonicalToViewport,{x,y});
  const mx = (r.x0+r.x1)/2, my = (r.y0+r.y1)/2;
  return { bitmapToViewport, canonicalToViewport, viewportToCanonical: inverse,
    rect: { left: Math.min(lo.x,hi.x),top: Math.min(lo.y,hi.y),width: Math.abs(hi.x-lo.x),height: Math.abs(hi.y-lo.y) },
    handles: { topLeft:at(r.x0,r.y0),topRight:at(r.x1,r.y0),bottomRight:at(r.x1,r.y1),bottomLeft:at(r.x0,r.y1),
      top:at(mx,r.y0),right:at(r.x1,my),bottom:at(mx,r.y1),left:at(r.x0,my),move:at(mx,my) },
    coverScale: Math.min(viewport.x/((r.x1-r.x0)*w),viewport.y/((r.y1-r.y0)*h)) / Math.min(viewport.x/w,viewport.y/h) };
}

export const CROP_GUTTER = 24;
export function cropFitScale(viewport: Point, frame: Pick<RawGeometry,'nativeWidth'|'nativeHeight'>, crop?: RawCrop) {
  const w=frame.nativeWidth,h=frame.nativeHeight;
  const r=crop?.geometry.rect;
  const extentX=r?Math.max(.5,Math.abs(r.x0-.5),Math.abs(r.x1-.5))*2:1;
  const extentY=r?Math.max(.5,Math.abs(r.y0-.5),Math.abs(r.y1-.5))*2:1;
  const x=Math.max(1,viewport.x-2*Math.min(CROP_GUTTER,viewport.x/4)),y=Math.max(1,viewport.y-2*Math.min(CROP_GUTTER,viewport.y/4));
  return Math.min(x/(w*extentX),y/(h*extentY));
}
