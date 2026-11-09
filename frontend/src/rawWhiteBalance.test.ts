import { describe, expect, it } from 'vitest';
import { displayTemperature, displayTint, nativeTemperature } from './rawWhiteBalance';

describe('relative Native white balance display', () => {
  it('maps neutral and endpoint temperatures both ways without RAW step rounding', () => {
    expect(displayTemperature(6500, 'legacy')).toBe(0);
    expect(displayTemperature(nativeTemperature(-100, 'legacy'), 'legacy')).toBe(-100);
    expect(displayTemperature(nativeTemperature(100, 'legacy'), 'legacy')).toBe(100);
    expect(nativeTemperature(17, 'legacy')).not.toBe(Math.round(nativeTemperature(17, 'legacy') / 50) * 50);
  });

  it('leaves Kelvin values untouched and clamps only the displayed tint', () => {
    expect(displayTemperature(4875, 'kelvin')).toBe(4875);
    expect(displayTint(-150)).toBe(-100);
    expect(displayTint(22.4)).toBe(22);
  });
});
