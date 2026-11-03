import type { RawCrop, RawCropDisplay, RawGeometry, RawGeometryOperation, RawSettings } from './rawApi';
export type CropSnapshot = { url: string; frame: RawGeometry; display: RawCropDisplay; doc: RawSettings; mode: 'crop-edit' };
export type CropPresentation = { snapshot: CropSnapshot; crop: RawCrop; phase: 'provisional' | 'readback'; revision: number; fingerprint: string };
export function sameCropOwner(a: RawSettings, b: RawSettings) {
  return a.assetId===b.assetId && a.workspaceId===b.workspaceId && a.handle===b.handle
    && a.generation===b.generation && a.documentToken===b.documentToken;
}
export function reusableCropBitmap(snapshot: CropSnapshot, doc: RawSettings) {
  const a=snapshot.doc;
  // The closed drag/straighten contract preserves all other DevelopSettings. Native
  // crop-edit omits rect/angle; orientation, Warp and flips must never be rebound here.
  return sameCropOwner(a,doc) && !!doc.crop && a.orientation===doc.orientation
    && a.crop?.flip_h===doc.crop.flip_h && a.crop?.flip_v===doc.crop.flip_v
    && JSON.stringify([a.values,a.sections,a.process,a.wb,a.vignetteStyle])===JSON.stringify([doc.values,doc.sections,doc.process,doc.wb,doc.vignetteStyle]);
}
export function provisionalCrop(start: RawCrop, operation: RawGeometryOperation): RawCrop {
  const crop=structuredClone(start);
  if(operation.type==='straighten') { if(Number.isFinite(operation.params.angle) && Math.abs(operation.params.angle)<=45)crop.geometry.angle=operation.params.angle;return crop; }
  if(operation.type!=='drag') return crop;
  const p=operation.params,r=crop.geometry.rect,dx=p.to[0]-p.from[0],dy=p.to[1]-p.from[1],h=p.handle;
  if(![dx,dy].every(Number.isFinite))return crop;
  if(h==='move'){r.x0+=dx;r.x1+=dx;r.y0+=dy;r.y1+=dy;return crop;}
  const left=['left','topLeft','bottomLeft'].includes(h),right=['right','topRight','bottomRight'].includes(h);
  const top=['top','topLeft','topRight'].includes(h),bottom=['bottom','bottomLeft','bottomRight'].includes(h);
  if(left)r.x0=Math.min(r.x1-1e-6,r.x0+dx);if(right)r.x1=Math.max(r.x0+1e-6,r.x1+dx);
  if(top)r.y0=Math.min(r.y1-1e-6,r.y0+dy);if(bottom)r.y1=Math.max(r.y0+1e-6,r.y1+dy);
  // Display-only aspect feedback. Native owns boundary fitting and the saved result.
  if(start.aspect || p.keepRatio){
    const base=start.geometry.rect,ratio=(base.x1-base.x0)/(base.y1-base.y0),w=r.x1-r.x0,h=r.y1-r.y0;
    if(left||right){const height=w/ratio;if(top)r.y0=r.y1-height;else if(bottom)r.y1=r.y0+height;else {const cy=(r.y0+r.y1)/2;r.y0=cy-height/2;r.y1=cy+height/2;}}
    else {const width=h*ratio,cx=(r.x0+r.x1)/2;r.x0=cx-width/2;r.x1=cx+width/2;}
  }
  return crop;
}
