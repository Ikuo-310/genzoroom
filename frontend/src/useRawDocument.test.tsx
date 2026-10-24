// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRawDocument } from './useRawDocument';
import { frontendLogger } from './frontendLogging';
import * as api from './rawApi';
import { rawSettings } from './test/rawSettings';
import { rawHistoryResult, rawHistoryPage, fakeRawHistory } from './test/rawHistory';

vi.mock('./rawApi', async original => ({ ...await original<typeof import('./rawApi')>(),
  rawCapability: vi.fn(), createRawWorkspace: vi.fn(), openRawDocument: vi.fn(),
  rawPreview: vi.fn(), cancelRawPreview: vi.fn(async () => {}), readRawDocument: vi.fn(), readRawSettings: vi.fn(), setRawControls: vi.fn(), releaseRawWorkspace: vi.fn(), rawWorkspaceEmpty: vi.fn(),
  readRawHistory: vi.fn(), saveRawHistory: vi.fn(), saveRawRecipe: vi.fn(), readRawRecipe: vi.fn() }));
const commitHistory = vi.fn(async (request: api.RawHistoryRequest): Promise<api.RawHistoryResult> => rawHistoryResult(request));
let root: Root;
let current: ReturnType<typeof useRawDocument>;
const createURL = vi.fn(), revokeURL = vi.fn();
let decode: () => Promise<void>;
function Harness({ id, before = false }: { id: string | null; before?: boolean }) { current = useRawDocument(id, before); return <span>{current?.url}</span>; }
async function render(id: string | null, before = false) { await act(async () => { root.render(<Harness id={id} before={before} />); }); }
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.mocked(api.readRawHistory).mockReset().mockImplementation(async (doc, offset) => rawHistoryPage(doc, offset));
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
  commitHistory.mockReset().mockImplementation(async request => rawHistoryResult(request));
  vi.mocked(api.saveRawHistory).mockReset().mockImplementation(async request => request.action === 'initialize'
    ? rawHistoryResult(request) : commitHistory(request));
  vi.mocked(api.releaseRawWorkspace).mockReset().mockResolvedValue();
  vi.mocked(api.rawWorkspaceEmpty).mockResolvedValue(false);
});
afterEach(async () => { act(() => root.unmount()); await flush(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function enableBefore() {
  vi.mocked(api.readRawSettings).mockImplementation(async doc => ({ ...rawSettings(doc), beforeKey: 'b'.repeat(64) }));
  vi.mocked(api.rawPreview).mockImplementation(async (doc, _serial, _signal, kind = 'after') => ({
    blob: new Blob(['png']), width: 16, height: 12, epoch: 1, sequence: 1, kind,
    ...(kind === 'before' ? { key: doc.beforeKey! } : {}) }));
}

describe('RAW native Before cache', () => {
  it.each([[10, 40], [10, 250], [300, 40]])('adopts monotonic ACK Drafts during continuous input (mutation %ims, render %ims)', async (mutationMs, renderMs) => {
    vi.useFakeTimers();
    const diagnostics = vi.spyOn(frontendLogger, 'add');
    await render('a'); await flush();
    const mutate = vi.mocked(api.setRawControls).getMockImplementation()!;
    vi.mocked(api.setRawControls).mockImplementation(async (...args) => {
      await new Promise(resolve => setTimeout(resolve, mutationMs));
      return mutate(...args);
    });
    vi.mocked(api.rawPreview).mockImplementation(async (_doc, _serial, _signal, _kind, target) => {
      await new Promise(resolve => setTimeout(resolve, renderMs));
      return { blob: new Blob(['png']), width: 16, height: 12, epoch: 1, sequence: 1, quality: target?.quality };
    });
    const adopted: number[] = [];
    for (let i = 0; i < 60; i++) {
      act(() => current!.changeControls({ 'light.exposure': i / 100 }));
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      if (current?.quality === 'draft' && adopted.at(-1) !== current.imageRevision) adopted.push(current.imageRevision!);
    }
    expect(adopted.length).toBeGreaterThanOrEqual(5);
    expect(adopted.every((revision, i) => i === 0 || revision > adopted[i - 1])).toBe(true);
    expect(current?.displayError).toBeUndefined();
    act(() => current!.flushControls());
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); await flush();
    expect(current?.quality).toBe('full'); expect(current?.imageRevision).toBe(current?.settings?.revision);
    expect(current?.settings?.values['light.exposure']).toBe(.59); expect(current?.dirty).toBe(false);
    const summary = diagnostics.mock.calls.find(([entry]) => entry.event === 'interaction.summary' && entry.context?.phase === 'fullDisplayed')?.[0].context;
    expect(summary).toMatchObject({ inputs: 60, fullDisplayMs: expect.any(Number), draftAdoptions: expect.any(Number) });
    expect(Number(summary?.draftAdoptions)).toBeGreaterThanOrEqual(5);
    diagnostics.mockRestore();
  });

  it('cancels and rejects a running ACK Draft from the previous view', async () => {
    vi.useFakeTimers(); await render('a'); await flush();
    const gate = deferred<api.RawFrame>(); vi.mocked(api.rawPreview).mockReturnValueOnce(gate.promise);
    act(() => current!.changeControls({ 'light.exposure': 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); }); await flush();
    const previous = current?.url;
    act(() => current!.viewChanged()); await flush();
    expect(api.cancelRawPreview).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }), 'after', 2);
    await act(async () => gate.resolve({ blob: new Blob(['old view']), width: 16, height: 12, epoch: 1, sequence: 2 })); await flush();
    expect(createURL).toHaveBeenCalledTimes(2); expect(current?.url).not.toBe(previous);
    expect(vi.mocked(api.rawPreview).mock.calls.at(-1)?.[4]?.viewGeneration).toBe(1);
    act(() => current!.flushControls()); await flush(); expect(current?.quality).toBe('full');
  });

  it('keeps a saved gesture successful when its final Full fails', async () => {
    vi.useFakeTimers(); await render('a'); await flush();
    act(() => current!.changeControls({ 'light.exposure': 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); }); await flush();
    vi.mocked(api.rawPreview).mockRejectedValueOnce(new api.RawApiError('raw_render_failed'));
    act(() => current!.flushControls()); await flush();
    expect(current?.dirty).toBe(false); expect(current?.saveError).toBeUndefined();
    expect(current?.displayError).toBe('raw_render_failed'); expect(current?.quality).toBe('draft');
  });

  it('bounds stalled Draft courtesy, discards its old revision and still saves', async () => {
    vi.useFakeTimers(); await render('a'); await flush();
    const gate = deferred<void>(); decode = () => gate.promise;
    act(() => current!.changeControls({ 'light.exposure': 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); }); await flush();
    act(() => current!.changeControls({ 'light.exposure': 2 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); }); await flush();
    expect(api.setRawControls).toHaveBeenCalledTimes(2);
    expect(current?.imageRevision).toBe(1); expect(current?.displayError).toBeUndefined();
    decode = async () => {}; await act(async () => gate.resolve()); await flush();
    expect(current?.imageRevision).toBe(3);
    act(() => current!.flushControls()); await flush();
    expect(current?.dirty).toBe(false); expect(current?.quality).toBe('full');
  });

  it('adopts an ACK Draft across new desired input, then resumes after an input pause', async () => {
    vi.useFakeTimers(); await render('a'); await flush();
    const gate = deferred<void>(); decode = () => gate.promise;
    act(() => current!.changeControls({ 'light.exposure': 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); }); await flush();
    const revision = current!.settings!.revision;
    act(() => current!.changeControls({ 'light.exposure': 2 }));
    decode = async () => {}; await act(async () => gate.resolve()); await flush();
    expect(current?.quality).toBe('draft'); expect(current?.imageRevision).toBe(revision);
    expect(current?.desired?.['light.exposure']).toBe(2); expect(current?.settings?.values['light.exposure']).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); }); await flush();
    expect(current?.imageRevision).toBe(revision + 1);
    act(() => current!.changeControls({ 'light.exposure': 3 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); }); await flush();
    expect(current?.imageRevision).toBe(revision + 2);
    act(() => current!.flushControls()); await flush(); expect(current?.quality).toBe('full');
  });

  it('resynchronizes a render revision once without rewriting its History checkpoint', async () => {
    await render('a'); await flush();
    const saved = current!.settings!.recipeFingerprint;
    vi.mocked(api.readRawSettings).mockImplementationOnce(async doc => ({ ...rawSettings(doc), revision: doc.revision + 1,
      settingsFingerprint: 'f'.repeat(64), recipeFingerprint: saved! }));
    vi.mocked(api.rawPreview).mockRejectedValueOnce(new api.RawSuperseded('revision'));
    act(() => current!.viewChanged()); await flush();
    expect(current?.settings?.settingsFingerprint).toBe('f'.repeat(64));
    expect(current?.dirty).toBe(true);
    await act(async () => { await expect(current!.prepareSave()).rejects.toThrow('raw_history_readback_mismatch'); });
    expect(commitHistory).not.toHaveBeenCalled();
    expect(current?.saveError).toBe('raw_history_readback_mismatch');
  });
  it('discards a delayed Full after an edit and drains the latest Draft before final Full', async () => {
    const gate = deferred<api.RawFrame>(); vi.mocked(api.rawPreview).mockReturnValueOnce(gate.promise);
    await render('a'); await flush();
    expect(current?.locked).toBe(false);
    act(() => { current!.beginControls('light.exposure'); current!.changeControls({ 'light.exposure': 1 }); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); }); await flush();
    expect(api.rawPreview).toHaveBeenCalledOnce();
    expect(api.cancelRawPreview).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'a' }), 'after', 1);
    await act(async () => gate.resolve({ blob: new Blob(['stale']), width: 16, height: 12, epoch: 1, sequence: 1 })); await flush();
    expect(createURL).toHaveBeenCalledOnce();
    expect(vi.mocked(api.rawPreview).mock.calls.at(-1)?.[4]?.quality).toBe('draft');
    act(() => current!.flushControls()); await flush();
    expect(vi.mocked(api.rawPreview).mock.calls.at(-1)?.[4]?.quality).toBe('full');
    expect(api.setRawControls).toHaveBeenCalledOnce();
  });

  it('refuses a native Before pair with a different geometry while keeping saving usable', async () => {
    enableBefore();
    const implementation = vi.mocked(api.rawPreview).getMockImplementation()!;
    vi.mocked(api.rawPreview).mockImplementation(async (...args) => ({ ...await implementation(...args),
      quality: args[4]?.quality ?? 'full', frame: { geometryId: (args[3] === 'before' ? 'b' : 'a').repeat(64),
        nativeWidth: 6000, nativeHeight: 4500, aspect: 4 / 3, fullWidth: 16, fullHeight: 12, window: null } }));
    await render('a', true); await flush();
    expect(current?.beforeUrl).toBeUndefined(); expect(current?.beforeStatus).toBe('error');
    expect(current?.frame?.nativeWidth).toBe(6000); expect(current?.width).toBe(16);
    await act(async () => current!.prepareSave());
    expect(current?.saveError).toBeUndefined();
  });
  it('requests Draft on acknowledged interaction and Full on end without another mutation', async () => {
    await render('a'); await flush();
    act(() => { current!.beginControls('light.exposure'); current!.changeControls({ 'light.exposure': 1 }); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); }); await flush();
    expect(vi.mocked(api.rawPreview).mock.calls.at(-1)?.[4]?.quality).toBe('draft');
    const revision = current!.settings!.revision;
    act(() => current!.flushControls('light.exposure')); await flush();
    const calls = vi.mocked(api.rawPreview).mock.calls;
    expect(calls.at(-1)?.[4]?.quality).toBe('full');
    expect(calls.at(-1)?.[0].revision).toBe(revision);
    expect(calls.at(-1)?.[1]).toBeGreaterThan(calls.at(-2)![1]);
    expect(api.setRawControls).toHaveBeenCalledOnce();
  });

  it('finishes saving while Draft decode is stalled and rejects its late publication', async () => {
    await render('a'); await flush();
    const gate = deferred<void>(); decode = () => gate.promise;
    act(() => { current!.beginControls('light.exposure'); current!.changeControls({ 'light.exposure': 1 }); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 170)); }); await flush();
    const previous = current!.url;
    act(() => current!.flushControls()); await flush();
    await act(async () => { await current!.prepareSave(); });
    expect(current?.dirty).toBe(false); expect(current?.saveError).toBeUndefined();
    decode = async () => {};
    await act(async () => gate.resolve()); await flush();
    expect(current?.url).toBe(previous);
    act(() => current!.resumeEditing());
    act(() => current!.viewChanged()); await flush();
    expect(vi.mocked(api.rawPreview).mock.calls.at(-1)?.[4]?.quality).toBe('full');
    expect(current?.url).not.toBe(previous);
  });
  it('loads lazily, reuses across edits and toggles, and releases on document change', async () => {
    enableBefore();
    await render('a'); await flush();
    expect(api.rawPreview).toHaveBeenCalledTimes(1);
    const saves = vi.mocked(api.saveRawHistory).mock.calls.length;
    await render('a', true); await flush();
    const before = current?.beforeUrl;
    expect(before).toBeTruthy(); expect(current?.beforeStatus).toBe('ready');
    expect(api.rawPreview).toHaveBeenCalledTimes(2);
    expect(api.saveRawHistory).toHaveBeenCalledTimes(saves);
    expect(current?.dirty).toBe(false);
    await render('a', false); await render('a', true); await flush();
    expect(api.rawPreview).toHaveBeenCalledTimes(2);
    act(() => { current!.changeControls({ 'light.exposure': 1 }); current!.flushControls(); }); await flush();
    expect(vi.mocked(api.rawPreview).mock.calls.filter(call => call[3] === 'before')).toHaveLength(1);
    expect(current?.beforeUrl).toBe(before);
    await render('b', false); await flush();
    expect(current?.beforeUrl).toBeUndefined();
    await render('b', true); await flush();
    expect(revokeURL).toHaveBeenCalledWith(before);
    expect(vi.mocked(api.rawPreview).mock.calls.filter(call => call[3] === 'before')).toHaveLength(2);
  });

  it('keeps After editing usable when Before fails or decoded dimensions do not match', async () => {
    enableBefore(); await render('a'); await flush();
    const after = current?.url;
    vi.mocked(api.rawPreview).mockRejectedValueOnce(new api.RawApiError('raw_before_unsupported'));
    await render('a', true); await flush();
    expect(current?.beforeStatus).toBe('error'); expect(current?.url).toBe(after);
    expect(current?.editError).toBeUndefined(); expect(current?.locked).toBe(false);
    act(() => { current!.changeControls({ 'light.exposure': 1 }); current!.flushControls(); }); await flush();
    expect(current?.settings?.values['light.exposure']).toBe(1); expect(current?.dirty).toBe(false);
    vi.mocked(api.rawPreview).mockResolvedValueOnce({ blob: new Blob(), width: 17, height: 12,
      epoch: 1, sequence: 1, kind: 'before', key: 'b'.repeat(64) });
    act(() => current?.retryBefore()); await flush();
    expect(current?.beforeStatus).toBe('error'); expect(current?.beforeUrl).toBeUndefined();
  });

  it('discards a Before result decoded after its document was replaced', async () => {
    enableBefore(); await render('a'); await flush();
    const pending = deferred<void>(); decode = () => pending.promise;
    await render('a', true); await flush();
    const candidate = `blob:raw-${createURL.mock.calls.length}`;
    decode = async () => {};
    await render('b'); await flush();
    await act(async () => pending.resolve()); await flush();
    expect(current?.assetId).toBe('b'); expect(current?.beforeUrl).toBeUndefined();
    expect(revokeURL).toHaveBeenCalledWith(candidate);
  });
});
describe('RAW document lifetime', () => {
  it('drains an accepted adjacent control when departure freezes a pending first commit', async () => {
    await render('a'); await flush();
    const pending = deferred<api.RawHistoryResult>(); commitHistory.mockReturnValueOnce(pending.promise);
    act(() => { current!.changeControls({ 'light.exposure': 1 }); current!.changeControls({ 'light.contrast': 20 }); });
    await flush();
    let departing!: Promise<void>;
    act(() => { departing = current!.prepareSave(); }); await flush();
    const request = commitHistory.mock.calls[0][0]; expect(request.control).toBe('light.exposure');
    await act(async () => { pending.resolve(rawHistoryResult(request)); await departing; }); await flush();
    expect(commitHistory).toHaveBeenCalledTimes(2); expect(current?.settings?.values['light.contrast']).toBe(20);
    expect(current?.dirty).toBe(false); expect(api.releaseRawWorkspace).not.toHaveBeenCalled();
  });
  it('can persist verified native readback when only its edited Preview fails', async () => {
    await render('a'); await flush();
    vi.mocked(api.rawPreview).mockRejectedValueOnce(new api.RawApiError('raw_render_failed'));
    act(() => { current!.changeControls({ 'light.exposure': 2 }); current!.flushControls(); }); await flush();
    expect(current?.displayError).toBe('raw_render_failed'); expect(current?.editError).toBeUndefined(); expect(current?.saveError).toBeUndefined();
    expect(commitHistory).toHaveBeenCalledOnce(); expect(current?.dirty).toBe(false);
    await act(async () => { await current!.prepareSave(); });
    expect(current?.settings?.values['light.exposure']).toBe(2);
  });
  it('retries failed native readback before creating the History commit request', async () => {
    await render('a'); await flush();
    vi.mocked(api.setRawControls).mockRejectedValueOnce(new api.RawApiError('raw_connection_failed'));
    act(() => { current!.changeControls({ 'light.exposure': 2 }); current!.flushControls(); }); await flush();
    expect(current?.saveError).toBe('raw_connection_failed'); expect(commitHistory).not.toHaveBeenCalled();
    await act(async () => { await current!.retrySave(); }); await flush();
    expect(current?.saveError).toBeUndefined(); expect(current?.settings?.values['light.exposure']).toBe(2);
    expect(commitHistory).toHaveBeenCalledOnce(); expect(current?.dirty).toBe(false);
  });
  it('commits an unmounted document before releasing or opening its successor', async () => {
    await render('a'); await flush();
    act(() => current!.changeControls({ 'light.exposure': 2 }));
    const pending = deferred<api.RawHistoryResult>(); commitHistory.mockReturnValueOnce(pending.promise);
    await render('b'); await flush();
    expect(api.openRawDocument).toHaveBeenCalledOnce(); expect(api.releaseRawWorkspace).not.toHaveBeenCalled();
    const request = commitHistory.mock.calls[0][0]; expect(request.doc.assetId).toBe('a');
    await act(async () => pending.resolve(rawHistoryResult(request))); await flush();
    expect(current?.assetId).toBe('b'); expect(current?.dirty).toBe(false);
    expect(api.releaseRawWorkspace).toHaveBeenCalledOnce();
  });
  it('rejects old slider callbacks after a successor RAW document has opened', async () => {
    await render('a'); await flush(); const old = current!;
    await render('b'); await flush();
    act(() => { old.changeControls({ 'light.exposure': 2 }); old.flushControls(); }); await flush();
    expect(api.setRawControls).not.toHaveBeenCalled(); expect(current?.document?.assetId).toBe('b');
  });
  it('discards a Preview revision immediately when newer desired values arrive', async () => {
    vi.useFakeTimers();
    await render('raw'); await flush();
    const pending = deferred<api.RawFrame>(); vi.mocked(api.rawPreview).mockReturnValueOnce(pending.promise);
    act(() => { current!.changeControls({ 'light.exposure': 1 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); }); await flush();
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
    expect(current?.status).toBe('ready'); expect(current?.displayError).toBeDefined(); expect(current?.url).toBeUndefined();
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
    expect(current?.status).toBe('ready'); expect(current?.displayError).toBeDefined(); expect(current?.url).toBeUndefined();
    expect(revokeURL).toHaveBeenCalledWith('blob:raw-1');
  });
  it('releases native ownership and the displayed URL on pagehide', async () => {
    await render('a'); await flush();
    await act(async () => window.dispatchEvent(new Event('pagehide'))); await flush();
    expect(current?.status).toBe('error'); expect(current?.url).toBeUndefined();
    expect(revokeURL).toHaveBeenCalledWith('blob:raw-1');
    expect(api.releaseRawWorkspace).toHaveBeenCalledWith('workspace');
  });
  it('saves each gesture immediately and never sends recipe-only autosave', async () => {
    vi.useFakeTimers(); await render('a'); await flush();
    act(() => { current!.changeControls({ 'light.exposure': 1 }); current!.flushControls(); }); await flush();
    expect(current?.dirty).toBe(false);
    const url = current?.url;
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(commitHistory).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); await flush();
    expect(commitHistory).toHaveBeenCalledOnce(); expect(current?.dirty).toBe(false); expect(current?.url).toBe(url);
  });
  it('freezes input, flushes desired values, waits for readback and SQLite acknowledgement before leaving', async () => {
    await render('a'); await flush();
    const mutation = deferred<api.RawSettings>(), saving = deferred<api.RawHistoryResult>();
    vi.mocked(api.setRawControls).mockReturnValueOnce(mutation.promise);
    commitHistory.mockReturnValueOnce(saving.promise);
    act(() => current!.changeControls({ 'light.exposure': 2 }));
    let transition!: Promise<void>;
    act(() => { transition = current!.prepareSave(); }); await flush();
    expect(current?.locked).toBe(true); expect(commitHistory).not.toHaveBeenCalled();
    act(() => current!.changeControls({ 'light.exposure': 4 }));
    const confirmed = { ...current!.settings!, revision: 2, settingsFingerprint: '2'.repeat(64),
      values: { ...current!.settings!.values, 'light.exposure': 2 } };
    await act(async () => mutation.resolve(confirmed)); await flush();
    expect(commitHistory).toHaveBeenCalledOnce(); expect(current?.saving).toBe(true);
    const request = commitHistory.mock.calls[0][0];
    await act(async () => saving.resolve(rawHistoryResult(request)));
    await act(async () => transition); expect(current?.dirty).toBe(false);
    expect(api.setRawControls).toHaveBeenCalledOnce();
  });
  it('ignores the save completion for a document that has been replaced', async () => {
    await render('a'); await flush();
    act(() => { current!.changeControls({ 'light.exposure': 1 }); });
    const gate = deferred<api.RawHistoryResult>(); commitHistory.mockReturnValueOnce(gate.promise);
    let transition!: Promise<unknown>;
    act(() => { transition = current!.prepareSave().catch(error => error); }); await flush();
    const request = commitHistory.mock.calls[0][0];
    await render('b');
    await act(async () => gate.resolve(rawHistoryResult(request)));
    await transition; await flush();
    expect(current?.assetId).toBe('b'); expect(current?.saveError).toBeUndefined();
  });
});

