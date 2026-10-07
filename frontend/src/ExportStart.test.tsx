// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ExportManagementToolbar, ExportManagementContent, ExportRetryPriorityNotice } from './ExportManagement';
import { useExportManagement, type ExportManagementQueue, type ExportManagementState } from './useExportManagement';
import type { ExportQueueItem } from './exportQueueApi';
import i18n from './i18n';
vi.mock('./api', () => ({ fetchAssetDetail: async (id: string) => ({ id, filename: id, date: '', thumbnail_url: '',
  format: 'JPEG', is_raw: false, preview_url: '', exif: {} }), refreshSelectedImmichStacks: async () => [] }));
const item = (assetId: string, status: ExportQueueItem['status'] = 'queued'): ExportQueueItem => ({ assetId, status, queuedAt: '', updatedAt: '' });
const idle = { runId: null, status: null, stopRequested: false, stopAllowed: false, currentAssetId: null } as const;
let root: Root, host: HTMLDivElement, queue: ExportManagementQueue, current: ExportManagementState;
const show = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
function Probe({ active }: { active: boolean }) {
  current = useExportManagement(queue, active);
  return active ? <><div className="home-tabs-bar"><div className="home-tabs" role="tablist" />
    <ExportRetryPriorityNotice management={current} /></div><ExportManagementToolbar management={current} /><ExportManagementContent management={current} /></> : null;
}
async function render(active = true) { await act(async () => root.render(<Probe active={active} />)); }
async function click(selector: string) { await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click()); }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); await i18n.changeLanguage('en');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  queue = { items: [item('b'), item('a')], loaded: true, loading: false, error: null, runtime: idle,
    enqueue: vi.fn(), dequeue: vi.fn(), refresh: vi.fn(), mutationFor: () => ({ operation: null }),
    startRuntime: vi.fn().mockResolvedValue(undefined), cancelRuntime: vi.fn().mockResolvedValue(undefined) };
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();
  for (const [key, descriptor] of [['showModal', show], ['close', close]] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, key);
  }
});
it('starts only armed queued IDs in Queue order, independently of selection, after confirmation', async () => {
  await render(); expect(host.querySelector<HTMLButtonElement>('.immich-action-button')!.disabled).toBe(true);
  await act(async () => current.selectAll()); await click('.export-arm-toggle');
  expect(host.querySelectorAll('.export-status-armed')).toHaveLength(2);
  await act(async () => current.selectOnly('a'));
  await click('.immich-action-button'); expect(queue.startRuntime).not.toHaveBeenCalled();
  expect(host.querySelector('dialog p')?.textContent).toBe('Export 2 photos to Immich?');
  expect(document.activeElement?.textContent).toBe(i18n.t('workspace.historyCancel'));
  await click('dialog button:last-child');
  expect(queue.startRuntime).toHaveBeenCalledTimes(1); expect(queue.startRuntime).toHaveBeenCalledWith(['b', 'a']);
  expect(current.armedIds.size).toBe(0);
  expect(host.querySelector('dialog')).toBeNull();
});
it('confirmation cancellation does not Start and repeated Confirm cannot dispatch twice', async () => {
  await render(); await act(async () => current.selectAll()); await click('.export-arm-toggle');
  await click('.immich-action-button'); await click('dialog button:first-child');
  expect(queue.startRuntime).not.toHaveBeenCalled();
  await click('.immich-action-button');
  await act(async () => { expect(current.confirmExport()).toBe(true); expect(current.confirmExport()).toBe(false); });
  expect(queue.startRuntime).toHaveBeenCalledTimes(1);
});
it('retries failed Queue items through the primary action and starts only that frozen group', async () => {
  queue.items = [item('armed')];
  queue.runtime = idle;
  await render(); await act(async () => current.selectOnly('armed')); await click('.export-arm-toggle');
  queue.items = [item('armed'), item('failed-a', 'failed'), item('failed-b', 'failed')];
  queue.retry = vi.fn().mockImplementation(async ids => { queue.items = queue.items.map(row => ids.includes(row.assetId) ? { ...row, status: 'queued' } : row); });
  await render();
  expect(host.querySelector<HTMLButtonElement>('.immich-action-button')?.textContent).toBe('Retry export');
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')?.textContent).toBe('Some photos failed to export, so only failed photos can be managed.');
  expect(host.querySelector('.export-toolbar .export-retry-notice')).toBeNull();
  await click('.immich-action-button');
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')).not.toBeNull();
  expect(host.querySelector('dialog p')?.textContent).toBe('Retry export for 2 failed items?');
  await click('dialog button:last-child');
  expect(queue.retry).toHaveBeenCalledWith(['failed-a', 'failed-b']);
  expect(queue.startRuntime).toHaveBeenCalledWith(['failed-a', 'failed-b']);
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')).toBeNull();
  expect([...current.armedIds]).toEqual(['armed']);
  expect(host.querySelector('.export-retry')).toBeNull();
});
it('gives active runtime Stop priority over failed Retry', async () => {
  queue.items = [item('failed', 'failed'), item('running', 'encoding')];
  queue.runtime = { runId: 'run', status: 'active', stopRequested: false, stopAllowed: true, currentAssetId: 'running' };
  await render();
  expect(host.querySelector<HTMLButtonElement>('.immich-action-button')?.textContent).toBe('Cancel export');
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')).not.toBeNull();
});
it('returns the primary action to ordinary Export when the last failed item leaves Queue', async () => {
  queue.items = [item('failed', 'failed'), item('queued')]; queue.runtime = idle;
  await render(); expect(host.querySelector<HTMLButtonElement>('.immich-action-button')?.textContent).toBe('Retry export');
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')).not.toBeNull();
  queue.items = [item('queued')]; await render();
  expect(host.querySelector<HTMLButtonElement>('.immich-action-button')?.textContent).toBe('Export to Immich');
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')).toBeNull();
});
it('keeps armed intent but limits selection, Q, and badges to failed items during Retry priority', async () => {
  queue.items = [item('queued')];
  await render(); await act(async () => current.selectOnly('queued')); await click('.export-arm-toggle');
  queue.items = [item('failed', 'failed'), item('queued')]; await render();
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')?.textContent).toBe('Some photos failed to export, so only failed photos can be managed.');
  expect(current.armedIds.has('queued')).toBe(true);
  expect(current.selectedIds).toEqual([]);
  expect(host.querySelector('[data-asset-id="failed"] .export-status-failed')?.textContent).toBe('Export failed');
  expect(host.querySelector('[data-asset-id="queued"] .export-status-armed')).toBeNull();
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')).not.toBeNull();
  expect(host.querySelector<HTMLInputElement>('[data-asset-id="queued"] input')?.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[data-asset-id="queued"] .photo-card-button')?.disabled).toBe(true);
  await act(async () => current.selectAll());
  expect(current.selectedIds).toEqual(['failed']);
  await click('.export-queue-remove');
  expect(queue.dequeue).toHaveBeenCalledTimes(1);
  expect(queue.dequeue).toHaveBeenCalledWith('failed');
  expect(current.armedIds.has('queued')).toBe(true);
});
it('suppresses unrelated armed badge through Retry transition and active run, then restores it at idle', async () => {
  queue.items = [item('queued')];
  await render(); await act(async () => current.selectOnly('queued')); await click('.export-arm-toggle');
  queue.items = [item('failed', 'failed'), item('queued')];
  let finishRetry!: () => void;
  queue.retry = vi.fn(async ids => {
    queue.items = queue.items.map(row => ids.includes(row.assetId) ? { ...row, status: 'queued' } : row);
    await new Promise<void>(resolve => { finishRetry = resolve; });
  });
  queue.startRuntime = vi.fn(async ids => {
    queue.items = queue.items.map(row => ids.includes(row.assetId) ? { ...row, status: 'waiting' } : row);
    queue.runtime = { runId: 'retry-run', status: 'active', stopRequested: false, stopAllowed: true, currentAssetId: 'failed' };
    return queue.runtime;
  });
  await render(); await click('.immich-action-button'); await click('dialog button:last-child');
  expect(queue.retry).toHaveBeenCalledWith(['failed']);
  expect(queue.startRuntime).not.toHaveBeenCalled();
  await render();
  expect(host.querySelector('.immich-action-button')?.textContent).toBe('Retry export');
  expect(host.querySelector('[data-asset-id="queued"] .export-status-armed')).toBeNull();
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')).not.toBeNull();
  expect(current.armedIds.has('queued')).toBe(true);
  await act(async () => { finishRetry(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(queue.startRuntime).toHaveBeenCalledWith(['failed']);
  await render();
  expect(host.querySelector('[data-asset-id="failed"] .export-status-waiting')).not.toBeNull();
  expect(host.querySelector('[data-asset-id="queued"] .export-status-armed')).toBeNull();
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')).not.toBeNull();
  expect(current.armedIds.has('queued')).toBe(true);
  queue.runtime = null; await render();
  expect(host.querySelector('[data-asset-id="queued"] .export-status-armed')).toBeNull();
  queue.items = [item('queued')]; queue.runtime = idle; await render();
  expect(host.querySelector('[data-asset-id="queued"] .export-status-armed')?.textContent).toBe('Ready to export');
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')).toBeNull();
  expect(current.armedIds.has('queued')).toBe(true);
});
it('keeps unrelated armed badge hidden when Retry fails and failed Queue intent remains', async () => {
  queue.items = [item('queued')]; await render();
  await act(async () => current.selectOnly('queued')); await click('.export-arm-toggle');
  queue.items = [item('failed', 'failed'), item('queued')];
  queue.retry = vi.fn().mockRejectedValue(new Error('retry failed'));
  await render(); await click('.immich-action-button'); await click('dialog button:last-child');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(queue.startRuntime).not.toHaveBeenCalled();
  expect(current.removalError).toBe('retryFailed');
  expect(current.armedIds.has('queued')).toBe(true);
  expect(host.querySelector('[data-asset-id="queued"] .export-status-armed')).toBeNull();
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')).not.toBeNull();
});
it('holds Retry priority after a lost Start acknowledgement through unknown and active polls until confirmed idle', async () => {
  queue.items = [item('queued')]; await render();
  await act(async () => current.selectOnly('queued')); await click('.export-arm-toggle');
  queue.items = [item('failed', 'failed'), item('queued')];
  queue.retry = vi.fn(async () => { queue.items = [item('failed', 'waiting'), item('queued')]; });
  queue.startRuntime = vi.fn(async () => { queue.runtime = null; throw new Error('lost acknowledgement'); });
  await render(); await click('.immich-action-button'); await click('dialog button:last-child'); await render();
  expect(current.retryPriority).toBe(true);
  expect(host.querySelector('.immich-action-button')?.textContent).toBe('Retry export');
  expect(host.querySelector('[data-asset-id="queued"] .export-status-armed')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('[data-asset-id="queued"] input')?.disabled).toBe(true);
  queue.runtime = { runId: 'retry-run', status: 'active', stopRequested: false, stopAllowed: true, currentAssetId: 'failed' };
  await render(); expect(current.retryPriority).toBe(true);
  expect(host.querySelector('.immich-action-button')?.textContent).toBe('Cancel export');
  queue.items = [item('queued')]; queue.runtime = idle; await render();
  expect(current.retryPriority).toBe(false);
  expect(host.querySelector('[data-asset-id="queued"] .export-status-armed')).not.toBeNull();
});
it('does not Start after Retry preparation reports a refresh failure, even if failed intent became queued', async () => {
  queue.items = [item('failed', 'failed')];
  queue.retry = vi.fn(async () => { queue.items = [item('failed')]; throw new Error('refresh failed'); });
  await render(); await click('.immich-action-button'); await click('dialog button:last-child');
  expect(queue.startRuntime).not.toHaveBeenCalled(); expect(current.removalError).toBe('retryFailed');
});
it('releases uncertain Retry priority when a fresh idle poll confirms Start did not leave an active run', async () => {
  queue.items = [item('failed', 'failed')];
  queue.retry = vi.fn(async () => { queue.items = [item('failed')]; });
  queue.startRuntime = vi.fn(async () => { queue.runtime = null; throw new Error('Start failed'); });
  await render(); await click('.immich-action-button'); await click('dialog button:last-child'); await render();
  expect(current.retryPriority).toBe(true);
  queue.runtime = idle; await render();
  expect(current.retryPriority).toBe(false); expect(current.armedIds.size).toBe(0);
  expect(host.querySelector('.immich-action-button')?.textContent).toBe('Export to Immich');
});
it.each(['ja', 'en'])('shows the Retry priority explanation in %s and hides it during ordinary export', async language => {
  await i18n.changeLanguage(language);
  await render();
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')).toBeNull();
  queue.items = [item('failed', 'failed')]; await render();
  expect(host.querySelector('.home-tabs-bar .export-retry-notice')?.textContent).toBe(language === 'ja'
    ? '出力に失敗した写真があるので、失敗した写真のみ操作できます'
    : 'Some photos failed to export, so only failed photos can be managed.');
});
it('excludes failed/locked/mutating armed items and revalidates targets at confirmation', async () => {
  queue.items = [item('b'), item('a')];
  await render(); await act(async () => current.selectAll()); await click('.export-arm-toggle');
  await click('.immich-action-button'); expect(host.querySelector('dialog p')?.textContent).toBe('Export 2 photos to Immich?');
  queue.items = [item('b'), item('a', 'waiting')]; await render();
  await click('dialog button:last-child'); expect(queue.startRuntime).not.toHaveBeenCalled();
  expect(current.removalError).toBe('startFailed'); expect(current.armedIds.has('a')).toBe(false);
});
it('reports Start failure without replacing W Undo and clears confirmation on tab departure', async () => {
  queue.startRuntime = vi.fn().mockRejectedValue(new Error('private'));
  await render(); await act(async () => current.selectOnly('a')); await click('.export-arm-toggle');
  await click('.immich-action-button'); await render(false); await render();
  expect(host.querySelector('dialog')).toBeNull(); expect(queue.startRuntime).not.toHaveBeenCalled();
  await click('.immich-action-button'); await click('dialog button:last-child');
  expect(current.removalError).toBe('startFailed'); expect(host.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('exportManagement.startFailed'));
  await act(async () => current.undo()); expect(current.armedIds.size).toBe(0);
});
it.each(['ja', 'en'])('confirms Stop with fixed wording in %s and does not dispatch before confirmation', async language => {
  await i18n.changeLanguage(language);
  queue.runtime = { runId: 'run', status: 'active', stopRequested: false, stopAllowed: true, currentAssetId: 'a' };
  queue.items = [item('a', 'registering')]; await render();
  await click('.immich-action-button'); expect(queue.cancelRuntime).not.toHaveBeenCalled();
  expect(host.querySelector('dialog p')?.textContent).toBe(language === 'ja'
    ? '現在の出力処理を終了後、以降の出力をキャンセルします。' : 'Cancel remaining exports after the current export finishes.');
  await click('dialog button:last-child'); expect(queue.cancelRuntime).toHaveBeenCalledTimes(1);
  queue.runtime = { ...queue.runtime, stopRequested: true, stopAllowed: false }; await render();
  expect(host.querySelector<HTMLButtonElement>('.immich-action-button')!.disabled).toBe(true);
});
