// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRawDocument } from './useRawDocument';
import * as api from './rawApi';
import { rawSettings } from './test/rawSettings';

vi.mock('./rawApi', async original => ({ ...await original<typeof import('./rawApi')>(),
  rawCapability: vi.fn(), createRawWorkspace: vi.fn(), openRawDocument: vi.fn(),
  rawPreview: vi.fn(), readRawDocument: vi.fn(), readRawSettings: vi.fn(), setRawControls: vi.fn(), releaseRawWorkspace: vi.fn() }));
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
    values: { ...rawSettings(doc).values, ...patch } }));
  vi.mocked(api.releaseRawWorkspace).mockResolvedValue();
});
afterEach(async () => { act(() => root.unmount()); await flush(); vi.unstubAllGlobals(); });
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
});
