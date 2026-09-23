import { describe, expect, it } from 'vitest';
import { defaultRecipe, editAsset, editSession, effectiveAdjustments, newSession } from './editing';
import { midtonesGradingWeight, renderAdjustments, shadowsGradingWeight, temperatureGains, tintGains } from './adjustmentPipeline';

function withShadowsTemperature(value: number) {
  const recipe = defaultRecipe();
  recipe.adjustments.shadowsTemperature = value;
  return recipe;
}

function withShadowsTint(value: number) {
  const recipe = defaultRecipe();
  recipe.adjustments.shadowsTint = value;
  return recipe;
}

function withMidtonesTemperature(value: number) {
  const recipe = defaultRecipe();
  recipe.adjustments.midtonesTemperature = value;
  return recipe;
}

describe('Midtones Temperature pixel stage', () => {
  it('is byte-identical at zero and uses global Temperature gains at both endpoints', () => {
    const source = new Uint8ClampedArray([127, 127, 127, 91, 255, 255, 255, 213]);
    expect(defaultRecipe().adjustments.midtonesTemperature).toBe(0);
    expect(renderAdjustments(source, withMidtonesTemperature(0))).toEqual(source);
    const warm = renderAdjustments(source, withMidtonesTemperature(-100));
    const cool = renderAdjustments(source, withMidtonesTemperature(100));
    expect(temperatureGains(-100)).toEqual({ red: 1.5, green: 1, blue: 2 / 3 });
    expect(temperatureGains(100)).toEqual({ red: 2 / 3, green: 1, blue: 1.5 });
    expect(warm[0]).toBeGreaterThan(127);
    expect(warm[2]).toBeLessThan(127);
    expect(cool[0]).toBeLessThan(127);
    expect(cool[2]).toBeGreaterThan(127);
    expect([warm[1], cool[1], warm[3], cool[3]]).toEqual([127, 127, 91, 91]);
    expect(Array.from(warm.slice(4))).toEqual(Array.from(source.slice(4)));
    expect(Array.from(cool.slice(4))).toEqual(Array.from(source.slice(4)));
  });

  it('has continuous fade-in, full plateau, and fade-out at the specified boundaries', () => {
    for (const [y, weight] of [[0, 0], [0.15, 0], [0.25, 0.5], [0.35, 1],
      [0.5, 1], [0.60, 1], [0.69, 0.5], [0.78, 0], [1, 0]]) {
      expect(midtonesGradingWeight(y)).toBeCloseTo(weight, 10);
    }
    for (const boundary of [0.15, 0.35, 0.60, 0.78]) {
      expect(Math.abs(midtonesGradingWeight(boundary - 1e-6)
        - midtonesGradingWeight(boundary + 1e-6))).toBeLessThan(1e-9);
    }
    expect(midtonesGradingWeight(0.2)).toBeLessThan(midtonesGradingWeight(0.3));
    expect(midtonesGradingWeight(0.65)).toBeGreaterThan(midtonesGradingWeight(0.73));
    expect(shadowsGradingWeight(0.15)).toBe(1);
    expect(shadowsGradingWeight(0.35)).toBe(0);
  });

  it('skips pixels outside its band, preserves alpha, and clips grayscale endpoints safely', () => {
    const source = new Uint8ClampedArray([38, 38, 38, 11, 64, 64, 64, 22,
      127, 127, 127, 33, 176, 176, 176, 44, 199, 199, 199, 55,
      250, 2, 127, 66, 2, 127, 250, 77]);
    for (const value of [-100, 100]) {
      const result = renderAdjustments(source, withMidtonesTemperature(value));
      expect(Array.from(result.slice(0, 4))).toEqual(Array.from(source.slice(0, 4)));
      expect(Array.from(result.slice(16, 20))).toEqual(Array.from(source.slice(16, 20)));
      expect(result[4]).not.toBe(source[4]);
      expect(result[8]).not.toBe(source[8]);
      expect(result[12]).not.toBe(source[12]);
      for (let i = 3; i < result.length; i += 4) expect(result[i]).toBe(source[i]);
      expect(Array.from(result).every((channel) => channel >= 0 && channel <= 255)).toBe(true);
    }
  });

  it('runs after Shadows Temperature and Shadows Tint, before Color', () => {
    const source = new Uint8ClampedArray([70, 70, 70, 97]);
    const combined = defaultRecipe();
    Object.assign(combined.adjustments, { shadowsTemperature: -100, shadowsTint: 100,
      midtonesTemperature: 100, vibrance: 40, saturation: -20 });
    const shadowsTemperature = withShadowsTemperature(-100);
    const shadowsTint = withShadowsTint(100);
    const midtones = withMidtonesTemperature(100);
    const color = defaultRecipe();
    Object.assign(color.adjustments, { vibrance: 40, saturation: -20 });
    expect(renderAdjustments(source, combined)).toEqual(renderAdjustments(
      renderAdjustments(renderAdjustments(renderAdjustments(source, shadowsTemperature), shadowsTint), midtones), color));
    expect(renderAdjustments(source, combined)).not.toEqual(renderAdjustments(
      renderAdjustments(renderAdjustments(renderAdjustments(source, midtones), shadowsTemperature), shadowsTint), color));
  });
});

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

