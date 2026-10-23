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

describe('legacy individual flags and integrated Color category', () => {
  it('keeps all sixteen v18 fields but ignores them in effective and pixel rendering', () => {
    const recipe = defaultRecipe();
    for (const key of ADJUSTMENT_IDS) recipe.adjustments[key] = key === 'exposure' ? 1 : 20;
    const expected = { ...recipe.adjustments };
    for (const id of ADJUSTMENT_IDS) recipe.adjustmentEnabled[id] = false;
    expect(Object.keys(recipe.adjustmentEnabled)).toEqual([...ADJUSTMENT_IDS]);
    expect(effectiveAdjustments(recipe)).toEqual(expected);
    expect(renderAdjustments(pixels, recipe)).toEqual(renderAdjustments(pixels, { ...defaultRecipe(), adjustments: expected }));
    expect(editSession({ ...newSession(), recipe }, { type: 'toggleAdjustment', id: 'exposure' })).toEqual({ ...newSession(), recipe });
  });

  it('toggles the four Color controls and both stored flags in one undoable operation', () => {
    let session = newSession();
    session = editSession(session, { type: 'temperature', value: 25 });
    session = editSession(session, { type: 'tint', value: -15 });
    session = editSession(session, { type: 'vibrance', value: 30 });
    session = editSession(session, { type: 'saturation', value: -20 });
    session = editSession(session, { type: 'toggleColor' });
    expect(session.history.at(-1)?.kind).toBe('colorToggle');
    expect(session.recipe.whiteBalanceEnabled).toBe(false);
    expect(session.recipe.colorEnabled).toBe(false);
    expect(effectiveAdjustments(session.recipe)).toMatchObject({ temperature: 0, tint: 0, vibrance: 0, saturation: 0 });
    expect(session.history).toHaveLength(5);
    const off = session;
    session = editSession(session, { type: 'toggleColor' });
    expect(session.recipe.whiteBalanceEnabled).toBe(true);
    expect(session.recipe.colorEnabled).toBe(true);
    expect(session.recipe.adjustments).toMatchObject({ temperature: 25, tint: -15, vibrance: 30, saturation: -20 });
    const undone = editSession(session, { type: 'undo' });
    expect(undone.recipe).toEqual(off.recipe);
    expect(editSession(undone, { type: 'redo' }).recipe).toEqual(session.recipe);
  });

  it('resets all Color values and synchronizes legacy flags in one History step, including Undo/Redo/jump', () => {
    let session = newSession();
    for (const [id, value] of [['temperature', 25], ['tint', -15], ['vibrance', 30], ['saturation', -20]] as const)
      session = editSession(session, { type: id, value });
    const beforeReset = session.recipe;
    session = editSession(session, { type: 'colorReset' });
    expect(session.history.at(-1)?.kind).toBe('colorReset');
    expect(session.history.at(-1)?.before).toEqual(beforeReset);
    expect(session.recipe.adjustments).toMatchObject({ temperature: 0, tint: 0, vibrance: 0, saturation: 0 });
    expect(session.recipe.whiteBalanceEnabled).toBe(true);
    expect(session.recipe.colorEnabled).toBe(true);
    expect(session.history).toHaveLength(5);
    expect(editSession(session, { type: 'undo' }).recipe).toEqual(beforeReset);
    expect(editSession(editSession(session, { type: 'undo' }), { type: 'redo' }).recipe).toEqual(session.recipe);
    expect(editSession(session, { type: 'jumpToHistory', cursor: 4 }).recipe).toEqual(beforeReset);

    const mismatched = { ...newSession(), recipe: { ...defaultRecipe(), whiteBalanceEnabled: true, colorEnabled: false,
      adjustments: { ...defaultRecipe().adjustments, temperature: 5 } } };
    const synchronized = editSession(mismatched, { type: 'colorReset' });
    expect(synchronized.recipe.whiteBalanceEnabled).toBe(false);
    expect(synchronized.recipe.colorEnabled).toBe(false);
    expect(synchronized.history).toHaveLength(1);
    expect(editSession(synchronized, { type: 'undo' }).recipe).toEqual(mismatched.recipe);
    expect(editSession(synchronized, { type: 'redo' }).recipe).toEqual(synchronized.recipe);
    expect(editSession(synchronized, { type: 'jumpToHistory', cursor: 0 }).recipe).toEqual(mismatched.recipe);
  });

  it('continues to apply Color adjustments when legacy individual flags are false', () => {
    const recipe = defaultRecipe(); recipe.adjustments.temperature = 100; recipe.adjustmentEnabled.temperature = false;
    const rendered = renderAdjustments(pixels, recipe);
    expect(rendered).toEqual(renderAdjustments(pixels, { ...recipe, adjustmentEnabled: defaultRecipe().adjustmentEnabled }));
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
    expect(restoreEditSession(snapshot(redone))).toMatchObject({ ok: true, value: redone });
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
    const saved = snapshot(editSession(newSession(), { type: 'temperature', value: 2 }));
    for (const flags of [undefined, {}, { ...saved.currentRecipe.adjustmentEnabled, extra: true }, { ...saved.currentRecipe.adjustmentEnabled, tint: 1 }]) {
      expect(validateEditStateSnapshot({ ...saved, currentRecipe: { ...saved.currentRecipe, adjustmentEnabled: flags } }).ok).toBe(false);
    }
    const invalid = structuredClone(saved);
    invalid.currentRecipe.adjustmentEnabled.tint = false;
    invalid.history[0].after.adjustmentEnabled.tint = false;
    expect(validateEditStateSnapshot(invalid)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_history_semantics' })]) });
  });
});
