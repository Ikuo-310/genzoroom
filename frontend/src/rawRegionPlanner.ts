import contract from './rawRegionContract.json';

// These are C1 validation budgets, not accepted product limits or a process memory cap.
export const C1_REGION_BUDGET = Object.freeze(contract.c1InitialBudget);
export type RegionBudget = Pick<typeof C1_REGION_BUDGET, 'maxFullSide' | 'maxSide' | 'maxPixels' | 'grid'>;
export type RegionRect = Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
export type RegionWindow = Readonly<{ x: number; y: number; w: number; h: number }>;
export type RegionGeometry = Readonly<{ nativeWidth: number; nativeHeight: number; geometryId: string }>;
export type RegionView = Readonly<{ width: number; height: number; dpr: number; scale: number; panX: number; panY: number }>;
// F is supplied by a native Plan negotiation; this planner never guesses LC's aspect rounding.
export type RegionFullFrame = Readonly<{ geometryId: string; fullWidth: number; fullHeight: number }>;
export type RegionPlannerInput = Readonly<{ geometry: RegionGeometry; view: RegionView; full: RegionFullFrame;
  context: number; prefetch: number; budget?: RegionBudget }>;
export type RegionFallback = 'invalid_input' | 'arithmetic_overflow' | 'geometry_mismatch' | 'frame_limit'
  | 'not_visible' | 'context_exhausted' | 'budget_exhausted';
export type RegionPlan = { mode: 'whole'; reason: RegionFallback; nativeVisibleRect?: RegionRect }
  | { mode: 'region'; nativeVisibleRect: RegionRect; requestedWindow: RegionWindow; contextWindow: RegionWindow;
      validRegion: RegionWindow; nativePlacement: RegionRect; validNativeRect: RegionRect; limited: boolean };

