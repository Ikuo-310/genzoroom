export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

export type Point = { x: number; y: number };

export function wholeImagePoint(point: Point, bounds: { left: number; top: number; width: number; height: number }): Point | null {
  if (![point.x, point.y, bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) return null;
  // DOM bounds already include CSS pan/zoom. DPR belongs to resolution planning, not pointer coordinates.
  const x = (point.x - bounds.left) / bounds.width, y = (point.y - bounds.top) / bounds.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

export function clampViewerPan(pan: Point, scale: number, image: Point, viewport: Point): Point {
  const maxX = Math.max(0, (image.x * scale - viewport.x) / 2);
  const maxY = Math.max(0, (image.y * scale - viewport.y) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, pan.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.y)),
  };
}

export function calculateFitScale(container: Point, image: Point): number {
  if (container.x <= 0 || container.y <= 0 || image.x <= 0 || image.y <= 0) return 1;
  return Math.min(container.x / image.x, container.y / image.y);
}

export function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function zoomAroundPoint(pan: Point, point: Point, current: number, next: number): Point {
  if (current <= 0) return pan;
  // Adjust pan by the scale ratio so wheel zoom keeps the cursor's image point stationary.
  const ratio = next / current;
  return {
    x: point.x - (point.x - pan.x) * ratio,
    y: point.y - (point.y - pan.y) * ratio,
  };
}

export function panForCenteredZoom(pan: Point, point: Point, current: number, next: number): Point {
  if (current <= 0) return pan;
  const ratio = next / current;
  return { x: (pan.x - point.x) * ratio, y: (pan.y - point.y) * ratio };
}
