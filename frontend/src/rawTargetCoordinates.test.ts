import { expect, it } from 'vitest';
import { rawTargetOrientedSize, rawTargetPoint } from './rawTargetCoordinates';
import type { RawCrop } from './rawApi';
const crop = (angle=0, flip_h=false, flip_v=false): RawCrop => ({ geometry:{rect:{x0:.2,y0:.1,x1:.8,y1:.9},angle},aspect:null,flip_h,flip_v });
it('maps output coordinates through crop, flips and inverse straighten', () => {
  expect(rawTargetOrientedSize({x:4000,y:3000}, 'Rotate90')).toEqual({x:3000,y:4000});
  expect(rawTargetOrientedSize({x:4000,y:3000}, 'Transverse')).toEqual({x:3000,y:4000});
  expect(rawTargetPoint({x:.5,y:.5}, crop(), {x:4000,y:2000})).toEqual({x:.5,y:.5});
  expect(rawTargetPoint({x:0,y:0}, crop(0,true,true), {x:4000,y:2000})).toEqual({x:.8,y:.9});
  const p = rawTargetPoint({x:.25,y:.75}, crop(30), {x:4000,y:2000})!;
  expect(p.x).toBeCloseTo(.4201, 3);
  expect(p.y).toBeCloseTo(.8232, 3);
});
