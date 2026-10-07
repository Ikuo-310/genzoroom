// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ExportManagementContent } from './ExportManagement';
import type { ExportQueueState } from './useExportQueue';
import type { ExportQueueItem, ExportQueueStatus } from './exportQueueApi';
import { updateSetting } from './appSettings';
import i18n from './i18n';
const api = vi.hoisted(() => ({ fetchDetail: vi.fn(), refreshStacks: vi.fn() }));
vi.mock('./api', () => ({ fetchAssetDetail: api.fetchDetail, refreshSelectedImmichStacks: api.refreshStacks }));
vi.mock('./frontendLogging', () => ({ frontendLogger: { add: vi.fn() } }));
const item = (assetId: string, status: ExportQueueStatus = 'queued'): ExportQueueItem => ({ assetId, status, queuedAt: 'q', updatedAt: 'u' });
type Queue = Pick<ExportQueueState, 'items' | 'loaded' | 'loading' | 'error'>;
let root: Root, host: HTMLDivElement;
async function render(items: ExportQueueItem[] = [], extra: Partial<Queue> = {}) {
  await act(async () => root.render(<ExportManagementContent queue={{ items, loaded: true, loading: false, error: null, ...extra }} />));
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
  expect(host.querySelector('button, input, [role="checkbox"], [draggable="true"], .cover-badge, .stack-candidate-lights')).toBeNull();
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
