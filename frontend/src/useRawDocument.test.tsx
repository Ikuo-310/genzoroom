// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRawDocument } from './useRawDocument';
import * as api from './rawApi';
import { rawSettings } from './test/rawSettings';

vi.mock('./rawApi', async original => ({ ...await original<typeof import('./rawApi')>(),
  rawCapability: vi.fn(), createRawWorkspace: vi.fn(), openRawDocument: vi.fn(),
  rawPreview: vi.fn(), readRawDocument: vi.fn(), readRawSettings: vi.fn(), setRawControls: vi.fn(), releaseRawWorkspace: vi.fn(), rawWorkspaceEmpty: vi.fn(),
  saveRawRecipe: vi.fn(), readRawRecipe: vi.fn() }));
let root: Root;
let current: ReturnType<typeof useRawDocument>;
const createURL = vi.fn(), revokeURL = vi.fn();
let decode: () => Promise<void>;
function Harness({ id }: { id: string | null }) { current = useRawDocument(id); return <span>{current?.url}</span>; }
async function render(id: string | null) { await act(async () => { root.render(<Harness id={id} />); }); }
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.createElement('div'));
  vi.clearAllMocks(); decode = async () => {};
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 16; naturalHeight = 12; decode() { return decode(); } removeAttribute() {} });
  vi.stubGlobal('URL', { createObjectURL: createURL, revokeObjectURL: revokeURL });
  createURL.mockImplementation(() => `blob:raw-${createURL.mock.calls.length}`);
  vi.mocked(api.rawCapability).mockResolvedValue(true);
  vi.mocked(api.createRawWorkspace).mockResolvedValue('workspace');
  vi.mocked(api.openRawDocument).mockImplementation(async (workspaceId, assetId) => ({
    workspaceId, assetId, handle: assetId, generation: 1, documentToken: assetId, revision: 1 }));
  vi.mocked(api.rawPreview).mockResolvedValue({ blob: new Blob(['png']), width: 16, height: 12, epoch: 1, sequence: 1 });
  vi.mocked(api.readRawDocument).mockImplementation(async doc => doc);
  vi.mocked(api.readRawSettings).mockImplementation(async doc => rawSettings(doc));
  vi.mocked(api.setRawControls).mockImplementation(async (doc, patch) => ({ ...rawSettings(doc), revision: doc.revision + 1,
    settingsFingerprint: String(doc.revision + 1).padStart(64, '0'),
    values: { ...rawSettings(doc).values, ...patch } }));
  vi.mocked(api.saveRawRecipe).mockImplementation(async request => ({ documentRevision: request.doc.revision,
    recipeRevision: request.expectedRecipeRevision + 1, settingsFingerprint: request.doc.settingsFingerprint,
    saveId: request.saveId, updatedAt: '2026-10-22T00:00:00.000Z' }));
  vi.mocked(api.releaseRawWorkspace).mockReset().mockResolvedValue();
  vi.mocked(api.rawWorkspaceEmpty).mockResolvedValue(false);
});
afterEach(async () => { act(() => root.unmount()); await flush(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('RAW document lifetime', () => {
  it('rejects old slider callbacks after a successor RAW document has opened', async () => {
    await render('a'); await flush(); const old = current!;
    await render('b'); await flush();
    act(() => { old.changeControls({ 'light.exposure': 2 }); old.flushControls(); }); await flush();
    expect(api.setRawControls).not.toHaveBeenCalled(); expect(current?.document?.assetId).toBe('b');
  });
  it('discards a Preview revision immediately when newer desired values arrive', async () => {
    await render('raw'); await flush();
    const pending = deferred<api.RawFrame>(); vi.mocked(api.rawPreview).mockReturnValueOnce(pending.promise);
    act(() => { current!.changeControls({ 'light.exposure': 1 }); current!.flushControls(); }); await flush();
    act(() => { current!.changeControls({ 'light.exposure': 2 }); current!.flushControls(); });
    await act(async () => pending.resolve({ blob: new Blob(['old']), width: 16, height: 12, epoch: 1, sequence: 2 })); await flush();
    expect(api.setRawControls).toHaveBeenCalledTimes(2); expect(createURL).toHaveBeenCalledTimes(2);
    expect(current?.url).toBe('blob:raw-2'); expect(current?.settings?.values['light.exposure']).toBe(2);
    expect(current?.pending).toBe(false); expect(revokeURL).toHaveBeenCalledWith('blob:raw-1');
  });
  it('keeps an in-flight mutation owned but never publishes it after switching to JPEG', async () => {
    await render('raw'); await flush();
    const pending = deferred<api.RawSettings>(); vi.mocked(api.setRawControls).mockReturnValueOnce(pending.promise);
    act(() => { current!.changeControls({ 'light.contrast': 20 }); current!.flushControls(); }); await flush();
    expect(current?.pending).toBe(true);
    await render(null);
    await act(async () => pending.resolve({ ...rawSettings({ workspaceId: 'workspace', handle: 'raw', assetId: 'raw',
      generation: 1, documentToken: 'raw', revision: 2 }) })); await flush();
    expect(current).toBeNull(); expect(api.rawPreview).toHaveBeenCalledOnce(); expect(api.releaseRawWorkspace).toHaveBeenCalledWith('workspace');
  });
  it('does nothing for JPEG and only publishes a decoded, verified native frame', async () => {
    await render(null); expect(api.rawCapability).not.toHaveBeenCalled();
    await render('raw'); await flush();
    expect(current?.status).toBe('ready'); expect(current?.url).toBe('blob:raw-1');
    expect(api.rawPreview).toHaveBeenCalledOnce(); expect(api.readRawDocument).toHaveBeenCalledOnce();
    await render(null); await flush();
    expect(revokeURL).toHaveBeenCalledWith('blob:raw-1');
    expect(api.releaseRawWorkspace).toHaveBeenCalledWith('workspace');
  });
  it('does not open a document when capability is unavailable', async () => {
    vi.mocked(api.rawCapability).mockResolvedValue(false);
    await render('raw'); await flush();
    expect(current?.status).toBe('unavailable'); expect(api.openRawDocument).not.toHaveBeenCalled();
    expect(createURL).not.toHaveBeenCalled();
  });
  it('reports native Preview failure without substituting a viewing Preview', async () => {
    vi.mocked(api.rawPreview).mockRejectedValue(new api.RawApiError('raw_unavailable'));
    await render('raw'); await flush();
    expect(current?.status).toBe('error'); expect(current?.url).toBeUndefined();
  });
  it('does not cancel a transmitted import and releases it before opening the next RAW', async () => {
    const pending = deferred<api.RawDocument>();
    vi.mocked(api.openRawDocument).mockReturnValueOnce(pending.promise);
    await render('a'); await flush(); await render('b');
    expect(current?.status).toBe('loading'); expect(api.openRawDocument).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ workspaceId: 'workspace', handle: 'a', assetId: 'a', generation: 1, revision: 1, documentToken: 'a' }));
    await flush();
    expect(current?.document?.assetId).toBe('b');
    expect(vi.mocked(api.releaseRawWorkspace).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.openRawDocument).mock.invocationCallOrder[1]);
    expect(api.rawPreview).toHaveBeenCalledOnce();
  });
  it('rejects an old HTTP Preview after switching to JPEG', async () => {
    const pending = deferred<api.RawFrame>(); vi.mocked(api.rawPreview).mockReturnValueOnce(pending.promise);
    await render('raw'); await flush(); await render(null);
    await act(async () => pending.resolve({ blob: new Blob(['old']), width: 16, height: 12, epoch: 1, sequence: 1 }));
    await flush(); expect(current).toBeNull(); expect(createURL).not.toHaveBeenCalled();
  });
  it('revokes a decode candidate on navigation and never publishes the old document', async () => {
    const pending = deferred<void>(); decode = () => pending.promise;
    await render('a'); await flush(); expect(createURL).toHaveBeenCalledOnce();
    await render(null); await flush();
    expect(current).toBeNull(); expect(revokeURL).toHaveBeenCalledWith('blob:raw-1');
    await act(async () => pending.resolve()); await flush(); expect(current).toBeNull();
  });
  it('rejects an engine identity change during decode', async () => {
    vi.mocked(api.readRawDocument).mockRejectedValue(new api.RawApiError('raw_stale_handle'));
    await render('a'); await flush();
    expect(current?.status).toBe('error'); expect(current?.url).toBeUndefined();
    expect(revokeURL).toHaveBeenCalledWith('blob:raw-1');
  });
  it('releases native ownership and the displayed URL on pagehide', async () => {
    await render('a'); await flush();
    await act(async () => window.dispatchEvent(new Event('pagehide'))); await flush();
    expect(current?.status).toBe('error'); expect(current?.url).toBeUndefined();
    expect(revokeURL).toHaveBeenCalledWith('blob:raw-1');
    expect(api.releaseRawWorkspace).toHaveBeenCalledWith('workspace');
  });
  it('autosaves confirmed RAW edits after five seconds and keeps the same Preview ownership', async () => {
    vi.useFakeTimers(); await render('a'); await flush();
    act(() => { current!.changeControls({ 'light.exposure': 1 }); current!.flushControls(); }); await flush();
    expect(current?.dirty).toBe(true);
    const url = current?.url;
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(api.saveRawRecipe).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); await flush();
    expect(api.saveRawRecipe).toHaveBeenCalledOnce(); expect(current?.dirty).toBe(false); expect(current?.url).toBe(url);
  });
  it('freezes input, flushes desired values, waits for readback and SQLite acknowledgement before leaving', async () => {
    await render('a'); await flush();
    const mutation = deferred<api.RawSettings>(), saving = deferred<api.RawRecipeAck>();
    vi.mocked(api.setRawControls).mockReturnValueOnce(mutation.promise);
    vi.mocked(api.saveRawRecipe).mockReturnValueOnce(saving.promise);
    act(() => current!.changeControls({ 'light.exposure': 2 }));
    let transition!: Promise<void>;
    act(() => { transition = current!.prepareSave(); }); await flush();
    expect(current?.locked).toBe(true); expect(api.saveRawRecipe).not.toHaveBeenCalled();
    act(() => current!.changeControls({ 'light.exposure': 4 }));
    const confirmed = { ...current!.settings!, revision: 2, settingsFingerprint: '2'.repeat(64),
      values: { ...current!.settings!.values, 'light.exposure': 2 } };
    await act(async () => mutation.resolve(confirmed)); await flush();
    expect(api.saveRawRecipe).toHaveBeenCalledOnce(); expect(current?.saving).toBe(true);
    const request = vi.mocked(api.saveRawRecipe).mock.calls[0][0];
    await act(async () => saving.resolve({ documentRevision: 2, settingsFingerprint: confirmed.settingsFingerprint,
      recipeRevision: 1, saveId: request.saveId, updatedAt: '2026-10-22T00:00:00.000Z' }));
    await act(async () => transition); expect(current?.dirty).toBe(false);
    expect(api.setRawControls).toHaveBeenCalledOnce();
  });
  it('ignores the save completion for a document that has been replaced', async () => {
    await render('a'); await flush();
    act(() => { current!.changeControls({ 'light.exposure': 1 }); current!.flushControls(); }); await flush();
    const gate = deferred<api.RawRecipeAck>(); vi.mocked(api.saveRawRecipe).mockReturnValueOnce(gate.promise);
    let transition!: Promise<unknown>;
    act(() => { transition = current!.prepareSave().catch(error => error); }); await flush();
    const request = vi.mocked(api.saveRawRecipe).mock.calls[0][0];
    await render('b');
    await act(async () => gate.resolve({ documentRevision: request.doc.revision, settingsFingerprint: request.doc.settingsFingerprint,
      recipeRevision: 1, saveId: request.saveId, updatedAt: '2026-10-22T00:00:00.000Z' }));
    await transition; await flush();
    expect(current?.assetId).toBe('b'); expect(current?.saveError).toBeUndefined();
  });
});


