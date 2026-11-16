// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRawDocument } from './useRawDocument';
import * as api from './rawApi';
import { rawSettings } from './test/rawSettings';
import { rawHistoryData, rawHistoryResult } from './test/rawHistory';

vi.mock('./rawApi', async original => ({ ...await original<typeof import('./rawApi')>(),
  discardRawWorkspace: vi.fn(), rawCapability: vi.fn(), createRawWorkspace: vi.fn(), openRawDocument: vi.fn(),
  rawRegionOwner: vi.fn(), rawRegion: vi.fn(), cancelRawRegion: vi.fn(async () => {}), rawPreview: vi.fn(),
  cancelRawPreview: vi.fn(async () => {}), readRawDocument: vi.fn(), readRawSettings: vi.fn(), setRawControls: vi.fn(),
  releaseRawWorkspace: vi.fn(), rawWorkspaceEmpty: vi.fn(), readRawHistory: vi.fn(), saveRawHistory: vi.fn(),
  saveRawRecipe: vi.fn(), readRawRecipe: vi.fn(), beginRawPointColorInteraction: vi.fn(),
  updateRawPointColorInteraction: vi.fn(), cancelRawPointColorInteraction: vi.fn(),
}));

const commitHistory = vi.fn(async (request: api.RawHistoryRequest): Promise<api.RawHistoryResult> => rawHistoryResult(request));
let root: Root, current: ReturnType<typeof useRawDocument>;
function Harness({ id }: { id: string | null }) { current = useRawDocument(id); return null; }
async function render(id: string | null) { await act(async () => { root.render(<Harness id={id} />); }); }
async function flush() { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.createElement('div'));
  vi.clearAllMocks();
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 16; naturalHeight = 12; decode() { return Promise.resolve(); } removeAttribute() {} });
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:departure'), revokeObjectURL: vi.fn() });
  vi.mocked(api.rawCapability).mockResolvedValue(true);
  vi.mocked(api.rawRegionOwner).mockResolvedValue({ sourceId: 'b'.repeat(64), supported: true });
  vi.mocked(api.rawRegion).mockRejectedValue(new api.RawApiError('raw_region_unsupported'));
  vi.mocked(api.createRawWorkspace).mockResolvedValue('workspace-a');
  vi.mocked(api.openRawDocument).mockImplementation(async (workspaceId, assetId) => ({
    workspaceId, assetId, handle: assetId, generation: 1, documentToken: assetId, revision: 1 }));
  vi.mocked(api.rawPreview).mockResolvedValue({ blob: new Blob(['png']), width: 16, height: 12, epoch: 1, sequence: 1 });
  vi.mocked(api.readRawDocument).mockImplementation(async doc => doc);
  vi.mocked(api.readRawSettings).mockImplementation(async doc => rawSettings(doc));
  vi.mocked(api.readRawHistory).mockImplementation(async doc => rawHistoryData(doc));
  vi.mocked(api.setRawControls).mockImplementation(async (doc, patch) => ({ ...rawSettings(doc), revision: doc.revision + 1,
    settingsFingerprint: String(doc.revision + 1).padStart(64, '0'), values: { ...rawSettings(doc).values, ...patch } }));
  commitHistory.mockReset().mockImplementation(async request => rawHistoryResult(request));
  vi.mocked(api.saveRawHistory).mockImplementation(async request => request.action === 'initialize'
    ? rawHistoryResult(request) : commitHistory(request));
  vi.mocked(api.releaseRawWorkspace).mockResolvedValue();
  vi.mocked(api.rawWorkspaceEmpty).mockResolvedValue(false);
});

afterEach(async () => { act(() => root.unmount()); await flush(); vi.unstubAllGlobals(); });

it('holds ordinary departure at the saving boundary when History outcome is unknown', async () => {
  commitHistory.mockRejectedValueOnce(new api.RawSaveError('raw_connection_failed', 'unknown'));
  await render('a'); await flush();
  act(() => current!.changeControls({ 'light.exposure': 2 }));
  const saveStarted = render('b');
  await saveStarted; await flush();

  expect(commitHistory).toHaveBeenCalledOnce();
  expect(commitHistory.mock.calls[0][0].saveId).toBeTruthy();
  expect(api.releaseRawWorkspace).not.toHaveBeenCalled();
  expect(api.rawWorkspaceEmpty).not.toHaveBeenCalled();
  expect(api.createRawWorkspace).toHaveBeenCalledOnce();
  expect(api.openRawDocument).toHaveBeenCalledOnce();
  expect(current).toMatchObject({ assetId: 'b', status: 'error' });
});
