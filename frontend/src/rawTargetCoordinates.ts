import type { RawCrop } from './rawApi';
import type { Point } from './viewerMath';

/** Maps a whole output point through LightCraft's crop output-to-oriented-source transform. */
export function rawTargetPoint(point: Point, crop: RawCrop | undefined, oriented: Point): Point | null {
  if (![point.x, point.y, oriented.x, oriented.y].every(Number.isFinite)
    || oriented.x <= 0 || oriented.y <= 0 || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  const c = crop ?? { geometry: { rect: { x0: 0, y0: 0, x1: 1, y1: 1 }, angle: 0 }, aspect: null, flip_h: false, flip_v: false };
  const { rect, angle } = c.geometry;
  if (![rect.x0, rect.y0, rect.x1, rect.y1, angle].every(Number.isFinite) || rect.x0 >= rect.x1 || rect.y0 >= rect.y1) return null;
  const x = c.flip_h ? 1 - point.x : point.x, y = c.flip_v ? 1 - point.y : point.y;
  const px = (rect.x0 + x * (rect.x1 - rect.x0)) * oriented.x;
  const py = (rect.y0 + y * (rect.y1 - rect.y0)) * oriented.y;
  const dx = px - oriented.x / 2, dy = py - oriented.y / 2, radians = -angle * Math.PI / 180;
  const sx = oriented.x / 2 + dx * Math.cos(radians) - dy * Math.sin(radians);
  const sy = oriented.y / 2 + dx * Math.sin(radians) + dy * Math.cos(radians);
  return { x: sx / oriented.x, y: sy / oriented.y };
}
