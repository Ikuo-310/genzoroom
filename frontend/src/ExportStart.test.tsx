// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ExportManagementToolbar, ExportManagementContent } from './ExportManagement';
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
  return active ? <><ExportManagementToolbar management={current} /><ExportManagementContent management={current} /></> : null;
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
it('excludes failed/locked/mutating armed items and revalidates targets at confirmation', async () => {
  queue.items = [item('b', 'failed'), item('a')];
  await render(); await act(async () => current.selectAll()); await click('.export-arm-toggle');
  await click('.immich-action-button'); expect(host.querySelector('dialog p')?.textContent).toBe('Export 1 photo to Immich?');
  queue.items = [item('b', 'failed'), item('a', 'waiting')]; await render();
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
