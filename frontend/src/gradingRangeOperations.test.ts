import { describe, expect, it } from 'vitest';
import { GRADING_RANGE_CONTROLS, newSession, editSession, type EditSession } from './editing';
import { compactEditStateSnapshot, createEditStateSnapshot, restoreEditSession, validateEditStateSnapshot } from './editState';

const source = { provider: 'immich' as const, assetId: '12345678-1234-4234-9234-123456789abc', inputKind: 'immich-preview' as const };
function snapshot(session: EditSession) {
  const result = createEditStateSnapshot(session, source);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
describe('grading range resets and persisted History', () => {
  it.each(GRADING_RANGE_CONTROLS)('resets only $id values and preserves flags, Undo, Redo and saved branches', range => {
    let session = newSession();
    for (const group of GRADING_RANGE_CONTROLS) for (const id of group.ids) session.recipe.adjustments[id] = 20;
    session.recipe.colorGradingEnabled = false;
    session.recipe[range.enabled] = false;
    for (const id of range.ids) session.recipe.adjustmentEnabled[id] = false;
    const before = structuredClone(session.recipe);
    session = editSession(session, { type: range.reset });
    const expected = structuredClone(before);
    for (const id of range.ids) expected.adjustments[id] = 0;
    expect(session.recipe).toEqual(expected);
    expect(session.history).toHaveLength(1);
    expect(session.history[0].kind).toBe(range.reset);
    expect(editSession(session, { type: range.reset })).toEqual(session);
    const saved = snapshot(session);
    expect(validateEditStateSnapshot(saved).ok).toBe(true);
    const compacted = compactEditStateSnapshot(saved);
    expect(compacted.ok).toBe(true);
    if (!compacted.ok) return;
    expect(compacted.value).toEqual(saved);
    const restored = restoreEditSession(compacted.value);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const undone = editSession(restored.value, { type: 'undo' });
    expect(undone.recipe).toEqual(before);
    const redoSaved = snapshot(undone);
    const redoRestored = restoreEditSession(redoSaved);
    if (!redoRestored.ok) throw new Error('Redo branch lost');
    expect(editSession(redoRestored.value, { type: 'redo' }).recipe).toEqual(expected);
    expect(editSession(session, { type: 'jumpToHistory', cursor: 0 }).recipe).toEqual(before);
    expect(editSession(session, { type: 'trimHistory', cursor: 1 }).recipe).toEqual(expected);
    const invalid = structuredClone(saved);
    invalid.history[0].after.adjustments.exposure = 1;
    invalid.currentRecipe.adjustments.exposure = 1;
    expect(validateEditStateSnapshot(invalid).ok).toBe(false);
  });
  it('keeps separate ranges and reset boundaries during compression', () => {
    let session = newSession();
    session.recipe.adjustments.shadowsTemperature = 20;
    session.recipe.adjustments.midtonesTint = -20;
    session = editSession(session, { type: 'gradingShadowsReset' });
    session = editSession(session, { type: 'gradingMidtonesReset' });
    session = editSession(session, { type: 'undo' });
    const result = compactEditStateSnapshot(snapshot(session));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.history.map(entry => entry.kind)).toEqual(['gradingShadowsReset', 'gradingMidtonesReset']);
    expect(result.value.historyCursor).toBe(1);
  });
});
