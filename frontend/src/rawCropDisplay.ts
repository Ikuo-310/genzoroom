import { cropInverse, cropPoint, projectRawCrop, type CropMatrix } from './rawCropMath';
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
    && JSON.stringify([a.values,a.sections,a.opticsFlags,a.process,a.wb,a.vignetteStyle])===JSON.stringify([doc.values,doc.sections,doc.opticsFlags,doc.process,doc.wb,doc.vignetteStyle]);
}
export function provisionalCrop(start: RawCrop, operation: RawGeometryOperation, frame?: RawGeometry): RawCrop {
  const crop=structuredClone(start);
  if(operation.type==='straighten') { if(Number.isFinite(operation.params.angle) && Math.abs(operation.params.angle)<=45)crop.geometry.angle=operation.params.angle;return crop; }
  if(operation.type!=='drag') return crop;
  const p=operation.params,r=crop.geometry.rect,dx=p.to[0]-p.from[0],dy=p.to[1]-p.from[1],h=p.handle;
  if(![dx,dy].every(Number.isFinite))return crop;
  if(h==='move'){
    crop.geometry.rect=moveCropRect(start,dx,dy,frame);
    return crop;
  }
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
  return constrainDraft(start,crop,frame);
}
function moveCropRect(start:RawCrop,dx:number,dy:number,frame?:RawGeometry){
  const r=start.geometry.rect;
  if(!frame)return {x0:r.x0+dx,y0:r.y0+dy,x1:r.x1+dx,y1:r.y1+dy};
  const {nativeWidth:w,nativeHeight:h}=frame;
  if(!(Number.isFinite(w)&&w>0&&Number.isFinite(h)&&h>0))return {x0:r.x0+dx,y0:r.y0+dy,x1:r.x1+dx,y1:r.y1+dy};
  const px={x0:r.x0*w,y0:r.y0*h,x1:r.x1*w,y1:r.y1*h};
  const want={x:Math.max(-2*w,Math.min(2*w,dx*w)),y:Math.max(-2*h,Math.min(2*h,dy*h))};
  if(start.geometry.angle===0){
    // Match Native's Move branch: a blocked axis must not reduce the other axis' translation.
    const x=Math.max(-px.x0,Math.min(w-px.x1,want.x));
    const y=Math.max(-px.y0,Math.min(h-px.y1,want.y));
    return {x0:(px.x0+x)/w,y0:(px.y0+y)/h,x1:(px.x1+x)/w,y1:(px.y1+y)/h};
  }
  // Straightened crops use Native's nearest feasible offset so a frame can slide along tilted edges.
  const offset=nearestCropOffset(px,start.geometry.angle,w,h,want)
    ?? slideCropOffset(start,w,h,want);
  return {x0:(px.x0+offset.x)/w,y0:(px.y0+offset.y)/h,x1:(px.x1+offset.x)/w,y1:(px.y1+offset.y)/h};
}
function nearestCropOffset(rect:{x0:number;y0:number;x1:number;y1:number},angle:number,w:number,h:number,want:{x:number;y:number}){
  const a=angle*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  const rotation:CropMatrix=[c,s,-s,c,w/2-c*w/2+s*h/2,h/2-s*w/2-c*h/2],back=cropInverse(rotation);
  if(!back)return null;
  const ex={x:back[0],y:back[1]},ey={x:back[2],y:back[3]};
  const corners=[{x:rect.x0,y:rect.y0},{x:rect.x1,y:rect.y0},{x:rect.x1,y:rect.y1},{x:rect.x0,y:rect.y1}]
    .map(p=>cropPoint(back,p));
  const slackX=1e-9*w,slackY=1e-9*h;
  const planes:{x:number;y:number;b:number}[]=[];
  for(const q of corners){
    const nx={x:ex.x,y:ey.x},ny={x:ex.y,y:ey.y};
    planes.push(
      {x:nx.x,y:nx.y,b:Math.max(0,w-q.x)+slackX},
      {x:-nx.x,y:-nx.y,b:Math.max(0,q.x)+slackX},
      {x:ny.x,y:ny.y,b:Math.max(0,h-q.y)+slackY},
      {x:-ny.x,y:-ny.y,b:Math.max(0,q.y)+slackY},
    );
  }
  if(planes.every(p=>p.x*want.x+p.y*want.y<=p.b))return want;
  const limit=4*Math.max(w,h);
  let polygon=[{x:-limit,y:-limit},{x:limit,y:-limit},{x:limit,y:limit},{x:-limit,y:limit}];
  for(const plane of planes){
    const clipped:typeof polygon=[];
    for(let i=0;i<polygon.length;i++){
      const p=polygon[i],q=polygon[(i+1)%polygon.length],dp=plane.x*p.x+plane.y*p.y-plane.b,dq=plane.x*q.x+plane.y*q.y-plane.b;
      if(dp<=0)clipped.push(p);
      if((dp<=0)!==(dq<=0)){
        const t=dp/(dp-dq);clipped.push({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t});
      }
    }
    polygon=clipped;if(!polygon.length)return null;
  }
  let closest:{x:number;y:number}|null=null,best=Infinity;
  for(let i=0;i<polygon.length;i++){
    const p=polygon[i],q=polygon[(i+1)%polygon.length],vx=q.x-p.x,vy=q.y-p.y,l2=vx*vx+vy*vy;
    const t=l2>0?Math.max(0,Math.min(1,((want.x-p.x)*vx+(want.y-p.y)*vy)/l2)):0;
    const point={x:p.x+vx*t,y:p.y+vy*t},distance=(point.x-want.x)**2+(point.y-want.y)**2;
    if(distance<best){best=distance;closest=point;}
  }
  return closest;
}
function slideCropOffset(start:RawCrop,w:number,h:number,want:{x:number;y:number}){
  const valid=(x:number,y:number)=>{
    const crop=structuredClone(start),r=crop.geometry.rect;
    crop.geometry.rect={x0:r.x0+x/w,y0:r.y0+y/h,x1:r.x1+x/w,y1:r.y1+y/h};
    return !!projectRawCrop(crop,{nativeWidth:w,nativeHeight:h,fullWidth:w,fullHeight:h,geometryId:'',aspect:w/h,window:null},{x:1,y:1},1,{x:0,y:0});
  };
  const slide=(origin:{x:number;y:number},x:number,y:number)=>{
    let lo=0,hi=1;
    if(valid(origin.x+x,origin.y+y))return {x:origin.x+x,y:origin.y+y};
    for(let i=0;i<48;i++){
      const t=(lo+hi)/2;
      if(valid(origin.x+x*t,origin.y+y*t))lo=t;else hi=t;
    }
    return {x:origin.x+x*lo,y:origin.y+y*lo};
  };
  const x=slide({x:0,y:0},want.x,0);
  return slide(x,0,want.y);
}
function constrainDraft(start:RawCrop,draft:RawCrop,frame?:RawGeometry){
  if(!frame)return draft;
  const valid=(c:RawCrop)=>!!projectRawCrop(c,frame,{x:1,y:1},1,{x:0,y:0});
  if(valid(draft))return draft;
  if(!valid(start))return start;
  // Conservative feedback along the drag ray, using existing corner containment.
  // This is not Native fitting; the final unmodified pointer intent still goes to Native.
  let lo=0,hi=1,result=start;
  for(let n=0;n<24;n++){
    const t=(lo+hi)/2,c=structuredClone(start),a=start.geometry.rect,b=draft.geometry.rect;
    c.geometry.rect={x0:a.x0+(b.x0-a.x0)*t,y0:a.y0+(b.y0-a.y0)*t,x1:a.x1+(b.x1-a.x1)*t,y1:a.y1+(b.y1-a.y1)*t};
    if(valid(c)){lo=t;result=c;}else hi=t;
  }
  return result;
}
