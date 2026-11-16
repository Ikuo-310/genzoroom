// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRawDocument } from './useRawDocument';
import { RawRecipeSave, type RawDraftDiscardDecision } from './rawRecipeSave';
import { RawControls } from './rawControls';
import * as api from './rawApi';
import { rawSettings } from './test/rawSettings';
import { rawHistoryData, rawHistoryResult } from './test/rawHistory';

vi.mock('./rawApi', async original => ({ ...await original<typeof import('./rawApi')>(),
  createRawWorkspace: vi.fn(), openRawDocument: vi.fn(), rawCapability: vi.fn(), rawPreview: vi.fn(),
  readRawDocument: vi.fn(), readRawSettings: vi.fn(), readRawHistory: vi.fn(), saveRawHistory: vi.fn(), saveRawRecipe: vi.fn(),
  beginRawPointColorInteraction: vi.fn(), updateRawPointColorInteraction: vi.fn(), cancelRawPointColorInteraction: vi.fn(),
  discardRawWorkspace: vi.fn(), releaseRawWorkspace: vi.fn(), rawWorkspaceEmpty: vi.fn(), cancelRawPreview: vi.fn(async () => {}),
  rawRegionOwner: vi.fn(), rawRegion: vi.fn(), cancelRawRegion: vi.fn(async () => {}), setRawControls: vi.fn() }));

const commitHistory = vi.fn(async (request: api.RawHistoryRequest): Promise<api.RawHistoryResult> => rawHistoryResult(request));
let root: Root, host: HTMLDivElement, current: ReturnType<typeof useRawDocument>;
const color = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
  range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
const frame: api.RawFrame = { blob: new Blob(['preview']), width: 16, height: 12, epoch: 1, sequence: 1,
  interactionId: 'd'.repeat(32), interactionSequence: 1,
  frame: { geometryId: 'a'.repeat(64), nativeWidth: 4000, nativeHeight: 3000, aspect: 4 / 3,
    fullWidth: 16, fullHeight: 12, window: null } };
function Harness({ id = 'a' }: { id?: string } = {}) { current = useRawDocument(id); return <span>{current?.url}</span>; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); root = createRoot(host);
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 16; naturalHeight = 12; async decode() {} removeAttribute() {} });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:discard-test', revokeObjectURL: vi.fn() });
  vi.mocked(api.rawCapability).mockResolvedValue(true);
  vi.mocked(api.createRawWorkspace).mockResolvedValue('workspace-a');
  vi.mocked(api.openRawDocument).mockImplementation(async (workspaceId, assetId) => ({
    workspaceId, assetId, handle: 'handle-a', generation: 1, documentToken: 'token-a', revision: 1 }));
  vi.mocked(api.readRawDocument).mockImplementation(async doc => doc);
  vi.mocked(api.rawRegionOwner).mockResolvedValue({ sourceId: 'b'.repeat(64), supported: true });
  vi.mocked(api.rawRegion).mockRejectedValue(new api.RawApiError('raw_region_unsupported'));
  vi.mocked(api.readRawSettings).mockImplementation(async doc => ({ ...rawSettings(doc), point_colors: [color] }));
  vi.mocked(api.readRawHistory).mockImplementation(async doc => rawHistoryData(doc));
  vi.mocked(api.rawPreview).mockResolvedValue(frame);
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValue('d'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockImplementation(async (_doc, _serial, _signal, _target, operation) => operation.sequence);
  vi.mocked(api.cancelRawPointColorInteraction).mockResolvedValue();
  vi.mocked(api.discardRawWorkspace).mockResolvedValue();
  vi.mocked(api.releaseRawWorkspace).mockResolvedValue();
  vi.mocked(api.rawWorkspaceEmpty).mockResolvedValue(false);
  commitHistory.mockReset().mockImplementation(async request => rawHistoryResult(request));
  vi.mocked(api.saveRawHistory).mockImplementation(async request => request.action === 'initialize'
    ? rawHistoryResult(request) : commitHistory(request));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); vi.unstubAllGlobals();
});

