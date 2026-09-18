import { describe, expect, it } from 'vitest';
import { BASIC_ADJUSTMENT_KEYS, defaultRecipe, editSession, effectiveAdjustments, isBasicDefault, isWhiteBalanceDefault, newSession, normalizeTemperature, normalizeTint, type EditAction } from './editing';
import { renderAdjustments, temperatureGains, tintGains } from './adjustmentPipeline';

function recipe(temperature = 0, exposure = 0) {
  const result = defaultRecipe();
  Object.assign(result.adjustments, { temperature, exposure });
  return result;
}
function tintRecipe(tint = 0, exposure = 0) {
  const result = defaultRecipe();
  Object.assign(result.adjustments, { tint, exposure });
  return result;
}
const pixels = new Uint8ClampedArray(Array.from({ length: 256 }, (_, i) => [i, 255 - i, (i * 37) % 256, i]).flat());
const decode = (byte: number) => byte / 255 <= 0.04045 ? byte / 255 / 12.92 : ((byte / 255 + 0.055) / 1.055) ** 2.4;

describe('Temperature preview', () => {
  it('is byte-identical at zero for all byte values and preserves the source', () => {
    const original = pixels.slice();
    const output = renderAdjustments(pixels, recipe());
    expect(output).toEqual(pixels);
    expect(output).not.toBe(pixels);
    expect(pixels).toEqual(original);
  });
  it.each([25, 50, 100])('warms negative and cools positive %s with reciprocal gains', (value) => {
    const source = new Uint8ClampedArray([100, 100, 100, 17]);
    const warm = renderAdjustments(source, recipe(-value));
    const cool = renderAdjustments(source, recipe(value));
    expect(warm[0]).toBeGreaterThan(100);
    expect(warm[2]).toBeLessThan(100);
    expect(cool[0]).toBeLessThan(100);
    expect(cool[2]).toBeGreaterThan(100);
    expect(warm[0]).toBe(cool[2]);
    expect(warm[2]).toBe(cool[0]);
    expect(warm[1]).toBe(100);
    expect(cool[1]).toBe(100);
    const positive = temperatureGains(value);
    const negative = temperatureGains(-value);
    expect(positive.red * negative.red).toBeCloseTo(1, 12);
    expect(positive.blue * negative.blue).toBeCloseTo(1, 12);
    expect(positive.green).toBe(1);
    // Check the rendered linear-light gain, allowing for final 8-bit quantization.
    expect(decode(cool[0]) / decode(100)).toBeCloseTo(positive.red, 1);
    expect(decode(cool[2]) / decode(100)).toBeCloseTo(positive.blue, 1);
  });
  it('uses moderate endpoint gains', () => {
    expect(temperatureGains(100)).toEqual({ red: 2 / 3, green: 1, blue: 1.5 });
    expect(temperatureGains(-100)).toEqual({ red: 1.5, green: 1, blue: 2 / 3 });
  });
  it.each([-100, 100])('clips safely and preserves Green and alpha at %s', (value) => {
    const source = new Uint8ClampedArray([...pixels, 0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 1, 0, 0, 255, 254]);
    const original = source.slice();
    const output = renderAdjustments(source, recipe(value));
    for (let i = 0; i < source.length; i += 4) {
      expect(output[i + 1]).toBe(source[i + 1]);
      expect(output[i + 3]).toBe(source[i + 3]);
      expect(output[i]).toBeGreaterThanOrEqual(0);
      expect(output[i + 2]).toBeLessThanOrEqual(255);
    }
    expect(output.slice(pixels.length, pixels.length + 4)).toEqual(new Uint8ClampedArray([0, 0, 0, 0]));
    expect(output[pixels.length + (value < 0 ? 4 : 6)]).toBe(255);
    expect(source).toEqual(original);
  });
  it.each([NaN, Infinity, -Infinity])('treats non-finite %s as neutral', (value) => {
    expect(renderAdjustments(pixels, recipe(value))).toEqual(pixels);
  });
  it('applies Temperature before Exposure, retaining intermediate clipping and rounding', () => {
    const source = new Uint8ClampedArray([250, 120, 250, 77]);
    const expected = renderAdjustments(renderAdjustments(source, recipe(-100)), recipe(0, -1));
    const reversed = renderAdjustments(renderAdjustments(source, recipe(0, -1)), recipe(-100));
    expect(renderAdjustments(source, recipe(-100, -1))).toEqual(expected);
    expect(expected).not.toEqual(reversed);
  });
  it('runs the unchanged six Basic stages after Temperature', () => {
    const basic = defaultRecipe();
    Object.assign(basic.adjustments, { exposure: 0.5, contrast: 20, highlights: -30, whites: 25, shadows: 40, blacks: -20 });
    const combined = { ...basic, adjustments: { ...basic.adjustments, temperature: 50 } };
    expect(renderAdjustments(pixels, combined)).toEqual(renderAdjustments(renderAdjustments(pixels, recipe(50)), basic));
  });
  it.each([[true, true], [false, true], [true, false], [false, false]])('independently bypasses WB=%s Basic=%s', (whiteBalanceEnabled, basicEnabled) => {
    const current = { ...recipe(70, 0.5), whiteBalanceEnabled, basicEnabled };
    current.adjustments.tint = -60;
    const before = structuredClone(current);
    const expected = recipe(whiteBalanceEnabled ? 70 : 0, basicEnabled ? 0.5 : 0);
    expected.adjustments.tint = whiteBalanceEnabled ? -60 : 0;
    expect(renderAdjustments(pixels, current)).toEqual(renderAdjustments(pixels, expected));
    expect(current).toEqual(before);
  });
});

