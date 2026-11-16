// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRawDocument } from './useRawDocument';
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
function Harness() { current = useRawDocument('a'); return <span>{current?.url}</span>; }
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

it('does not discard when P1 cannot prove the active Point Color interaction is draft-only', async () => {
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
  await expect(request).rejects.toMatchObject({ code: 'raw_save_unconfirmed' });
  expect(api.discardRawWorkspace).not.toHaveBeenCalled();
});