describe('Shadows Tint pixel stage', () => {
  it('defaults to zero and remains byte-identical', () => {
    const source = new Uint8ClampedArray([31, 47, 63, 79, 220, 210, 200, 191]);
    expect(defaultRecipe().adjustments.shadowsTint).toBe(0);
    expect(renderAdjustments(source, withShadowsTint(0))).toEqual(source);
  });

  it('uses the global Tint direction and endpoint gains in low luminance', () => {
    const source = new Uint8ClampedArray([35, 35, 35, 123]);
    const green = renderAdjustments(source, withShadowsTint(-100));
    const magenta = renderAdjustments(source, withShadowsTint(100));
    expect(tintGains(-100)).toEqual({ red: 1 / 1.3, green: 1.3, blue: 1 / 1.3 });
    expect(tintGains(100)).toEqual({ red: 1.3, green: 1 / 1.3, blue: 1.3 });
    expect(green[1]).toBeGreaterThan(source[1]);
    expect(green[0]).toBeLessThan(source[0]);
    expect(green[2]).toBeLessThan(source[2]);
    expect(magenta[0]).toBeGreaterThan(source[0]);
    expect(magenta[2]).toBeGreaterThan(source[2]);
    expect(magenta[1]).toBeLessThan(source[1]);
    expect([green[3], magenta[3]]).toEqual([123, 123]);
  });

  it('uses the shared Shadows weight, fades continuously, and is zero outside the range', () => {
    const source = new Uint8ClampedArray([
      38, 38, 38, 10,
      64, 64, 64, 20,
      90, 90, 90, 30,
      220, 220, 220, 40,
    ]);
    const result = renderAdjustments(source, withShadowsTint(100));
    const chroma = (offset: number) => Math.abs(result[offset] - result[offset + 1]);
    expect(chroma(0)).toBeGreaterThan(chroma(4));
    expect(chroma(4)).toBeGreaterThan(0);
    expect(Array.from(result.slice(8, 12))).toEqual(Array.from(source.slice(8, 12)));
    expect(Array.from(result.slice(12, 16))).toEqual(Array.from(source.slice(12, 16)));
  });

  it('preserves alpha and clips every output channel safely', () => {
    const source = new Uint8ClampedArray([75, 2, 75, 17, 2, 75, 2, 239]);
    for (const value of [-100, 100]) {
      const result = renderAdjustments(source, withShadowsTint(value));
      expect([result[3], result[7]]).toEqual([17, 239]);
      expect(Array.from(result).every((channel) => channel >= 0 && channel <= 255)).toBe(true);
    }
  });

  it('runs immediately after Shadows Temperature', () => {
    const source = new Uint8ClampedArray([0, 0, 2, 97]);
    const combined = defaultRecipe();
    Object.assign(combined.adjustments, { shadowsTemperature: -100, shadowsTint: 100 });
    const temperature = withShadowsTemperature(-100);
    const tint = withShadowsTint(100);
    expect(renderAdjustments(source, combined)).toEqual(
      renderAdjustments(renderAdjustments(source, temperature), tint),
    );
    expect(renderAdjustments(source, combined)).not.toEqual(
      renderAdjustments(renderAdjustments(source, tint), temperature),
    );
  });
});

