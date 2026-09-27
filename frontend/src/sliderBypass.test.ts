import { describe, expect, it } from 'vitest';
import { ADJUSTMENT_IDS, BASIC_ADJUSTMENT_KEYS, COLOR_ADJUSTMENT_KEYS, COLOR_GRADING_ADJUSTMENT_KEYS,
  WHITE_BALANCE_ADJUSTMENT_KEYS, defaultRecipe, editSession, effectiveAdjustments, newSession } from './editing';
import { compactEditSession, createEditStateSnapshot, restoreEditSession, validateEditStateSnapshot } from './editState';
import { copyEditSettings, readEditClipboard } from './editClipboard';
import { renderAdjustments } from './adjustmentPipeline';
import { handleAdjustmentWorkerMessage } from './adjustmentWorkerRuntime';

const source = { provider: 'immich', assetId: 'asset', inputKind: 'immich-preview' } as const;
const pixels = new Uint8ClampedArray([45, 90, 135, 255, 190, 150, 100, 255]);
function snapshot(session = newSession()) {
  const result = createEditStateSnapshot(session, source);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
function legacySnapshot(includePaste = true) {
  let session = newSession();
  for (const id of ADJUSTMENT_IDS) {
    session = editSession(session, { type: id, value: id === 'exposure' ? 0.8 : 15 });
    session = editSession(session, { type: 'commit' });
  }
  session = editSession(session, { type: 'toggleBasic' });
  session = editSession(session, { type: 'toggleGradingShadows' });
  if (includePaste) session = editSession(session, { type: 'paste', values: { tint: 22, exposure: 1.2 }, sourceAssetId: 'source', sourceFilename: 'source.jpg' });
  session = editSession(session, { type: 'jumpToHistory', cursor: 8 });
  const current = snapshot(session);
  const oldRecipe = (recipe: typeof current.currentRecipe) => {
    const { adjustmentEnabled: _flags, ...rest } = recipe;
    return { ...rest, version: 17 as const };
  };
  return { ...current, recipeVersion: 17 as const, currentRecipe: oldRecipe(current.currentRecipe),
    history: current.history.map((entry) => ({ ...entry, before: oldRecipe(entry.before), after: oldRecipe(entry.after) })) };
}
// Independent reference to the v17 effective-value rules, before per-item flags existed.
function legacyEffective(recipe: ReturnType<typeof legacySnapshot>['currentRecipe']) {
  const values = { ...recipe.adjustments };
  for (const [enabled, ids] of [
    [recipe.whiteBalanceEnabled, WHITE_BALANCE_ADJUSTMENT_KEYS], [recipe.basicEnabled, BASIC_ADJUSTMENT_KEYS],
    [recipe.colorEnabled, COLOR_ADJUSTMENT_KEYS], [recipe.colorGradingEnabled, COLOR_GRADING_ADJUSTMENT_KEYS],
    [recipe.gradingShadowsEnabled, ['shadowsTemperature', 'shadowsTint'] as const],
    [recipe.gradingMidtonesEnabled, ['midtonesTemperature', 'midtonesTint'] as const],
    [recipe.gradingHighlightsEnabled, ['highlightsTemperature', 'highlightsTint'] as const],
  ] as const) if (!enabled) for (const id of ids) values[id] = 0;
  return values;
}

describe('individual adjustment bypass', () => {
  it('starts with exactly sixteen enabled flags', () => {
    expect(Object.keys(defaultRecipe().adjustmentEnabled)).toEqual([...ADJUSTMENT_IDS]);
    expect(Object.values(defaultRecipe().adjustmentEnabled)).toEqual(Array(16).fill(true));
  });

  it.each(ADJUSTMENT_IDS)('%s retains values, bypasses only itself, and supports Undo/Redo', (id) => {
    const recipe = defaultRecipe();
    for (const key of ADJUSTMENT_IDS) recipe.adjustments[key] = key === 'exposure' ? 1 : 20;
    const initial = { ...newSession(), recipe };
    const off = editSession(initial, { type: 'toggleAdjustment', id });
    expect(off.history).toHaveLength(1);
    expect(off.history[0].kind).toBe(`${id}Toggle`);
    expect(off.recipe.adjustments).toEqual(recipe.adjustments);
    expect(effectiveAdjustments(off.recipe)).toEqual({ ...recipe.adjustments, [id]: 0 });
    const expected = { ...recipe, adjustments: { ...recipe.adjustments, [id]: 0 } };
    expect(renderAdjustments(pixels, off.recipe)).toEqual(renderAdjustments(pixels, expected));
    expect(editSession(off, { type: 'undo' }).recipe).toEqual(recipe);
    expect(editSession(editSession(off, { type: 'undo' }), { type: 'redo' }).recipe).toEqual(off.recipe);
    expect(editSession(off, { type: 'toggleAdjustment', id }).recipe).toEqual(recipe);
    expect(validateEditStateSnapshot(snapshot(off)).ok).toBe(true);
    const reset = editSession(off, { type: `${id}Reset` });
    expect(reset.recipe.adjustments[id]).toBe(0);
    expect(reset.recipe.adjustmentEnabled[id]).toBe(false);
    const changed = editSession(off, { type: id, value: id === 'exposure' ? 2 : 30 });
    expect(changed.recipe.adjustmentEnabled[id]).toBe(false);
    expect(effectiveAdjustments(changed.recipe)[id]).toBe(0);
  });

  it.each([
    ['temperature', 'toggleWhiteBalance', 'whiteBalanceReset'], ['exposure', 'toggleBasic', 'basicReset'],
    ['vibrance', 'toggleColor', 'colorReset'], ['shadowsTint', 'toggleColorGrading', 'colorGradingReset'],
  ] as const)('combines %s with category bypass and preserves individual flags on category reset', (id, toggle, reset) => {
    let session = editSession(newSession(), { type: id, value: 2 });
    session = editSession(session, { type: 'toggleAdjustment', id });
    const categoryOff = editSession(session, { type: toggle });
    const categoryOn = editSession(categoryOff, { type: toggle });
    expect(categoryOn.recipe.adjustmentEnabled[id]).toBe(false);
    expect(categoryOn.recipe.adjustments[id]).toBe(2);
    expect(effectiveAdjustments(categoryOn.recipe)[id]).toBe(0);
    expect(editSession(categoryOff, { type: reset }).recipe.adjustmentEnabled).toEqual(categoryOff.recipe.adjustmentEnabled);
    expect(editSession(categoryOff, { type: 'allReset' }).recipe).toEqual(defaultRecipe());
  });

  it.each([
    ['shadowsTemperature', 'shadowsTint', 'toggleGradingShadows'],
    ['midtonesTemperature', 'midtonesTint', 'toggleGradingMidtones'],
    ['highlightsTemperature', 'highlightsTint', 'toggleGradingHighlights'],
  ] as const)('combines range bypass with %s and %s independently', (temperature, tint, toggle) => {
    let session = newSession();
    session = editSession(session, { type: temperature, value: 20 });
    session = editSession(session, { type: tint, value: 30 });
    session = editSession(session, { type: 'toggleAdjustment', id: tint });
    const off = editSession(session, { type: toggle });
    expect(effectiveAdjustments(off.recipe)).toMatchObject({ [temperature]: 0, [tint]: 0 });
    const on = editSession(off, { type: toggle });
    expect(effectiveAdjustments(on.recipe)).toMatchObject({ [temperature]: 20, [tint]: 0 });
  });

  it('keeps pending edits, cursor jumps, partial deletion and separate toggle targets consistent', () => {
    let session = editSession(newSession(), { type: 'exposure', value: 1 });
    session = editSession(session, { type: 'toggleAdjustment', id: 'exposure' });
    session = editSession(session, { type: 'toggleAdjustment', id: 'contrast' });
    expect(session.history.map((entry) => entry.kind)).toEqual(['exposure', 'exposureToggle', 'contrastToggle']);
    const jumped = editSession(session, { type: 'jumpToHistory', cursor: 1 });
    const compacted = compactEditSession(jumped, source);
    expect(compacted.ok).toBe(true);
    if (!compacted.ok) return;
    expect(compacted.value).toEqual(jumped);
    const trimmed = editSession(jumped, { type: 'trimHistory', cursor: 1 });
    expect(trimmed.cursor).toBe(0);
    expect(editSession(trimmed, { type: 'redo' }).recipe.adjustmentEnabled.exposure).toBe(false);
    expect(validateEditStateSnapshot(snapshot(trimmed)).ok).toBe(true);
    const paired = editSession(editSession(newSession(), { type: 'toggleAdjustment', id: 'tint' }), { type: 'toggleAdjustment', id: 'tint' });
    const compactPair = compactEditSession(paired, source);
    expect(compactPair).toMatchObject({ ok: true, value: { history: [], cursor: 0, recipe: defaultRecipe() } });
    const acrossCursor = editSession(paired, { type: 'undo' });
    const preserved = compactEditSession(acrossCursor, source);
    expect(preserved).toMatchObject({ ok: true, value: { history: acrossCursor.history, cursor: 1, recipe: acrossCursor.recipe } });
  });

  it('copies stored numbers while OFF and pastes without changing any enabled state', () => {
    const from = defaultRecipe(); from.adjustments.tint = 20; from.adjustmentEnabled.tint = false;
    copyEditSettings(from, 'source', 'source.jpg');
    const clipboard = readEditClipboard()!;
    expect(clipboard.values.tint).toBe(20);
    expect(clipboard).not.toHaveProperty('adjustmentEnabled');
    let to = editSession(newSession(), { type: 'toggleAdjustment', id: 'tint' });
    to = editSession(to, { type: 'toggleWhiteBalance' });
    const before = to.recipe;
    const pasted = editSession(to, { type: 'paste', ...clipboard });
    expect(pasted.recipe.adjustmentEnabled).toEqual(before.adjustmentEnabled);
    expect(pasted.recipe.whiteBalanceEnabled).toBe(false);
    expect(pasted.history.length).toBe(to.history.length + 1);
    expect(editSession(pasted, { type: 'undo' }).recipe).toEqual(before);
  });

  it('passes the same effective recipe to Worker rendering', () => {
    const recipe = defaultRecipe(); recipe.adjustments.exposure = 2; recipe.adjustmentEnabled.exposure = false;
    let output: Uint8ClampedArray | undefined;
    handleAdjustmentWorkerMessage({ assetGeneration: 1, source: pixels, width: 2, height: 1 },
      { type: 'render', recipe, requestId: 1, assetGeneration: 1 }, (response) => {
        if (response.type === 'result') output = new Uint8ClampedArray(response.pixelBuffer);
      });
    expect(output).toEqual(renderAdjustments(pixels, defaultRecipe()));
  });
});

describe('recipe v17 migration and v18 validation', () => {
  it.each([1, 2] as const)('migrates v17 snapshot format %s including Redo without mutating JSON or output', (stateFormatVersion) => {
    const old = { ...legacySnapshot(stateFormatVersion === 2), stateFormatVersion };
    const untouched = structuredClone(old);
    const restored = restoreEditSession(old);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(old).toEqual(untouched);
    expect(restored.value.cursor).toBe(old.historyCursor);
    expect(restored.value.history).toHaveLength(old.history.length);
    if (stateFormatVersion === 2) expect(restored.value.history.at(-1)).toMatchObject({ kind: 'paste', metadata: {
      sourceAssetId: 'source', sourceFilename: 'source.jpg', adjustmentIds: ['tint', 'exposure'],
    } });
    for (const [index, entry] of restored.value.history.entries()) {
      for (const side of ['before', 'after'] as const) {
        expect(entry[side]).toEqual({ ...old.history[index][side], version: 18, adjustmentEnabled: defaultRecipe().adjustmentEnabled });
        const legacyValues = legacyEffective(old.history[index][side]);
        expect(effectiveAdjustments(entry[side])).toEqual(legacyValues);
        expect(renderAdjustments(pixels, entry[side])).toEqual(renderAdjustments(pixels, { ...defaultRecipe(), adjustments: legacyValues }));
      }
    }
    const saved = snapshot(restored.value);
    expect(restoreEditSession(saved)).toEqual(restored);
    const redone = editSession(restored.value, { type: 'redo' });
    expect(redone.recipe.adjustments).toEqual(old.history[old.historyCursor].after.adjustments);
    const edited = editSession(redone, { type: 'toggleAdjustment', id: 'tint' });
    expect(restoreEditSession(snapshot(edited))).toMatchObject({ ok: true, value: edited });
  });

  it('rejects malformed, mixed-version, or discontinuous old data instead of repairing it', () => {
    const old = legacySnapshot();
    expect(restoreEditSession({ ...old, currentRecipe: { ...old.currentRecipe, adjustmentEnabled: {} } }).ok).toBe(false);
    const broken = structuredClone(old); broken.history.at(-1)!.before.adjustments.tint = 50;
    expect(restoreEditSession(broken).ok).toBe(false);
    const mixed = structuredClone(old); (mixed.history[0].after as { version: number }).version = 18;
    expect(restoreEditSession(mixed).ok).toBe(false);
  });

  it('strictly rejects missing/extra/nonboolean v18 flags and unrelated changes in History', () => {
    const saved = snapshot(editSession(newSession(), { type: 'toggleAdjustment', id: 'temperature' }));
    for (const flags of [undefined, {}, { ...saved.currentRecipe.adjustmentEnabled, extra: true }, { ...saved.currentRecipe.adjustmentEnabled, tint: 1 }]) {
      expect(validateEditStateSnapshot({ ...saved, currentRecipe: { ...saved.currentRecipe, adjustmentEnabled: flags } }).ok).toBe(false);
    }
    const invalid = structuredClone(saved);
    invalid.currentRecipe.adjustmentEnabled.tint = false;
    invalid.history[0].after.adjustmentEnabled.tint = false;
    expect(validateEditStateSnapshot(invalid)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_history_semantics' })]) });
  });
});