export const regionInteger = (n: number, min = 0) => Number.isSafeInteger(n) && n >= min;
const safe = (n: number) => Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER;
export function validRegionGeometry(g: RegionGeometry) {
  return regionInteger(g.nativeWidth, 1) && regionInteger(g.nativeHeight, 1) && /^[a-f0-9]{64}$/.test(g.geometryId);
}
export function containsRegionRect(outer: RegionRect, inner: RegionRect) {
  return [outer, inner].every(r => [r.x0, r.y0, r.x1, r.y1].every(safe) && r.x0 < r.x1 && r.y0 < r.y1)
    && outer.x0 <= inner.x0 && outer.y0 <= inner.y0 && outer.x1 >= inner.x1 && outer.y1 >= inner.y1;
}
const asWindow = (r: RegionRect): RegionWindow => ({ x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 });
export function regionNativeRect(w: RegionWindow, g: RegionGeometry, f: RegionFullFrame): RegionRect {
  return { x0: w.x * g.nativeWidth / f.fullWidth, y0: w.y * g.nativeHeight / f.fullHeight,
    x1: (w.x + w.w) * g.nativeWidth / f.fullWidth, y1: (w.y + w.h) * g.nativeHeight / f.fullHeight };
}
export function visibleNativeRegion(g: RegionGeometry, v: RegionView): RegionRect | RegionFallback {
  if (!validRegionGeometry(g) || ![v.width, v.height, v.dpr, v.scale].every(n => safe(n) && n > 0)
    || ![v.panX, v.panY].every(safe)) return 'invalid_input';
  const drawnW = g.nativeWidth * v.scale, drawnH = g.nativeHeight * v.scale;
  const left = (v.width - drawnW) / 2 + v.panX, top = (v.height - drawnH) / 2 + v.panY;
  const edges = [-left / v.scale, -top / v.scale, (v.width - left) / v.scale, (v.height - top) / v.scale];
  if (![drawnW, drawnH, left, top, ...edges, v.scale * v.dpr].every(safe)) return 'arithmetic_overflow';
  const r = { x0: Math.max(0, edges[0]), y0: Math.max(0, edges[1]),
    x1: Math.min(g.nativeWidth, edges[2]), y1: Math.min(g.nativeHeight, edges[3]) };
  return r.x0 < r.x1 && r.y0 < r.y1 ? r : 'not_visible';
}
function validBudget(b: RegionBudget) {
  return Object.values(b).every(n => regionInteger(n, 1)) && b.maxFullSide <= C1_REGION_BUDGET.maxFullSide
    && b.maxSide <= C1_REGION_BUDGET.maxSide && b.maxPixels <= C1_REGION_BUDGET.maxPixels
    && b.grid <= b.maxSide;
}
export function planRawRegion(input: RegionPlannerInput): RegionPlan {
  const { geometry: g, view, full: f, context, prefetch } = input, b = input.budget ?? C1_REGION_BUDGET;
  const visible = visibleNativeRegion(g, view);
  if (typeof visible === 'string') return { mode: 'whole', reason: visible };
  const fallback = (reason: RegionFallback): RegionPlan => ({ mode: 'whole', reason, nativeVisibleRect: visible });
  if (!validBudget(b) || ![f.fullWidth, f.fullHeight].every(n => regionInteger(n, 1))
    || ![context, prefetch].every(n => regionInteger(n) && n <= b.maxFullSide)) return fallback('invalid_input');
  if (f.geometryId !== g.geometryId) return fallback('geometry_mismatch');
  if (Math.max(g.nativeWidth, g.nativeHeight, f.fullWidth, f.fullHeight) > b.maxFullSide
    || f.fullWidth > g.nativeWidth || f.fullHeight > g.nativeHeight) return fallback('frame_limit');
  const r = { x0: visible.x0 * f.fullWidth / g.nativeWidth, y0: visible.y0 * f.fullHeight / g.nativeHeight,
    x1: visible.x1 * f.fullWidth / g.nativeWidth, y1: visible.y1 * f.fullHeight / g.nativeHeight };
  // Expanding floats before rounding is observable at 1px edges; all ports must keep this order.
  const snap = (margin: number): RegionWindow => asWindow({
    x0: Math.max(0, Math.floor(Math.floor(r.x0 - margin) / b.grid) * b.grid),
    y0: Math.max(0, Math.floor(Math.floor(r.y0 - margin) / b.grid) * b.grid),
    x1: Math.min(f.fullWidth, Math.ceil(Math.ceil(r.x1 + margin) / b.grid) * b.grid),
    y1: Math.min(f.fullHeight, Math.ceil(Math.ceil(r.y1 + margin) / b.grid) * b.grid) });
  const requestedWindow = snap(prefetch), desired = snap(prefetch + context);
  let w = Math.min(desired.w, b.maxSide), h = Math.min(desired.h, b.maxSide);
  // Keep the shorter axis, reduce the longer one deterministically (width wins a tie).
  if (w * h > b.maxPixels) {
    if (w >= h) w = Math.floor(Math.floor(b.maxPixels / h) / b.grid) * b.grid;
    else h = Math.floor(Math.floor(b.maxPixels / w) / b.grid) * b.grid;
  }
  if (w <= 0 || h <= 0) return fallback('budget_exhausted');
  const origin = (lo: number, hi: number, start: number, length: number, span: number) =>
    Math.max(start, Math.min(start + span - length, Math.floor(((lo + hi) / 2 - length / 2) / b.grid) * b.grid));
  const window = { x: origin(r.x0, r.x1, desired.x, w, desired.w), y: origin(r.y0, r.y1, desired.y, h, desired.h), w, h };
  const valid = { x0: window.x + (window.x === 0 ? 0 : context), y0: window.y + (window.y === 0 ? 0 : context),
    x1: window.x + w - (window.x + w === f.fullWidth ? 0 : context),
    y1: window.y + h - (window.y + h === f.fullHeight ? 0 : context) };
  if (valid.x0 >= valid.x1 || valid.y0 >= valid.y1) return fallback('context_exhausted');
  if (Math.max(valid.x0, r.x0) >= Math.min(valid.x1, r.x1) || Math.max(valid.y0, r.y0) >= Math.min(valid.y1, r.y1))
    return fallback('budget_exhausted');
  const validRegion = asWindow(valid);
  return { mode: 'region', nativeVisibleRect: visible, requestedWindow, contextWindow: window, validRegion,
    nativePlacement: regionNativeRect(window, g, f), validNativeRect: regionNativeRect(validRegion, g, f),
    limited: w !== desired.w || h !== desired.h };
}

export function rawWholeDensity(g: RegionGeometry, scale: number, dpr: number,
  bitmap: Readonly<{ width: number; height: number }>, visible: RegionRect) {
  if (!validRegionGeometry(g) || ![scale, dpr].every(n => safe(n) && n > 0)
    || ![bitmap.width, bitmap.height].every(n => regionInteger(n, 1))
    || !containsRegionRect({ x0: 0, y0: 0, x1: g.nativeWidth, y1: g.nativeHeight }, visible)) return undefined;
  const physicalScale = scale * dpr;
  const rhoX = physicalScale * g.nativeWidth / bitmap.width, rhoY = physicalScale * g.nativeHeight / bitmap.height;
  if (![physicalScale, rhoX, rhoY].every(safe)) return undefined;
  return { rho: Math.max(rhoX, rhoY), rhoX, rhoY, sufficient: rhoX <= 1 && rhoY <= 1,
    nativeCappedRho: Math.max(Math.min(1, physicalScale) * g.nativeWidth / bitmap.width,
      Math.min(1, physicalScale) * g.nativeHeight / bitmap.height),
    visibleNativeRect: visible, physicalScale };
}