it('preserves an unresolved public Point Color History operation instead of discarding its workspace', async () => {
  await act(async () => { root.render(<Harness />); }); await flush();
  expect(current).toMatchObject({ status: 'ready', history: { initialized: true } });
  const unknownSave = new api.RawSaveError('raw_history_save_failed', 'unknown');
  commitHistory.mockRejectedValueOnce(unknownSave);

  act(() => current!.operate({ kind: 'pointColorDelete', metadata: { index: 0 } }));
  await flush();
  expect(commitHistory).toHaveBeenCalledOnce();
  const pendingSave = commitHistory.mock.calls[0]![0];
  expect(pendingSave).toMatchObject({ action: 'operate', operation: { kind: 'pointColorDelete', metadata: { index: 0 } } });
  expect(current).toMatchObject({ saving: false, movingHistory: false, saveError: 'raw_history_save_failed' });

  await expect(act(async () => current!.discardChanges())).rejects.toMatchObject({ code: 'raw_save_unconfirmed' });
  expect(api.discardRawWorkspace).not.toHaveBeenCalled();
  act(() => current!.operate({ kind: 'pointColorReset', metadata: {} }));
  await flush();
  expect(commitHistory).toHaveBeenCalledOnce();

  commitHistory.mockImplementationOnce(async request => rawHistoryResult(request));
  await act(async () => { await current!.retrySave(); });
  expect(commitHistory).toHaveBeenCalledTimes(2);
  expect(commitHistory.mock.calls[1]![0]).toEqual(pendingSave);
  await act(async () => { await current!.discardChanges(); });
  expect(api.discardRawWorkspace).toHaveBeenCalledOnce();
  expect(api.discardRawWorkspace).toHaveBeenCalledWith({ workspaceId: 'workspace-a' });
});

it('disposes the explicit discard owner resources after a later open completes its retry', async () => {
  const saverDispose = vi.spyOn(RawRecipeSave.prototype, 'dispose');
  const editorDispose = vi.spyOn(RawControls.prototype, 'dispose');
  const retryDiscard = deferred<void>();
  vi.mocked(api.cancelRawPointColorInteraction).mockRejectedValueOnce(new api.RawApiError('raw_connection_failed'));
  vi.mocked(api.discardRawWorkspace).mockRejectedValueOnce(new api.RawApiError('raw_connection_failed'))
    .mockRejectedValueOnce(new api.RawApiError('raw_connection_failed')).mockReturnValueOnce(retryDiscard.promise);
  vi.mocked(api.rawWorkspaceEmpty).mockResolvedValue(false);

  await act(async () => { root.render(<Harness />); }); await flush();
  act(() => { expect(current!.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true); }); await flush();
  await expect(act(async () => current!.discardChanges())).rejects.toMatchObject({ code: 'raw_connection_failed' });
  expect(api.discardRawWorkspace).toHaveBeenCalledTimes(2);
  expect(saverDispose).not.toHaveBeenCalled();
  expect(editorDispose).not.toHaveBeenCalled();

  await act(async () => { root.render(<Harness id="b" />); }); await flush();
  expect(api.discardRawWorkspace).toHaveBeenCalledTimes(3);
  expect(saverDispose).not.toHaveBeenCalled();
  await act(async () => { root.render(<Harness id="c" />); }); await flush();
  await act(async () => { retryDiscard.resolve(); await flush(); });
  expect(api.discardRawWorkspace).toHaveBeenCalledTimes(3);
  expect(api.discardRawWorkspace).toHaveBeenLastCalledWith({ workspaceId: 'workspace-a' });
  expect(saverDispose).toHaveBeenCalledOnce();
  expect(editorDispose).toHaveBeenCalledOnce();
  expect(vi.mocked(api.openRawDocument).mock.invocationCallOrder[1])
    .toBeGreaterThan(editorDispose.mock.invocationCallOrder[0]);
  expect(api.openRawDocument).not.toHaveBeenCalledWith('workspace-a', 'b');
  expect(current?.document?.assetId).toBe('c');
  saverDispose.mockRestore();
  editorDispose.mockRestore();
});

it('runs common cleanup after an initial explicit discard succeeds', async () => {
  const saverDispose = vi.spyOn(RawRecipeSave.prototype, 'dispose');
  const editorDispose = vi.spyOn(RawControls.prototype, 'dispose');
  await act(async () => { root.render(<Harness />); }); await flush();

  await act(async () => { await current!.discardChanges(); });

  expect(api.discardRawWorkspace).toHaveBeenCalledOnce();
  expect(saverDispose).toHaveBeenCalledOnce();
  expect(editorDispose).toHaveBeenCalledOnce();
  expect(current).toMatchObject({ status: 'error', code: 'raw_document_closed' });
  saverDispose.mockRestore();
  editorDispose.mockRestore();
});

