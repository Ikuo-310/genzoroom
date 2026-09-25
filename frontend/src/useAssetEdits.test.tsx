// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssetEdits } from './useAssetEdits';
import { EditStateApiError } from './editStateApi';
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
    expect(api.put.mock.calls[3][3]).not.toBe(previousId);
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
    api.put.mockRejectedValueOnce(new EditStateApiError('unavailable'));
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
    expect(api.put.mock.calls[1][3]).not.toBe(api.put.mock.calls[0][3]);
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
});