describe('Tint preview', () => {
  it('is byte-identical at zero for all byte values', () => {
    expect(renderAdjustments(pixels, tintRecipe())).toEqual(pixels);
  });
  it.each([25, 50, 100])('shifts negative toward Green and positive toward Magenta at %s with reciprocal gains', (value) => {
    const source = new Uint8ClampedArray([100, 100, 100, 17]);
    const green = renderAdjustments(source, tintRecipe(-value));
    const magenta = renderAdjustments(source, tintRecipe(value));
    expect(green[1]).toBeGreaterThan(green[0]);
    expect(green[1]).toBeGreaterThan(green[2]);
    expect(magenta[0]).toBeGreaterThan(magenta[1]);
    expect(magenta[2]).toBeGreaterThan(magenta[1]);
    expect(green[0]).toBe(magenta[1]);
    expect(green[1]).toBe(magenta[0]);
    expect(green[2]).toBe(magenta[1]);
    const positive = tintGains(value);
    const negative = tintGains(-value);
    expect(positive.red * negative.red).toBeCloseTo(1, 12);
    expect(positive.green * negative.green).toBeCloseTo(1, 12);
    expect(positive.blue * negative.blue).toBeCloseTo(1, 12);
  });
  it('uses moderate endpoint gains', () => {
    expect(tintGains(100)).toEqual({ red: 1.3, green: 1 / 1.3, blue: 1.3 });
    expect(tintGains(-100)).toEqual({ red: 1 / 1.3, green: 1.3, blue: 1 / 1.3 });
  });
  it.each([-100, 100])('clips safely for extreme RGB and preserves alpha at %s', (value) => {
    const source = new Uint8ClampedArray([...pixels, 0, 0, 0, 0, 255, 255, 255, 255, 255, 0, 255, 1]);
    const output = renderAdjustments(source, tintRecipe(value));
    expect(output).toHaveLength(source.length);
    for (let i = 0; i < source.length; i += 4) {
      expect(output[i]).toBeGreaterThanOrEqual(0);
      expect(output[i]).toBeLessThanOrEqual(255);
      expect(output[i + 1]).toBeGreaterThanOrEqual(0);
      expect(output[i + 1]).toBeLessThanOrEqual(255);
      expect(output[i + 2]).toBeGreaterThanOrEqual(0);
      expect(output[i + 2]).toBeLessThanOrEqual(255);
      expect(output[i + 3]).toBe(source[i + 3]);
    }
  });
  it.each([NaN, Infinity, -Infinity])('treats non-finite %s as neutral', (value) => {
    expect(renderAdjustments(pixels, tintRecipe(value))).toEqual(pixels);
  });
  it('applies Temperature then Tint then Exposure with intermediate clipping and rounding', () => {
    const source = new Uint8ClampedArray([240, 120, 220, 77]);
    const combined = defaultRecipe();
    Object.assign(combined.adjustments, { temperature: -100, tint: 100, exposure: -1 });
    const expected = renderAdjustments(renderAdjustments(renderAdjustments(source, recipe(-100)), tintRecipe(100)), recipe(0, -1));
    const wrongOrder = renderAdjustments(renderAdjustments(renderAdjustments(source, tintRecipe(100)), recipe(-100)), recipe(0, -1));
    expect(renderAdjustments(source, combined)).toEqual(expected);
    expect(expected).not.toEqual(wrongOrder);
  });
});

