import { expect, it } from 'vitest';
import { cropPoint, cropInverse, projectRawCrop } from './rawCropMath';
import type { RawCrop, RawGeometry } from './rawApi';
const frame = (w:number,h:number):RawGeometry => ({geometryId:'edit',nativeWidth:w,nativeHeight:h,aspect:w/h,fullWidth:w/4,fullHeight:h/4,window:null});
const crop = (angle=0,flip_h=false,flip_v=false):RawCrop => ({ geometry:{rect:{x0:.4,y0:.4,x1:.6,y1:.6},angle},aspect:null,flip_h,flip_v });
it.each([0,45,-45])('round trips noncentral normalized coordinates at %s degrees across oriented dimensions/flips/zoom/DPR', angle => {
  for (const [w,h] of [[4000,2000],[2000,4000]]) for (const flipH of [false,true]) for (const flipV of [false,true])
    for (const dpr of [1,1.5,2]) for (const scale of [.1,1,2]) for (const imageCentered of [false,true]) {
      const c=crop(angle,flipH,flipV); c.geometry.rect={x0:.41,y0:.37,x1:.57,y1:.56};
      // Orientation is already represented by Native dimensions; DPR has no place in the CSS inverse.
      const p=projectRawCrop(c,frame(w,h),{x:900,y:700},scale/dpr,{x:31,y:-19},{imageCentered})!;
      expect(p).toBeTruthy();
      for(const q of [{x:.41,y:.37},{x:.57,y:.56},{x:.49,y:.42}]) {
        const back=cropPoint(p.viewportToCanonical,cropPoint(p.canonicalToViewport,q));
        expect(back.x).toBeCloseTo(q.x,12);expect(back.y).toBeCloseTo(q.y,12);
      }
      expect(p.rect.width).toBeCloseTo(.16*w*scale/dpr);
      const bitmapCenter=cropPoint(p.bitmapToViewport,{x:w/8,y:h/8});
      expect(Number.isFinite(bitmapCenter.x)).toBe(true);
    }
});
it('accepts valid out-of-unit canonical crop and rejects holes/singular/nonfinite transforms',()=>{
  const c=crop(45);c.geometry.rect={x0:.45,y0:-.1,x1:.55,y1:1.1};
  expect(projectRawCrop(c,frame(4000,2000),{x:800,y:600},.1,{x:0,y:0})).toBeTruthy();
  c.geometry.rect={x0:0,y0:0,x1:1,y1:1};
  expect(projectRawCrop(c,frame(4000,2000),{x:800,y:600},.1,{x:0,y:0})).toBeNull();
  expect(cropInverse([1,2,2,4,0,0])).toBeNull();expect(cropInverse([NaN,0,0,1,0,0])).toBeNull();
  expect(projectRawCrop(crop(),frame(4000,2000),{x:800,y:600},0,{x:0,y:0})).toBeNull();
});
it('maps uncropped bitmap and canonical frame identically at zero angle, including flips',()=>{
  for(const h of [false,true]) for(const v of [false,true]) {
    const c=crop(0,h,v), f=frame(4000,2000),p=projectRawCrop(c,f,{x:800,y:600},.2,{x:12,y:8})!;
    const q={x:.45,y:.55},bitmap={x:(h?1-q.x:q.x)*f.fullWidth,y:(v?1-q.y:q.y)*f.fullHeight};
    const a=cropPoint(p.bitmapToViewport,bitmap),b=cropPoint(p.canonicalToViewport,q);
    expect(a.x).toBeCloseTo(b.x);expect(a.y).toBeCloseTo(b.y);
  }
});

it.each(['Normal','Rotate90','Rotate180','Rotate270','FlipH','FlipV','Transpose','Transverse'])('matches the Native inverse source equation after pre-applied orientation %s',orientation=>{
  const swapped=['Rotate90','Rotate270','Transpose','Transverse'].includes(orientation),w=swapped?2000:4000,h=swapped?4000:2000;
  for(const angle of [-45,0,45])for(const fh of [false,true])for(const fv of [false,true]){
    const c=crop(angle,fh,fv);c.geometry.rect={x0:.43,y0:.38,x1:.58,y1:.57};
    const f=frame(w,h),p=projectRawCrop(c,f,{x:900,y:700},.2,{x:17,y:-23})!;
    const source={x:.48*w,y:.51*h},theta=angle*Math.PI/180;
    const rx=w/2+Math.cos(theta)*(source.x-w/2)-Math.sin(theta)*(source.y-h/2);
    const ry=h/2+Math.sin(theta)*(source.x-w/2)+Math.cos(theta)*(source.y-h/2);
    const cx=(.43+.58)*w/2,cy=(.38+.57)*h/2;
    const expected={x:450+17+.2*(fh?cx-rx:rx-cx),y:350-23+.2*(fv?cy-ry:ry-cy)};
    const actual=cropPoint(p.bitmapToViewport,{x:(fh?1-source.x/w:source.x/w)*f.fullWidth,y:(fv?1-source.y/h:source.y/h)*f.fullHeight});
    expect(actual.x).toBeCloseTo(expected.x,10);expect(actual.y).toBeCloseTo(expected.y,10);
  }
});
