// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AssetDetail } from './assets';
import { createEditStateSnapshot } from './editState';
import { editSession, newSession } from './editing';
import { EditStateApiError } from './editStateApi';
import { ExportQueueApiError, type ExportQueueItem, type ExportQueueStatus } from './exportQueueApi';
import i18n from './i18n';
import { clearWorkspaceSession } from './workspaceResume';
const api = vi.hoisted(() => ({ detail: vi.fn(), get: vi.fn(), put: vi.fn(), list: vi.fn(), enqueue: vi.fn(), dequeue: vi.fn() }));
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), fetchAssetDetail: api.detail }));
vi.mock('./editStateApi', async original => ({ ...await original<typeof import('./editStateApi')>(),
  getAssetEditState: api.get, putAssetEditState: api.put,
  getAssetEditStatuses: async () => ({ [first.id]: true, [second.id]: true }) }));
vi.mock('./exportQueueApi', async original => ({ ...await original<typeof import('./exportQueueApi')>(),
  listExportQueue: api.list, enqueueExportAssets: api.enqueue, dequeueExportAsset: api.dequeue }));
vi.mock('./ImageViewer', () => ({ ImageViewer: () => <div className="viewer-panel" /> }));
const first: AssetDetail = { id: '12345678-1234-4234-9234-123456789abc', filename: 'first.jpg',
  date: '2026-10-06', thumbnail_url: '/thumb', preview_url: '/preview', format: 'JPEG', is_raw: false, exif: {} };
