export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

export type Point = { x: number; y: number };

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
