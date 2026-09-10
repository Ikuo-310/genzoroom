import { describe, expect, it } from 'vitest';
import { editAsset, editSession, newSession, supportsEditing, type EditSession } from './editing';
import { renderAdjustments } from './exposurePipeline';
import { sliderSteps, undoShortcut } from './editShortcuts';

const adjust = (state: EditSession, value: number) => editSession(editSession(state, { type: 'exposure', value }), { type: 'commit' });
describe('non-destructive edit sessions', () => {
  it('starts with a serializable versioned zero recipe', () => {
    expect(JSON.parse(JSON.stringify(newSession().recipe))).toEqual({ version: 1, adjustments: { exposure: 0 } });
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
    expect(adjust(state, 0.3).history).toHaveLength(1);
  });
  it.each(['exposureReset', 'allReset'] as const)('%s is distinct and undoable', (type) => {
    const state = editSession(adjust(newSession(), 0.35), { type });
    expect(state.recipe.adjustments.exposure).toBe(0);
    expect(state.history[1].kind).toBe(type);
    const undone = editSession(state, { type: 'undo' });
    expect(undone.recipe.adjustments.exposure).toBe(0.35);
    expect(editSession(undone, { type: 'redo' }).recipe.adjustments.exposure).toBe(0);
  });
  it('commits pending edits before undo and discards redo only on a new committed edit', () => {
    const pending = editSession(newSession(), { type: 'exposure', value: 1 });
    const undone = editSession(pending, { type: 'undo' });
    expect(undone.recipe.adjustments.exposure).toBe(0);
    expect(undone.history).toHaveLength(1);
    expect(adjust(undone, 0).history).toHaveLength(1);
    const branch = adjust(undone, -0.5);
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
    expect(adjust(newSession(), 100).recipe.adjustments.exposure).toBe(5);
    expect(adjust(newSession(), -100).recipe.adjustments.exposure).toBe(-5);
    for (const format of ['DNG', 'HEIC', 'PNG']) expect(supportsEditing({ id: 'a', filename: 'a', date: '', thumbnail_url: '', format, is_raw: false })).toBe(false);
  });
});

describe('linear-light Exposure pipeline', () => {
  it('preserves the source, alpha and identity exactly', () => {
    const source = new Uint8ClampedArray([0, 128, 255, 73]);
    expect(renderAdjustments(source, newSession().recipe)).toEqual(source);
    const result = renderAdjustments(source, adjust(newSession(), 1).recipe);
    expect(Array.from(result)).toEqual([0, 176, 255, 73]);
    expect(Array.from(source)).toEqual([0, 128, 255, 73]);
  });
  it('renders from source without cumulative clipping or rounding', () => {
    const source = new Uint8ClampedArray([128, 64, 255, 255]);
    renderAdjustments(source, adjust(newSession(), 5).recipe);
    expect(Array.from(renderAdjustments(source, adjust(newSession(), -1).recipe))).toEqual([92, 44, 188, 255]);
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
