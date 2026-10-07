// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ExportManagementContent, ExportManagementToolbar } from './ExportManagement';
import { useExportManagement, type ExportManagementQueue } from './useExportManagement';
import type { ExportQueueState } from './useExportQueue';
import type { ExportQueueItem, ExportQueueStatus } from './exportQueueApi';
import { updateSetting } from './appSettings';
import i18n from './i18n';
const api = vi.hoisted(() => ({ fetchDetail: vi.fn(), refreshStacks: vi.fn() }));
vi.mock('./api', () => ({ fetchAssetDetail: api.fetchDetail, refreshSelectedImmichStacks: api.refreshStacks }));
vi.mock('./frontendLogging', () => ({ frontendLogger: { add: vi.fn() } }));
const item = (assetId: string, status: ExportQueueStatus = 'queued'): ExportQueueItem => ({ assetId, status, queuedAt: 'q', updatedAt: 'u' });
type Queue = Pick<ExportQueueState, 'items' | 'loaded' | 'loading' | 'error'>;
function Probe({ queue }: { queue: ExportManagementQueue }) {
  const management = useExportManagement(queue, true);
  return <><ExportManagementContent management={management} /></>;
}
let root: Root, host: HTMLDivElement;
async function render(items: ExportQueueItem[] = [], extra: Partial<Queue> = {}) {
  await act(async () => root.render(<Probe queue={{ items, loaded: true, loading: false, error: null,
    enqueue: vi.fn(), dequeue: vi.fn(), refresh: vi.fn(), mutationFor: () => ({ operation: null }), ...extra }} />));
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); await i18n.changeLanguage('en');
  updateSetting('homeThumbnailColumns', 5);
  api.refreshStacks.mockReset().mockResolvedValue([{ id: 'stack-x', primaryAssetId: '0', assets: ['0','2','3','4'].map(id => ({
    id, filename: id, date: '', thumbnail_url: '', format: 'DNG', is_raw: true, stackId: 'stack-x',
    primaryAssetId: '0', stackAssetCount: 4 })) }]);
  api.fetchDetail.mockReset().mockImplementation(async (id: string) => ({ id, filename: `${id}.dng`, date: '2026-09-01',
    thumbnail_url: `/thumb/${id}`, format: 'DNG', is_raw: true, preview_url: '', exif: {},
  }));
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
it('shows waiting/activity/failed bars while runtime cards remain locked', async () => {
  await render([item('a', 'waiting'), item('b', 'encoding'), item('c', 'registering'), item('d', 'failed')]);
  expect(host.querySelector('.export-status-waiting')?.textContent).toBe('Waiting');
  expect(host.querySelector('.export-status-encoding')?.textContent).toBe('Encoding JPEG');
  expect(host.querySelector('.export-status-registering')?.textContent).toBe('Registering');
  expect(host.querySelector('.export-status-failed')?.textContent).toBe('Export failed');
  expect(host.querySelectorAll('input:disabled')).toHaveLength(3);
});
it.each(['en', 'ja'])('shows persistent Stop state and exact Cancel explanation in %s', async language => {
  await i18n.changeLanguage(language);
  const queue: ExportManagementQueue = { items: [item('a', 'encoding')], loaded: true, loading: false, error: null,
    enqueue: vi.fn(), dequeue: vi.fn(), refresh: vi.fn(), mutationFor: () => ({ operation: null }), cancelRuntime: vi.fn(),
    runtime: { runId: 'run', status: 'active', stopRequested: true, stopAllowed: false, currentAssetId: 'a' } };
  function RuntimeProbe() {
    const management = useExportManagement(queue, true);
    return <><ExportManagementToolbar management={management} /><ExportManagementContent management={management} /></>;
  }
  await act(async () => root.render(<RuntimeProbe />));
  const button = host.querySelector<HTMLButtonElement>('.immich-action-button')!;
  expect(button.disabled).toBe(true); expect(button.classList.contains('export-stop-requested')).toBe(true);
  expect(button.textContent).toBe(language === 'ja' ? '出力キャンセル' : 'Cancel export');
  expect(button.title).toBe(language === 'ja' ? '現在の出力処理を終了後、以降の出力をキャンセルします。' : 'Cancel remaining exports after the current export finishes.');
  expect(host.querySelector('.export-status-stop')).not.toBeNull();
});
it.each(['en', 'ja'])('distinguishes Queue loading/error/empty and metadata loading/error in %s', async language => {
  await i18n.changeLanguage(language);
  await render([], { loaded: false, loading: true }); expect(host.textContent).toBe(i18n.t('exportManagement.queueLoading'));
  await render([], { error: new Error('queue') }); expect(host.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('exportManagement.queueLoadFailed'));
  await render(); expect(host.textContent).toBe(i18n.t('exportManagement.empty')); expect(api.fetchDetail).not.toHaveBeenCalled(); expect(api.refreshStacks).not.toHaveBeenCalled();
  let reject!: (error: Error) => void;
  api.fetchDetail.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  await render([item('a')]); expect(host.querySelector('[role="status"]')?.textContent).toBe(i18n.t('exportManagement.metadataLoading'));
  await act(async () => reject(new Error('detail')));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('exportManagement.metadataLoadFailed'));
  expect(host.querySelector('.export-queue-card')).toBeNull();
});
it('renders all statuses, noninteractive Gallery cards, Stack groups and shared thumbnail sizing', async () => {
  const statuses: ExportQueueStatus[] = ['queued', 'waiting', 'encoding', 'registering', 'failed'];
  const items = statuses.map((status, i) => item(['0','solo','2','3','4'][i], status));
  await render(items);
  expect(host.querySelectorAll('.export-stack-group')).toHaveLength(1);
  expect(host.querySelectorAll('.export-stack-members .export-queue-card')).toHaveLength(4);
  expect(host.querySelectorAll('.export-queue-grid > .export-queue-card')).toHaveLength(1);
  expect([...host.querySelectorAll<HTMLElement>('.export-queue-card')].map(card => card.dataset.queueStatus))
    .toEqual(['queued', 'encoding', 'registering', 'failed', 'waiting']);
  expect(host.querySelector('.photo-info p')?.textContent).toBe('0.dng');
  expect(host.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-01');
  expect(host.querySelector('img')?.getAttribute('src')).toBe('/thumb/0');
  expect(host.querySelector('.format-badge.raw')?.textContent).toBe('DNG');
  expect(host.querySelectorAll('.photo-selection-input')).toHaveLength(5);
  expect(host.querySelector('[draggable="true"], .cover-badge, .stack-candidate-lights, .photo-card-badges')).toBeNull();
  expect(host.querySelector<HTMLElement>('.export-queue-grid')?.style.getPropertyValue('--export-columns')).toBe('5');
  await act(async () => updateSetting('homeThumbnailColumns', 3));
  expect(host.querySelector<HTMLElement>('.export-queue-grid')?.style.getPropertyValue('--export-columns')).toBe('3');
  await render(items.map(row => ({ ...row, status: 'failed' })), { loading: true });
  expect(host.querySelectorAll('.export-queue-card')).toHaveLength(5); expect(api.fetchDetail).toHaveBeenCalledTimes(5);
  expect([...host.querySelectorAll<HTMLElement>('.export-queue-card')].every(card => card.dataset.queueStatus === 'failed')).toBe(true);
});
it('keeps a single queued Stack member standalone', async () => {
  api.refreshStacks.mockResolvedValue([{ id: 'stack-x', primaryAssetId: 'a', assets: ['a','outside'].map(id => ({
    id, filename: id, date: '', thumbnail_url: '', format: 'JPEG', is_raw: false, stackId: 'stack-x',
    primaryAssetId: 'a', stackAssetCount: 2 })) }]);
  await render([item('a')]); expect(host.querySelector('.export-stack-group')).toBeNull();
  expect(host.querySelectorAll('.export-queue-card')).toHaveLength(1);
});
