// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssetEdits } from './useAssetEdits';
import { EditStateApiError } from './editStateApi';
import * as editStateModule from './editState';
import { createEditStateSnapshot } from './editState';
import { editSession, newSession } from './editing';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('./editStateApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./editStateApi')>()),
  getAssetEditState: api.get,
  putAssetEditState: api.put,
}));

const first = '12345678-1234-4234-9234-123456789abc';
const second = '87654321-4321-4321-8321-cba987654321';
const source = (assetId: string) => ({ provider: 'immich' as const, assetId, inputKind: 'immich-preview' as const });
const response = (state: unknown, revision = 1) => ({ state, revision, updatedAt: '2026-09-25T00:00:00Z', lastSaveId: crypto.randomUUID() });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Mirrors the store's last-save-id check and revision compare-and-swap. A
// response can be lost either before or after the row was committed.
function useCasStore() {
  type Row = { state: editStateModule.EditStateSnapshot; revision: number; saveId: string; expectedRevision: number };
  const rows = new Map<string, Row>();
  let loseAfterCommit = false;
  let loseBeforeCommit = false;
  let holdReplay: ReturnType<typeof deferred<ReturnType<typeof response>>> | null = null;
  let holdCommittedWrite: ReturnType<typeof deferred<ReturnType<typeof response>>> | null = null;
  api.get.mockImplementation(async (id: string) => {
    const row = rows.get(id);
    return row ? response(row.state, row.revision) : { state: null };
  });
  api.put.mockImplementation(async (id: string, state: editStateModule.EditStateSnapshot, expectedRevision: number, saveId: string) => {
    if (loseBeforeCommit) {
      loseBeforeCommit = false;
      throw new EditStateApiError('network');
    }
    const row = rows.get(id);
    if (row?.saveId === saveId) {
      if (expectedRevision !== row.revision - 1 || JSON.stringify(state) !== JSON.stringify(row.state)) {
        throw new EditStateApiError('conflict', 409, 'save_id_reused');
      }
      if (holdReplay) return holdReplay.promise;
      return response(row.state, row.revision);
    }
    if (expectedRevision !== (row?.revision ?? 0)) {
      throw new EditStateApiError('conflict', 409, 'revision_conflict');
    }
    rows.set(id, { state, revision: expectedRevision + 1, saveId, expectedRevision });
    if (loseAfterCommit) {
      loseAfterCommit = false;
      throw new EditStateApiError('network');
    }
    if (holdCommittedWrite) {
      const held = holdCommittedWrite;
      holdCommittedWrite = null;
      return held.promise;
    }
    return response(state, expectedRevision + 1);
  });
  return {
    rows,
    loseNextResponse: () => { loseAfterCommit = true; },
    failBeforeCommit: () => { loseBeforeCommit = true; },
    holdNextReplay: () => { holdReplay = deferred<ReturnType<typeof response>>(); return holdReplay; },
    holdNextCommittedWrite: () => { holdCommittedWrite = deferred<ReturnType<typeof response>>(); return holdCommittedWrite; },
    externalWrite: (id: string, state: editStateModule.EditStateSnapshot) => {
      const previous = rows.get(id);
      rows.set(id, { state, revision: (previous?.revision ?? 0) + 1,
        saveId: crypto.randomUUID(), expectedRevision: previous?.revision ?? 0 });
    },
  };
}

