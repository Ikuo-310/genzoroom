import { describe,it,expect } from 'vitest';
import { cropOverlayPaths } from './rawCropOverlay';
describe('crop overlay geometry',()=>{
 it('provides the default thirds, halves, golden, diagonals and uniform grid',()=>{
  expect(cropOverlayPaths('thirds',300,150)).toHaveLength(4);expect(cropOverlayPaths('halves',300,150)).toHaveLength(2);
  expect(cropOverlayPaths('golden',100,100)[0]).toContain('38.1966');expect(cropOverlayPaths('diagonals',100,100)).toHaveLength(2);
  expect(cropOverlayPaths('grid',100,100)).toHaveLength(16);expect(cropOverlayPaths('none',100,100)).toEqual([]);
 });
 it('rotates the spiral in normalized crop space and rejects invalid frames',()=>{
  const base=cropOverlayPaths('spiral',400,200,0)[0],rotated=cropOverlayPaths('spiral',400,200,90)[0];
  expect(rotated).not.toBe(base);expect(cropOverlayPaths('spiral',400,200,360)[0]).toBe(base);expect(cropOverlayPaths('grid',0,3)).toEqual([]);
 });
});
