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

let root: Root, current: ReturnType<typeof useRawDocument>;
const commitHistory = vi.fn(async (request: api.RawHistoryRequest): Promise<api.RawHistoryResult> => rawHistoryResult(request));
async function render(id: string | null) { await act(async () => { root.render(<Harness id={id} />); }); }
function Harness({ id }: { id: string | null }) { current = useRawDocument(id); return null; }
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.createElement('div'));
  vi.clearAllMocks();
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 16; naturalHeight = 12; decode() { return Promise.resolve(); } removeAttribute() {} });
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:revision-safety'), revokeObjectURL: vi.fn() });
  vi.mocked(api.rawCapability).mockResolvedValue(true);
  vi.mocked(api.rawRegionOwner).mockResolvedValue({ sourceId: 'b'.repeat(64), supported: true });
  vi.mocked(api.rawRegion).mockRejectedValue(new api.RawApiError('raw_region_unsupported'));
  vi.mocked(api.createRawWorkspace).mockResolvedValue('workspace');
  vi.mocked(api.openRawDocument).mockImplementation(async (workspaceId, assetId) => ({
    workspaceId, assetId, handle: assetId, generation: 1, documentToken: assetId, revision: 1 }));
  vi.mocked(api.rawPreview).mockResolvedValue({ blob: new Blob(['png']), width: 16, height: 12, epoch: 1, sequence: 1 });
  vi.mocked(api.readRawDocument).mockImplementation(async doc => doc);
  vi.mocked(api.readRawSettings).mockImplementation(async doc => rawSettings(doc));
  vi.mocked(api.readRawHistory).mockImplementation(async doc => rawHistoryData(doc));
  commitHistory.mockReset().mockImplementation(async request => rawHistoryResult(request));
  vi.mocked(api.saveRawHistory).mockImplementation(async request => request.action === 'initialize'
    ? rawHistoryResult(request) : commitHistory(request));
  vi.mocked(api.releaseRawWorkspace).mockResolvedValue();
  vi.mocked(api.rawWorkspaceEmpty).mockResolvedValue(false);
});

afterEach(async () => { act(() => root.unmount()); await flush(); vi.unstubAllGlobals(); });

it('resynchronizes a render revision once without rewriting its History checkpoint', async () => {
  await render('a'); await flush();
  expect(current?.status).toBe('ready');
  expect(api.rawPreview).toHaveBeenCalledOnce();
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
