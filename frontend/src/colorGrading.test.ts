import { describe, expect, it } from 'vitest';
import { defaultRecipe, editAsset, editSession, effectiveAdjustments, newSession } from './editing';
import { renderAdjustments, shadowsGradingWeight, temperatureGains } from './exposurePipeline';

function withShadowsTemperature(value: number) {
  const recipe = defaultRecipe();
  recipe.adjustments.shadowsTemperature = value;
  return recipe;
}

describe('Shadows Temperature pixel stage', () => {
  it('defaults to zero and remains byte-identical', () => {
    const source = new Uint8ClampedArray([31, 47, 63, 79, 220, 210, 200, 191]);
    expect(defaultRecipe().adjustments.shadowsTemperature).toBe(0);
    expect(renderAdjustments(source, defaultRecipe())).toEqual(source);
  });

  it('uses the same warm/cool direction and endpoint gains as global Temperature', () => {
    const source = new Uint8ClampedArray([45, 45, 45, 123]);
    const warm = renderAdjustments(source, withShadowsTemperature(-100));
    const cool = renderAdjustments(source, withShadowsTemperature(100));
    expect(temperatureGains(-100)).toEqual({ red: 1.5, green: 1, blue: 2 / 3 });
    expect(temperatureGains(100)).toEqual({ red: 2 / 3, green: 1, blue: 1.5 });
    expect(warm[0]).toBeGreaterThan(source[0]);
    expect(warm[2]).toBeLessThan(source[2]);
    expect(cool[0]).toBeLessThan(source[0]);
    expect(cool[2]).toBeGreaterThan(source[2]);
    expect([warm[1], cool[1], warm[3], cool[3]]).toEqual([45, 45, 123, 123]);
  });

  it('is strong through low luminance, fades smoothly, and is zero in highlights', () => {
    expect(shadowsGradingWeight(0)).toBe(1);
    expect(shadowsGradingWeight(0.15)).toBe(1);
    expect(shadowsGradingWeight(0.25)).toBeCloseTo(0.5, 10);
    expect(shadowsGradingWeight(0.35)).toBe(0);
    expect(shadowsGradingWeight(1)).toBe(0);
    const nearLeft = shadowsGradingWeight(0.15 - 1e-6);
    const nearRight = shadowsGradingWeight(0.15 + 1e-6);
    expect(Math.abs(nearLeft - nearRight)).toBeLessThan(1e-9);
    const fadeLeft = shadowsGradingWeight(0.35 - 1e-6);
    const fadeRight = shadowsGradingWeight(0.35 + 1e-6);
    expect(Math.abs(fadeLeft - fadeRight)).toBeLessThan(1e-9);

    const source = new Uint8ClampedArray([45, 45, 45, 17, 220, 220, 220, 239]);
    const result = renderAdjustments(source, withShadowsTemperature(100));
    expect(Array.from(result.slice(0, 3))).not.toEqual(Array.from(source.slice(0, 3)));
    expect(Array.from(result.slice(4))).toEqual(Array.from(source.slice(4)));
  });

  it('runs after Basic tone controls and before Vibrance and Saturation', () => {
    const source = new Uint8ClampedArray([45, 55, 65, 97]);
    const combined = defaultRecipe();
    Object.assign(combined.adjustments, { blacks: 30, shadowsTemperature: -60, vibrance: 25, saturation: 20 });
    const basic = defaultRecipe();
    basic.adjustments.blacks = 30;
    const grading = withShadowsTemperature(-60);
    const color = defaultRecipe();
    Object.assign(color.adjustments, { vibrance: 25, saturation: 20 });
    expect(renderAdjustments(source, combined)).toEqual(
      renderAdjustments(renderAdjustments(renderAdjustments(source, basic), grading), color),
    );
  });
});

describe('Color Grading recipe and History', () => {
  it('bypasses while OFF without losing the value', () => {
    const source = new Uint8ClampedArray([40, 50, 60, 255]);
    const recipe = withShadowsTemperature(70);
    const enabled = renderAdjustments(source, recipe);
    recipe.colorGradingEnabled = false;
    expect(effectiveAdjustments(recipe).shadowsTemperature).toBe(0);
    expect(recipe.adjustments.shadowsTemperature).toBe(70);
    expect(renderAdjustments(source, recipe)).toEqual(source);
    recipe.colorGradingEnabled = true;
    expect(renderAdjustments(source, recipe)).toEqual(enabled);
  });

  it('coalesces changes and supports category Reset, All Reset, Undo, and Redo', () => {
    let state = newSession();
    state = editSession(state, { type: 'shadowsTemperature', value: 10 });
    state = editSession(state, { type: 'shadowsTemperature', value: 40 });
    state = editSession(state, { type: 'commit', kind: 'shadowsTemperature' });
    expect(state.history.map((entry) => entry.kind)).toEqual(['shadowsTemperature']);
    state = editSession(state, { type: 'toggleColorGrading' });
    expect(state.recipe.colorGradingEnabled).toBe(false);
    state = editSession(state, { type: 'colorGradingReset' });
    expect(state.recipe.adjustments.shadowsTemperature).toBe(0);
    expect(state.recipe.colorGradingEnabled).toBe(false);
    state = editSession(state, { type: 'undo' });
    expect(state.recipe.adjustments.shadowsTemperature).toBe(40);
    state = editSession(state, { type: 'redo' });
    expect(state.recipe.adjustments.shadowsTemperature).toBe(0);
    state = editSession(state, { type: 'undo' });
    state = editSession(state, { type: 'allReset' });
    expect(state.recipe).toEqual(defaultRecipe());
    expect(editSession(state, { type: 'undo' }).recipe.adjustments.shadowsTemperature).toBe(40);
  });

  it('round-trips recipe JSON and keeps state per asset', () => {
    let sessions = editAsset({}, 'a', { type: 'shadowsTemperature', value: -35 });
    sessions = editAsset(sessions, 'a', { type: 'commit', kind: 'shadowsTemperature' });
    sessions = editAsset(sessions, 'b', { type: 'shadowsTemperature', value: 65 });
    expect(sessions.a.recipe.adjustments.shadowsTemperature).toBe(-35);
    expect(sessions.b.recipe.adjustments.shadowsTemperature).toBe(65);
    expect(JSON.parse(JSON.stringify(sessions.a.recipe))).toEqual(sessions.a.recipe);
  });
});
