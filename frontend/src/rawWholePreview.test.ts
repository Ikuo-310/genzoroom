import { expect, it } from 'vitest';
import { rawWholeSide, type RawView } from './rawWholePreview';
const view: RawView = { width: 900, height: 600, nativeWidth: 3990, nativeHeight: 3000,
  geometryId: 'a', dpr: 1, scale: 1, fit: true };
it.each([[1, 832], [1.25, 1024], [1.5, 1216], [2, 1600]])('fits physical viewport at DPR %s', (dpr, expected) => {
  expect(rawWholeSide({ ...view, dpr })).toBe(expected);
});
it('uses both viewport dimensions, caps native size and bounds Whole zoom', () => {
  expect(rawWholeSide({ ...view, width: 1600, height: 1200 })).toBe(1600);
  expect(rawWholeSide({ ...view, dpr: 2, width: 1600, height: 1200 })).toBe(2048);
  expect(rawWholeSide({ ...view, nativeWidth: 700, nativeHeight: 500, dpr: 2 })).toBe(700);
  expect(rawWholeSide({ ...view, fit: false, scale: 1 / 2, dpr: 2 })).toBe(2048);
});
it('quantizes, holds small changes and reduces only after meaningful shrinkage', () => {
  expect(rawWholeSide({ ...view, width: 1000, height: 750 }, 1024)).toBe(1024);
  expect(rawWholeSide({ ...view, width: 1100, height: 825 }, 1024)).toBe(1024);
  expect(rawWholeSide({ ...view, width: 1200, height: 900 }, 1024)).toBe(1216);
  expect(rawWholeSide({ ...view, width: 700, height: 525 }, 1024)).toBe(704);
});
it.each([0, -1, NaN, Infinity])('ignores invalid view dimensions %s', width => {
  expect(rawWholeSide({ ...view, width })).toBeUndefined();
});
