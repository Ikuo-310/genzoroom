import { describe, expect, it } from 'vitest';
import { defaultRecipe, editSession, newSession, type EditAction, type EditKind, type EditRecipe, type EditSession } from './editing';
import {
  COMPACT_HISTORY_ON_EXIT,
  EDIT_STATE_FORMAT_VERSION,
  PROCESSING_VERSION,
  compactEditSession,
  compactEditStateSnapshot,
  createEditStateSnapshot,
  restoreEditSession,
  validateEditStateSnapshot,
  type EditSourceIdentity,
  type EditStateSnapshot,
} from './editState';

const sourceIdentity: EditSourceIdentity = {
  provider: 'immich',
  assetId: '12345678-1234-4234-9234-123456789abc',
  inputKind: 'immich-preview',
};

function action(session: EditSession, value: EditAction): EditSession {
  return editSession(session, value);
}

function edit(session: EditSession, kind: 'temperature' | 'exposure' | 'tint', value: number): EditSession {
  const updated = action(session, { type: kind, value });
  return action(updated, { type: 'commit', kind });
}

function toggle(session: EditSession, kind: 'toggleBasic' | 'toggleColorGrading' | 'toggleGradingShadows'): EditSession {
  return action(session, { type: kind });
}

function snapshot(session: EditSession): EditStateSnapshot {
  const result = createEditStateSnapshot(session, sourceIdentity);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function compact(session: EditSession): EditStateSnapshot {
  const result = compactEditStateSnapshot(snapshot(session));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function entry(kind: Exclude<EditKind, 'paste'>, before: EditRecipe, after: EditRecipe) {
  return { kind, before, after };
}

describe('edit state snapshot', () => {
  it('defines independent state format, processing version, and exit policy constants', () => {
    expect(EDIT_STATE_FORMAT_VERSION).toBe(2);
    expect(PROCESSING_VERSION).toBe('jpeg-preview-srgb8-v1');
    expect(COMPACT_HISTORY_ON_EXIT).toBe(true);
  });

  it('creates an independent snapshot and commits pending work only on the copy', () => {
    let session = action(newSession(), { type: 'begin', kind: 'temperature' });
    session = action(session, { type: 'temperature', value: 12 });
    const before = structuredClone(session);

    const result = createEditStateSnapshot(session, sourceIdentity);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.history).toEqual([entry('temperature', defaultRecipe(), session.recipe)]);
    expect(result.value.historyCursor).toBe(1);
    expect(result.value.currentRecipe).toEqual(session.recipe);
    expect(session).toEqual(before);
    expect(session.pending).toEqual({ kind: 'temperature', before: defaultRecipe() });
    expect(session.history).toEqual([]);
    expect(result.value.currentRecipe).not.toBe(session.recipe);
  });

  it('restores only validated state and clears transient pending work', () => {
    const saved = snapshot(edit(newSession(), 'temperature', 8));
    const restored = restoreEditSession(saved);
    expect(restored).toEqual({ ok: true, value: { recipe: saved.currentRecipe, history: saved.history, cursor: 1, pending: null } });
  });

  it('persists a jumped cursor with the matching recipe and preserves the Redo branch', () => {
    let session = edit(newSession(), 'temperature', 8);
    session = edit(session, 'exposure', 0.5);
    session = action(session, { type: 'jumpToHistory', cursor: 1 });
    const saved = snapshot(session);
    expect(saved.history).toHaveLength(2);
    expect(saved.historyCursor).toBe(1);
    expect(saved.currentRecipe).toEqual(saved.history[0].after);
    expect(restoreEditSession(saved)).toMatchObject({ ok: true, value: { cursor: 1, recipe: saved.history[0].after, history: saved.history } });
  });

  it('allows a valid empty history and preserves its current recipe', () => {
    const saved = snapshot(newSession());
    expect(validateEditStateSnapshot(saved).ok).toBe(true);
    expect(restoreEditSession(saved)).toMatchObject({ ok: true, value: { history: [], cursor: 0, recipe: saved.currentRecipe } });
  });

  it('detects unsupported state and recipe versions and malformed recipes', () => {
    const saved = snapshot(newSession());
    expect(validateEditStateSnapshot({ ...saved, stateFormatVersion: 3 })).toMatchObject({ ok: false, issues: [{ code: 'unsupported_state_format_version' }] });
    expect(validateEditStateSnapshot({ ...saved, recipeVersion: 18 })).toMatchObject({ ok: false, issues: [{ code: 'unsupported_recipe_version' }] });
    expect(validateEditStateSnapshot({ ...saved, currentRecipe: { ...saved.currentRecipe, version: 18 } })).toMatchObject({ ok: false, issues: [{ code: 'unsupported_recipe_version' }] });
    expect(validateEditStateSnapshot({ ...saved, processingVersion: 'future' })).toMatchObject({ ok: false, issues: [{ code: 'unsupported_processing_version' }] });
    expect(validateEditStateSnapshot({ ...saved, currentRecipe: { ...saved.currentRecipe, adjustments: { ...saved.currentRecipe.adjustments, exposure: 6 } } })).toMatchObject({ ok: false, issues: [{ code: 'invalid_recipe' }] });
    expect(validateEditStateSnapshot({ ...saved, sourceIdentity: { ...sourceIdentity, checksum: 'abc' } })).toMatchObject({ ok: false, issues: [{ code: 'invalid_source_identity' }] });
  });

  it('detects history continuity, cursor, and current recipe mismatches without defaulting', () => {
    const saved = snapshot(edit(edit(newSession(), 'temperature', 8), 'exposure', 0.35));
    const brokenContinuity = structuredClone(saved);
    brokenContinuity.history[1].before = defaultRecipe();
    expect(validateEditStateSnapshot(brokenContinuity)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'history_discontinuity' })]) });

    expect(validateEditStateSnapshot({ ...saved, historyCursor: 3 })).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_history_cursor' })]) });
    expect(validateEditStateSnapshot({ ...saved, currentRecipe: defaultRecipe() })).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'current_recipe_mismatch' })]) });
    expect(restoreEditSession(brokenContinuity)).toMatchObject({ ok: false });
  });

  it('rejects a History kind whose recipe diff changes another control', () => {
    const saved = snapshot(edit(newSession(), 'exposure', 0.5));
    saved.history[0].kind = 'temperature';
    expect(validateEditStateSnapshot(saved)).toMatchObject({ ok: false, issues: [{ code: 'invalid_history_semantics' }] });
  });
});