let latest: ReturnType<typeof useAssetEdits>;
let root: Root;
let container: HTMLDivElement;
function Harness({ id }: { id: string }) {
  latest = useAssetEdits(id, true);
  const [, setUiState] = useState(false);
  return <button type="button" onClick={() => setUiState((value) => !value)}>Viewer-only state</button>;
}
async function mount(id = first) {
  await act(async () => { root.render(<Harness id={id} />); });
}
async function flush() { await act(async () => { await Promise.resolve(); }); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function editTemperature(value: number) {
  act(() => { latest.dispatch({ type: 'temperature', value }); });
}
function editExposure(value: number) {
  act(() => { latest.dispatch({ type: 'exposure', value }); });
}
function commitEdit() {
  act(() => { latest.dispatch({ type: 'commit' }); });
}

beforeEach(() => {
  // React's act environment is set explicitly for createRoot tests.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api.get.mockReset(); api.put.mockReset();
  api.get.mockResolvedValue({ state: null });
  api.put.mockImplementation(async (_id, snapshot, revision, saveId) => ({
    state: snapshot, revision: revision + 1, updatedAt: '2026-09-25T00:00:00Z', lastSaveId: saveId,
  }));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useAssetEdits persistence', () => {
  it('reads v1 without a write, then saves an edited session as v2 with the loaded revision', async () => {
    const edited = editSession(editSession(newSession(), { type: 'temperature', value: 8 }), { type: 'commit' });
    const snapshot = createEditStateSnapshot(edited, source(first));
    if (!snapshot.ok) throw new Error('Invalid test snapshot');
    const legacy = { ...snapshot.value, stateFormatVersion: 1 as const };
    api.get.mockResolvedValue(response(legacy, 4));
    await mount(); await flush();
    expect(latest.dirty).toBe(false);
    expect(latest.session.history).toEqual(edited.history);
    expect(await latest.save(first)).toEqual({ ok: true, clean: true });
    expect(api.put).not.toHaveBeenCalled();
    act(() => latest.dispatch({ type: 'paste', values: { tint: 10 }, sourceAssetId: second, sourceFilename: 'second.jpg' }));
    await act(async () => { await latest.save(first); });
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0][1].stateFormatVersion).toBe(2);
    expect(api.put.mock.calls[0][1].history.map((entry: { kind: string }) => entry.kind)).toEqual(['temperature', 'paste']);
    expect(api.put.mock.calls[0][2]).toBe(4);
    expect(latest.revision).toBe(5);
    expect(legacy.stateFormatVersion).toBe(1);
  });

  it('replays a lost Paste snapshot before saving newer local edits and preserves metadata', async () => {
    vi.useFakeTimers();
    const store = useCasStore();
    await mount(); await flush();
    store.loseNextResponse();
    act(() => latest.dispatch({ type: 'paste', values: { exposure: 1, tint: 10 }, sourceAssetId: second, sourceFilename: 'second.jpg' }));
    await advance(5000);
    expect(latest.dirty).toBe(true);
    expect(latest.autosaveError).toBe('network');
    editExposure(2); commitEdit();
    await act(async () => { await latest.save(first); });
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(api.put.mock.calls[1].slice(1, 4)).toEqual(api.put.mock.calls[0].slice(1, 4));
    expect(api.put.mock.calls[0][1].currentRecipe.adjustments.exposure).toBe(1);
    expect(api.put.mock.calls[2][1].currentRecipe.adjustments.exposure).toBe(2);
    expect(store.rows.get(first)!.state.history.map((entry) => entry.kind)).toEqual(['paste', 'exposure']);
    expect(store.rows.get(first)!.state.history[0]).toMatchObject({ metadata: { sourceFilename: 'second.jpg' } });
    expect(latest.revision).toBe(2);
    expect(latest.dirty).toBe(false);
  });

  it('starts a new session for state:null and skips PUT when clean', async () => {
    await mount(); await flush();
    expect(latest.loadStatus).toBe('ready');
    expect(latest.session).toEqual(newSession());
    expect(latest.revision).toBe(0);
    expect(latest.dirty).toBe(false);
    expect(await latest.save(first)).toEqual({ ok: true, clean: true });
    expect(api.put).not.toHaveBeenCalled();
  });

  it('restores recipe, History, cursor, and revision', async () => {
    const edited = editSession(editSession(newSession(), { type: 'temperature', value: 8 }), { type: 'commit' });
    const undone = editSession(edited, { type: 'undo' });
    const snapshot = createEditStateSnapshot(undone, source(first));
    if (!snapshot.ok) throw new Error('Invalid test snapshot');
    api.get.mockResolvedValue(response(snapshot.value, 4));
    await mount(); await flush();
    expect(latest.session.recipe).toEqual(undone.recipe);
    expect(latest.session.history).toEqual(undone.history);
    expect(latest.session.cursor).toBe(0);
    expect(latest.revision).toBe(4);
    expect(latest.dirty).toBe(false);
  });

  it('blocks editing after a failed GET and recovers on retry', async () => {
    api.get.mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await mount(); await flush();
    expect(latest.loadStatus).toBe('error');
    editTemperature(9);
    expect(latest.session).toEqual(newSession());
    await act(async () => { latest.retryLoad(); }); await flush();
    expect(latest.loadStatus).toBe('ready');
  });

  it('ignores a delayed GET for the previous asset', async () => {
    const late = deferred<{ state: null }>();
    api.get.mockReturnValueOnce(late.promise);
    await mount();
    await mount(second); await flush();
    expect(latest.loadStatus).toBe('ready');
    late.resolve({ state: null }); await flush();
    expect(latest.loadStatus).toBe('ready');
    expect(latest.session).toEqual(newSession());
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('invalidates an in-flight retry when leaving the asset', async () => {
    const retry = deferred<{ state: null }>();
    api.get.mockRejectedValueOnce(new EditStateApiError('unavailable')).mockReturnValueOnce(retry.promise);
    await mount(); await flush();
    await act(async () => { latest.retryLoad(); });
    expect(latest.loadStatus).toBe('loading');
    await mount(second); await flush();
    retry.resolve({ state: null }); await flush();
    await mount(first); await flush();
    expect(latest.loadStatus).toBe('ready');
    expect(api.get).toHaveBeenCalledTimes(4);
  });

  it('saves a pending edit on a copy, updates revision, and does not mutate the live gesture', async () => {
    await mount(); await flush();
    editTemperature(12);
    expect(latest.session.pending?.kind).toBe('temperature');
    let result: Awaited<ReturnType<typeof latest.save>> | undefined;
    await act(async () => { result = await latest.save(first); });
    expect(result).toEqual({ ok: true, clean: true });
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0][2]).toBe(0);
    expect(api.put.mock.calls[0][1].history).toHaveLength(1);
    expect(latest.session.pending?.kind).toBe('temperature');
    expect(latest.session.history).toHaveLength(0);
    expect(latest.revision).toBe(1);
    expect(latest.dirty).toBe(false);
    await latest.save(first);
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('uses current revision on the next save and a new saveId', async () => {
    await mount(); await flush();
    editTemperature(10);
    await act(async () => { await latest.save(first); });
    editTemperature(11);
    await act(async () => { await latest.save(first); });
    expect(api.put.mock.calls[1][2]).toBe(1);
    expect(api.put.mock.calls[1][3]).not.toBe(api.put.mock.calls[0][3]);
  });

  it('keeps later edits dirty and never overlaps PUT for one asset', async () => {
    const pending = deferred<ReturnType<typeof response>>();
    api.put.mockReturnValueOnce(pending.promise);
    await mount(); await flush();
    editTemperature(10);
    let saving!: ReturnType<typeof latest.save>;
    let same!: ReturnType<typeof latest.save>;
    act(() => { saving = latest.save(first); same = latest.save(first); });
    expect(same).toBe(saving);
    editTemperature(20);
    await act(async () => { pending.resolve(response(api.put.mock.calls[0][1], 1)); await saving; });
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(latest.revision).toBe(1);
    expect(latest.dirty).toBe(true);
    await act(async () => { await latest.save(first); });
    expect(api.put.mock.calls[1][2]).toBe(1);
  });

  it('reuses saveId after a network failure only for the same snapshot and revision', async () => {
    api.put.mockRejectedValueOnce(new EditStateApiError('network'));
    await mount(); await flush(); editTemperature(10);
    await act(async () => { expect(await latest.save(first)).toMatchObject({ ok: false, error: { kind: 'network' } }); });
    await act(async () => { await latest.save(first); });
    expect(api.put.mock.calls[1][3]).toBe(api.put.mock.calls[0][3]);
    editTemperature(20);
    api.put.mockRejectedValueOnce(new EditStateApiError('network'));
    await act(async () => { await latest.save(first); });
    const previousId = api.put.mock.calls[2][3];
    editTemperature(21);
    await act(async () => { await latest.save(first); });
    expect(api.put.mock.calls[3][3]).toBe(previousId);
    expect(api.put.mock.calls[4][3]).not.toBe(previousId);
  });

  it('confirms a committed but unanswered autosave before saving later edits', async () => {
    vi.useFakeTimers();
    const store = useCasStore();
    await mount(); await flush();
    store.loseNextResponse();
    editTemperature(10); commitEdit();
    await advance(5000);
    expect(store.rows.get(first)?.revision).toBe(1);
    expect(latest.revision).toBe(0);
    editTemperature(20); commitEdit();
    await advance(5000);
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(api.put.mock.calls[1].slice(1, 4)).toEqual(api.put.mock.calls[0].slice(1, 4));
    expect(api.put.mock.calls[2][2]).toBe(1);
    expect(api.put.mock.calls[2][3]).not.toBe(api.put.mock.calls[0][3]);
    expect(store.rows.get(first)?.state.currentRecipe.adjustments.temperature).toBe(20);
    expect(latest.revision).toBe(2);
    expect(latest.dirty).toBe(false);
  });

  it('replays the same request when the first PUT never reached the database', async () => {
    const store = useCasStore();
    await mount(); await flush();
    editTemperature(10); commitEdit();
    store.failBeforeCommit();
    await act(async () => { expect(await latest.save(first)).toMatchObject({ ok: false, error: { kind: 'network' } }); });
    expect(store.rows.has(first)).toBe(false);
    await act(async () => { expect(await latest.save(first)).toEqual({ ok: true, clean: true }); });
    expect(api.put.mock.calls[1].slice(1, 4)).toEqual(api.put.mock.calls[0].slice(1, 4));
    expect(store.rows.get(first)?.revision).toBe(1);
  });

  it('models Backend CAS rejection for a changed request with the same saveId or an old revision', async () => {
    const store = useCasStore();
    const original = createEditStateSnapshot(newSession(), source(first));
    if (!original.ok) throw new Error('Invalid test state');
    const changedSession = editSession(newSession(), { type: 'temperature', value: 10 });
    const changed = createEditStateSnapshot(changedSession, source(first));
    if (!changed.ok) throw new Error('Invalid changed state');
    const saveId = crypto.randomUUID();
    await api.put(first, original.value, 0, saveId);
    await expect(api.put(first, changed.value, 0, saveId))
      .rejects.toMatchObject({ code: 'save_id_reused' });
    await expect(api.put(first, changed.value, 0, crypto.randomUUID()))
      .rejects.toMatchObject({ code: 'revision_conflict' });
    expect(store.rows.get(first)?.state).toEqual(original.value);
  });

  it('keeps an unanswered save dirty even if a pending gesture returns to its old baseline', async () => {
    const store = useCasStore();
    await mount(); await flush();
    editTemperature(10);
    store.loseNextResponse();
    await act(async () => { await latest.save(first); });
    editTemperature(0);
    expect(latest.session.recipe.adjustments.temperature).toBe(0);
    expect(latest.dirty).toBe(true);
    await act(async () => { expect(await latest.save(first)).toEqual({ ok: true, clean: true }); });
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(api.put.mock.calls[1][3]).toBe(api.put.mock.calls[0][3]);
    expect(api.put.mock.calls[2][2]).toBe(1);
    expect(store.rows.get(first)?.state.currentRecipe.adjustments.temperature).toBe(0);
  });

  it('confirms an unanswered normal save before compacting on Home exit', async () => {
    const store = useCasStore();
    await mount(); await flush();
    editTemperature(10); commitEdit(); editTemperature(20); commitEdit();
    store.loseNextResponse();
    await act(async () => { expect(await latest.save(first)).toMatchObject({ ok: false, error: { kind: 'network' } }); });
    let exit: Awaited<ReturnType<typeof latest.saveEditedAssetsForExit>> | undefined;
    await act(async () => { exit = await latest.saveEditedAssetsForExit(); });
    expect(exit?.ok).toBe(true);
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(api.put.mock.calls[1].slice(1, 4)).toEqual(api.put.mock.calls[0].slice(1, 4));
    expect(api.put.mock.calls[2][2]).toBe(1);
    expect(api.put.mock.calls[2][1].history).toHaveLength(1);
    expect(store.rows.get(first)?.revision).toBe(2);
  });

  it('confirms an unanswered compact save before autosave and another Home exit', async () => {
    vi.useFakeTimers();
    const store = useCasStore();
    await mount(); await flush();
    editTemperature(10); commitEdit(); editTemperature(20); commitEdit();
    store.loseNextResponse();
    await act(async () => { expect(await latest.saveEditedAssetsForExit()).toMatchObject({ ok: false, error: { kind: 'network' } }); });
    expect(api.put.mock.calls[0][1].history).toHaveLength(1);
    act(() => latest.resumeAfterExitFailure());
    await advance(5000);
    expect(api.put.mock.calls[1].slice(1, 4)).toEqual(api.put.mock.calls[0].slice(1, 4));
    expect(store.rows.get(first)?.revision).toBe(1);
    expect(latest.session.history).toHaveLength(1);
    expect(latest.dirty).toBe(false);
    await act(async () => { expect(await latest.saveEditedAssetsForExit()).toMatchObject({ ok: true }); });
    expect(api.put).toHaveBeenCalledTimes(2);
  });

  it('keeps later edits when an unanswered compact save is confirmed', async () => {
    const store = useCasStore();
    await mount(); await flush();
    editTemperature(10); commitEdit(); editTemperature(20); commitEdit();
    store.loseNextResponse();
    await act(async () => { await latest.saveEditedAssetsForExit(); });
    act(() => latest.resumeAfterExitFailure());
    editTemperature(30); commitEdit();
    await act(async () => { expect(await latest.save(first)).toEqual({ ok: true, clean: true }); });
    expect(api.put.mock.calls[1].slice(1, 4)).toEqual(api.put.mock.calls[0].slice(1, 4));
    expect(api.put.mock.calls[2][2]).toBe(1);
    expect(store.rows.get(first)?.state.currentRecipe.adjustments.temperature).toBe(30);
    expect(latest.session.history).toHaveLength(3);
    expect(latest.dirty).toBe(false);
    await act(async () => { expect(await latest.saveEditedAssetsForExit()).toMatchObject({ ok: true }); });
    expect(store.rows.get(first)?.state.history).toHaveLength(1);
  });

  it('does not send newer state until the uncertain request has resolved, and preserves edits during replay', async () => {
    const store = useCasStore();
    await mount(); await flush();
    editTemperature(10); commitEdit();
    store.loseNextResponse();
    await act(async () => { await latest.save(first); });
    editTemperature(20); commitEdit();
    const replay = store.holdNextReplay();
    let saving!: ReturnType<typeof latest.save>;
    act(() => { saving = latest.save(first); });
    await flush();
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put.mock.calls[1].slice(1, 4)).toEqual(api.put.mock.calls[0].slice(1, 4));
    editTemperature(30); commitEdit();
    expect(latest.dirty).toBe(true);
    expect(api.put).toHaveBeenCalledTimes(2);
    await act(async () => { replay.resolve(response(api.put.mock.calls[0][1], 1)); await saving; });
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(api.put.mock.calls[2][1].currentRecipe.adjustments.temperature).toBe(30);
    expect(store.rows.get(first)?.state.currentRecipe.adjustments.temperature).toBe(30);
    expect(latest.dirty).toBe(false);
  });

  it('treats a real external revision change as conflict without overwriting the other save', async () => {
    const store = useCasStore();
    await mount(); await flush();
    editTemperature(10); commitEdit();
    store.failBeforeCommit();
    await act(async () => { await latest.save(first); });
    const external = createEditStateSnapshot(newSession(), source(first));
    if (!external.ok) throw new Error('Invalid external state');
    store.externalWrite(first, external.value);
    editTemperature(20); commitEdit();
    await act(async () => {
      expect(await latest.save(first)).toMatchObject({ ok: false, error: { kind: 'conflict', code: 'revision_conflict' } });
    });
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put.mock.calls[1][3]).toBe(api.put.mock.calls[0][3]);
    expect(store.rows.get(first)?.state).toEqual(external.value);
    expect(latest.revision).toBe(0);
    expect(latest.session.recipe.adjustments.temperature).toBe(20);
    expect(latest.dirty).toBe(true);
  });

  it('discards local edits without a rollback and fetches again on revisit', async () => {
    await mount(); await flush(); editTemperature(10);
    act(() => latest.discard(first));
    await mount(second); await flush();
    await mount(first); await flush();
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(latest.session).toEqual(newSession());
    expect(api.put).not.toHaveBeenCalled();
  });

  it('debounces edits for five seconds and resets the deadline after a later edit', async () => {
    vi.useFakeTimers();
    await mount(); await flush();
    editTemperature(10);
    await advance(3000);
    editTemperature(20);
    await advance(4999);
    expect(api.put).not.toHaveBeenCalled();
    await advance(1);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0][1].currentRecipe.adjustments.temperature).toBe(20);
    expect(latest.dirty).toBe(false);
  });

  it('does not PUT at 4.999 seconds and starts autosave at five seconds', async () => {
    vi.useFakeTimers();
    await mount(); await flush(); editTemperature(9);
    await advance(4999);
    expect(api.put).not.toHaveBeenCalled();
    await advance(1);
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('does not autosave while the edit-state GET is loading or has failed', async () => {
    vi.useFakeTimers();
    const pending = deferred<{ state: null }>();
    api.get.mockReturnValueOnce(pending.promise);
    await mount();
    editTemperature(9);
    await advance(10000);
    expect(api.put).not.toHaveBeenCalled();
    pending.reject(new EditStateApiError('unavailable'));
    await flush();
    expect(latest.loadStatus).toBe('error');
    await advance(10000);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('does not let UI-only rerenders reset the edit debounce', async () => {
    vi.useFakeTimers();
    await mount(); await flush(); editTemperature(12);
    await advance(3000);
    const viewerOnly = container.querySelector('button');
    if (!viewerOnly) throw new Error('Missing viewer-only button');
    act(() => viewerOnly.click());
    await advance(1999);
    expect(api.put).not.toHaveBeenCalled();
    await advance(1);
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('reuses a validated snapshot across UI-only rerenders and within an edit dispatch with long History', async () => {
    let session = newSession();
    for (let index = 0; index < 1000; index += 1) {
      session = editSession(editSession(session, { type: 'temperature', value: index % 2 === 0 ? 1 : 0 }), { type: 'commit' });
    }
    const stored = createEditStateSnapshot(session, source(first));
    if (!stored.ok) throw new Error('Invalid long History');
    api.get.mockResolvedValue(response(stored.value));
    await mount(); await flush();
    const create = vi.spyOn(editStateModule, 'createEditStateSnapshot');
    try {
      const viewerOnly = container.querySelector('button');
      if (!viewerOnly) throw new Error('Missing viewer-only button');
      for (let index = 0; index < 5; index += 1) act(() => viewerOnly.click());
      expect(latest.dirty).toBe(false);
      expect(create).not.toHaveBeenCalled();

      editTemperature(30);
      expect(latest.dirty).toBe(true);
      // The old session is already cached, and the new one is evaluated once.
      // The render's dirty check reuses the result of that same dispatch.
      expect(create).toHaveBeenCalledTimes(1);
      act(() => viewerOnly.click());
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      create.mockRestore();
    }
  });

  it('updates cached dirty state for pending commit, Undo, Redo, and Reset', async () => {
    await mount(); await flush();
    editTemperature(10);
    expect(latest.dirty).toBe(true);
    await act(async () => { await latest.save(first); });
    expect(latest.dirty).toBe(false);
    expect(latest.session.pending?.kind).toBe('temperature');

    commitEdit();
    expect(latest.session.pending).toBeNull();
    expect(latest.dirty).toBe(false);
    act(() => latest.dispatch({ type: 'undo' }));
    expect(latest.session.cursor).toBe(0);
    expect(latest.dirty).toBe(true);
    act(() => latest.dispatch({ type: 'redo' }));
    expect(latest.session.cursor).toBe(1);
    expect(latest.dirty).toBe(false);
    act(() => latest.dispatch({ type: 'temperatureReset' }));
    expect(latest.session.recipe.adjustments.temperature).toBe(0);
    expect(latest.dirty).toBe(true);
    await act(async () => { await latest.save(first); });
    expect(latest.dirty).toBe(false);
  });

  it('saves pending edits on a copied session without compressing History or committing the live gesture', async () => {
    vi.useFakeTimers();
    await mount(); await flush(); editTemperature(12);
    expect(latest.session.pending?.kind).toBe('temperature');
    await advance(5000);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0][1].history).toHaveLength(1);
    expect(latest.session.pending?.kind).toBe('temperature');
    expect(latest.session.history).toHaveLength(0);
    expect(latest.dirty).toBe(false);
  });

  it('keeps edits made during autosave dirty and starts another debounce after the in-flight save', async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof response>>();
    api.put.mockReturnValueOnce(pending.promise);
    await mount(); await flush(); editTemperature(10);
    await advance(5000);
    expect(api.put).toHaveBeenCalledTimes(1);
    editTemperature(20);
    await advance(5000);
    expect(api.put).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(response(api.put.mock.calls[0][1], 1)); await pending.promise; });
    expect(latest.revision).toBe(1);
    expect(latest.dirty).toBe(true);
    await advance(4999);
    expect(api.put).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put.mock.calls[1][1].currentRecipe.adjustments.temperature).toBe(20);
  });

  it('keeps failed autosaves dirty, exposes a nonblocking error, and does not retry until another edit', async () => {
    vi.useFakeTimers();
    api.put.mockRejectedValueOnce(new EditStateApiError('unavailable'))
      .mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await mount(); await flush(); editTemperature(14);
    await advance(5000); await flush();
    expect(latest.dirty).toBe(true);
    expect(latest.revision).toBe(0);
    expect(latest.autosaveError).toBe('unavailable');
    expect(api.put).toHaveBeenCalledTimes(1);
    await advance(15000);
    expect(api.put).toHaveBeenCalledTimes(1);
    editTemperature(15);
    await advance(5000);
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(latest.dirty).toBe(true);
    expect(latest.autosaveError).toBe('unavailable');
    expect(api.put.mock.calls[1][3]).not.toBe(api.put.mock.calls[0][3]);
    editTemperature(16);
    await advance(5000);
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(latest.dirty).toBe(false);
    expect(latest.autosaveError).toBeNull();
  });

  it('clears the autosave warning when the next edited snapshot is saved', async () => {
    vi.useFakeTimers();
    api.put.mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await mount(); await flush();
    editTemperature(10); commitEdit();
    await advance(5000);
    expect(latest.autosaveError).toBe('unavailable');
    expect(latest.dirty).toBe(true);
    editTemperature(20); commitEdit();
    await advance(5000);
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(latest.dirty).toBe(false);
    expect(latest.autosaveError).toBeNull();
  });

  it('keeps the warning and dirty state after confirming an old retry until the newer snapshot is saved', async () => {
    vi.useFakeTimers();
    const store = useCasStore();
    await mount(); await flush();
    store.loseNextResponse();
    editTemperature(10); commitEdit();
    await advance(5000);
    expect(latest.autosaveError).toBe('network');
    expect(latest.dirty).toBe(true);

    editTemperature(20); commitEdit();
    const heldLatestResponse = store.holdNextCommittedWrite();
    await advance(5000); await flush();
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(api.put.mock.calls[1].slice(1, 4)).toEqual(api.put.mock.calls[0].slice(1, 4));
    expect(api.put.mock.calls[2][2]).toBe(1);
    expect(store.rows.get(first)?.state.currentRecipe.adjustments.temperature).toBe(20);
    expect(latest.revision).toBe(1);
    expect(latest.dirty).toBe(true);
    expect(latest.autosaveError).toBe('network');

    await act(async () => {
      heldLatestResponse.resolve(response(store.rows.get(first)?.state, 2));
      await heldLatestResponse.promise;
    });
    await flush();
    expect(latest.revision).toBe(2);
    expect(latest.dirty).toBe(false);
    expect(latest.autosaveError).toBeNull();
  });

  it('keeps a newer autosave failure after an older in-flight save completes', async () => {
    vi.useFakeTimers();
    const store = useCasStore();
    const heldOldResponse = store.holdNextCommittedWrite();
    await mount(); await flush();
    editTemperature(10); commitEdit();
    await advance(5000); await flush();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(store.rows.get(first)?.revision).toBe(1);

    editTemperature(20); commitEdit();
    await advance(5000);
    expect(api.put).toHaveBeenCalledTimes(1);
    store.failBeforeCommit();
    await act(async () => {
      heldOldResponse.resolve(response(store.rows.get(first)?.state, 1));
      await heldOldResponse.promise;
    });
    await flush();
    expect(latest.dirty).toBe(true);
    await advance(5000); await flush();
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(latest.dirty).toBe(true);
    expect(latest.autosaveError).toBe('network');
  });

  it('clears an autosave warning after a successful Filmstrip save', async () => {
    vi.useFakeTimers();
    const store = useCasStore();
    await mount(); await flush();
    store.failBeforeCommit();
    editTemperature(10); commitEdit();
    await advance(5000);
    expect(latest.autosaveError).toBe('network');
    expect(latest.dirty).toBe(true);
    act(() => latest.pauseAutosave(first));
    await act(async () => { expect(await latest.save(first)).toEqual({ ok: true, clean: true }); });
    expect(store.rows.get(first)?.revision).toBe(1);
    expect(latest.dirty).toBe(false);
    expect(latest.autosaveError).toBeNull();
  });

  it('clears an autosave warning after a successful Home exit save', async () => {
    vi.useFakeTimers();
    const store = useCasStore();
    await mount(); await flush();
    store.failBeforeCommit();
    editTemperature(10); commitEdit();
    await advance(5000);
    expect(latest.autosaveError).toBe('network');
    let result: Awaited<ReturnType<typeof latest.saveEditedAssetsForExit>> | undefined;
    await act(async () => { result = await latest.saveEditedAssetsForExit(); });
    expect(result?.ok).toBe(true);
    expect(store.rows.get(first)?.revision).toBe(1);
    expect(latest.dirty).toBe(false);
    expect(latest.autosaveError).toBeNull();
  });

  it('keeps autosave warnings scoped to the active asset', async () => {
    vi.useFakeTimers();
    api.put.mockRejectedValueOnce(new EditStateApiError('network'));
    await mount(); await flush();
    editTemperature(10); commitEdit();
    await advance(5000);
    expect(latest.autosaveError).toBe('network');
    await mount(second); await flush();
    expect(latest.autosaveError).toBeNull();
    await mount(first);
    expect(latest.autosaveError).toBe('network');
  });

  it('reuses the autosave saveId for an unchanged network retry and keeps conflicts local', async () => {
    vi.useFakeTimers();
    api.put.mockRejectedValueOnce(new EditStateApiError('network'));
    await mount(); await flush(); editTemperature(16);
    await advance(5000); await flush();
    const failedSaveId = api.put.mock.calls[0][3];
    await advance(10000);
    expect(api.put).toHaveBeenCalledTimes(1);
    await act(async () => { await latest.save(first); });
    expect(api.put.mock.calls[1][3]).toBe(failedSaveId);

    const localRecipe = latest.session.recipe;
    api.put.mockRejectedValueOnce(new EditStateApiError('conflict', 409, 'revision_conflict'));
    editTemperature(17);
    await advance(5000); await flush();
    expect(latest.session.recipe).not.toEqual(localRecipe);
    expect(latest.session.recipe.adjustments.temperature).toBe(17);
    expect(latest.revision).toBe(1);
  });

  it('pauses the active timer for a Filmstrip transition and resumes only when asked', async () => {
    vi.useFakeTimers();
    await mount(); await flush(); editTemperature(10);
    act(() => latest.pauseAutosave(first));
    await advance(10000);
    expect(api.put).not.toHaveBeenCalled();
    act(() => latest.resumeAutosave(first));
    await advance(4999);
    expect(api.put).not.toHaveBeenCalled();
    await advance(1);
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('allows autosave again when a previously paused asset is activated and loaded later', async () => {
    vi.useFakeTimers();
    await mount(); await flush(); editTemperature(10);
    act(() => latest.pauseAutosave(first));
    await mount(second); await flush();
    await mount(first); await flush();
    editTemperature(11);
    await advance(5000);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0][0]).toBe(first);
  });

  it('does not continue autosaving an old asset after a delayed save resolves following a switch', async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof response>>();
    api.put.mockReturnValueOnce(pending.promise);
    await mount(); await flush(); editTemperature(10);
    await advance(5000);
    expect(api.put).toHaveBeenCalledTimes(1);
    await mount(second); await flush();
    await act(async () => { pending.resolve(response(api.put.mock.calls[0][1], 1)); await pending.promise; });
    await advance(15000);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0][0]).toBe(first);
  });

  it('compacts every asset edited this session, including autosaved clean assets, but skips viewed-only assets', async () => {
    const database = new Map<string, ReturnType<typeof response>>();
    api.get.mockImplementation(async (id: string) => database.get(id) ?? { state: null });
    api.put.mockImplementation(async (id: string, snapshot: any, revision: number, saveId: string) => {
      const saved = response(snapshot, revision + 1);
      database.set(id, saved);
      return saved;
    });

    await mount(); await flush();
    editTemperature(10); commitEdit(); editTemperature(5); commitEdit(); editTemperature(12); commitEdit();
    await act(async () => { await latest.save(first); });
    expect(latest.dirty).toBe(false);

    await mount(second); await flush();
    editExposure(0.1); commitEdit(); editExposure(0.2); commitEdit(); editExposure(0.35); commitEdit();
    await act(async () => { await latest.save(second); });
    expect(latest.dirty).toBe(false);

    const third = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    await mount(third); await flush();
    api.put.mockClear();
    let result: Awaited<ReturnType<typeof latest.saveEditedAssetsForExit>> | undefined;
    await act(async () => { result = await latest.saveEditedAssetsForExit(); });

    expect(result).toMatchObject({ ok: true, compactFallbackAssetIds: [] });
    expect(api.put.mock.calls.map(([id]) => id)).toEqual([first, second]);
    expect(api.put.mock.calls[0][1].history).toHaveLength(1);
    expect(api.put.mock.calls[0][1].history[0].before.adjustments.temperature).toBe(0);
    expect(api.put.mock.calls[0][1].history[0].after.adjustments.temperature).toBe(12);
    expect(api.put.mock.calls[1][1].history).toHaveLength(1);
    expect(api.put.mock.calls[1][1].history[0].after.adjustments.exposure).toBe(0.35);
    expect(api.put.mock.calls.every(([, , revision]) => revision === 1)).toBe(true);
  });

  it('keeps a pending live gesture untouched until compact save succeeds, then syncs the compact session', async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof response>>();
    api.put.mockReturnValueOnce(pending.promise);
    await mount(); await flush(); editTemperature(10);
    expect(latest.session.pending?.kind).toBe('temperature');
    let finishing!: ReturnType<typeof latest.saveEditedAssetsForExit>;
    act(() => { finishing = latest.saveEditedAssetsForExit(); });
    await flush();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0][1].history).toHaveLength(1);
    expect(latest.session.pending?.kind).toBe('temperature');

    let result: Awaited<typeof finishing> | undefined;
    await act(async () => {
      pending.resolve(response(api.put.mock.calls[0][1], 1));
      result = await finishing;
    });
    expect(result?.ok).toBe(true);
    expect(latest.session.pending).toBeNull();
    expect(latest.session.history).toHaveLength(1);
    expect(latest.session.cursor).toBe(1);
    expect(latest.revision).toBe(1);
    expect(latest.dirty).toBe(false);
    await advance(10000);
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('retains a failed exit asset local edit when revisiting it after choosing to stay', async () => {
    vi.useFakeTimers();
    await mount(); await flush();
    await mount(second); await flush();
    editExposure(0.25); commitEdit();
    await mount(first); await flush();
    const getsBeforeExit = api.get.mock.calls.length;
    api.put.mockRejectedValueOnce(new EditStateApiError('unavailable'));

    let result: Awaited<ReturnType<typeof latest.saveEditedAssetsForExit>> | undefined;
    await act(async () => { result = await latest.saveEditedAssetsForExit(); });
    expect(result).toMatchObject({ ok: false, assetId: second });
    act(() => latest.resumeAfterExitFailure());

    await mount(second);
    expect(latest.loadStatus).toBe('ready');
    expect(api.get).toHaveBeenCalledTimes(getsBeforeExit);
    expect(latest.session.recipe.adjustments.exposure).toBe(0.25);
    expect(latest.session.history).toHaveLength(1);

    await act(async () => { result = await latest.saveEditedAssetsForExit(); });
    expect(result?.ok).toBe(true);
    expect(api.put).toHaveBeenCalledTimes(2);
  });

  it('falls back to the original uncompressed snapshot when compaction reports failure', async () => {
    const compact = vi.spyOn(editStateModule, 'compactEditStateSnapshot')
      .mockReturnValueOnce({ ok: false, issues: [] });
    await mount(); await flush();
    editTemperature(10); commitEdit(); editTemperature(20); commitEdit();
    let result: Awaited<ReturnType<typeof latest.saveEditedAssetsForExit>> | undefined;
    await act(async () => { result = await latest.saveEditedAssetsForExit(); });
    expect(result).toMatchObject({ ok: true, compactFallbackAssetIds: [first] });
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0][1].history).toHaveLength(2);
    compact.mockRestore();
  });

  it('keeps the full History when exit compaction policy is disabled', async () => {
    await mount(); await flush();
    editTemperature(10); commitEdit(); editTemperature(20); commitEdit();
    let result: Awaited<ReturnType<typeof latest.saveEditedAssetsForExit>> | undefined;
    await act(async () => { result = await latest.saveEditedAssetsForExit(false); });
    expect(result?.ok).toBe(true);
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls[0][1].history).toHaveLength(2);
  });

  it('waits for an in-flight autosave before compact-saving the latest session and leaves no old timer', async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof response>>();
    api.put.mockReturnValueOnce(pending.promise);
    await mount(); await flush();
    editTemperature(10); commitEdit(); editTemperature(20); commitEdit();
    await advance(5000);
    expect(api.put).toHaveBeenCalledTimes(1);

    let finishing!: ReturnType<typeof latest.saveEditedAssetsForExit>;
    act(() => { finishing = latest.saveEditedAssetsForExit(); });
    await flush();
    expect(api.put).toHaveBeenCalledTimes(1);
    let result: Awaited<typeof finishing> | undefined;
    await act(async () => {
      pending.resolve(response(api.put.mock.calls[0][1], 1));
      result = await finishing;
    });
    expect(result?.ok).toBe(true);
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put.mock.calls[1][2]).toBe(1);
    expect(api.put.mock.calls[1][1].history).toHaveLength(1);
    await advance(10000);
    expect(api.put).toHaveBeenCalledTimes(2);
  });

  it('resolves an uncertain in-flight autosave with the same request before compact-saving newer edits', async () => {
    vi.useFakeTimers();
    const pending = deferred<ReturnType<typeof response>>();
    api.put.mockReturnValueOnce(pending.promise);
    await mount(); await flush();
    editTemperature(10); commitEdit();
    await advance(5000);
    expect(api.put).toHaveBeenCalledTimes(1);
    editTemperature(20); commitEdit();

    let finishing!: ReturnType<typeof latest.saveEditedAssetsForExit>;
    act(() => { finishing = latest.saveEditedAssetsForExit(); });
    await flush();
    await act(async () => {
      pending.reject(new EditStateApiError('network'));
      try { await pending.promise; } catch { /* the request result is handled by the hook */ }
      await Promise.resolve();
    });
    let result: Awaited<typeof finishing> | undefined;
    await act(async () => { result = await finishing; });

    expect(result?.ok).toBe(true);
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(api.put.mock.calls[1][1]).toEqual(api.put.mock.calls[0][1]);
    expect(api.put.mock.calls[1][2]).toBe(api.put.mock.calls[0][2]);
    expect(api.put.mock.calls[1][3]).toBe(api.put.mock.calls[0][3]);
    expect(api.put.mock.calls[2][2]).toBe(1);
    expect(api.put.mock.calls[2][3]).not.toBe(api.put.mock.calls[1][3]);
    expect(api.put.mock.calls[2][1].currentRecipe.adjustments.temperature).toBe(20);
    expect(api.put.mock.calls[2][1].history).toHaveLength(1);
    expect(latest.revision).toBe(2);
    expect(latest.dirty).toBe(false);
  });

  it('does not compact-save an already confirmed asset again after partial failure and stay', async () => {
    const database = new Map<string, ReturnType<typeof response>>();
    let failSecondAssetOnce = false;
    api.get.mockImplementation(async (id: string) => database.get(id) ?? { state: null });
    api.put.mockImplementation(async (id: string, snapshot: any, revision: number, saveId: string) => {
      if (id === second && failSecondAssetOnce) {
        failSecondAssetOnce = false;
        throw new EditStateApiError('unavailable');
      }
      const saved = response(snapshot, revision + 1);
      database.set(id, saved);
      return saved;
    });

    await mount(); await flush();
    editTemperature(10); commitEdit(); editTemperature(20); commitEdit(); editTemperature(30); commitEdit();
    await act(async () => { await latest.save(first); });
    await mount(second); await flush();
    editExposure(0.1); commitEdit(); editExposure(0.2); commitEdit(); editExposure(0.3); commitEdit();
    await act(async () => { await latest.save(second); });
    await mount(first); await flush();

    const initialCalls = api.put.mock.calls.length;
    failSecondAssetOnce = true;
    let failedExit: Awaited<ReturnType<typeof latest.saveEditedAssetsForExit>> | undefined;
    await act(async () => { failedExit = await latest.saveEditedAssetsForExit(); });
    expect(failedExit).toMatchObject({ ok: false, assetId: second });
    expect(latest.session.history).toHaveLength(1);
    expect(latest.session.history[0].after.adjustments.temperature).toBe(30);
    expect(latest.revision).toBe(2);
    expect(latest.dirty).toBe(false);
    const afterPartialSuccess = api.put.mock.calls.length;
    expect(afterPartialSuccess).toBe(initialCalls + 2);

    act(() => latest.resumeAfterExitFailure());
    await mount(second); await flush();
    expect(latest.session.history).toHaveLength(3);
    expect(latest.revision).toBe(1);
    let retryExit: Awaited<ReturnType<typeof latest.saveEditedAssetsForExit>> | undefined;
    await act(async () => { retryExit = await latest.saveEditedAssetsForExit(); });
    expect(retryExit?.ok).toBe(true);
    expect(api.put.mock.calls.length).toBe(afterPartialSuccess + 1);
    expect(api.put.mock.calls.at(-1)?.[0]).toBe(second);
    expect((database.get(first)?.state as { history: unknown[] }).history).toHaveLength(1);
    expect((database.get(second)?.state as { history: unknown[] }).history).toHaveLength(1);
  });
});
