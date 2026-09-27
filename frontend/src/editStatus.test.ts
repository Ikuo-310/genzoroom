import { describe, expect, it } from 'vitest';
import cases from './test-fixtures/edit-status.json';
import { hasEdits } from './editStatus';
import { ADJUSTMENT_IDS, defaultRecipe, editSession, newSession } from './editing';
import { createEditStateSnapshot, restoreEditSession } from './editState';

describe('edit status (shared frontend/backend cases)', () => {
  it.each(cases)('$name', test => {
    const session = newSession();
    Object.assign(session.recipe.adjustments, test.adjustments);
    Object.assign(session.recipe, test.flags);
    Object.assign(session.recipe.adjustmentEnabled, test.adjustmentEnabled);
    if (test.history) session.history = [{ kind: 'temperature', before: defaultRecipe(),
      after: { ...defaultRecipe(), adjustments: { ...defaultRecipe().adjustments, temperature: 12 } } }];
    if (test.version === 17) {
      const result = createEditStateSnapshot(session, { provider: 'immich', assetId: 'a', inputKind: 'immich-preview' });
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      const legacy = JSON.parse(JSON.stringify(result.value));
      legacy.recipeVersion = 17;
      legacy.stateFormatVersion = test.stateFormatVersion ?? 2;
      for (const recipe of [legacy.currentRecipe, ...legacy.history.flatMap((entry: { before: object; after: object }) => [entry.before, entry.after])]) {
        recipe.version = 17; delete recipe.adjustmentEnabled;
      }
      const restored = restoreEditSession(legacy);
      if (!restored.ok) throw new Error(JSON.stringify(restored.issues));
      expect(hasEdits(restored.value)).toBe(test.edited);
    } else expect(hasEdits(session)).toBe(test.edited);
  });

  it.each(ADJUSTMENT_IDS)('includes saved values and individual bypass for %s', id => {
    const session = newSession();
    session.recipe.adjustments[id] = 1;
    expect(hasEdits(session)).toBe(true);
    session.recipe.adjustments[id] = 0; session.recipe.adjustmentEnabled[id] = false;
    expect(hasEdits(session)).toBe(true);
  });

  it('keeps History clear edited, includes pending edits and clears a full reset', () => {
    let session = editSession(newSession(), { type: 'temperature', value: 12 });
    expect(hasEdits(session)).toBe(true);
    session = editSession(session, { type: 'clearHistory' });
    expect(hasEdits(session)).toBe(true);
    session = editSession(session, { type: 'temperature', value: 0 });
    expect(session.recipe.adjustments.temperature).toBe(0);
    expect(session.history).toHaveLength(0);
    expect(hasEdits(session)).toBe(true);
    session = editSession(session, { type: 'resetEdits' });
    expect(hasEdits(session)).toBe(false);
  });
  it('does not mark an untouched pending gesture as edited', () => {
    expect(hasEdits(editSession(newSession(), { type: 'begin', kind: 'temperature' }))).toBe(false);
  });
  it.each(['whiteBalanceEnabled', 'basicEnabled', 'colorEnabled', 'colorGradingEnabled',
    'gradingShadowsEnabled', 'gradingMidtonesEnabled', 'gradingHighlightsEnabled'] as const)
    ('includes the %s bypass at zero', flag => {
      const session = newSession(); session.recipe[flag] = false;
      expect(hasEdits(session)).toBe(true);
    });
});
