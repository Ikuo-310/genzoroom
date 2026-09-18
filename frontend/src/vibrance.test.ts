import { describe, expect, it } from 'vitest';
import { defaultRecipe } from './editing';
import { VIBRANCE_CHROMA_THRESHOLD, renderAdjustments } from './adjustmentPipeline';

const withVibrance = (value: number) => {
  const recipe = defaultRecipe();
  recipe.adjustments.vibrance = value;
  return recipe;
};
const rgbChroma = (data: Uint8ClampedArray) => Math.max(data[0], data[1], data[2]) - Math.min(data[0], data[1], data[2]);

describe('Vibrance pixel stage', () => {
  it('uses the documented normalized chroma threshold', () => {
    expect(VIBRANCE_CHROMA_THRESHOLD).toBe(0.5);
  });

  it('keeps vibrance 0 byte-identical', () => {
    const source = new Uint8ClampedArray([140, 120, 100, 31]);
    expect(renderAdjustments(source, withVibrance(0))).toEqual(source);
  });

  it('increases low-saturation chroma and acts less on high-saturation color', () => {
    const low = new Uint8ClampedArray([140, 120, 100, 255]);
    const high = new Uint8ClampedArray([240, 40, 20, 255]);
    const lowIncrease = rgbChroma(renderAdjustments(low, withVibrance(100))) - rgbChroma(low);
    const highIncrease = rgbChroma(renderAdjustments(high, withVibrance(100))) - rgbChroma(high);
    expect(lowIncrease).toBeGreaterThan(0);
    expect(highIncrease).toBeLessThan(lowIncrease);
  });

  it('is gentler than Saturation +100', () => {
    const source = new Uint8ClampedArray([140, 120, 100, 255]);
    const saturation = defaultRecipe();
    saturation.adjustments.saturation = 100;
    expect(rgbChroma(renderAdjustments(source, withVibrance(100))))
      .toBeLessThan(rgbChroma(renderAdjustments(source, saturation)));
  });

  it('reduces chroma at negative values without making low-saturation color gray', () => {
    const source = new Uint8ClampedArray([140, 120, 100, 255]);
    const result = renderAdjustments(source, withVibrance(-100));
    expect(rgbChroma(result)).toBeLessThan(rgbChroma(source));
    expect(rgbChroma(result)).toBeGreaterThan(0);
  });

  it('changes continuously around zero', () => {
    const source = new Uint8ClampedArray([160, 120, 100, 255]);
    for (const value of [-1, 1]) {
      const result = renderAdjustments(source, withVibrance(value));
      expect(Math.max(...result.slice(0, 3).map((channel, index) => Math.abs(channel - source[index])))).toBeLessThanOrEqual(1);
    }
  });

  it('keeps grayscale neutral and preserves alpha', () => {
    const gray = new Uint8ClampedArray([117, 117, 117, 83]);
    for (const value of [-100, -1, 1, 100]) {
      expect(renderAdjustments(gray, withVibrance(value))).toEqual(gray);
    }
  });

  it('clips safely for high-saturation input without overflow', () => {
    const source = new Uint8ClampedArray([255, 3, 0, 77, 0, 251, 9, 199]);
    const result = renderAdjustments(source, withVibrance(100));
    expect([...result].every((value) => value >= 0 && value <= 255)).toBe(true);
    expect([result[3], result[7]]).toEqual([77, 199]);
  });

  it('runs Vibrance before Saturation with an 8-bit boundary', () => {
    const source = new Uint8ClampedArray([152, 112, 91, 141]);
    const combined = defaultRecipe();
    combined.adjustments.vibrance = 70;
    combined.adjustments.saturation = 45;
    const vibranceOnly = withVibrance(70);
    const saturationOnly = defaultRecipe();
    saturationOnly.adjustments.saturation = 45;
    expect(renderAdjustments(source, combined)).toEqual(
      renderAdjustments(renderAdjustments(source, vibranceOnly), saturationOnly),
    );
  });
});