describe('RAW History document integration', () => {
  function backend(attempts = 0) {
    const model = fakeRawHistory(2, 2, attempts);
    vi.mocked(api.readRawSettings).mockImplementation(async doc => model.settings(doc));
    vi.mocked(api.saveRawHistory).mockImplementation(async request => model.save(request));
    vi.mocked(api.readRawHistory).mockImplementation(async (doc, offset) => model.page(doc, offset));
    return model;
  }
  it('publishes SQLite cursor, controls and a fresh Preview after moving', async () => {
    const model = backend(); await render('a'); await flush();
    expect(current?.history?.cursor).toBe(2); expect(current?.historySteps).toHaveLength(2);
    act(() => current!.undo()); await flush();
    expect(current?.history?.cursor).toBe(1); expect(current?.settings?.values['light.exposure']).toBe(1);
    expect(current?.url).toBe('blob:raw-2'); expect(current?.canRedo).toBe(true); expect(current?.dirty).toBe(false);
    act(() => current!.jumpHistory(null)); await flush(); expect(current?.history?.cursor).toBe(0);
    expect(current?.canUndo).toBe(false); expect(current?.history?.length).toBe(2);
    act(() => current!.redo()); await flush(); expect(current?.history?.cursor).toBe(1);
    expect(model.entries).toHaveLength(2);
  });
  it('waits for a cursor save before departure and suppresses repeated moves', async () => {
    const model = backend(); await render('a'); await flush();
    const pending = deferred<api.RawHistoryResult>(); vi.mocked(api.saveRawHistory).mockReturnValueOnce(pending.promise);
    act(() => current!.undo()); await flush(); const request = vi.mocked(api.saveRawHistory).mock.calls[1][0];
    act(() => { current!.undo(); current!.redo(); current!.jumpHistory(null); });
    let departing!: Promise<void>; act(() => { departing = current!.prepareSave(); }); await flush();
    expect(current?.locked).toBe(true); expect(api.saveRawHistory).toHaveBeenCalledTimes(2);
    expect(api.releaseRawWorkspace).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(model.save(request)); await departing; }); await flush();
    expect(current?.history?.cursor).toBe(1); expect(current?.dirty).toBe(false);
  });
  it('keeps a failed History move locked and replays its immutable request on Retry', async () => {
    const model = backend(); await render('a'); await flush();
    vi.mocked(api.saveRawHistory).mockImplementationOnce(async request => {
      model.save(request); throw new api.RawSaveError('raw_history_save_failed', 'unknown');
    });
    act(() => current!.undo()); await flush();
    const request = vi.mocked(api.saveRawHistory).mock.calls[1][0];
    expect(current?.saveError).toBe('raw_history_save_failed'); expect(current?.history?.cursor).toBe(2);
    await act(async () => { await current!.retrySave(); }); await flush();
    expect(vi.mocked(api.saveRawHistory).mock.calls[2][0]).toEqual(request);
    expect(current?.history?.cursor).toBe(1); expect(current?.locked).toBe(false);
  });
  it('refreshes History from SQLite after a move reaches 200 and renews the session', async () => {
    backend(199); let generation = 1;
    vi.mocked(api.openRawDocument).mockImplementation(async (workspaceId, assetId) => ({ workspaceId, assetId,
      generation, handle: `handle-${generation}`, documentToken: `token-${generation}`, revision: 1 }));
    vi.mocked(api.releaseRawWorkspace).mockImplementation(async () => { generation++; });
    await render('a'); await flush();
    act(() => current!.undo());
    await act(async () => { for (let i = 0; i < 160; i++) await Promise.resolve(); });
    expect(current?.document?.generation).toBe(2); expect(current?.history?.cursor).toBe(1); expect(current?.canRedo).toBe(true);
    expect(current?.historySteps).toHaveLength(2); expect(api.readRawHistory).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.saveRawHistory).mock.calls.map(([r]) => r.action)).toEqual(['initialize', 'undo', 'initialize']);
  });
  it('never publishes a late History move or its Preview into the successor document', async () => {
    const model = backend(); await render('a'); await flush(); const old = current!;
    const pending = deferred<api.RawHistoryResult>(); vi.mocked(api.saveRawHistory).mockReturnValueOnce(pending.promise);
    act(() => current!.undo()); await flush(); const request = vi.mocked(api.saveRawHistory).mock.calls[1][0];
    await render('b');
    await act(async () => pending.resolve(model.save(request))); await flush();
    expect(current?.assetId).toBe('b'); expect(current?.saveError).toBeUndefined();
    const count = vi.mocked(api.saveRawHistory).mock.calls.length;
    act(() => old.undo()); await flush(); expect(api.saveRawHistory).toHaveBeenCalledTimes(count);
    expect(api.rawPreview).toHaveBeenCalledTimes(2);
  });
  it('reserves the move on the queue even when unmounted in the same event', async () => {
    backend(); await render('a'); await flush();
    act(() => { current!.undo(); root.render(<Harness id="b" />); }); await flush();
    expect(vi.mocked(api.saveRawHistory).mock.calls.map(([r]) => [r.doc.assetId, r.action])).toEqual([
      ['a', 'initialize'], ['a', 'undo'], ['b', 'initialize']]);
    expect(current?.assetId).toBe('b'); expect(api.releaseRawWorkspace).toHaveBeenCalledOnce();
  });
  it('keeps a confirmed cursor save when only its Preview fails', async () => {
    backend(); await render('a'); await flush();
    vi.mocked(api.rawPreview).mockRejectedValueOnce(new api.RawApiError('raw_render_failed'));
    act(() => current!.undo()); await flush();
    expect(current?.history?.cursor).toBe(1); expect(current?.dirty).toBe(false);
    expect(current?.displayError).toBe('raw_render_failed'); expect(current?.editError).toBeUndefined(); expect(current?.saveError).toBeUndefined();
  });
});