it('runs common cleanup when the same explicit discard owner is retried successfully', async () => {
  const saverDispose = vi.spyOn(RawRecipeSave.prototype, 'dispose');
  const editorDispose = vi.spyOn(RawControls.prototype, 'dispose');
  vi.mocked(api.discardRawWorkspace).mockRejectedValueOnce(new api.RawApiError('raw_connection_failed'))
    .mockRejectedValueOnce(new api.RawApiError('raw_connection_failed')).mockResolvedValueOnce();
  vi.mocked(api.rawWorkspaceEmpty).mockResolvedValue(false);
  await act(async () => { root.render(<Harness />); }); await flush();
  act(() => { expect(current!.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true); }); await flush();

  await expect(act(async () => current!.discardChanges())).rejects.toMatchObject({ code: 'raw_connection_failed' });
  expect(saverDispose).not.toHaveBeenCalled();
  expect(editorDispose).not.toHaveBeenCalled();
  await act(async () => { await current!.discardChanges(); });

  expect(api.discardRawWorkspace).toHaveBeenCalledTimes(3);
  expect(saverDispose).toHaveBeenCalledOnce();
  expect(editorDispose).toHaveBeenCalledOnce();
  saverDispose.mockRestore();
  editorDispose.mockRestore();
});

it('runs common cleanup when a later open confirms an explicit discard is already empty', async () => {
  const saverDispose = vi.spyOn(RawRecipeSave.prototype, 'dispose');
  const editorDispose = vi.spyOn(RawControls.prototype, 'dispose');
  vi.mocked(api.cancelRawPointColorInteraction).mockRejectedValueOnce(new api.RawApiError('raw_connection_failed'));
  vi.mocked(api.discardRawWorkspace).mockRejectedValueOnce(new api.RawApiError('raw_connection_failed'))
    .mockRejectedValueOnce(new api.RawApiError('raw_connection_failed'));
  vi.mocked(api.rawWorkspaceEmpty).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await act(async () => { root.render(<Harness />); }); await flush();
  act(() => { expect(current!.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true); }); await flush();

  await expect(act(async () => current!.discardChanges())).rejects.toMatchObject({ code: 'raw_connection_failed' });
  expect(saverDispose).not.toHaveBeenCalled();
  expect(editorDispose).not.toHaveBeenCalled();
  await act(async () => { root.render(<Harness id="b" />); }); await flush();

  expect(api.rawWorkspaceEmpty).toHaveBeenCalledTimes(3);
  expect(api.discardRawWorkspace).toHaveBeenCalledTimes(2);
  expect(saverDispose).toHaveBeenCalledOnce();
  expect(editorDispose).toHaveBeenCalledOnce();
  expect(current?.document?.assetId).toBe('b');
  saverDispose.mockRestore();
  editorDispose.mockRestore();
});

it('releases instead of discarding when Finish wins an explicit discard and then confirms History', async () => {
  const saverDispose = vi.spyOn(RawRecipeSave.prototype, 'dispose');
  const editorDispose = vi.spyOn(RawControls.prototype, 'dispose');
  await act(async () => { root.render(<Harness />); }); await flush();
  act(() => { expect(current!.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true); }); await flush();
  act(() => current!.updatePointColorInteraction(38));
  await new Promise(resolve => setTimeout(resolve, 60)); await flush();

  const history = deferred<api.RawHistoryResult>();
  commitHistory.mockReturnValueOnce(history.promise);
  act(() => current!.finishPointColorInteraction()); await flush();
  expect(commitHistory).toHaveBeenCalledOnce();
  const finish = commitHistory.mock.calls[0]![0];
  let discarded!: Promise<void>;
  act(() => { discarded = current!.discardChanges(); void discarded.catch(() => {}); });
  await flush();
  expect(api.discardRawWorkspace).not.toHaveBeenCalled();
  expect(api.releaseRawWorkspace).not.toHaveBeenCalled();

  await act(async () => { root.render(<Harness id="b" />); }); await flush();
  expect(api.openRawDocument).toHaveBeenCalledOnce();
  vi.mocked(api.releaseRawWorkspace).mockRejectedValueOnce(new api.RawApiError('raw_connection_failed'));
  await act(async () => { history.resolve(rawHistoryResult(finish)); await discarded; await flush(); });
  expect(api.discardRawWorkspace).not.toHaveBeenCalled();
  expect(api.releaseRawWorkspace).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.releaseRawWorkspace).mock.calls).toEqual([['workspace-a'], ['workspace-a']]);
  expect(vi.mocked(api.releaseRawWorkspace).mock.invocationCallOrder[1]).toBeLessThan(
    vi.mocked(api.openRawDocument).mock.invocationCallOrder[1]);
  expect(api.openRawDocument).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.openRawDocument).mock.calls[1]![1]).toBe('b');
  expect(saverDispose).toHaveBeenCalledOnce();
  expect(editorDispose).toHaveBeenCalledOnce();
  saverDispose.mockRestore();
  editorDispose.mockRestore();
});

