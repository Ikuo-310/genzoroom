import { describe, expect, it } from 'vitest';
import { defaultRecipe, editSession, effectiveAdjustments, newSession } from './editing';
import { renderAdjustments } from './exposurePipeline';

const pixels = new Uint8ClampedArray([220, 80, 30, 17, 48, 150, 210, 239]);
const withSaturation = (value: number) => {
  const recipe = defaultRecipe();
  recipe.adjustments.saturation = value;
  return recipe;
};
const chroma = (data: Uint8ClampedArray) => Math.max(data[0], data[1], data[2]) - Math.min(data[0], data[1], data[2]);

describe('Saturation pixel stage', () => {
  it('keeps saturation 0 byte-identical', () => {
    expect(renderAdjustments(pixels, withSaturation(0))).toEqual(pixels);
  });

  it('makes -100 grayscale while preserving alpha', () => {
    const result = renderAdjustments(pixels, withSaturation(-100));
    expect(result[0]).toBe(result[1]);
    expect(result[1]).toBe(result[2]);
    expect(result[4]).toBe(result[5]);
    expect(result[5]).toBe(result[6]);
    expect([result[3], result[7]]).toEqual([17, 239]);
  });

  it('reduces negative and increases positive chroma', () => {
    expect(chroma(renderAdjustments(pixels, withSaturation(-50)))).toBeLessThan(chroma(pixels));
    expect(chroma(renderAdjustments(pixels, withSaturation(50)))).toBeGreaterThan(chroma(pixels));
  });

  it('keeps neutral gray neutral for every saturation value', () => {
    const gray = new Uint8ClampedArray([117, 117, 117, 91]);
    for (const value of [-100, -35, 35, 100]) {
      expect(renderAdjustments(gray, withSaturation(value))).toEqual(gray);
    }
  });

  it('clips safely at +100 for already saturated colors and preserves alpha', () => {
    const source = new Uint8ClampedArray([255, 4, 0, 77, 0, 250, 12, 199]);
    const result = renderAdjustments(source, withSaturation(100));
    expect([...result].every((value) => value >= 0 && value <= 255)).toBe(true);
    expect([result[3], result[7]]).toEqual([77, 199]);
    expect(result[0]).toBe(255);
    expect(result[2]).toBe(0);
  });

  it('runs Saturation after Blacks', () => {
    const combined = defaultRecipe();
    combined.adjustments.blacks = 80;
    combined.adjustments.saturation = 60;
    const blacksOnly = defaultRecipe();
    blacksOnly.adjustments.blacks = 80;
    const saturationOnly = withSaturation(60);
    expect(renderAdjustments(pixels, combined)).toEqual(
      renderAdjustments(renderAdjustments(pixels, blacksOnly), saturationOnly),
    );
  });
});

describe('Color category recipe and History', () => {
  it('bypasses only Saturation while retaining and reapplying its value', () => {
    const recipe = withSaturation(70);
    recipe.adjustments.exposure = 0.5;
    const enabled = renderAdjustments(pixels, recipe);
    recipe.colorEnabled = false;
    expect(recipe.adjustments.saturation).toBe(70);
    const bypassed = renderAdjustments(pixels, recipe);
    const expected = defaultRecipe();
    expected.adjustments.exposure = 0.5;
    expect(bypassed).toEqual(renderAdjustments(pixels, expected));
    recipe.colorEnabled = true;
    expect(renderAdjustments(pixels, recipe)).toEqual(enabled);
  });

  it('applies Saturation independently when Basic or White Balance is off', () => {
    const expected = renderAdjustments(pixels, withSaturation(65));
    for (const disabled of ['basicEnabled', 'whiteBalanceEnabled'] as const) {
      const recipe = withSaturation(65);
      recipe[disabled] = false;
      expect(renderAdjustments(pixels, recipe)).toEqual(expected);
    }
  });

  it('uses Color only in its effective scope', () => {
    const recipe = withSaturation(40);
    recipe.adjustments.temperature = 30;
    recipe.adjustments.exposure = 0.4;
    recipe.colorEnabled = false;
    expect(effectiveAdjustments(recipe)).toMatchObject({ temperature: 30, exposure: 0.4, saturation: 0 });
  });

  it('coalesces Saturation, commits pending before category actions, and supports Undo/Redo', () => {
    let state = newSession();
    state = editSession(state, { type: 'saturation', value: 10 });
    state = editSession(state, { type: 'saturation', value: 35 });
    expect(state.pending?.kind).toBe('saturation');
    state = editSession(state, { type: 'toggleColor' });
    expect(state.history.map((entry) => entry.kind)).toEqual(['saturation', 'colorToggle']);
    expect(state.recipe.adjustments.saturation).toBe(35);
    expect(state.recipe.colorEnabled).toBe(false);
    state = editSession(state, { type: 'undo' });
    expect(state.recipe.colorEnabled).toBe(true);
    state = editSession(state, { type: 'redo' });
    expect(state.recipe.colorEnabled).toBe(false);
  });

  it('resets Saturation and Color without changing other categories', () => {
    let state = newSession();
    Object.assign(state.recipe.adjustments, { temperature: 20, exposure: 0.5, saturation: 55 });
    state.recipe.colorEnabled = false;
    state = editSession(state, { type: 'saturationReset' });
    expect(state.recipe.adjustments).toMatchObject({ temperature: 20, exposure: 0.5, saturation: 0 });
    state = editSession(state, { type: 'undo' });
    state = editSession(state, { type: 'colorReset' });
    expect(state.recipe.adjustments).toMatchObject({ temperature: 20, exposure: 0.5, saturation: 0 });
    expect(state.recipe.colorEnabled).toBe(false);
    expect(state.history.at(-1)?.kind).toBe('colorReset');
  });

  it('preserves Saturation in White Balance and Basic Reset and resets it in All Reset', () => {
    let state = newSession();
    Object.assign(state.recipe.adjustments, { temperature: 20, exposure: 0.5, saturation: 55 });
    state = editSession(state, { type: 'whiteBalanceReset' });
    expect(state.recipe.adjustments.saturation).toBe(55);
    state = editSession(state, { type: 'basicReset' });
    expect(state.recipe.adjustments.saturation).toBe(55);
    state = editSession(state, { type: 'toggleWhiteBalance' });
    state = editSession(state, { type: 'toggleBasic' });
    state = editSession(state, { type: 'toggleColor' });
    state = editSession(state, { type: 'allReset' });
    expect(state.recipe).toEqual(defaultRecipe());
    expect(state.history.at(-1)?.kind).toBe('allReset');
  });
});