describe('White Balance recipe and History', () => {
  it('keeps category membership and future fields independent', () => {
    expect(BASIC_ADJUSTMENT_KEYS).not.toContain('temperature');
    expect(BASIC_ADJUSTMENT_KEYS).not.toContain('tint');
    const current = { ...recipe(50), whiteBalanceEnabled: false, basicEnabled: false };
    current.adjustments.tint = -30;
    const extended = { ...current, adjustments: { ...current.adjustments, futureColor: 42 } };
    expect(effectiveAdjustments(extended)).toEqual({ ...defaultRecipe().adjustments, futureColor: 42 });
    expect(isBasicDefault(current.adjustments)).toBe(true);
    expect(isWhiteBalanceDefault(current.adjustments)).toBe(false);
  });
  it.each([[-200, -100], [200, 100], [25.6, 26], [-25.6, -26], [NaN, 0]])('normalizes %s to %s', (value, expected) => {
    expect(normalizeTemperature(value)).toBe(expected);
    expect(normalizeTint(value)).toBe(expected);
    expect(editSession(newSession(), { type: 'temperature', value }).recipe.adjustments.temperature).toBe(expected);
    expect(editSession(newSession(), { type: 'tint', value }).recipe.adjustments.tint).toBe(expected);
  });
  it('coalesces pending Temperature input and ignores stale commits on adjustment switches', () => {
    let state = newSession();
    for (const value of [10, 20, 30]) state = editSession(state, { type: 'temperature', value });
    expect(state.history).toHaveLength(0);
    state = editSession(state, { type: 'exposure', value: 0.5 });
    expect(state.history.map(e => e.kind)).toEqual(['temperature']);
    expect(state.history[0].before.adjustments.temperature).toBe(0);
    expect(state.history[0].after.adjustments.temperature).toBe(30);
    state = editSession(state, { type: 'commit', kind: 'temperature' });
    expect(state.pending?.kind).toBe('exposure');
    state = editSession(state, { type: 'temperature', value: 40 });
    expect(state.history.map(e => e.kind)).toEqual(['temperature', 'exposure']);
    state = editSession(state, { type: 'undo' });
    expect(state.recipe.adjustments.temperature).toBe(30);
    expect(state.recipe.adjustments.exposure).toBe(0.5);
    expect(editSession(state, { type: 'redo' }).recipe.adjustments.temperature).toBe(40);
  });
  it('coalesces pending Tint input and commits it when switching adjustments', () => {
    let state = newSession();
    for (const value of [-10, -20, -30]) state = editSession(state, { type: 'tint', value });
    expect(state.history).toHaveLength(0);
    state = editSession(state, { type: 'temperature', value: 25 });
    expect(state.history.map(entry => entry.kind)).toEqual(['tint']);
    expect(state.history[0].before.adjustments.tint).toBe(0);
    expect(state.history[0].after.adjustments.tint).toBe(-30);
    state = editSession(state, { type: 'commit', kind: 'tint' });
    expect(state.pending?.kind).toBe('temperature');
    state = editSession(state, { type: 'commit', kind: 'temperature' });
    expect(state.history.map(entry => entry.kind)).toEqual(['tint', 'temperature']);
    expect(editSession(state, { type: 'undo' }).recipe.adjustments.temperature).toBe(0);
    expect(editSession(editSession(state, { type: 'undo' }), { type: 'redo' }).recipe.adjustments.temperature).toBe(25);
  });
  it.each(['temperatureReset', 'tintReset', 'whiteBalanceReset', 'basicReset', 'allReset', 'toggleWhiteBalance', 'toggleBasic'] as const)('%s commits pending first and supports Undo/Redo', (type) => {
    let state = newSession();
    state = editSession(state, { type: 'exposure', value: 0.5 });
    state = editSession(state, { type: 'temperature', value: -50 });
    if (type === 'tintReset') state = { ...state, recipe: { ...state.recipe, adjustments: { ...state.recipe.adjustments, tint: 20 } } };
    const before = state.recipe;
    state = editSession(state, { type });
    expect(state.history).toHaveLength(3);
    expect(state.history[1].kind).toBe('temperature');
    expect(state.pending).toBeNull();
    expect(editSession(state, { type: 'undo' }).recipe).toEqual(before);
    expect(editSession(editSession(state, { type: 'undo' }), { type: 'redo' }).recipe).toEqual(state.recipe);
  });
  it('resets individual White Balance values independently and category values together while retaining OFF', () => {
    let state = newSession();
    state.recipe = { ...recipe(40, 0.5), whiteBalanceEnabled: false };
    state.recipe.adjustments.tint = -30;
    state = editSession(state, { type: 'tintReset' });
    expect(state.recipe.adjustments).toMatchObject({ temperature: 40, tint: 0, exposure: 0.5 });
    state = editSession(state, { type: 'undo' });
    state = editSession(state, { type: 'temperatureReset' });
    expect(state.recipe.adjustments).toMatchObject({ temperature: 0, tint: -30, exposure: 0.5 });
    state = editSession(state, { type: 'undo' });
    state = editSession(state, { type: 'whiteBalanceReset' });
    expect(state.recipe.adjustments).toMatchObject({ temperature: 0, tint: 0, exposure: 0.5 });
    expect(state.recipe.whiteBalanceEnabled).toBe(false);
    expect(state.history.at(-1)?.kind).toBe('whiteBalanceReset');
  });
  it('Basic Reset preserves Temperature/Tint and both flags; All Reset restores all defaults in one operation', () => {
    let state = newSession();
    state.recipe = { ...recipe(-50, 0.5), whiteBalanceEnabled: false, basicEnabled: false };
    state.recipe.adjustments.tint = 60;
    const before = state.recipe;
    state = editSession(state, { type: 'basicReset' });
    expect(state.recipe.adjustments).toMatchObject({ temperature: -50, tint: 60, exposure: 0 });
    expect(state.recipe.whiteBalanceEnabled).toBe(false);
    expect(state.recipe.basicEnabled).toBe(false);
    state = editSession(state, { type: 'undo' });
    expect(state.recipe).toEqual(before);
    state = editSession(state, { type: 'allReset' });
    expect(state.recipe).toEqual(defaultRecipe());
    expect(state.history.map(e => e.kind)).toEqual(['allReset']);
    expect(editSession(state, { type: 'undo' }).recipe).toEqual(before);
  });
  it('reapplies retained Temperature/Tint after ON and skips no-op reset history', () => {
    let state = editSession(newSession(), { type: 'temperature', value: 50 });
    state = editSession(state, { type: 'tint', value: -40 });
    state = editSession(state, { type: 'toggleWhiteBalance' });
    expect(state.recipe.adjustments.temperature).toBe(50);
    expect(renderAdjustments(pixels, state.recipe)).toEqual(pixels);
    state = editSession(state, { type: 'toggleWhiteBalance' });
    const enabled = defaultRecipe();
    Object.assign(enabled.adjustments, { temperature: 50, tint: -40 });
    expect(renderAdjustments(pixels, state.recipe)).toEqual(renderAdjustments(pixels, enabled));
    const actions: EditAction[] = [{ type: 'temperatureReset' }, { type: 'tintReset' }, { type: 'whiteBalanceReset' }];
    for (const action of actions) expect(editSession(newSession(), action).history).toHaveLength(0);
  });
});