describe('history compaction', () => {
  it('compacts consecutive changes to one numeric adjustment', () => {
    const result = compact(edit(edit(edit(newSession(), 'temperature', 10), 'temperature', 5), 'temperature', 12));
    expect(result.history).toEqual([entry('temperature', defaultRecipe(), result.currentRecipe)]);
    expect(result.historyCursor).toBe(1);
  });

  it('keeps another adjustment as a boundary between numeric runs', () => {
    let state = edit(newSession(), 'temperature', 12);
    state = edit(state, 'exposure', 0.35);
    state = edit(state, 'temperature', 8);
    expect(compact(state).history.map((item) => item.kind)).toEqual(['temperature', 'exposure', 'temperature']);
  });

  it('recompacts matching numeric changes after an intervening no-op toggle disappears', () => {
    let state = edit(newSession(), 'exposure', 1);
    state = toggle(toggle(state, 'toggleColorGrading'), 'toggleColorGrading');
    state = edit(state, 'exposure', 0.4);
    const result = compact(state);
    expect(result.history).toEqual([entry('exposure', defaultRecipe(), result.currentRecipe)]);
    expect(result.currentRecipe.adjustments.exposure).toBe(0.4);
  });

  it('removes a toggle sequence whose final state equals its initial state', () => {
    let state = newSession();
    for (let index = 0; index < 4; index += 1) state = toggle(state, 'toggleBasic');
    expect(compact(state).history).toEqual([]);
  });

  it('reduces a toggle sequence with a changed final state to one operation', () => {
    let state = newSession();
    for (let index = 0; index < 3; index += 1) state = toggle(state, 'toggleBasic');
    const result = compact(state);
    expect(result.history).toEqual([entry('basicToggle', defaultRecipe(), result.currentRecipe)]);
    expect(result.currentRecipe.basicEnabled).toBe(false);
  });

  it('removes a numeric round trip', () => {
    const result = compact(edit(edit(newSession(), 'exposure', 1), 'exposure', 0));
    expect(result.history).toEqual([]);
    expect(result.historyCursor).toBe(0);
    expect(result.currentRecipe).toEqual(defaultRecipe());
  });

  it('does not compact across the cursor between applied and redo history', () => {
    let state = edit(newSession(), 'temperature', 12);
    state = edit(state, 'temperature', 8);
    state = action(state, { type: 'undo' });
    const result = compact(state);
    expect(result.history.map((item) => item.before.adjustments.temperature)).toEqual([0, 12]);
    expect(result.history.map((item) => item.after.adjustments.temperature)).toEqual([12, 8]);
    expect(result.historyCursor).toBe(1);
    expect(result.currentRecipe.adjustments.temperature).toBe(12);
  });

  it('compacts consecutive entries wholly within the redo branch', () => {
    let state = edit(newSession(), 'exposure', 0.1);
    state = edit(state, 'temperature', 2);
    state = edit(state, 'temperature', 5);
    state = action(state, { type: 'undo' });
    state = action(state, { type: 'undo' });
    const result = compact(state);
    expect(result.history.map((item) => item.kind)).toEqual(['exposure', 'temperature']);
    expect(result.historyCursor).toBe(1);
    expect(result.history[1].before.adjustments.temperature).toBe(0);
    expect(result.history[1].after.adjustments.temperature).toBe(5);
    expect(result.currentRecipe.adjustments.exposure).toBe(0.1);
  });

  it('preserves the current recipe and recalculates cursor after removing applied no-ops', () => {
    let state = edit(newSession(), 'temperature', 10);
    state = edit(state, 'temperature', 0);
    state = edit(state, 'exposure', 0.5);
    const result = compact(state);
    expect(result.history.map((item) => item.kind)).toEqual(['exposure']);
    expect(result.historyCursor).toBe(1);
    expect(result.currentRecipe).toEqual(state.recipe);
  });

  it('retains individual, category, and All Reset as independent operations', () => {
    let state = edit(newSession(), 'temperature', 10);
    state = action(state, { type: 'temperatureReset' });
    state = edit(state, 'exposure', 0.5);
    state = action(state, { type: 'basicReset' });
    state = edit(state, 'temperature', 8);
    state = action(state, { type: 'allReset' });
    expect(compact(state).history.map((item) => item.kind)).toEqual([
      'temperature', 'temperatureReset', 'exposure', 'basicReset', 'temperature', 'allReset',
    ]);
  });

  it('reduces parent and range toggles independently and preserves meaningful child state', () => {
    let state = newSession();
    state = toggle(toggle(state, 'toggleGradingShadows'), 'toggleGradingShadows');
    state = toggle(state, 'toggleColorGrading');
    state = toggle(state, 'toggleGradingShadows');
    const result = compact(state);
    expect(result.history.map((item) => item.kind)).toEqual(['colorGradingToggle', 'gradingShadowsToggle']);
    expect(result.currentRecipe.colorGradingEnabled).toBe(false);
    expect(result.currentRecipe.gradingShadowsEnabled).toBe(false);
    expect(result.history[0].before.gradingShadowsEnabled).toBe(true);
    expect(result.history[0].after.gradingShadowsEnabled).toBe(true);
    expect(result.history[1].before.gradingShadowsEnabled).toBe(true);
    expect(result.history[1].after.gradingShadowsEnabled).toBe(false);
  });

  it('supports empty history and cursor at both branch endpoints', () => {
    expect(compact(newSession())).toMatchObject({ history: [], historyCursor: 0 });

    const applied = compact(edit(edit(newSession(), 'temperature', 2), 'temperature', 6));
    expect(applied.historyCursor).toBe(applied.history.length);

    let redo = edit(edit(newSession(), 'temperature', 2), 'temperature', 6);
    redo = action(action(redo, { type: 'undo' }), { type: 'undo' });
    const compactedRedo = compact(redo);
    expect(compactedRedo.historyCursor).toBe(0);
    expect(compactedRedo.history).toHaveLength(1);
    expect(compactedRedo.currentRecipe).toEqual(defaultRecipe());
  });

  it('returns validation failures instead of compacting corrupt history', () => {
    const invalid = snapshot(edit(edit(newSession(), 'temperature', 8), 'exposure', 0.35));
    invalid.history[1].before = defaultRecipe();
    expect(compactEditStateSnapshot(invalid)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'history_discontinuity' })]) });
  });

  it('compacts an EditSession through snapshots while preserving its Recipe, cursor, Redo branch, and pending gesture', () => {
    let session = edit(newSession(), 'exposure', 0.1);
    session = edit(session, 'temperature', 2);
    session = edit(session, 'temperature', 5);
    session = action(action(session, { type: 'undo' }), { type: 'undo' });
    session = action(session, { type: 'tint', value: 10 });
    const recipe = structuredClone(session.recipe);
    const pending = structuredClone(session.pending);

    const result = compactEditSession(session, sourceIdentity);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipe).toEqual(recipe);
    expect(result.value.cursor).toBe(1);
    expect(result.value.history.map((item) => item.kind)).toEqual(['exposure', 'temperature']);
    expect(result.value.history[1].before).toEqual(result.value.history[0].after);
    expect(result.value.history[1].after.adjustments.temperature).toBe(5);
    expect(result.value.pending).toEqual(pending);
    expect(result.value.history[1].before).toEqual(result.value.pending!.before);
    expect(session.history).toHaveLength(3);
  });

  it('does not mutate an invalid session when session compaction fails validation', () => {
    let session = edit(newSession(), 'exposure', 0.5);
    session = edit(session, 'temperature', 10);
    const invalid = structuredClone(session);
    invalid.history[0].after.adjustments.exposure = 500;
    const original = structuredClone(invalid);
    const result = compactEditSession(invalid, sourceIdentity);
    expect(result.ok).toBe(false);
    expect(invalid).toEqual(original);
  });
});
