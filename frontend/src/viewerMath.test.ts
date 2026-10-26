import { describe, expect, it } from 'vitest';
import { calculateFitScale, clampViewerPan, clampZoom, panForCenteredZoom, zoomAroundPoint } from './viewerMath';

describe('viewer math', () => {
  it('fits the entire image inside the viewport', () => {
    expect(calculateFitScale({ x: 1000, y: 600 }, { x: 2000, y: 800 })).toBe(0.5);
    expect(calculateFitScale({ x: 600, y: 1000 }, { x: 800, y: 2000 })).toBe(0.5);
  });

  it('clamps zoom to safe bounds', () => {
    expect(clampZoom(0)).toBe(0.05);
    expect(clampZoom(20)).toBe(8);
  });

  it('keeps the pointed image location stable while zooming', () => {
    expect(zoomAroundPoint({ x: 0, y: 0 }, { x: 100, y: 50 }, 1, 2)).toEqual({ x: -100, y: -50 });
  });

  it('moves a selected image point to the viewport center during zoom', () => {
    expect(panForCenteredZoom({ x: 0, y: 0 }, { x: 100, y: 50 }, 0.5, 1)).toEqual({ x: -200, y: -100 });
  });

  it('clamps pan to displayed image bounds and centers undersized axes', () => {
    expect(clampViewerPan({ x: 500, y: -500 }, 1, { x: 800, y: 600 }, { x: 400, y: 300 }))
      .toEqual({ x: 200, y: -150 });
    expect(clampViewerPan({ x: 30, y: -30 }, 1, { x: 200, y: 600 }, { x: 400, y: 300 }))
      .toEqual({ x: 0, y: -30 });
  });
});
