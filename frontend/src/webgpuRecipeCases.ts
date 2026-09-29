import { ADJUSTMENT_IDS, defaultRecipe, type EditRecipe } from './editing';

export function gpuRecipeCases() {
  const cases: Array<{ name: string; recipe: EditRecipe }> = [];
  const add = (name: string, adjustments: Partial<EditRecipe['adjustments']> = {}) => {
    const recipe = defaultRecipe(); Object.assign(recipe.adjustments, adjustments);
    cases.push({ name, recipe }); return recipe;
  };
  add('All adjustments at defaults');
  const all = {
    temperature: -25, tint: 15, exposure: 0.5, contrast: 20, highlights: -30, whites: 25, shadows: 40,
    blacks: -20, shadowsTemperature: 60, shadowsTint: -45, midtonesTemperature: -70,
    midtonesTint: 65, highlightsTemperature: 80, highlightsTint: -90, vibrance: 25, saturation: 15,
  };
  const off = add('All adjustments disabled', all);
  for (const id of ADJUSTMENT_IDS) off.adjustmentEnabled[id] = false;
  for (const exposure of [0, 1, -1, 2]) add(`G1 Exposure ${exposure} EV`, { exposure });
  for (const id of ADJUSTMENT_IDS) {
    for (const value of id === 'exposure' ? [-5, -0.5, 0.5, 5] : [-100, -35, 35, 100]) {
      add(`${id} ${value}`, { [id]: value });
    }
    add(`${id} OFF (other adjustments enabled)`, all).adjustmentEnabled[id] = false;
  }
  for (const key of ['whiteBalanceEnabled', 'basicEnabled', 'colorGradingEnabled', 'colorEnabled',
    'gradingShadowsEnabled', 'gradingMidtonesEnabled', 'gradingHighlightsEnabled'] as const) {
    add(`${key} OFF`, all)[key] = false;
  }
  add('Temperature → Tint → Exposure/Contrast', { temperature: -70, tint: 65, exposure: 0.5, contrast: 30 });
  add('Highlights → Whites → Shadows → Blacks', { highlights: -50, whites: 75, shadows: 65, blacks: -20 });
  add('All 3WAY ranges', { shadowsTemperature: -100, shadowsTint: 100, midtonesTemperature: 100,
    midtonesTint: -100, highlightsTemperature: -100, highlightsTint: 100 });
  add('Vibrance → Saturation', { vibrance: 75, saturation: -40 });
  add('All sixteen adjustments', all);
  // Prefix cases isolate the first stage at which a combined Recipe starts differing.
  const prefix: Partial<EditRecipe['adjustments']> = {};
  for (const id of ['temperature', 'tint', 'exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks',
    'shadowsTemperature', 'shadowsTint', 'midtonesTemperature', 'midtonesTint', 'highlightsTemperature',
    'highlightsTint', 'vibrance', 'saturation'] as const) {
    prefix[id] = all[id];
    add(`Stage prefix through ${id}`, prefix);
  }
  return cases;
}

export function gpuComparisonPixels() {
  // 512 pixels: all grayscale levels, mixed colors, transfer/weight boundaries, and every alpha byte.
  const pixels = new Uint8ClampedArray(512 * 4);
  for (let i = 0; i < 256; i++) {
    pixels.set([i, i, i, i], i * 4);
    pixels.set([i, (i * 73) & 255, 255 - i, 255 - i], (256 + i) * 4);
  }
  pixels.set([255, 0, 0, 64, 0, 255, 0, 128, 0, 0, 255, 192], 256 * 4);
  return pixels;
}
