import { describe, expect, it } from 'vitest';
import { editAsset, editSession, newSession, supportsEditing, isBasicDefault, effectiveAdjustments, type EditSession } from './editing';
import { renderAdjustments } from './adjustmentPipeline';
import { sliderSteps, undoShortcut } from './editShortcuts';

const adjustExposure = (state: EditSession, value: number) => editSession(editSession(state, { type: 'exposure', value }), { type: 'commit' });
const adjustContrast = (state: EditSession, value: number) => editSession(editSession(state, { type: 'contrast', value }), { type: 'commit' });
const adjustHighlights = (state: EditSession, value: number) => editSession(editSession(state, { type: 'highlights', value }), { type: 'commit' });
const adjustWhites = (state: EditSession, value: number) => editSession(editSession(state, { type: 'whites', value }), { type: 'commit' });
const adjustShadows = (state: EditSession, value: number) => editSession(editSession(state, { type: 'shadows', value }), { type: 'commit' });
const adjustBlacks = (state: EditSession, value: number) => editSession(editSession(state, { type: 'blacks', value }), { type: 'commit' });
describe('non-destructive edit sessions', () => {
  it('starts with a serializable versioned zero recipe', () => {
    expect(JSON.parse(JSON.stringify(newSession().recipe))).toEqual({ version: 17, whiteBalanceEnabled: true, basicEnabled: true, colorGradingEnabled: true, gradingShadowsEnabled: true, gradingMidtonesEnabled: true, gradingHighlightsEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 } });
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
    ['blacksReset', 'blacks', -50],
  ] as const)('%s is distinct and undoable', (type, adjustment, value) => {
    const adjusted = adjustment === 'exposure' ? adjustExposure(newSession(), value)
      : adjustment === 'contrast' ? adjustContrast(newSession(), value)
        : adjustment === 'highlights' ? adjustHighlights(newSession(), value)
          : adjustment === 'whites' ? adjustWhites(newSession(), value)
            : adjustment === 'shadows' ? adjustShadows(newSession(), value) : adjustBlacks(newSession(), value);
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
    state = adjustBlacks(state, -70);
    state = editSession(state, { type: 'toggleBasic' });
    state = editSession(state, { type: 'allReset' });
    expect(state.recipe.basicEnabled).toBe(true);
    expect(state.recipe.adjustments).toEqual({ temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 });
    expect(state.history.at(-1)?.kind).toBe('allReset');
    const undone = editSession(state, { type: 'undo' });
    expect(undone.recipe.basicEnabled).toBe(false);
    expect(undone.recipe.adjustments).toEqual({ temperature: 0, tint: 0, exposure: 0.35, contrast: 40, highlights: -55, whites: 45, shadows: 65, blacks: -70, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 });
    const redone = editSession(undone, { type: 'redo' });
    expect(redone.recipe.basicEnabled).toBe(true);
    expect(redone.recipe.adjustments).toEqual({ temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 });
  });
  it('toggles Basic as one undoable bypass without changing adjustment values', () => {
    let state = editSession(newSession(), { type: 'exposure', value: 0.5 });
    state = editSession(state, { type: 'toggleBasic' });
    expect(state.recipe.basicEnabled).toBe(false);
    expect(state.recipe.adjustments.exposure).toBe(0.5);
    expect(state.history.map((entry) => entry.kind)).toEqual(['exposure', 'basicToggle']);
    const undone = editSession(state, { type: 'undo' });
    expect(undone.recipe.basicEnabled).toBe(true);
    expect(undone.recipe.adjustments.exposure).toBe(0.5);
    expect(editSession(undone, { type: 'redo' }).recipe.basicEnabled).toBe(false);
  });
  it('resets all Basic values in one operation while preserving its enabled state', () => {
    let state = adjustExposure(newSession(), 0.5);
    state = adjustContrast(state, 20);
    state = adjustHighlights(state, -30);
    state = adjustWhites(state, 10);
    state = adjustShadows(state, 40);
    state = adjustBlacks(state, -15);
    state = editSession(state, { type: 'toggleBasic' });
    const beforeReset = state.recipe;
    state = editSession(state, { type: 'basicReset' });
    expect(state.recipe.basicEnabled).toBe(false);
    expect(state.recipe.adjustments).toEqual({ temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 });
    expect(state.history.at(-1)?.kind).toBe('basicReset');
    const undone = editSession(state, { type: 'undo' });
    expect(undone.recipe).toEqual(beforeReset);
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
  it('jumps to applied or redo history, keeps the branch, and restores the matching recipe', () => {
    let state = adjustExposure(newSession(), 0.5);
    state = adjustContrast(state, 20);
    state = adjustExposure(state, 1.25);
    const fullHistory = state.history;

    state = editSession(state, { type: 'jumpToHistory', cursor: 1 });
    expect(state.cursor).toBe(1);
    expect(state.recipe.adjustments.exposure).toBe(0.5);
    expect(state.history).toBe(fullHistory);
    state = editSession(state, { type: 'undo' });
    expect(state.cursor).toBe(0);
    expect(state.recipe.adjustments.exposure).toBe(0);
    state = editSession(state, { type: 'redo' });
    expect(state.cursor).toBe(1);
    state = editSession(state, { type: 'jumpToHistory', cursor: 3 });
    expect(state.cursor).toBe(3);
    expect(state.recipe.adjustments.exposure).toBe(1.25);
    expect(state.history).toEqual(fullHistory);
    expect(editSession(state, { type: 'jumpToHistory', cursor: 3 })).toBe(state);
  });
  it('jumps to Initial State and bounds cursor after committing pending work', () => {
    let state = adjustExposure(newSession(), 0.5);
    state = adjustContrast(state, 20);
    state = editSession(state, { type: 'jumpToHistory', cursor: 0 });
    expect(state.cursor).toBe(0);
    expect(state.recipe.adjustments.exposure).toBe(0);
    expect(editSession(state, { type: 'jumpToHistory', cursor: -10 }).cursor).toBe(0);
    state = editSession(state, { type: 'jumpToHistory', cursor: 100 });
    expect(state.cursor).toBe(2);

    state = editSession(state, { type: 'exposure', value: 0.75 });
    state = editSession(state, { type: 'jumpToHistory', cursor: 3 });
    expect(state.history).toHaveLength(3);
    expect(state.cursor).toBe(3);
    expect(state.recipe.adjustments.exposure).toBe(0.75);
    expect(state.pending).toBeNull();
  });
  it('jumps across compound Paste entries and a new edit after a jump drops Redo', () => {
    let state = adjustExposure(newSession(), 0.5);
    state = editSession(state, { type: 'paste', values: { exposure: 1, tint: 30 }, sourceAssetId: 'source', sourceFilename: 'source.jpg' });
    state = adjustContrast(state, 15);
    expect(state.history.map((entry) => entry.kind)).toEqual(['exposure', 'paste', 'contrast']);
    state = editSession(state, { type: 'jumpToHistory', cursor: 2 });
    expect(state.recipe.adjustments.exposure).toBe(1);
    expect(state.recipe.adjustments.tint).toBe(30);
    state = editSession(state, { type: 'jumpToHistory', cursor: 1 });
    expect(state.recipe.adjustments.tint).toBe(0);
    expect(state.history).toHaveLength(3);
    state = adjustExposure(state, -0.25);
    expect(state.history).toHaveLength(2);
    expect(state.cursor).toBe(2);
    expect(editSession(state, { type: 'redo' })).toBe(state);
  });
  it('clears applied and Redo history while preserving the current recipe and pending value', () => {
    let state = adjustExposure(newSession(), 0.5);
    state = adjustContrast(state, 20);
    state = editSession(state, { type: 'jumpToHistory', cursor: 1 });
    const currentRecipe = state.recipe;
    expect(state.history).toHaveLength(2);
    state = editSession(state, { type: 'clearHistory' });
    expect(state).toMatchObject({ recipe: currentRecipe, history: [], cursor: 0, pending: null });
    expect(editSession(state, { type: 'redo' })).toBe(state);

    const pending = editSession(newSession(), { type: 'exposure', value: 0.75 });
    const clearedPending = editSession(pending, { type: 'clearHistory' });
    expect(clearedPending.recipe.adjustments.exposure).toBe(0.75);
    expect(clearedPending).toMatchObject({ history: [], cursor: 0, pending: null });
  });
  it('resets the recipe, pending work, applied history, and Redo history without recording Reset', () => {
    let state = adjustExposure(newSession(), 0.5);
    state = adjustContrast(state, 20);
    state = editSession(state, { type: 'jumpToHistory', cursor: 1 });
    state = editSession(state, { type: 'temperature', value: 12 });
    state = editSession(state, { type: 'resetEdits' });
    expect(state).toEqual(newSession());
  });
  it('trims only applied history and leaves the current recipe and Redo operations intact', () => {
    let state = adjustExposure(newSession(), 0.5);
    state = adjustContrast(state, 20);
    state = adjustHighlights(state, -30);
    state = adjustExposure(state, 1.25);
    state = editSession(state, { type: 'jumpToHistory', cursor: 2 });
    const currentRecipe = state.recipe;
    const oldRedo = state.history.slice(2);
    state = editSession(state, { type: 'trimHistory' });
    expect(state.recipe).toEqual(currentRecipe);
    expect(state.cursor).toBe(0);
    expect(state.history).toEqual(oldRedo);
    expect(state.history[0].before).toEqual(currentRecipe);
    expect(editSession(state, { type: 'undo' })).toBe(state);
    state = editSession(state, { type: 'redo' });
    expect(state.recipe).toEqual(oldRedo[0].after);
    state = editSession(state, { type: 'redo' });
    expect(state.recipe).toEqual(oldRedo[1].after);
    expect(state.cursor).toBe(2);
  });
  it('does nothing to an empty applied branch, trims everything at latest, and keeps pending work consistent', () => {
    const start = newSession();
    expect(editSession(start, { type: 'trimHistory' })).toBe(start);

    let latest = adjustExposure(newSession(), 0.5);
    latest = adjustContrast(latest, 20);
    const latestRecipe = latest.recipe;
    latest = editSession(latest, { type: 'trimHistory' });
    expect(latest).toMatchObject({ recipe: latestRecipe, history: [], cursor: 0, pending: null });

    let pending = adjustExposure(newSession(), 0.5);
    pending = adjustContrast(pending, 20);
    pending = editSession(pending, { type: 'jumpToHistory', cursor: 1 });
    pending = editSession(pending, { type: 'temperature', value: 12 });
    const liveRecipe = pending.recipe;
    pending = editSession(pending, { type: 'trimHistory' });
    expect(pending).toMatchObject({ recipe: liveRecipe, cursor: 0, pending: { kind: 'temperature' } });
    expect(pending.history).toHaveLength(1);
    expect(pending.history[0].before).toEqual(pending.pending!.before);
    const committed = editSession(pending, { type: 'commit' });
    expect(committed.history).toHaveLength(1);
    expect(committed.history[0].after).toEqual(liveRecipe);
  });
  it('trims across a compound Paste without splitting it or changing its applied recipe', () => {
    let state = adjustExposure(newSession(), 0.5);
    state = editSession(state, { type: 'paste', values: { exposure: 1, tint: 30 }, sourceAssetId: 'source', sourceFilename: 'source.jpg' });
    state = adjustContrast(state, 15);
    state = editSession(state, { type: 'jumpToHistory', cursor: 2 });
    const recipe = state.recipe;
    state = editSession(state, { type: 'trimHistory' });
    expect(state.recipe).toEqual(recipe);
    expect(state.history).toHaveLength(1);
    expect(state.history[0].kind).toBe('contrast');
    expect(state.history[0].before).toEqual(recipe);
    expect(editSession(state, { type: 'redo' }).recipe.adjustments.contrast).toBe(15);
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
    state = adjustBlacks(state, -150);
    state = adjustExposure(state, -0.25);
    expect(state.recipe.adjustments).toEqual({ temperature: 0, tint: 0, exposure: -0.25, contrast: 100, highlights: -100, whites: -80, shadows: 100, blacks: -100, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 });
    expect(state.history.map((entry) => entry.kind)).toEqual(['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks', 'exposure']);
    state = editSession(state, { type: 'undo' });
    expect(state.recipe.adjustments).toEqual({ temperature: 0, tint: 0, exposure: 0.5, contrast: 100, highlights: -100, whites: -80, shadows: 100, blacks: -100, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 });
    state = editSession(state, { type: 'undo' });
    expect(state.recipe.adjustments).toEqual({ temperature: 0, tint: 0, exposure: 0.5, contrast: 100, highlights: -100, whites: -80, shadows: 100, blacks: 0, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 });
    expect(editSession(state, { type: 'redo' }).recipe.adjustments).toEqual({ temperature: 0, tint: 0, exposure: 0.5, contrast: 100, highlights: -100, whites: -80, shadows: 100, blacks: -100, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0 });
    expect(adjustContrast(newSession(), -150).recipe.adjustments.contrast).toBe(-100);
    expect(adjustHighlights(newSession(), 150).recipe.adjustments.highlights).toBe(100);
    expect(adjustHighlights(newSession(), Number.NaN).recipe.adjustments.highlights).toBe(0);
    expect(adjustHighlights(newSession(), Number.NEGATIVE_INFINITY).recipe.adjustments.highlights).toBe(0);
    expect(adjustWhites(newSession(), 150).recipe.adjustments.whites).toBe(100);
    expect(adjustWhites(newSession(), Number.NaN).recipe.adjustments.whites).toBe(0);
    expect(adjustShadows(newSession(), -150).recipe.adjustments.shadows).toBe(-100);
    expect(adjustShadows(newSession(), Number.POSITIVE_INFINITY).recipe.adjustments.shadows).toBe(0);
    expect(adjustBlacks(newSession(), 150).recipe.adjustments.blacks).toBe(100);
    expect(adjustBlacks(newSession(), Number.NaN).recipe.adjustments.blacks).toBe(0);
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
  it('bypasses all Basic adjustments while retaining their recipe values', () => {
    const source = new Uint8ClampedArray([40, 90, 180, 73]);
    let enabled = adjustExposure(newSession(), 1);
    enabled = adjustContrast(enabled, 30);
    enabled = adjustHighlights(enabled, -20);
    enabled = adjustWhites(enabled, 15);
    enabled = adjustShadows(enabled, 40);
    enabled = adjustBlacks(enabled, -10);
    const adjusted = renderAdjustments(source, enabled.recipe);
    const disabled = editSession(enabled, { type: 'toggleBasic' });
    expect(disabled.recipe.adjustments).toEqual(enabled.recipe.adjustments);
    expect(renderAdjustments(source, disabled.recipe)).toEqual(source);
    const restored = editSession(disabled, { type: 'toggleBasic' });
    expect(renderAdjustments(source, restored.recipe)).toEqual(adjusted);
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
    combined = adjustBlacks(combined, 60);
    let exposureContrast = adjustExposure(newSession(), -0.25);
    exposureContrast = adjustContrast(exposureContrast, 15);
    const stages = [
      exposureContrast,
      adjustHighlights(newSession(), 30),
      adjustWhites(newSession(), -40),
      adjustShadows(newSession(), 70),
      adjustBlacks(newSession(), 60),
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
  it('applies a pedestal offset across the low range and preserves alpha', () => {
    const source = new Uint8ClampedArray([
      0, 0, 0, 31,
      26, 26, 26, 47,
      51, 51, 51, 63,
      77, 77, 77, 79,
      102, 102, 102, 95,
    ]);
    const positive = renderAdjustments(source, adjustBlacks(newSession(), 100).recipe);
    const negative = renderAdjustments(source, adjustBlacks(newSession(), -100).recipe);
    expect(Array.from(positive.slice(0, 4))).toEqual([26, 26, 26, 31]);
    expect(Array.from(negative.slice(0, 4))).toEqual([0, 0, 0, 31]);
    for (const offset of [4, 8]) {
      expect(positive[offset]).toBeGreaterThan(source[offset]);
      expect(negative[offset]).toBeLessThan(source[offset]);
    }
    expect(positive[8] - source[8]).toBeGreaterThan(positive[12] - source[12]);
    expect(source[8] - negative[8]).toBeGreaterThan(source[12] - negative[12]);
    expect(Math.abs(positive[12] - source[12])).toBeLessThanOrEqual(2);
    expect(Math.abs(negative[12] - source[12])).toBeLessThanOrEqual(2);
    expect(Array.from(positive.slice(16))).toEqual(Array.from(source.slice(16)));
    expect(Array.from(negative.slice(16))).toEqual(Array.from(source.slice(16)));
  });
  it('leaves the exact 0.35 fade endpoint unchanged in both directions', () => {
    const source = new Uint8ClampedArray([1, 104, 203, 139]);
    expect(0.2126 * 1 + 0.7152 * 104 + 0.0722 * 203).toBeCloseTo(89.25, 10);
    expect(renderAdjustments(source, adjustBlacks(newSession(), 100).recipe)).toEqual(source);
    expect(renderAdjustments(source, adjustBlacks(newSession(), -100).recipe)).toEqual(source);
  });
  it('keeps Blacks finite and preserves RGB proportions for non-black pixels', () => {
    const source = new Uint8ClampedArray([72, 48, 24, 113]);
    const sourceTotal = source[0] + source[1] + source[2];
    for (const value of [100, -100]) {
      const result = renderAdjustments(source, adjustBlacks(newSession(), value).recipe);
      expect(Array.from(result).every(Number.isFinite)).toBe(true);
      const resultTotal = result[0] + result[1] + result[2];
      for (let channel = 0; channel < 3; channel++) {
        expect(result[channel] / resultTotal).toBeCloseTo(source[channel] / sourceTotal, 2);
      }
      expect(result[3]).toBe(113);
    }
  });
  it('applies Blacks after Shadows from the untouched source', () => {
    const source = new Uint8ClampedArray([8, 12, 16, 101]);
    let combined = adjustShadows(newSession(), 50);
    combined = adjustBlacks(combined, -70);
    const throughShadows = renderAdjustments(source, adjustShadows(newSession(), 50).recipe);
    const sequential = renderAdjustments(throughShadows, adjustBlacks(newSession(), -70).recipe);
    expect(renderAdjustments(source, combined.recipe)).toEqual(sequential);
    expect(Array.from(source)).toEqual([8, 12, 16, 101]);
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

// Extra fields model a future category without extending the production adjustment type.
describe('Basic scope', () => {
  it.each(['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks'] as const)('includes %s in the default check', (key) => {
    const adjustments = { ...newSession().recipe.adjustments, futureColor: 42 };
    expect(isBasicDefault(adjustments)).toBe(true);
    adjustments[key] = 1;
    expect(isBasicDefault(adjustments)).toBe(false);
  });
  it('preserves non-Basic values through reset, bypass, Undo and Redo', () => {
    const recipe = { ...newSession().recipe, adjustments: { temperature: 0, tint: 25, exposure: 0.5, contrast: 20, highlights: -30, whites: 40, shadows: 50, blacks: -60, shadowsTemperature: 0, shadowsTint: 0, midtonesTemperature: 0, midtonesTint: 0, highlightsTemperature: 0, highlightsTint: 0, vibrance: 0, saturation: 0, futureColor: 42 } };
    const state = { ...newSession(), recipe };
    const off = editSession(state, { type: 'toggleBasic' });
    const expected = { ...newSession().recipe.adjustments, tint: 25, futureColor: 42 };
    expect(off.recipe.adjustments).toEqual(recipe.adjustments);
    expect(effectiveAdjustments(off.recipe)).toEqual(expected);
    expect(effectiveAdjustments(recipe)).toBe(recipe.adjustments);
    expect(recipe.adjustments.exposure).toBe(0.5);
    const reset = editSession(off, { type: 'basicReset' });
    expect(reset.recipe.adjustments).toEqual(expected);
    expect(reset.recipe.basicEnabled).toBe(false);
    expect(isBasicDefault(reset.recipe.adjustments)).toBe(true);
    expect(editSession(reset, { type: 'undo' }).recipe).toEqual(off.recipe);
    expect(editSession(editSession(reset, { type: 'undo' }), { type: 'redo' }).recipe).toEqual(reset.recipe);
    expect(editSession(reset, { type: 'basicReset' }).history).toHaveLength(2);
  });
});
