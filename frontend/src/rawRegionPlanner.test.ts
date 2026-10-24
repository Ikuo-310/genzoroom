import { expect, it } from 'vitest';
import fixtures from './test-fixtures/raw-region-v1.json';
import { C1_REGION_BUDGET, planRawRegion, rawWholeDensity, regionNativeRect, visibleNativeRegion,
  type RegionPlannerInput, type RegionView } from './rawRegionPlanner';

const base: RegionPlannerInput = fixtures[0].input;
it.each(fixtures)('shared coordinate fixture: $name', ({ input, expected }) => {
  const plan = planRawRegion(input);
  expect(plan.mode).toBe('region');
  if (plan.mode !== 'region') throw new Error(plan.reason);
  expect(plan.nativeVisibleRect).toEqual(expected.nativeVisibleRect);
  expect(plan.contextWindow).toEqual(expected.contextWindow);
  expect(plan.requestedWindow).toEqual(plan.contextWindow);
  expect(plan.validRegion).toEqual(plan.contextWindow);
  const r = regionNativeRect(plan.contextWindow, input.geometry, input.full);
  expect(plan.nativePlacement).toEqual(r);
  expect(plan.validNativeRect).toEqual(r);
  expect(plan.limited).toBe(false);
  // Roundtrip is at pixel edges, not centers, and uses actual negotiated F on both axes.
  expect(r.x0 / input.geometry.nativeWidth * input.full.fullWidth).toBeCloseTo(plan.contextWindow.x, 10);
  expect(r.y1 / input.geometry.nativeHeight * input.full.fullHeight).toBeCloseTo(plan.contextWindow.y + plan.contextWindow.h, 10);
});
it('expands floats before floor/ceil, grid snap and clamp; context is not prefetch', () => {
  const plan = planRawRegion({ ...base, view: { ...base.view, panX: -.5 }, context: 16, prefetch: 8,
    budget: { ...C1_REGION_BUDGET, grid: 64 } });
  expect(plan).toMatchObject({ mode: 'region', nativeVisibleRect: { x0: 1600.5, y0: 1200, x1: 2400.5, y1: 1800 },
    requestedWindow: { x: 1536, y: 1152, w: 896, h: 704 },
    contextWindow: { x: 1536, y: 1152, w: 896, h: 704 }, validRegion: { x: 1552, y: 1168, w: 864, h: 672 } });
  const separated = planRawRegion({ ...base, context: 16, prefetch: 8 });
  expect(separated).toMatchObject({ requestedWindow: { x: 1592, y: 1192, w: 816, h: 616 },
    contextWindow: { x: 1576, y: 1176, w: 848, h: 648 }, validRegion: { x: 1592, y: 1192, w: 816, h: 616 } });
});
it('does not inset an edge shared with the full image boundary', () => {
  const plan = planRawRegion({ ...base, view: { ...base.view, panX: 1600, panY: 1200 }, context: 16, prefetch: 8 });
  expect(plan).toMatchObject({ contextWindow: { x: 0, y: 0, w: 824, h: 624 }, validRegion: { x: 0, y: 0, w: 808, h: 608 } });
});
it('uses supplied F on each axis, including native/aspect integer rounding differences', () => {
  const plan = planRawRegion({ ...base, full: { ...base.full, fullWidth: 1999, fullHeight: 1500 } });
  expect(plan).toMatchObject({ contextWindow: { x: 799, y: 600, w: 401, h: 300 } });
});
it('bounds oversized regions around the visible center and reports partial coverage', () => {
  const plan = planRawRegion({ ...base, view: { ...base.view, width: 4000, height: 3000 } });
  expect(plan).toMatchObject({ mode: 'region', limited: true, contextWindow: { x: 1488, y: 476, w: 1024, h: 2048 } });
  if (plan.mode !== 'region') throw new Error('missing plan');
  expect(plan.contextWindow.w * plan.contextWindow.h).toBe(C1_REGION_BUDGET.maxPixels);
});
it('uses default 256px grid, clamps non-grid full boundaries and bounds sides', () => {
  const { budget: _, ...input } = base;
  expect(planRawRegion(input)).toMatchObject({ contextWindow: { x: 1536, y: 1024, w: 1024, h: 1024 } });
  expect(planRawRegion({ ...input, view: { ...base.view, panX: -1600, panY: -1200 } }))
    .toMatchObject({ contextWindow: { x: 3072, y: 2304, w: 928, h: 696 } });
});
it.each(['width', 'height', 'dpr', 'scale'] as const)('rejects invalid %s', key => {
  for (const n of [0, -1, NaN, Infinity, -Infinity])
    expect(planRawRegion({ ...base, view: { ...base.view, [key]: n } })).toMatchObject({ mode: 'whole', reason: 'invalid_input' });
});
it.each(['panX', 'panY'] as const)('rejects nonfinite %s', key => {
  expect(planRawRegion({ ...base, view: { ...base.view, [key]: NaN } })).toMatchObject({ reason: 'invalid_input' });
});
it('rejects invalid geometry, F, margins, overflow and hostile budgets', () => {
  for (const n of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(planRawRegion({ ...base, geometry: { ...base.geometry, nativeWidth: n } }).mode).toBe('whole');
    expect(planRawRegion({ ...base, full: { ...base.full, fullHeight: n } }).mode).toBe('whole');
  }
  for (const n of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    expect(planRawRegion({ ...base, context: n })).toMatchObject({ reason: 'invalid_input' });
  expect(planRawRegion({ ...base, view: { ...base.view, scale: Number.MAX_SAFE_INTEGER } })).toMatchObject({ reason: 'arithmetic_overflow' });
  expect(planRawRegion({ ...base, view: { ...base.view, scale: Number.MIN_VALUE } })).toMatchObject({ reason: 'arithmetic_overflow' });
  expect(planRawRegion({ ...base, full: { ...base.full, geometryId: 'b'.repeat(64) } })).toMatchObject({ reason: 'geometry_mismatch' });
  expect(planRawRegion({ ...base, full: { ...base.full, fullWidth: 4001 } })).toMatchObject({ reason: 'frame_limit' });
  expect(planRawRegion({ ...base, geometry: { ...base.geometry, nativeWidth: 65537 } })).toMatchObject({ reason: 'frame_limit' });
  expect(planRawRegion({ ...base, budget: { ...C1_REGION_BUDGET, maxPixels: 2 ** 53 } })).toMatchObject({ reason: 'invalid_input' });
});
it('falls back for an invisible image or no valid context interior', () => {
  expect(planRawRegion({ ...base, view: { ...base.view, panX: 10000 } })).toMatchObject({ reason: 'not_visible' });
  expect(planRawRegion({ ...base, context: 1024 })).toMatchObject({ mode: 'whole', reason: 'context_exhausted' });
  expect(planRawRegion({ ...base, budget: { ...C1_REGION_BUDGET, maxPixels: 1 } })).toMatchObject({ reason: 'budget_exhausted' });
});
it.each([1, 1.25, 1.5, 2])('preserves physical density when CSS scale compensates for DPR %s', dpr => {
  const visible = fixtures[0].expected.nativeVisibleRect;
  expect(rawWholeDensity(base.geometry, 1 / dpr, dpr, { width: 2000, height: 1500 }, visible))
    .toMatchObject({ rho: 2, rhoX: 2, rhoY: 2, nativeCappedRho: 2, sufficient: false, physicalScale: 1 });
});
it.each([1, 1.25, 1.5, 2])('maps physical 100%% to the correct visible Native area at DPR %s', dpr => {
  const plan = planRawRegion({ ...base, view: { ...base.view, dpr, scale: 1 / dpr } });
  expect(plan.mode).toBe('region');
  if (plan.mode !== 'region') throw new Error(plan.reason);
  expect(plan.nativeVisibleRect.x0).toBeCloseTo(2000 - 400 * dpr, 10);
  expect(plan.nativeVisibleRect.y1).toBeCloseTo(1500 + 300 * dpr, 10);
});
it('reports actual Whole density without choosing Region thresholds', () => {
  const r = fixtures[0].expected.nativeVisibleRect;
  expect(rawWholeDensity(base.geometry, .25, 2, { width: 2000, height: 1500 }, r)).toMatchObject({ rho: 1, sufficient: true });
  expect(rawWholeDensity(base.geometry, 2, 1, { width: 4000, height: 3000 }, r)).toMatchObject({ rho: 2, nativeCappedRho: 1 });
  expect(rawWholeDensity(base.geometry, 1, 1, { width: 2000, height: 1400 }, r)?.rho).toBeCloseTo(3000 / 1400);
  expect(rawWholeDensity(base.geometry, 0, 1, { width: 2000, height: 1500 }, r)).toBeUndefined();
  expect(rawWholeDensity(base.geometry, 1, 1, { width: NaN, height: 1500 }, r)).toBeUndefined();
  expect(rawWholeDensity(base.geometry, 1, 1, { width: 2000, height: 1500 }, { ...r, x0: -1 })).toBeUndefined();
  expect(visibleNativeRegion(base.geometry, { ...base.view, scale: 1e308 } as RegionView)).toBe('invalid_input');
});