it('rechecks the same Saver immediately before sending a proven-draft discard', async () => {
  await act(async () => { root.render(<Harness />); }); await flush();
  act(() => { expect(current!.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true); }); await flush();
  const original = RawRecipeSave.prototype.canDiscardWorkspace;
  let checks = 0;
  const safety = vi.spyOn(RawRecipeSave.prototype, 'canDiscardWorkspace').mockImplementation(function (this: RawRecipeSave,
    decision?: RawDraftDiscardDecision) {
    checks++;
    return checks === 4 ? false : original.call(this, decision);
  });

  await expect(act(async () => current!.discardChanges())).rejects.toMatchObject({ code: 'raw_save_unconfirmed' });
  expect(checks).toBeGreaterThanOrEqual(4);
  expect(api.discardRawWorkspace).not.toHaveBeenCalled();
  safety.mockRestore();

  await act(async () => { await current!.discardChanges(); });
  expect(api.discardRawWorkspace).toHaveBeenCalledOnce();
});

it('keeps an unknown Finish save and retries it before releasing the same workspace', async () => {
  await act(async () => { root.render(<Harness />); }); await flush();
  act(() => { expect(current!.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true); }); await flush();
  act(() => current!.updatePointColorInteraction(38));
  await new Promise(resolve => setTimeout(resolve, 60)); await flush();

  commitHistory.mockRejectedValueOnce(new api.RawSaveError('raw_history_save_failed', 'unknown'));
  act(() => current!.finishPointColorInteraction()); await flush();
  expect(commitHistory).toHaveBeenCalledOnce();
  const uncertainRequest = commitHistory.mock.calls[0]![0];
  await expect(act(async () => current!.discardChanges())).rejects.toMatchObject({ code: 'raw_history_save_failed' });
  expect(api.discardRawWorkspace).not.toHaveBeenCalled();
  expect(api.releaseRawWorkspace).not.toHaveBeenCalled();

  commitHistory.mockImplementationOnce(async request => rawHistoryResult(request));
  await act(async () => { await current!.retrySave(); });
  expect(commitHistory).toHaveBeenCalledTimes(2);
  expect(commitHistory.mock.calls[1]![0]).toEqual(uncertainRequest);
  await act(async () => { await current!.discardChanges(); });
  expect(api.discardRawWorkspace).not.toHaveBeenCalled();
  expect(api.releaseRawWorkspace).toHaveBeenCalledOnce();
  expect(api.releaseRawWorkspace).toHaveBeenCalledWith('workspace-a');
});

it('releases after Finish succeeds when P1 cannot prove the interaction is draft-only', async () => {
  await act(async () => { root.render(<Harness />); }); await flush();
  expect(current).toMatchObject({ status: 'ready', locked: false, history: { initialized: true }, frame: expect.any(Object), imageRevision: 1 });
  act(() => { expect(current!.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true); }); await flush();
  act(() => current!.updatePointColorInteraction(28));
  await new Promise(resolve => setTimeout(resolve, 60)); await flush();
  const history = deferred<api.RawHistoryResult>();
  commitHistory.mockReturnValueOnce(history.promise);
  act(() => current!.finishPointColorInteraction()); await flush();
  expect(commitHistory).toHaveBeenCalledOnce();

  let request!: Promise<void>;
  act(() => { request = current!.discardChanges(); void request.catch(() => {}); });
  await flush();
  expect(api.discardRawWorkspace).not.toHaveBeenCalled();
  await act(async () => { history.resolve(rawHistoryResult(commitHistory.mock.calls[0]![0])); await flush(); });
  await expect(request).resolves.toBeUndefined();
  expect(api.discardRawWorkspace).not.toHaveBeenCalled();
  expect(api.releaseRawWorkspace).toHaveBeenCalledOnce();
});