describe('bounded RAW session renewal', () => {
  function renewal() {
    let generation = 1, attempts = 199;
    let saved: api.RawHistoryRequest | undefined;
    vi.mocked(api.createRawWorkspace).mockImplementation(async () => `workspace-${generation}`);
    vi.mocked(api.openRawDocument).mockImplementation(async (workspaceId, assetId) => ({
      workspaceId, assetId, handle: `handle-${generation}`, generation, documentToken: `token-${generation}`, revision: 1 }));
    vi.mocked(api.readRawSettings).mockImplementation(async doc => ({ ...rawSettings(doc), mutationAttempts: attempts,
      ...(saved ? { values: saved.doc.values, settingsFingerprint: saved.doc.settingsFingerprint,
        recipeFingerprint: saved.doc.settingsFingerprint, recipeRevision: saved.expectedRecipeRevision + 1 } : {}) }));
    vi.mocked(api.setRawControls).mockImplementation(async (doc, patch) => ({ ...doc as api.RawSettings,
      revision: doc.revision + 1, mutationAttempts: ++attempts, settingsFingerprint: String(attempts).padStart(64, '0'),
      values: { ...(doc as api.RawSettings).values, ...patch } }));
    commitHistory.mockImplementation(async request => {
      saved = request;
      return rawHistoryResult(request);
    });
    vi.mocked(api.releaseRawWorkspace).mockImplementation(async () => { generation++; attempts = 1; });
    return { saved: () => saved };
  }
  async function drain() { await act(async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); }); }
  it('reacquires native Before after renewal and revokes the previous generation URL', async () => {
    renewal();
    const readSettings = vi.mocked(api.readRawSettings).getMockImplementation()!;
    vi.mocked(api.readRawSettings).mockImplementation(async doc => ({ ...await readSettings(doc),
      beforeKey: String(doc.generation).padStart(64, '0') }));
    vi.mocked(api.rawPreview).mockImplementation(async (doc, _serial, _signal, kind = 'after') => ({
      blob: new Blob(), width: 16, height: 12, epoch: 1, sequence: 1, kind,
      ...(kind === 'before' ? { key: doc.beforeKey! } : {}) }));
    await render('a', true); await drain();
    const before = current?.beforeUrl;
    expect(before).toBeTruthy();
    act(() => { current!.changeControls({ 'light.exposure': 1 }); current!.flushControls(); }); await drain();
    expect(current?.document?.generation).toBe(2);
    expect(revokeURL).toHaveBeenCalledWith(before);
    expect(vi.mocked(api.rawPreview).mock.calls.filter(call => call[3] === 'before')).toHaveLength(2);
    expect(current?.beforeUrl).toBeTruthy(); expect(current?.beforeUrl).not.toBe(before);
    expect(current?.dirty).toBe(false);
  });
  it('saves a compound Reset before renewal and restores its WB, category state and History cursor', async () => {
    renewal();
    let saved: api.RawHistoryResult | undefined;
    vi.mocked(api.readRawSettings).mockImplementation(async doc => ({ ...rawSettings(doc), mutationAttempts: doc.generation === 1 ? 199 : 1,
      ...(saved ? { values: saved.values, sections: saved.sections, settingsFingerprint: saved.settingsFingerprint,
        recipeFingerprint: saved.recipeFingerprint, recipeRevision: saved.recipeRevision } : {}) }));
    vi.mocked(api.saveRawHistory).mockImplementation(async request => {
      if (request.action === 'initialize') return rawHistoryResult(request, saved ? { history: saved.history } : {});
      const next = { ...request.doc, revision: request.doc.revision + 1, mutationAttempts: 201,
        settingsFingerprint: '8'.repeat(64), recipeFingerprint: '8'.repeat(64), sections: { light: true, color: false },
        values: { ...request.doc.values, 'wb.temp': 4875, 'wb.tint': 13 } };
      saved = rawHistoryResult({ ...request, doc: next }, { history: { initialized: true, length: 1, cursor: 1, selectedStepId: request.saveId } });
      return saved;
    });
    await render('a'); await drain();
    act(() => current!.operate({ kind: 'sectionReset', metadata: { section: 'color' } })); await drain();
    expect(api.releaseRawWorkspace).toHaveBeenCalledOnce();
    expect(current?.document?.generation).toBe(2);
    expect(current?.settings?.sections.color).toBe(false);
    expect(current?.settings?.values['wb.temp']).toBe(4875);
    expect(current?.history?.cursor).toBe(1); expect(current?.locked).toBe(false); expect(current?.dirty).toBe(false);
  });
  async function threshold() {
    await render('a'); await drain();
    act(() => { current!.beginControls('light.exposure'); current!.changeControls({ 'light.exposure': 1 }); });
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
    expect(commitHistory.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.releaseRawWorkspace).mock.invocationCallOrder[0]);
    expect(revokeURL).toHaveBeenCalledWith('blob:raw-1');
  });
  it('can prepare departure at the threshold without a pointer-end event or a queue deadlock', async () => {
    vi.useFakeTimers(); renewal(); await threshold();
    act(() => current!.changeControls({ 'light.exposure': 3 }));
    await act(async () => { await current!.prepareSave(); }); await drain();
    expect(commitHistory.mock.calls[0][0].doc.values['light.exposure']).toBe(3);
    expect(current?.dirty).toBe(false); expect(api.releaseRawWorkspace).not.toHaveBeenCalled();
  });
  it('keeps the old document and exact save request after saving fails, then retries before release', async () => {
    vi.useFakeTimers(); renewal(); await threshold();
    const save = commitHistory.getMockImplementation()!;
    commitHistory.mockRejectedValueOnce(new api.RawSaveError('raw_connection_failed', 'unknown'));
    act(() => current!.flushControls()); await drain();
    expect(current?.saveError).toBe('raw_connection_failed'); expect(current?.locked).toBe(true);
    expect(current?.document?.generation).toBe(1); expect(api.releaseRawWorkspace).not.toHaveBeenCalled();
    const first = commitHistory.mock.calls[0][0];
    commitHistory.mockImplementation(save);
    await act(async () => { await current!.retrySave(); }); await drain();
    expect(commitHistory.mock.calls[1][0]).toEqual(first);
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
    expect(current?.regenerating).toBe(false); await render(null);
    await act(async () => gate.resolve({ blob: new Blob(['stale']), width: 16, height: 12, epoch: 2, sequence: 1 })); await drain();
    expect(current).toBeNull(); expect(createURL).toHaveBeenCalledTimes(2);
    expect(api.releaseRawWorkspace).toHaveBeenCalledTimes(2);
  });
  it('waits for renewal save before allowing departure and rejects edits during renewal', async () => {
    vi.useFakeTimers(); renewal(); await threshold();
    const gate = deferred<void>(), save = commitHistory.getMockImplementation()!;
    commitHistory.mockImplementationOnce(async request => { await gate.promise; return save(request); });
    act(() => current!.flushControls()); await drain();
    expect(current?.regenerating).toBe(false); expect(current?.locked).toBe(true);
    let leaving!: Promise<void>;
    act(() => { current!.changeControls({ 'light.exposure': 4 }); leaving = current!.prepareSave(); });
    await drain(); expect(api.releaseRawWorkspace).not.toHaveBeenCalled();
    await act(async () => { gate.resolve(); await leaving; }); await drain();
    expect(current?.settings?.values['light.exposure']).toBe(1);
    expect(api.releaseRawWorkspace).not.toHaveBeenCalled();
    act(() => current!.resumeEditing()); await drain();
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
