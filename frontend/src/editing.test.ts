import { describe, expect, it } from 'vitest';
import { editAsset, editSession, newSession, supportsEditing, type EditSession } from './editing';
import { renderAdjustments } from './exposurePipeline';
import { sliderSteps, undoShortcut } from './editShortcuts';

const adjustExposure = (state: EditSession, value: number) => editSession(editSession(state, { type: 'exposure', value }), { type: 'commit' });
const adjustContrast = (state: EditSession, value: number) => editSession(editSession(state, { type: 'contrast', value }), { type: 'commit' });
const adjustHighlights = (state: EditSession, value: number) => editSession(editSession(state, { type: 'highlights', value }), { type: 'commit' });
const adjustWhites = (state: EditSession, value: number) => editSession(editSession(state, { type: 'whites', value }), { type: 'commit' });
const adjustShadows = (state: EditSession, value: number) => editSession(editSession(state, { type: 'shadows', value }), { type: 'commit' });
describe('non-destructive edit sessions', () => {
  it('starts with a serializable versioned zero recipe', () => {
    expect(JSON.parse(JSON.stringify(newSession().recipe))).toEqual({ version: 4, adjustments: { exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0 } });
  });
  it('coalesces intermediate input and skips no-op gestures', () => {
    let state = newSession();
    for (const value of [0, 0.01, 0.02, 0.15, 0.30]) state = editSession(state, { type: 'exposure', value });
    expect(state.history).toHaveLength(0);
    expect(state.recipe.adjustments.exposure).toBe(0.3);
    state = editSession(state, { type: 'commit' });
    expect(state.history).toHaveLength(1);
    expect(state.history[0].before.adjustments.exposure).toBe(0);
    expect(state.history[0].after.adjustments.exposure).toBe(0.3);
    expect(adjustExposure(state, 0.3).history).toHaveLength(1);
  });
  it.each([
    ['exposureReset', 'exposure', 0.35],
    ['contrastReset', 'contrast', 35],
    ['highlightsReset', 'highlights', -45],
    ['whitesReset', 'whites', -60],
    ['shadowsReset', 'shadows', 55],
  ] as const)('%s is distinct and undoable', (type, adjustment, value) => {
    const adjusted = adjustment === 'exposure' ? adjustExposure(newSession(), value)
      : adjustment === 'contrast' ? adjustContrast(newSession(), value)
        : adjustment === 'highlights' ? adjustHighlights(newSession(), value)
          : adjustment === 'whites' ? adjustWhites(newSession(), value) : adjustShadows(newSession(), value);
    const state = editSession(adjusted, { type });
    expect(state.recipe.adjustments[adjustment]).toBe(0);
    expect(state.history[1].kind).toBe(type);
    const undone = editSession(state, { type: 'undo' });
    expect(undone.recipe.adjustments[adjustment]).toBe(value);
    expect(editSession(undone, { type: 'redo' }).recipe.adjustments[adjustment]).toBe(0);
  });
  it('resets all adjustments as one undoable All Reset operation', () => {
    let state = adjustExposure(newSession(), 0.35);
    state = adjustContrast(state, 40);
    state = adjustHighlights(state, -55);
    state = adjustWhites(state, 45);
    state = adjustShadows(state, 65);
    state = editSession(state, { type: 'allReset' });
    expect(state.recipe.adjustments).toEqual({ exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0 });
    expect(state.history.at(-1)?.kind).toBe('allReset');
    const undone = editSession(state, { type: 'undo' });
    expect(undone.recipe.adjustments).toEqual({ exposure: 0.35, contrast: 40, highlights: -55, whites: 45, shadows: 65 });
    expect(editSession(undone, { type: 'redo' }).recipe.adjustments).toEqual({ exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0 });
  });
  it('commits pending edits before undo and discards redo only on a new committed edit', () => {
    const pending = editSession(newSession(), { type: 'exposure', value: 1 });
    const undone = editSession(pending, { type: 'undo' });
    expect(undone.recipe.adjustments.exposure).toBe(0);
    expect(undone.history).toHaveLength(1);
    expect(adjustExposure(undone, 0).history).toHaveLength(1);
    const branch = adjustExposure(undone, -0.5);
    expect(branch.history).toHaveLength(1);
    expect(editSession(branch, { type: 'redo' })).toEqual(branch);
  });
  it('isolates recipes and histories by asset ID', () => {
    let sessions = editAsset({}, 'a', { type: 'exposure', value: 0.3 });
    sessions = editAsset(sessions, 'a', { type: 'commit' });
    sessions = editAsset(sessions, 'b', { type: 'exposure', value: -0.7 });
    sessions = editAsset(sessions, 'b', { type: 'undo' });
    expect(sessions.a.recipe.adjustments.exposure).toBe(0.3);
    expect(sessions.a.history).toHaveLength(1);
    expect(sessions.b.recipe.adjustments.exposure).toBe(0);
  });
  it('clamps exposure and excludes non-JPEG assets', () => {
    expect(adjustExposure(newSession(), 100).recipe.adjustments.exposure).toBe(5);
    expect(adjustExposure(newSession(), -100).recipe.adjustments.exposure).toBe(-5);
    for (const format of ['DNG', 'HEIC', 'PNG']) expect(supportsEditing({ id: 'a', filename: 'a', date: '', thumbnail_url: '', format, is_raw: false })).toBe(false);
  });
  it('clamps tonal controls and keeps alternating adjustment history ordered', () => {
    let state = adjustExposure(newSession(), 0.5);
    state = adjustContrast(state, 150);
    state = adjustHighlights(state, -150);
    state = adjustWhites(state, -80);
    state = adjustShadows(state, 150);
    state = adjustExposure(state, -0.25);
    expect(state.recipe.adjustments).toEqual({ exposure: -0.25, contrast: 100, highlights: -100, whites: -80, shadows: 100 });
    expect(state.history.map((entry) => entry.kind)).toEqual(['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'exposure']);
    state = editSession(state, { type: 'undo' });
    expect(state.recipe.adjustments).toEqual({ exposure: 0.5, contrast: 100, highlights: -100, whites: -80, shadows: 100 });
    state = editSession(state, { type: 'undo' });
    expect(state.recipe.adjustments).toEqual({ exposure: 0.5, contrast: 100, highlights: -100, whites: -80, shadows: 0 });
    expect(editSession(state, { type: 'redo' }).recipe.adjustments).toEqual({ exposure: 0.5, contrast: 100, highlights: -100, whites: -80, shadows: 100 });
    expect(adjustContrast(newSession(), -150).recipe.adjustments.contrast).toBe(-100);
    expect(adjustHighlights(newSession(), 150).recipe.adjustments.highlights).toBe(100);
    expect(adjustHighlights(newSession(), Number.NaN).recipe.adjustments.highlights).toBe(0);
    expect(adjustHighlights(newSession(), Number.NEGATIVE_INFINITY).recipe.adjustments.highlights).toBe(0);
    expect(adjustWhites(newSession(), 150).recipe.adjustments.whites).toBe(100);
    expect(adjustWhites(newSession(), Number.NaN).recipe.adjustments.whites).toBe(0);
    expect(adjustShadows(newSession(), -150).recipe.adjustments.shadows).toBe(-100);
    expect(adjustShadows(newSession(), Number.POSITIVE_INFINITY).recipe.adjustments.shadows).toBe(0);
  });
  it('commits a pending control before another begins and ignores stale control commits', () => {
    let state = editSession(newSession(), { type: 'exposure', value: 0.2 });
    state = editSession(state, { type: 'begin', kind: 'contrast' });
    expect(state.history.map((entry) => entry.kind)).toEqual(['exposure']);
    expect(state.pending?.kind).toBe('contrast');
    state = editSession(state, { type: 'contrast', value: 25 });
    state = editSession(state, { type: 'commit', kind: 'exposure' });
    expect(state.pending?.kind).toBe('contrast');
    state = editSession(state, { type: 'commit', kind: 'contrast' });
    expect(state.history.map((entry) => entry.kind)).toEqual(['exposure', 'contrast']);
  });
});

describe('JPEG adjustment pipeline', () => {
  it('preserves the source, alpha and identity exactly', () => {
    const source = new Uint8ClampedArray([0, 128, 255, 73]);
    expect(renderAdjustments(source, newSession().recipe)).toEqual(source);
    const result = renderAdjustments(source, adjustExposure(newSession(), 1).recipe);
    expect(Array.from(result)).toEqual([0, 176, 255, 73]);
    expect(Array.from(source)).toEqual([0, 128, 255, 73]);
  });
  it('renders from source without cumulative clipping or rounding', () => {
    const source = new Uint8ClampedArray([128, 64, 255, 255]);
    renderAdjustments(source, adjustExposure(newSession(), 5).recipe);
    expect(Array.from(renderAdjustments(source, adjustExposure(newSession(), -1).recipe))).toEqual([92, 44, 188, 255]);
  });
  it('increases and decreases Contrast around the sRGB midpoint', () => {
    const source = new Uint8ClampedArray([64, 128, 192, 91]);
    const positive = renderAdjustments(source, adjustContrast(newSession(), 50).recipe);
    const negative = renderAdjustments(source, adjustContrast(newSession(), -50).recipe);
    expect(Array.from(positive)).toEqual([32, 128, 224, 91]);
    expect(Array.from(negative)).toEqual([96, 128, 160, 91]);
    expect(Array.from(source)).toEqual([64, 128, 192, 91]);
  });
  it('keeps Contrast boundaries finite and applies Exposure before Contrast', () => {
    const source = new Uint8ClampedArray([0, 128, 255, 255]);
    expect(Array.from(renderAdjustments(source, adjustContrast(newSession(), -100).recipe))).toEqual([128, 128, 128, 255]);
    expect(Array.from(renderAdjustments(source, adjustContrast(newSession(), 100).recipe))).toEqual([0, 129, 255, 255]);
    let combined = adjustExposure(newSession(), 1);
    combined = adjustContrast(combined, 100);
    expect(Array.from(renderAdjustments(new Uint8ClampedArray([128, 128, 128, 255]), combined.recipe))).toEqual([224, 224, 224, 255]);
  });
  it('applies Highlights smoothly to bright pixels while leaving dark pixels unchanged', () => {
    const source = new Uint8ClampedArray([32, 32, 32, 61, 204, 153, 102, 79]);
    const positive = renderAdjustments(source, adjustHighlights(newSession(), 100).recipe);
    const negative = renderAdjustments(source, adjustHighlights(newSession(), -100).recipe);
    expect(Array.from(positive.slice(0, 4))).toEqual([32, 32, 32, 61]);
    expect(Array.from(negative.slice(0, 4))).toEqual([32, 32, 32, 61]);
    expect(positive[4]).toBeGreaterThan(source[4]);
    expect(positive[5]).toBeGreaterThan(source[5]);
    expect(negative[4]).toBeLessThan(source[4]);
    expect(negative[5]).toBeLessThan(source[5]);
    expect(positive[7]).toBe(79);
    expect(negative[7]).toBe(79);
  });
  it('keeps Highlights finite at boundaries and preserves RGB proportions before clipping', () => {
    const source = new Uint8ClampedArray([180, 150, 120, 255]);
    const positive = renderAdjustments(source, adjustHighlights(newSession(), 100).recipe);
    const negative = renderAdjustments(source, adjustHighlights(newSession(), -100).recipe);
    for (const result of [positive, negative]) {
      expect(Array.from(result).every(Number.isFinite)).toBe(true);
      expect(result[0] / result[1]).toBeCloseTo(source[0] / source[1], 1);
      expect(result[1] / result[2]).toBeCloseTo(source[1] / source[2], 1);
    }
  });
  it('applies Highlights after Exposure and Contrast from the untouched source', () => {
    const source = new Uint8ClampedArray([140, 170, 200, 123]);
    let combined = adjustExposure(newSession(), 0.5);
    combined = adjustContrast(combined, 20);
    combined = adjustHighlights(combined, -60);
    let exposureContrast = adjustExposure(newSession(), 0.5);
    exposureContrast = adjustContrast(exposureContrast, 20);
    const afterExposureContrast = renderAdjustments(source, exposureContrast.recipe);
    const sequential = renderAdjustments(afterExposureContrast, adjustHighlights(newSession(), -60).recipe);
    expect(renderAdjustments(source, combined.recipe)).toEqual(sequential);
    expect(Array.from(source)).toEqual([140, 170, 200, 123]);
  });
  it('applies Whites to the brightest tones while leaving midtones and dark tones unchanged', () => {
    const source = new Uint8ClampedArray([64, 64, 64, 41, 170, 170, 170, 59, 230, 230, 230, 79]);
    const positive = renderAdjustments(source, adjustWhites(newSession(), 100).recipe);
    const negative = renderAdjustments(source, adjustWhites(newSession(), -100).recipe);
    expect(Array.from(positive.slice(0, 8))).toEqual(Array.from(source.slice(0, 8)));
    expect(Array.from(negative.slice(0, 8))).toEqual(Array.from(source.slice(0, 8)));
    expect(positive[8]).toBeGreaterThan(source[8]);
    expect(negative[8]).toBeLessThan(source[8]);
    expect(positive[11]).toBe(79);
    expect(negative[11]).toBe(79);
  });
  it('keeps the Whites threshold continuous and handles white without invalid values', () => {
    const source = new Uint8ClampedArray([4, 243, 230, 91, 255, 255, 255, 107]);
    const positive = renderAdjustments(source, adjustWhites(newSession(), 100).recipe);
    const negative = renderAdjustments(source, adjustWhites(newSession(), -100).recipe);
    expect(Array.from(positive.slice(0, 4))).toEqual([4, 243, 230, 91]);
    expect(Array.from(negative.slice(0, 4))).toEqual([4, 243, 230, 91]);
    expect(Array.from(positive.slice(4))).toEqual([255, 255, 255, 107]);
    expect(Array.from(negative.slice(4))).toEqual([191, 191, 191, 107]);
    expect(Array.from(positive).every(Number.isFinite)).toBe(true);
    expect(Array.from(negative).every(Number.isFinite)).toBe(true);
  });
  it('applies all adjustments in pipeline order from the untouched source', () => {
    const source = new Uint8ClampedArray([190, 210, 230, 123, 20, 30, 40, 87]);
    let combined = adjustExposure(newSession(), -0.25);
    combined = adjustContrast(combined, 15);
    combined = adjustHighlights(combined, 30);
    combined = adjustWhites(combined, -40);
    combined = adjustShadows(combined, 70);
    let exposureContrast = adjustExposure(newSession(), -0.25);
    exposureContrast = adjustContrast(exposureContrast, 15);
    const stages = [
      exposureContrast,
      adjustHighlights(newSession(), 30),
      adjustWhites(newSession(), -40),
      adjustShadows(newSession(), 70),
    ];
    const sequential = stages.reduce((pixels, stage) => renderAdjustments(pixels, stage.recipe), source);
    expect(renderAdjustments(source, combined.recipe)).toEqual(sequential);
    expect(Array.from(source)).toEqual([190, 210, 230, 123, 20, 30, 40, 87]);
  });
  it('applies Shadows to dark pixels while leaving bright pixels unchanged', () => {
    const source = new Uint8ClampedArray([40, 32, 24, 67, 210, 220, 230, 83]);
    const positive = renderAdjustments(source, adjustShadows(newSession(), 100).recipe);
    const negative = renderAdjustments(source, adjustShadows(newSession(), -100).recipe);
    expect(positive[0]).toBeGreaterThan(source[0]);
    expect(positive[1]).toBeGreaterThan(source[1]);
    expect(negative[0]).toBeLessThan(source[0]);
    expect(negative[1]).toBeLessThan(source[1]);
    expect(Array.from(positive.slice(4))).toEqual([210, 220, 230, 83]);
    expect(Array.from(negative.slice(4))).toEqual([210, 220, 230, 83]);
    expect(positive[3]).toBe(67);
    expect(negative[3]).toBe(67);
  });
  it('limits Shadows to luminance below 0.15 with a smooth dark-region transition', () => {
    const source = new Uint8ClampedArray([
      25, 25, 25, 255,
      15, 36, 129, 255,
      115, 115, 115, 255,
    ]);
    const positive = renderAdjustments(source, adjustShadows(newSession(), 100).recipe);
    const negative = renderAdjustments(source, adjustShadows(newSession(), -100).recipe);
    expect(positive[0]).toBeGreaterThan(source[0]);
    expect(negative[0]).toBeLessThan(source[0]);
    expect(Array.from(positive.slice(4))).toEqual(Array.from(source.slice(4)));
    expect(Array.from(negative.slice(4))).toEqual(Array.from(source.slice(4)));
  });
  it('keeps Shadows finite at black and preserves RGB proportions before clipping', () => {
    const source = new Uint8ClampedArray([0, 0, 0, 51, 80, 60, 40, 255]);
    const positive = renderAdjustments(source, adjustShadows(newSession(), 100).recipe);
    const negative = renderAdjustments(source, adjustShadows(newSession(), -100).recipe);
    expect(Array.from(positive.slice(0, 4))).toEqual([0, 0, 0, 51]);
    expect(Array.from(negative.slice(0, 4))).toEqual([0, 0, 0, 51]);
    for (const result of [positive, negative]) {
      expect(Array.from(result).every(Number.isFinite)).toBe(true);
      expect(result[4] / result[5]).toBeCloseTo(source[4] / source[5], 1);
      expect(result[5] / result[6]).toBeCloseTo(source[5] / source[6], 1);
    }
  });
  it('applies Shadows after Exposure, Contrast, and Highlights from the untouched source', () => {
    const source = new Uint8ClampedArray([35, 55, 75, 117]);
    let combined = adjustExposure(newSession(), -0.25);
    combined = adjustContrast(combined, 15);
    combined = adjustHighlights(combined, 30);
    combined = adjustShadows(combined, 70);
    let throughHighlights = adjustExposure(newSession(), -0.25);
    throughHighlights = adjustContrast(throughHighlights, 15);
    throughHighlights = adjustHighlights(throughHighlights, 30);
    const beforeShadows = renderAdjustments(source, throughHighlights.recipe);
    const sequential = renderAdjustments(beforeShadows, adjustShadows(newSession(), 70).recipe);
    expect(renderAdjustments(source, combined.recipe)).toEqual(sequential);
    expect(Array.from(source)).toEqual([35, 55, 75, 117]);
  });
});

describe('edit key mapping', () => {
  it.each([['ArrowLeft', -1], ['ArrowRight', 1], ['ArrowUp', 10], ['ArrowDown', -10]] as const)('%s = %s steps', (key, steps) => expect(sliderSteps(key)).toBe(steps));
  it.each([['z', false, 'undo'], ['z', true, 'redo'], ['y', false, 'redo']] as const)('Ctrl+%s shift=%s', (key, shiftKey, result) => {
    expect(undoShortcut({ key, shiftKey, ctrlKey: true, metaKey: false, altKey: false, isComposing: false })).toBe(result);
    expect(undoShortcut({ key, shiftKey, ctrlKey: false, metaKey: true, altKey: false, isComposing: false })).toBe(result);
  });
  it('ignores IME and unrelated keys', () => {
    expect(undoShortcut({ key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: true })).toBeNull();
    expect(sliderSteps('a')).toBeUndefined();
  });
});