describe('Color Grading recipe and History', () => {
  it('bypasses all three adjustments while OFF without losing their values or other categories', () => {
    const source = new Uint8ClampedArray([40, 50, 60, 255]);
    const recipe = withShadowsTemperature(70);
    Object.assign(recipe.adjustments, { exposure: 0.4, shadowsTint: -65, midtonesTemperature: 85, saturation: 20 });
    const enabled = renderAdjustments(source, recipe);
    recipe.colorGradingEnabled = false;
    expect(effectiveAdjustments(recipe).shadowsTemperature).toBe(0);
    expect(effectiveAdjustments(recipe).shadowsTint).toBe(0);
    expect(effectiveAdjustments(recipe).midtonesTemperature).toBe(0);
    expect(recipe.adjustments.shadowsTemperature).toBe(70);
    expect(recipe.adjustments.shadowsTint).toBe(-65);
    expect(recipe.adjustments.midtonesTemperature).toBe(85);
    const withoutGrading = defaultRecipe();
    Object.assign(withoutGrading.adjustments, { exposure: 0.4, saturation: 20 });
    expect(renderAdjustments(source, recipe)).toEqual(renderAdjustments(source, withoutGrading));
    recipe.colorGradingEnabled = true;
    expect(renderAdjustments(source, recipe)).toEqual(enabled);
  });

  it('keeps Midtones Temperature active when another category is disabled', () => {
    const source = new Uint8ClampedArray([127, 127, 127, 255]);
    const midtones = withMidtonesTemperature(-80);
    const expected = renderAdjustments(source, midtones);
    for (const category of ['whiteBalanceEnabled', 'basicEnabled', 'colorEnabled'] as const) {
      const recipe = withMidtonesTemperature(-80);
      recipe[category] = false;
      expect(effectiveAdjustments(recipe).midtonesTemperature).toBe(-80);
      expect(renderAdjustments(source, recipe)).toEqual(expected);
    }
  });

  it('commits Midtones Temperature changes, including pending edits, and supports Undo/Redo', () => {
    let state = newSession();
    state = editSession(state, { type: 'midtonesTemperature', value: 10 });
    state = editSession(state, { type: 'midtonesTemperature', value: 35 });
    expect(state.pending?.kind).toBe('midtonesTemperature');
    expect(state.history).toHaveLength(0);
    state = editSession(state, { type: 'shadowsTint', value: -20 });
    expect(state.history.map((entry) => entry.kind)).toEqual(['midtonesTemperature']);
    state = editSession(state, { type: 'commit', kind: 'shadowsTint' });
    expect(state.history.map((entry) => entry.kind)).toEqual(['midtonesTemperature', 'shadowsTint']);
    state = editSession(state, { type: 'undo' });
    expect(state.recipe.adjustments.shadowsTint).toBe(0);
    state = editSession(state, { type: 'undo' });
    expect(state.recipe.adjustments.midtonesTemperature).toBe(0);
    state = editSession(state, { type: 'redo' });
    expect(state.recipe.adjustments.midtonesTemperature).toBe(35);
  });

  it('coalesces Shadows Tint changes and supports Undo and Redo', () => {
    let state = newSession();
    state = editSession(state, { type: 'shadowsTint', value: 10 });
    state = editSession(state, { type: 'shadowsTint', value: 40 });
    state = editSession(state, { type: 'commit', kind: 'shadowsTint' });
    expect(state.history.map((entry) => entry.kind)).toEqual(['shadowsTint']);
    expect(editSession(state, { type: 'undo' }).recipe.adjustments.shadowsTint).toBe(0);
    state = editSession(state, { type: 'undo' });
    expect(editSession(state, { type: 'redo' }).recipe.adjustments.shadowsTint).toBe(40);
  });

  it('resets individual and category values without crossing category boundaries', () => {
    let state = newSession();
    state = editSession(state, { type: 'shadowsTemperature', value: 40 });
    state = editSession(state, { type: 'commit', kind: 'shadowsTemperature' });
    state = editSession(state, { type: 'shadowsTint', value: -30 });
    state = editSession(state, { type: 'commit', kind: 'shadowsTint' });
    state = editSession(state, { type: 'midtonesTemperature', value: 55 });
    state = editSession(state, { type: 'commit', kind: 'midtonesTemperature' });
    state = editSession(state, { type: 'shadowsTintReset' });
    expect(state.recipe.adjustments.shadowsTemperature).toBe(40);
    expect(state.recipe.adjustments.shadowsTint).toBe(0);
    expect(state.recipe.adjustments.midtonesTemperature).toBe(55);
    state = editSession(state, { type: 'midtonesTemperatureReset' });
    expect(state.recipe.adjustments.midtonesTemperature).toBe(0);
    expect(state.recipe.adjustments.shadowsTemperature).toBe(40);
    state = editSession(state, { type: 'undo' });
    expect(state.recipe.adjustments.midtonesTemperature).toBe(55);
    state = editSession(state, { type: 'shadowsTint', value: -30 });
    state = editSession(state, { type: 'commit', kind: 'shadowsTint' });
    for (const action of [{ type: 'whiteBalanceReset' }, { type: 'basicReset' }, { type: 'colorReset' }] as const) {
      state = editSession(state, action);
      expect(state.recipe.adjustments.shadowsTint).toBe(-30);
      expect(state.recipe.adjustments.midtonesTemperature).toBe(55);
    }
    state = editSession(state, { type: 'toggleColorGrading' });
    state = editSession(state, { type: 'colorGradingReset' });
    expect(state.recipe.adjustments.shadowsTemperature).toBe(0);
    expect(state.recipe.adjustments.shadowsTint).toBe(0);
    expect(state.recipe.adjustments.midtonesTemperature).toBe(0);
    expect(state.recipe.colorGradingEnabled).toBe(false);
    expect(state.history.at(-1)?.kind).toBe('colorGradingReset');
    state = editSession(state, { type: 'undo' });
    expect(state.recipe.adjustments.shadowsTemperature).toBe(40);
    expect(state.recipe.adjustments.shadowsTint).toBe(-30);
    expect(state.recipe.adjustments.midtonesTemperature).toBe(55);
    state = editSession(state, { type: 'redo' });
    expect(state.recipe.adjustments.shadowsTemperature).toBe(0);
    expect(state.recipe.adjustments.shadowsTint).toBe(0);
    expect(state.recipe.adjustments.midtonesTemperature).toBe(0);
  });

  it('includes all three Color Grading values in one-operation All Reset', () => {
    let state = newSession();
    state = editSession(state, { type: 'shadowsTint', value: 40 });
    state = editSession(state, { type: 'commit', kind: 'shadowsTint' });
    state = editSession(state, { type: 'midtonesTemperature', value: -60 });
    state = editSession(state, { type: 'commit', kind: 'midtonesTemperature' });
    state = editSession(state, { type: 'toggleColorGrading' });
    state = editSession(state, { type: 'allReset' });
    expect(state.recipe).toEqual(defaultRecipe());
    expect(state.history.at(-1)?.kind).toBe('allReset');
    const undone = editSession(state, { type: 'undo' }).recipe;
    expect(undone.adjustments.shadowsTint).toBe(40);
    expect(undone.adjustments.midtonesTemperature).toBe(-60);
    expect(undone.colorGradingEnabled).toBe(false);
  });

  it('round-trips recipe JSON and keeps state per asset', () => {
    let sessions = editAsset({}, 'a', { type: 'shadowsTint', value: -35 });
    sessions = editAsset(sessions, 'a', { type: 'commit', kind: 'shadowsTint' });
    sessions = editAsset(sessions, 'b', { type: 'shadowsTint', value: 65 });
    expect(sessions.a.recipe.adjustments.shadowsTint).toBe(-35);
    expect(sessions.b.recipe.adjustments.shadowsTint).toBe(65);
    expect(JSON.parse(JSON.stringify(sessions.a.recipe))).toEqual(sessions.a.recipe);
  });
});