describe('bounded RAW session renewal', () => {
  function renewal() {
    let generation = 1, attempts = 199;
    let saved: api.RawRecipeRequest | undefined;
    vi.mocked(api.createRawWorkspace).mockImplementation(async () => `workspace-${generation}`);
    vi.mocked(api.openRawDocument).mockImplementation(async (workspaceId, assetId) => ({
      workspaceId, assetId, handle: `handle-${generation}`, generation, documentToken: `token-${generation}`, revision: 1 }));
    vi.mocked(api.readRawSettings).mockImplementation(async doc => ({ ...rawSettings(doc), mutationAttempts: attempts,
      ...(saved ? { values: saved.doc.values, settingsFingerprint: saved.doc.settingsFingerprint,
        recipeFingerprint: saved.doc.settingsFingerprint, recipeRevision: saved.expectedRecipeRevision + 1 } : {}) }));
    vi.mocked(api.setRawControls).mockImplementation(async (doc, patch) => ({ ...doc as api.RawSettings,
      revision: doc.revision + 1, mutationAttempts: ++attempts, settingsFingerprint: String(attempts).padStart(64, '0'),
      values: { ...(doc as api.RawSettings).values, ...patch } }));
    vi.mocked(api.saveRawRecipe).mockImplementation(async request => {
      saved = request;
      return { documentRevision: request.doc.revision, recipeRevision: request.expectedRecipeRevision + 1,
        settingsFingerprint: request.doc.settingsFingerprint, saveId: request.saveId, updatedAt: '2026-10-22T00:00:00Z' };
    });
    vi.mocked(api.releaseRawWorkspace).mockImplementation(async () => { generation++; attempts = 1; });
    return { saved: () => saved };
  }
  async function drain() { await act(async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); }); }
  async function threshold() {
    await render('a'); await drain();
    act(() => { current!.beginControls(); current!.changeControls({ 'light.exposure': 1 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); }); await drain();
    expect(current?.settings?.mutationAttempts).toBe(200);
  }
  it('pauses native changes during a drag at 200, flushes the final desired value and restores it after saving', async () => {
    vi.useFakeTimers(); const model = renewal(); await threshold();
    const old = current!;
    for (let i = 0; i < 300; i++) act(() => current!.changeControls({ 'light.exposure': i / 100 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); await drain();
    expect(api.setRawControls).toHaveBeenCalledOnce(); expect(api.releaseRawWorkspace).not.toHaveBeenCalled();
    expect(current?.desired?.['light.exposure']).toBe(2.99);
    act(() => current!.flushControls()); await drain();
    expect(model.saved()?.doc.values['light.exposure']).toBe(2.99);
    expect(model.saved()?.doc.mutationAttempts).toBe(201);
    expect(current?.document?.generation).toBe(2); expect(current?.settings?.values['light.exposure']).toBe(2.99);
    expect(current?.dirty).toBe(false); expect(current?.locked).toBe(false);
    const count = vi.mocked(api.setRawControls).mock.calls.length;
    act(() => { old.changeControls({ 'light.exposure': 4 }); old.flushControls(); }); await drain();
    expect(api.setRawControls).toHaveBeenCalledTimes(count);
    expect(vi.mocked(api.saveRawRecipe).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.releaseRawWorkspace).mock.invocationCallOrder[0]);
    expect(revokeURL).toHaveBeenCalledWith('blob:raw-1');
  });
  it('keeps the old document and exact save request after saving fails, then retries before release', async () => {
    vi.useFakeTimers(); renewal(); await threshold();
    const save = vi.mocked(api.saveRawRecipe).getMockImplementation()!;
    vi.mocked(api.saveRawRecipe).mockRejectedValueOnce(new api.RawSaveError('raw_connection_failed', 'unknown'));
    act(() => current!.flushControls()); await drain();
    expect(current?.regenerationError).toBe('raw_connection_failed'); expect(current?.locked).toBe(true);
    expect(current?.document?.generation).toBe(1); expect(api.releaseRawWorkspace).not.toHaveBeenCalled();
    const first = vi.mocked(api.saveRawRecipe).mock.calls[0][0];
    vi.mocked(api.saveRawRecipe).mockImplementation(save);
    act(() => current!.retryRegeneration()); await drain();
    expect(vi.mocked(api.saveRawRecipe).mock.calls[1][0]).toEqual(first);
    expect(current?.document?.generation).toBe(2); expect(current?.regenerationError).toBeUndefined();
  });
  it('never creates a replacement while cleanup is pending and retries the same release owner', async () => {
    vi.useFakeTimers(); renewal(); await threshold();
    vi.mocked(api.releaseRawWorkspace).mockRejectedValueOnce(new api.RawApiError('raw_cache_cleanup_pending'));
    act(() => current!.flushControls()); await drain();
    expect(api.createRawWorkspace).toHaveBeenCalledOnce(); expect(current?.status).toBe('error');
    expect(current?.regenerationError).toBe('raw_cache_cleanup_pending');
    act(() => current!.retryRegeneration()); await drain();
    expect(vi.mocked(api.releaseRawWorkspace).mock.calls.slice(0, 2)).toEqual([['workspace-1'], ['workspace-1']]);
    expect(current?.document?.generation).toBe(2); expect(current?.locked).toBe(false);
  });
  it('does not accept default settings after a failed restore and keeps the saved recipe for retry', async () => {
    vi.useFakeTimers(); const model = renewal(); await threshold();
    const read = vi.mocked(api.readRawSettings).getMockImplementation()!;
    vi.mocked(api.readRawSettings).mockImplementationOnce(async doc => rawSettings(doc));
    act(() => current!.flushControls()); await drain();
    expect(model.saved()).toBeDefined(); expect(current?.status).toBe('error');
    expect(current?.regenerationError).toBe('raw_recipe_restore_mismatch');
    vi.mocked(api.readRawSettings).mockImplementation(read);
    act(() => current!.retryRegeneration()); await drain();
    expect(current?.document?.generation).toBe(3); expect(current?.settings?.values['light.exposure']).toBe(1);
  });
  it('does not publish a replacement Preview after switching to JPEG mid-renewal', async () => {
    vi.useFakeTimers(); renewal(); await threshold();
    const gate = deferred<api.RawFrame>(); vi.mocked(api.rawPreview).mockReturnValueOnce(gate.promise);
    act(() => current!.flushControls()); await drain();
    expect(current?.regenerating).toBe(true); await render(null);
    await act(async () => gate.resolve({ blob: new Blob(['stale']), width: 16, height: 12, epoch: 2, sequence: 1 })); await drain();
    expect(current).toBeNull(); expect(createURL).toHaveBeenCalledTimes(2);
    expect(api.releaseRawWorkspace).toHaveBeenCalledTimes(2);
  });
  it('waits for renewal save before allowing departure and rejects edits during renewal', async () => {
    vi.useFakeTimers(); renewal(); await threshold();
    const gate = deferred<void>(), save = vi.mocked(api.saveRawRecipe).getMockImplementation()!;
    vi.mocked(api.saveRawRecipe).mockImplementationOnce(async request => { await gate.promise; return save(request); });
    act(() => current!.flushControls()); await drain();
    expect(current?.regenerating).toBe(true); expect(current?.locked).toBe(true);
    let leaving!: Promise<void>;
    act(() => { current!.changeControls({ 'light.exposure': 4 }); leaving = current!.prepareSave(); });
    await drain(); expect(api.releaseRawWorkspace).not.toHaveBeenCalled();
    await act(async () => { gate.resolve(); await leaving; }); await drain();
    expect(current?.settings?.values['light.exposure']).toBe(1);
    expect(current?.document?.generation).toBe(2); expect(current?.dirty).toBe(false);
    expect(api.setRawControls).toHaveBeenCalledOnce();
  });
  it('recovers a lost release acknowledgement only after the Backend confirms an empty owner', async () => {
    vi.useFakeTimers(); renewal(); await threshold();
    const release = vi.mocked(api.releaseRawWorkspace).getMockImplementation()!;
    vi.mocked(api.releaseRawWorkspace).mockImplementationOnce(async id => {
      await release(id); throw new api.RawApiError('raw_connection_failed');
    });
    act(() => current!.flushControls()); await drain();
    expect(api.createRawWorkspace).toHaveBeenCalledOnce(); expect(current?.status).toBe('error');
    vi.mocked(api.releaseRawWorkspace).mockRejectedValueOnce(new api.RawApiError('raw_workspace_conflict', 409));
    vi.mocked(api.rawWorkspaceEmpty).mockResolvedValueOnce(true);
    act(() => current!.retryRegeneration()); await drain();
    expect(api.rawWorkspaceEmpty).toHaveBeenCalledOnce(); expect(current?.document?.generation).toBe(2);
    expect(current?.regenerationError).toBeUndefined();
  });
  it('serializes A to B to C to A with an in-flight import on the existing queue', async () => {
    renewal(); const gate = deferred<api.RawDocument>();
    vi.mocked(api.openRawDocument).mockReturnValueOnce(gate.promise);
    await render('a'); await drain(); await render('b'); await render('c'); await render('a');
    expect(api.openRawDocument).toHaveBeenCalledOnce();
    await act(async () => gate.resolve({ workspaceId: 'workspace-1', assetId: 'a', handle: 'old', generation: 1, documentToken: 'old', revision: 1 }));
    await drain();
    expect(current?.status).toBe('ready'); expect(current?.document?.assetId).toBe('a');
    expect(api.openRawDocument).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.releaseRawWorkspace).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.createRawWorkspace).mock.invocationCallOrder[1]);
  });
});
