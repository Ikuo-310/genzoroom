import { describe, expect, it } from 'vitest';
import { viewerPointLoupePosition, VIEWER_POINT_LOUPE_MAGNIFICATION, VIEWER_POINT_LOUPE_SIZE } from './viewerPointLoupeMath';

describe('viewer point loupe layout', () => {
  it('keeps the 120px circle inside the viewport and centers it over the target horizontally', () => {
    expect(VIEWER_POINT_LOUPE_SIZE).toBe(120);
    expect(VIEWER_POINT_LOUPE_MAGNIFICATION).toBe(4);
    expect(viewerPointLoupePosition({ x: 400, y: 300 }, { x: 200, y: 180 })).toEqual({ x: 140, y: 34 });
    expect(viewerPointLoupePosition({ x: 400, y: 300 }, { x: 12, y: 180 })?.x).toBe(0);
    expect(viewerPointLoupePosition({ x: 400, y: 300 }, { x: 390, y: 180 })?.x).toBe(280);
  });

  it('uses a 26px gap above and below when space allows, then clamps against the viewport edge', () => {
    expect(viewerPointLoupePosition({ x: 400, y: 300 }, { x: 200, y: 30 })?.y).toBe(56);
    expect(viewerPointLoupePosition({ x: 400, y: 140 }, { x: 200, y: 130 })?.y).toBe(20);
  });

  it('suppresses the loupe when the viewport cannot contain it', () => {
    expect(viewerPointLoupePosition({ x: 119, y: 300 }, { x: 40, y: 120 })).toBeNull();
    expect(viewerPointLoupePosition({ x: 400, y: 119 }, { x: 200, y: 60 })).toBeNull();
  });
});