const second = { ...first, id: '87654321-4321-4321-8321-cba987654321', filename: 'second.jpg' };
function snapshot(defaultWithHistory = false) {
  let session = editSession(editSession(newSession(), { type: 'temperature', value: 12 }), { type: 'commit' });
  if (defaultWithHistory) session = editSession(session, { type: 'allReset' });
  const result = createEditStateSnapshot(session, { provider: 'immich', assetId: first.id, inputKind: 'immich-preview' });
  if (!result.ok) throw new Error('Invalid fixture');
  return result.value;
}
const queueItem = (status: ExportQueueStatus): ExportQueueItem => ({ assetId: first.id, status,
  queuedAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z' });
let root: Root; let host: HTMLDivElement;
async function mount() {
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: `/anshitsu/${first.id}`,
    state: { selectedAssets: [first, second], activeAssetId: first.id } }]}><App /></MemoryRouter>));
}
async function q(init: KeyboardEventInit = {}, target: EventTarget = window) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true, ...init })); });
}
async function click(selector: string) { await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click()); }
const badge = (index = 0) => host.querySelectorAll<HTMLButtonElement>('.filmstrip-entry .edited-badge')[index];
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en'); clearWorkspaceSession();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  Object.values(api).forEach(mock => mock.mockReset());
  api.detail.mockImplementation(async id => id === first.id ? first : second);
  api.get.mockResolvedValue({ state: snapshot(), revision: 1, updatedAt: '2026-10-06T00:00:00Z', lastSaveId: crypto.randomUUID() });
  api.put.mockImplementation(async (_id, state, revision, saveId) => ({ state, revision: revision + 1,
    updatedAt: '2026-10-06T00:00:00Z', lastSaveId: saveId }));
  api.list.mockResolvedValue([]);
  api.enqueue.mockImplementation(async ids => ids.map((assetId: string) => ({ ...queueItem('queued'), assetId })));
  api.dequeue.mockResolvedValue(undefined);
});
afterEach(() => { act(() => root.unmount()); host.remove(); clearWorkspaceSession(); vi.unstubAllGlobals(); });
describe('Anshitsu Export Queue integration', () => {
  it('keeps initial unknown membership disabled until the Queue is loaded', async () => {
    let resolve!: (items: ExportQueueItem[]) => void;
    api.list.mockImplementation(() => new Promise<ExportQueueItem[]>(yes => { resolve = yes; }));
    await mount();
    expect(badge().disabled).toBe(true);
    expect(badge().classList.contains('queue-inactive')).toBe(false);
    await q(); expect(api.enqueue).not.toHaveBeenCalled();
    await act(async () => resolve([]));
    expect(badge().disabled).toBe(false);
    expect(badge().classList.contains('queue-inactive')).toBe(true);
  });
  it('preserves Recipe, History and membership after an enqueue failure', async () => {
    api.enqueue.mockRejectedValue(new ExportQueueApiError('network'));
    await mount();
    const history = host.querySelector('.edit-history')!.innerHTML;
    await q();
    expect(host.querySelector('.edit-history')!.innerHTML).toBe(history);
    expect(badge().classList.contains('queue-inactive')).toBe(true);
    expect(api.put).not.toHaveBeenCalled();
    expect(host.querySelector('.workspace-queue-error')?.textContent).toContain('Could not add');
  });
  it('enqueues a saved inactive photo without switching or fetching its edit-state', async () => {
    await mount(); await act(async () => badge(1).click());
    expect(api.enqueue).toHaveBeenCalledWith([second.id], expect.any(AbortSignal));
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[aria-current="true"]')?.getAttribute('aria-label')).toBe('first.jpg');
    expect(api.put).not.toHaveBeenCalled();
  });
  it('uses the same active operation for Q and badge click', async () => {
    await mount(); await q(); expect(api.enqueue).toHaveBeenCalledWith([first.id], expect.any(AbortSignal));
    await act(async () => badge().click()); expect(api.dequeue).toHaveBeenCalledWith(first.id, expect.any(AbortSignal));
    expect(api.put).not.toHaveBeenCalled();
  });
  it.each(['queued', 'failed'] as const)('Q removes %s without saving dirty Recipe', async status => {
    api.list.mockResolvedValue([queueItem(status)]); await mount();
    await click('button[aria-label="Disable Basic"]'); await q();
    expect(api.dequeue).toHaveBeenCalledWith(first.id, expect.any(AbortSignal)); expect(api.put).not.toHaveBeenCalled();
  });
  it.each(['waiting', 'encoding', 'registering'] as const)('locks %s for Q and badge', async status => {
    api.list.mockResolvedValue([queueItem(status)]); await mount(); await q();
    expect(badge().disabled).toBe(true); expect(api.enqueue).not.toHaveBeenCalled(); expect(api.dequeue).not.toHaveBeenCalled();
  });
  it('waits for dirty save and blocks duplicate Q until enqueue completes', async () => {
    let resolve!: (value: unknown) => void;
    api.put.mockImplementation(() => new Promise(yes => { resolve = yes; }));
    await mount(); await click('button[aria-label="Disable Basic"]'); await q(); await q();
    expect(api.put).toHaveBeenCalledTimes(1); expect(api.enqueue).not.toHaveBeenCalled(); expect(badge().disabled).toBe(true);
    const [, state, revision, saveId] = api.put.mock.calls[0];
    await act(async () => resolve({ state, revision: revision + 1, updatedAt: '2026-10-06T00:00:00Z', lastSaveId: saveId }));
    expect(api.enqueue).toHaveBeenCalledTimes(1);
    expect(api.enqueue).toHaveBeenCalledWith([first.id], expect.any(AbortSignal));
  });
  it('does not enqueue after failed save and shows a translated alert', async () => {
    api.put.mockRejectedValue(new EditStateApiError('network')); await mount();
    await click('button[aria-label="Disable Basic"]'); await q();
    expect(api.enqueue).not.toHaveBeenCalled(); expect(host.querySelector('.workspace-queue-error')?.textContent).toContain('Could not add');
    expect(host.querySelector('button[aria-label="Enable Basic"]')).not.toBeNull();
  });
  it.each([undefined, 'queued', 'waiting', 'failed'] as const)('keeps History-only noninteractive despite Queue status %s', async status => {
    api.get.mockResolvedValue({ state: snapshot(true), revision: 1, updatedAt: '2026-10-06T00:00:00Z', lastSaveId: crypto.randomUUID() });
    if (status) api.list.mockResolvedValue([queueItem(status)]);
    await mount();
    const entry = host.querySelector('.filmstrip-entry')!;
    const history = entry.querySelector<HTMLElement>('.filmstrip-history-badge')!;
    expect(history.getAttribute('aria-label')).toBe('Edit history retained');
    expect(entry.querySelector('.edited-badge')).toBeNull();
    expect(history.className).not.toContain('queue-');
    await act(async () => history.click()); await q();
    expect(api.enqueue).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
    expect(api.dequeue).not.toHaveBeenCalled();
    expect(host.querySelector('.workspace-queue-error')).toBeNull();
  });
  it('excludes dirty History-only Recipe from Q without changing autosave', async () => {
    await mount();
    const reset = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === i18n.t('workspace.allReset'))!;
    await act(async () => reset.click()); await q();
    expect(api.put).not.toHaveBeenCalled(); expect(api.enqueue).not.toHaveBeenCalled();
    expect(host.querySelector('.filmstrip-history-badge')).not.toBeNull();
  });
  it('refreshes canonical membership after default Recipe autosave cleanup', async () => {
    vi.useFakeTimers();
    try {
      api.list.mockResolvedValueOnce([queueItem('queued')]).mockResolvedValue([]); await mount();
      const reset = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === i18n.t('workspace.allReset'))!;
      await act(async () => reset.click());
      expect(host.querySelector('.filmstrip-entry:first-child .edited-badge')).toBeNull();
      expect(host.querySelector('.filmstrip-history-badge')).not.toBeNull();
      await q(); expect(api.dequeue).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(api.put).toHaveBeenCalledTimes(1); expect(api.list).toHaveBeenCalledTimes(2);
      expect(api.put.mock.calls[0][1].currentRecipe.adjustments.temperature).toBe(0);
      expect(api.put.mock.calls[0][1].history.length).toBeGreaterThan(0);
      expect(host.querySelector('.filmstrip-entry:first-child .edited-badge')).toBeNull();
      expect(host.querySelector('.filmstrip-history-badge')).not.toBeNull();
      expect(api.enqueue).not.toHaveBeenCalled();
      await click('button[aria-label="Disable Basic"]');
      expect(host.querySelector('.filmstrip-entry:first-child .edited-badge')?.classList.contains('queue-inactive')).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('preserves membership and active photo when dequeue fails', async () => {
    api.list.mockResolvedValue([queueItem('queued')]); api.dequeue.mockRejectedValue(new ExportQueueApiError('network'));
    await mount(); await q(); expect(badge().classList.contains('queue-queued')).toBe(true);
    expect(host.querySelector('.workspace-queue-error')?.textContent).toContain('Could not remove');
  });
  it('uses Backend eligibility for unvisited assets and reports not eligible', async () => {
    api.enqueue.mockRejectedValue(new ExportQueueApiError('not_eligible', 422, 'asset_not_eligible'));
    await mount(); await act(async () => badge(1).click());
    expect(api.get).toHaveBeenCalledTimes(1); expect(host.querySelector('.workspace-queue-error')?.textContent).toContain('current adjustments');
  });
  it('guards native inputs, repeat, composition, dialogs and menus', async () => {
    await mount(); await q({ repeat: true }); await q({ isComposing: true }); await q({ ctrlKey: true });
    const input = document.createElement('input'); host.append(input); await q({}, input); input.remove();
    for (const role of ['dialog', 'menu', 'alertdialog']) {
      const overlay = document.createElement('div'); overlay.setAttribute('role', role); host.append(overlay); await q(); overlay.remove();
    }
    expect(api.enqueue).not.toHaveBeenCalled(); await q(); expect(api.enqueue).toHaveBeenCalledTimes(1);
  });
});
