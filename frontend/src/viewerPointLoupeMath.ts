import type { Point } from './viewerMath';

export const VIEWER_POINT_LOUPE_SIZE = 120;
export const VIEWER_POINT_LOUPE_MAGNIFICATION = 4;
const VIEWER_POINT_LOUPE_GAP = 36;

export function viewerPointLoupePosition(viewport: Point, anchor: Point): Point | null {
  const size = VIEWER_POINT_LOUPE_SIZE;
  if (![viewport.x, viewport.y, anchor.x, anchor.y].every(Number.isFinite)
    || viewport.x < size || viewport.y < size) return null;
  const left = Math.max(0, Math.min(viewport.x - size, anchor.x - size / 2));
  const top = anchor.y >= size + VIEWER_POINT_LOUPE_GAP
    ? anchor.y - size - VIEWER_POINT_LOUPE_GAP
    : Math.max(0, Math.min(viewport.y - size, anchor.y + VIEWER_POINT_LOUPE_GAP));
  return { x: left, y: top };
}
