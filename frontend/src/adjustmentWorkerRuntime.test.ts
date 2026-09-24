import { describe, expect, it } from 'vitest';
import { renderAdjustments } from './adjustmentPipeline';
import { defaultRecipe, type EditRecipe } from './editing';
import type { AdjustmentWorkerResponse } from './adjustmentWorkerProtocol';
import { handleAdjustmentWorkerMessage, type AdjustmentWorkerState } from './adjustmentWorkerRuntime';

function sourcePixels() {
  return new Uint8ClampedArray([
    0, 0, 0, 0,
    15, 36, 129, 17,
    30, 20, 10, 73,
    72, 48, 24, 139,
    127, 127, 127, 201,
    128, 129, 130, 211,
    210, 200, 190, 233,
    250, 240, 230, 255,
  ]);
}

function recipe(adjustments: Partial<EditRecipe['adjustments']> = {}) {
  const result = defaultRecipe();
  Object.assign(result.adjustments, adjustments);
  return result;
}

const cases: Array<[string, EditRecipe]> = [
  ['default', recipe()],
  ['global white balance', recipe({ temperature: 100, tint: -100 })],
  ['basic combined', recipe({ exposure: 0.75, contrast: 30, highlights: -60, whites: 45, shadows: 70, blacks: -35 })],
  ['shadows temperature', recipe({ shadowsTemperature: -100 })],
  ['shadows tint', recipe({ shadowsTint: 100 })],
  ['shadows temperature and tint', recipe({ shadowsTemperature: 100, shadowsTint: -100 })],
  ['midtones temperature', recipe({ midtonesTemperature: -100 })],
  ['midtones tint', recipe({ midtonesTint: 100 })],
  ['midtones temperature and tint', recipe({ midtonesTemperature: -100, midtonesTint: 100 })],
  ['highlights temperature', recipe({ highlightsTemperature: -100 })],
  ['highlights tint', recipe({ highlightsTint: 100 })],
  ['highlights temperature and tint', recipe({ highlightsTemperature: -100, highlightsTint: 100 })],
  ['shadows disabled', { ...recipe({ shadowsTemperature: -80, shadowsTint: 60, midtonesTint: 30 }), gradingShadowsEnabled: false }],
  ['midtones disabled', { ...recipe({ midtonesTemperature: 90, midtonesTint: -60, highlightsTint: 50 }), gradingMidtonesEnabled: false }],
  ['highlights disabled', { ...recipe({ highlightsTemperature: -90, highlightsTint: 75, midtonesTint: 40 }), gradingHighlightsEnabled: false }],
  ['parent grading disabled', { ...recipe({ shadowsTint: 60, midtonesTint: -40, highlightsTint: 80 }), colorGradingEnabled: false, gradingShadowsEnabled: false }],
  ['all categories', recipe({ temperature: -50, tint: 35, exposure: -0.4, contrast: 25, highlights: 80, whites: -55, shadows: 65, blacks: 40, shadowsTemperature: -75, shadowsTint: 90, midtonesTemperature: 100, midtonesTint: -100, highlightsTemperature: 100, highlightsTint: -100, vibrance: 60, saturation: -45 })],
];

describe('adjustment Worker runtime', () => {
  it.each(cases)('returns byte-identical transferable pixels for %s', (_name, editRecipe) => {
    const source = sourcePixels();
    const expected = renderAdjustments(source, editRecipe);
    const responses: Array<{ response: AdjustmentWorkerResponse; transfer: Transferable[] }> = [];
    let state: AdjustmentWorkerState = null;
    state = handleAdjustmentWorkerMessage(state, {
      type: 'init', assetGeneration: 7, sourceBuffer: source.slice().buffer, width: 4, height: 2,
    }, (response, transfer = []) => responses.push({ response, transfer }));
    state = handleAdjustmentWorkerMessage(state, {
      type: 'render', requestId: 42, assetGeneration: 7, recipe: editRecipe,
    }, (response, transfer = []) => responses.push({ response, transfer }));

    expect(state?.assetGeneration).toBe(7);
    expect(responses[0].response).toEqual({ type: 'ready', assetGeneration: 7 });
    const result = responses[1].response;
    expect(result.type).toBe('result');
    if (result.type !== 'result') throw new Error('Expected Worker result');
    expect(result.requestId).toBe(42);
    expect(result.assetGeneration).toBe(7);
    expect([result.width, result.height]).toEqual([4, 2]);
    expect(new Uint8ClampedArray(result.pixelBuffer)).toEqual(expected);
    expect(responses[1].transfer).toEqual([result.pixelBuffer]);
    for (let i = 3; i < expected.length; i += 4) expect(new Uint8ClampedArray(result.pixelBuffer)[i]).toBe(source[i]);
  });

  it('rejects a render for an uninitialized asset generation', () => {
    const responses: AdjustmentWorkerResponse[] = [];
    const state = handleAdjustmentWorkerMessage(null, {
      type: 'render', requestId: 9, assetGeneration: 3, recipe: recipe(),
    }, (response) => responses.push(response));
    expect(state).toBeNull();
    expect(responses).toEqual([{
      type: 'error', requestId: 9, assetGeneration: 3,
      message: 'Adjustment worker source is not initialized for this asset generation.',
    }]);
  });
});
