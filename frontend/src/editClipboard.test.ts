import { describe, expect, it, vi } from 'vitest';
import { copyEditSettings, readEditClipboard } from './editClipboard';
import { ADJUSTMENT_IDS, defaultRecipe, editSession, newSession, type EditAction, type EditRecipe, type EditSession } from './editing';
import { compactEditStateSnapshot, createEditStateSnapshot, restoreEditSession, validateEditStateSnapshot } from './editState';

const source = { provider: 'immich' as const, assetId: 'destination', inputKind: 'immich-preview' as const };
const paste = (values: Partial<EditRecipe['adjustments']>): EditAction => ({
  type: 'paste', values, sourceAssetId: 'original', sourceFilename: 'original.jpg',
});
function snapshot(session: EditSession) {
  const result = createEditStateSnapshot(session, source);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
function allValues() {
  const recipe = defaultRecipe();
  ADJUSTMENT_IDS.forEach((id, index) => { recipe.adjustments[id] = id === 'exposure' ? 1.23 : index + 1; });
  return recipe;
}

describe('tab edit clipboard and compound Paste', () => {
  it('has no copy initially and keeps an independent read-only-by-copy snapshot of all stored values', async () => {
    // A fresh module represents a newly loaded tab, without resetting production state.
    vi.resetModules();
    const fresh = await import('./editClipboard');
    expect(fresh.readEditClipboard()).toBeNull();
    const recipe = allValues();
    recipe.whiteBalanceEnabled = recipe.basicEnabled = recipe.colorEnabled = recipe.colorGradingEnabled = false;
    recipe.gradingShadowsEnabled = recipe.gradingMidtonesEnabled = recipe.gradingHighlightsEnabled = false;
    const expected = { ...recipe.adjustments };
    fresh.copyEditSettings(recipe, 'original', 'original.jpg');
    recipe.adjustments.temperature = 99;
    const copied = fresh.readEditClipboard()!;
    expect(copied).toEqual({ values: expected, sourceAssetId: 'original', sourceFilename: 'original.jpg' });
    expect(Object.keys(copied.values)).toHaveLength(16);
    copied.values.tint = 88;
    expect(fresh.readEditClipboard()!.values).toEqual(expected);
  });

  it('pastes all values in one operation, preserves every flag, and undoes/redoes together', () => {
    const target = newSession();
    target.recipe.whiteBalanceEnabled = target.recipe.basicEnabled = target.recipe.colorGradingEnabled = target.recipe.colorEnabled = false;
    target.recipe.gradingShadowsEnabled = target.recipe.gradingMidtonesEnabled = target.recipe.gradingHighlightsEnabled = false;
    const original = structuredClone(target);
    const copied = allValues();
    copyEditSettings(copied, 'original', 'original.jpg');
    const clipboard = readEditClipboard()!;
    const result = editSession(target, { type: 'paste', ...clipboard });
    clipboard.values.temperature = 80;
    expect(result.recipe).toEqual({ ...original.recipe, adjustments: copied.adjustments });
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({ kind: 'paste', before: original.recipe, after: result.recipe,
      metadata: { sourceAssetId: 'original', sourceFilename: 'original.jpg', adjustmentIds: ADJUSTMENT_IDS } });
    expect(editSession(result, { type: 'undo' }).recipe).toEqual(original.recipe);
    expect(editSession(editSession(result, { type: 'undo' }), { type: 'redo' })).toEqual(result);
    expect(target).toEqual(original);
  });

  it('uses the same partial-value Paste for future selection and retains specified unchanged IDs', () => {
    const result = editSession(newSession(), paste({ exposure: 0.4, tint: 0 }));
    expect(result.recipe.adjustments).toEqual({ ...defaultRecipe().adjustments, exposure: 0.4 });
    expect(result.history[0]).toMatchObject({ kind: 'paste', metadata: { adjustmentIds: ['tint', 'exposure'] } });
  });

  it('commits pending work separately, including when Paste itself is a no-op', () => {
    const pending = editSession(newSession(), { type: 'exposure', value: 0.5 });
    const result = editSession(pending, paste({ exposure: 1, tint: 10 }));
    expect(result.history.map((entry) => entry.kind)).toEqual(['exposure', 'paste']);
    expect(result.history[1].before).toEqual(pending.recipe);
    expect(editSession(result, { type: 'undo' }).recipe).toEqual(pending.recipe);
    const noOp = editSession(pending, paste({ exposure: 0.5 }));
    expect(noOp.history.map((entry) => entry.kind)).toEqual(['exposure']);
    expect(noOp.pending).toBeNull();
  });

  it('preserves Redo on no-op and replaces it only on a changed Paste', () => {
    const edited = editSession(newSession(), paste({ temperature: 10 }));
    const undone = editSession(edited, { type: 'undo' });
    expect(editSession(undone, paste({ temperature: 0 }))).toBe(undone);
    expect(editSession(undone, paste({}))).toBe(undone);
    const changed = editSession(undone, paste({ tint: 4 }));
    expect(changed.history).toHaveLength(1);
    expect(changed.history[0].after.adjustments.temperature).toBe(0);
    expect(changed.history[0].after.adjustments.tint).toBe(4);
    expect(changed.cursor).toBe(1);
  });

  it('preserves independent Paste metadata through snapshots, validation, restore and both compacted branches', () => {
    let session = newSession();
    for (const value of [1, 2]) session = editSession(editSession(session, { type: 'temperature', value }), { type: 'commit' });
    session = editSession(session, paste({ tint: 10 }));
    session = editSession(session, paste({ tint: 20 }));
    for (const value of [3, 4]) session = editSession(editSession(session, { type: 'temperature', value }), { type: 'commit' });
    session = editSession(session, paste({ tint: 30 }));
    session = editSession(session, { type: 'undo' });
    const saved = snapshot(session);
    const validated = validateEditStateSnapshot(JSON.parse(JSON.stringify(saved)));
    expect(validated).toEqual({ ok: true, value: saved });
    const compacted = compactEditStateSnapshot(saved);
    if (!compacted.ok) throw new Error('Invalid compaction');
    expect(compacted.value.history.map((entry) => entry.kind)).toEqual(['temperature', 'paste', 'paste', 'temperature', 'paste']);
    expect(compacted.value.historyCursor).toBe(4);
    expect(compacted.value.currentRecipe).toEqual(session.recipe);
    const restored = restoreEditSession(compacted.value);
    if (!restored.ok) throw new Error('Invalid restore');
    const redone = editSession(restored.value, { type: 'redo' });
    expect(redone.recipe.adjustments.tint).toBe(30);
    expect(redone.history.filter((entry) => entry.kind === 'paste').map((entry) => entry.metadata))
      .toEqual(session.history.filter((entry) => entry.kind === 'paste').map((entry) => entry.metadata));
    const savedPaste = saved.history.find((entry) => entry.kind === 'paste')!;
    if (savedPaste.kind !== 'paste') throw new Error('Missing Paste');
    savedPaste.metadata.sourceFilename = 'mutated';
    savedPaste.metadata.adjustmentIds.push('exposure');
    expect(session.history[2]).toMatchObject({ metadata: { sourceFilename: 'original.jpg', adjustmentIds: ['tint'] } });
    expect(compacted.value.history[1]).toMatchObject({ metadata: { sourceFilename: 'original.jpg', adjustmentIds: ['tint'] } });
  });
});

describe('Paste snapshot validation and legacy read compatibility', () => {
  const valid = () => snapshot(editSession(newSession(), paste({ tint: 10 })));
  const metadata = { sourceAssetId: 'original', sourceFilename: 'original.jpg', adjustmentIds: ['tint'] };

  it.each([
    null, [], {}, { ...metadata, extra: true }, { ...metadata, sourceAssetId: 1 },
    { ...metadata, sourceFilename: null }, { ...metadata, adjustmentIds: 'tint' },
    { ...metadata, adjustmentIds: ['unknown'] }, { ...metadata, adjustmentIds: [['tint']] },
    { ...metadata, adjustmentIds: ['tint', 'tint'] }, { ...metadata, adjustmentIds: [] },
  ])('rejects malformed metadata %j', (bad) => {
    const saved = valid();
    expect(validateEditStateSnapshot({ ...saved, history: [{ ...saved.history[0], metadata: bad }] }))
      .toMatchObject({ ok: false, issues: [{ code: 'invalid_history' }] });
  });

  it.each(['flag', 'outside', 'noop', 'recipe'] as const)('rejects invalid Paste %s', (bad) => {
    const saved = valid();
    const entry = saved.history[0];
    if (bad === 'flag') entry.after.basicEnabled = false;
    if (bad === 'outside') entry.after.adjustments.exposure = 1;
    if (bad === 'noop') entry.after = structuredClone(entry.before);
    if (bad === 'recipe') entry.after.adjustments.tint = 101;
    saved.currentRecipe = entry.after;
    const result = validateEditStateSnapshot(saved);
    if (result.ok) throw new Error('Invalid Paste accepted');
    expect(result.issues.every((issue) => issue.code === (bad === 'recipe' ? 'invalid_recipe' : 'invalid_history_semantics'))).toBe(true);
  });

  it('strictly validates v1 and creates v2 only after restoring it; v1 never accepts Paste or metadata', () => {
    const original = snapshot(editSession(editSession(newSession(), { type: 'temperature', value: 12 }), { type: 'commit' }));
    const legacy = { ...original, stateFormatVersion: 1 as const };
    expect(validateEditStateSnapshot(legacy)).toEqual({ ok: true, value: legacy });
    const restored = restoreEditSession(legacy);
    if (!restored.ok) throw new Error('Invalid v1');
    expect(snapshot(restored.value)).toEqual(original);
    expect(legacy.stateFormatVersion).toBe(1);
    expect(validateEditStateSnapshot({ ...valid(), stateFormatVersion: 1 }).ok).toBe(false);
    expect(validateEditStateSnapshot({ ...legacy, history: [{ ...legacy.history[0], metadata }] }).ok).toBe(false);
    expect(validateEditStateSnapshot({ ...legacy, historyCursor: 0 }).ok).toBe(false);
    expect(validateEditStateSnapshot({ ...legacy, history: [{ ...legacy.history[0], kind: 'unknown' }] }).ok).toBe(false);
    const invalid = structuredClone(legacy);
    invalid.currentRecipe.adjustments.exposure = 6;
    expect(restoreEditSession(invalid).ok).toBe(false);
  });
});
