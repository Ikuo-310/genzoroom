// Transport and decode limits bound Whole rendering; Region/detail rendering is a separate contract.
export const RAW_WHOLE_MAX_SIDE = 2048;
export const RAW_WHOLE_MAX_BYTES = 17 * 1024 ** 2;
export type RawView = { width: number; height: number; dpr: number; scale: number;
  nativeWidth: number; nativeHeight: number; geometryId: string; fit: boolean };

export function rawWholeSide(view: RawView, previous?: number): number | undefined {
  if (![view.width, view.height, view.dpr, view.scale, view.nativeWidth, view.nativeHeight]
    .every(n => Number.isFinite(n) && n > 0)) return undefined;
  const native = Math.max(view.nativeWidth, view.nativeHeight);
  const scale = view.fit ? Math.min(view.width / view.nativeWidth, view.height / view.nativeHeight) : view.scale;
  const limit = Math.max(16, Math.min(RAW_WHOLE_MAX_SIDE, Math.floor(native)));
  const demand = Math.min(limit, native * Math.min(1, scale * view.dpr));
  if (previous && previous <= limit && demand <= previous * 1.08 && demand > previous * .75) return previous;
  return Math.min(limit, Math.max(16, Math.ceil(demand / 64) * 64));
}
