import { describe,it,expect } from 'vitest';
import { cropOverlayPaths } from './rawCropOverlay';
describe('crop overlay geometry',()=>{
 it('provides the default thirds, halves, golden, diagonals and uniform grid',()=>{
  expect(cropOverlayPaths('thirds',300,150)).toHaveLength(4);expect(cropOverlayPaths('halves',300,150)).toHaveLength(2);
  expect(cropOverlayPaths('golden',100,100)[0]).toContain('38.1966');expect(cropOverlayPaths('diagonals',100,100)).toHaveLength(2);
  expect(cropOverlayPaths('grid',100,100)).toHaveLength(16);expect(cropOverlayPaths('none',100,100)).toEqual([]);
 });
 it('supports exactly six overlays and rejects invalid frames',()=>{
  expect(['thirds','grid','golden','diagonals','halves','none']).toHaveLength(6);expect(cropOverlayPaths('grid',0,3)).toEqual([]);
 });
});
