// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useExportManagement, type ExportManagementQueue, type ExportManagementState } from './useExportManagement';
import type { ExportQueueItem } from './exportQueueApi';
const api = vi.hoisted(() => ({ detail: vi.fn(), stacks: vi.fn() }));
vi.mock('./api', () => ({ fetchAssetDetail: api.detail, refreshSelectedImmichStacks: api.stacks }));
vi.mock('./frontendLogging', () => ({ frontendLogger: { add: vi.fn() } }));
const item = (assetId: string, status: ExportQueueItem['status'] = 'queued'): ExportQueueItem => ({ assetId, status, queuedAt: '', updatedAt: '' });
let current: ExportManagementState, root: Root, host: HTMLDivElement;
let queue: ExportManagementQueue;
function Probe({ active }: { active: boolean }) { current = useExportManagement(queue, active); return null; }
async function render(items = queue.items, active = true) {
  queue = { ...queue, items };
  await act(async () => root.render(<Probe active={active} />));
}
async function settle(action: () => unknown) {
  await act(async () => { action(); await new Promise(resolve => setTimeout(resolve, 0)); });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.detail.mockReset().mockImplementation(async (id: string) => ({ id, filename: id, date: '', thumbnail_url: '', format: 'JPEG', is_raw: false, preview_url: '', exif: {} }));
  api.stacks.mockReset().mockResolvedValue([]);
  queue = { items: [], loaded: true, loading: false, error: null, enqueue: vi.fn(), dequeue: vi.fn(), refresh: vi.fn(), mutationFor: () => ({ operation: null }) };
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
it('confirms and retries every failed item in Queue order, then starts exactly those IDs without replacing W Undo', async () => {
  const starts = vi.fn(async (ids: readonly string[]) => undefined);
  queue.runtime = { runId: null, status: null, stopRequested: false, stopAllowed: false, currentAssetId: null };
  queue.startRuntime = starts;
  queue.retry = vi.fn(async ids => {
    queue.items = queue.items.map(row => ids.includes(row.assetId) ? { ...row, status: 'queued' } : row);
  });
  await render([item('b'), item('a', 'failed'), item('c', 'failed')]);
  await act(async () => current.selectOnly('b')); await act(async () => current.toggleArmed());
  expect(current.canRetryFailed).toBe(true);
  await act(async () => current.requestRetryFailed());
  expect(current.confirmation).toEqual({ kind: 'retry', assetIds: ['a', 'c'] });
  await settle(() => current.confirmExport());
  expect(queue.retry).toHaveBeenCalledWith(['a', 'c']); expect(starts).toHaveBeenCalledWith(['a', 'c']);
  expect([...current.armedIds]).toEqual(['b']);
  await render();
  await act(async () => current.undo());
  expect([...current.armedIds]).toEqual([]);
});
it('does not start after partial Retry failure and refreshes without rolling back successful IDs', async () => {
  queue.runtime = { runId: null, status: null, stopRequested: false, stopAllowed: false, currentAssetId: null };
  queue.startRuntime = vi.fn(); queue.refresh = vi.fn(async () => undefined);
  queue.retry = vi.fn(async () => { queue.items[0] = item('a', 'queued'); throw new Error('partial'); });
  await render([item('a', 'failed'), item('b', 'failed')]);
  await act(async () => current.selectOnly('a'));
  expect(current.canRetryFailed).toBe(true); await act(async () => current.requestRetryFailed());
  await settle(() => current.confirmExport());
  expect(queue.startRuntime).not.toHaveBeenCalled(); expect(queue.refresh).toHaveBeenCalled();
  expect(queue.items[0].status).toBe('queued'); expect(current.removalError).toBe('retryFailed');
});
it('revalidates frozen failed targets and prevents repeated confirmation dispatch', async () => {
  queue.runtime = { runId: null, status: null, stopRequested: false, stopAllowed: false, currentAssetId: null };
  queue.startRuntime = vi.fn(); queue.retry = vi.fn();
  await render([item('a', 'failed')]); await act(async () => current.requestRetryFailed());
  queue.items = [item('a', 'queued')]; await render(queue.items);
  await act(async () => { expect(current.confirmExport()).toBe(true); expect(current.confirmExport()).toBe(false); });
  expect(queue.retry).not.toHaveBeenCalled(); expect(queue.startRuntime).not.toHaveBeenCalled();
  expect(current.removalError).toBe('retryFailed');
});
it('allows Cancel only for recognized active runtime and does not create Undo', async () => {
  queue.cancelRuntime = vi.fn().mockResolvedValue(undefined);
  await render(); expect(current.cancelExport()).toBe(false);
  queue.runtime = { runId: 'run', status: 'active', stopRequested: false, stopAllowed: true, currentAssetId: 'a' };
  await render([item('a', 'encoding')]);
  await settle(() => current.cancelExport());
  expect(queue.cancelRuntime).not.toHaveBeenCalled();
  await settle(() => current.confirmExport());
  expect(queue.cancelRuntime).toHaveBeenCalledTimes(1); expect(current.undo()).toBe(false);
  queue.runtime = { ...queue.runtime, stopRequested: true, stopAllowed: false };
  await render(); expect(current.cancelExport()).toBe(false);
});
it('preserves selection and armed across status-only refresh and tab changes, but prunes deleted IDs and range anchors', async () => {
  await render([item('A'), item('b')]);
  await act(async () => { current.selectOnly('A'); });
  await act(async () => current.toggleArmed());
  expect([...current.armedIds]).toEqual(['a']);
  await render([item('a', 'failed'), item('b')]);
  expect(current.selectedIds).toEqual(['a']); expect([...current.armedIds]).toEqual(['a']);
  expect(api.detail).toHaveBeenCalledTimes(2); expect(api.stacks).toHaveBeenCalledTimes(1);
  await render([item('a'), item('b')]); expect([...current.armedIds]).toEqual(['a']);
  await render(queue.items, false); await render(queue.items, true);
  expect([...current.armedIds]).toEqual(['a']);
  await render([item('b')]); expect(current.selectedIds).toEqual([]); expect([...current.armedIds]).toEqual([]);
  await act(async () => current.extendRange('b')); expect(current.selectedIds).toEqual([]);
});
it.each(['waiting', 'encoding', 'registering'] as const)('prunes armed/selection and rejects manual actions when status becomes %s', async status => {
  await render([item('a')]); await act(async () => current.selectOnly('a')); await act(async () => current.toggleArmed());
  await render([item('a', status)]);
  expect(current.selectedIds).toEqual([]); expect([...current.armedIds]).toEqual([]);
  await act(async () => { current.selectOnly('a'); current.toggleSelection('a'); current.extendRange('a'); });
  expect(current.selectAll()).toBe(false); expect(current.toggleArmed()).toBe(false); expect(current.removeSelected()).toBe(false);
  expect(current.selectedIds).toEqual([]); expect(queue.dequeue).not.toHaveBeenCalled();
});
it('uses canonical visual order for ranges without changing Queue order', async () => {
  const original = [item('a'), item('b'), item('c')];
  api.stacks.mockResolvedValue([{ id: 'stack-x', primaryAssetId: 'a', assets: ['a', 'c', 'outside'].map(id => ({ id })) }]);
  await render(original); await act(async () => current.selectOnly('a')); await act(async () => current.extendRange('b'));
  expect(current.selectedIds).toEqual(['a', 'c', 'b']); expect(queue.items).toEqual(original);
});
it('snapshots removal targets and stops issuing further DELETEs after Home unmount', async () => {
  let finish!: () => void;
  queue.dequeue = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  await render([item('a'), item('b')]); await act(async () => current.selectAll()); await act(async () => current.removeSelected());
  expect(queue.dequeue).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount()); await act(async () => finish()); expect(queue.dequeue).toHaveBeenCalledTimes(1);
  root = createRoot(host);
});
it('starts a new Home mount with no selection or armed IDs', async () => {
  await render([item('a')]); await act(async () => current.selectOnly('a')); await act(async () => current.toggleArmed());
  await act(async () => root.unmount()); root = createRoot(host); await render([item('a')]);
  expect(current.selectedIds).toEqual([]); expect([...current.armedIds]).toEqual([]);
});

it('undoes W ON and OFF from per-asset snapshots without restoring selection', async () => {
  await render([item('a'), item('b'), item('c')]);
  await act(async () => current.selectOnly('a'));
  await act(async () => current.toggleArmed());
  await act(async () => current.selectOnly('b'));
  await act(async () => current.toggleSelection('c'));
  await act(async () => current.toggleArmed());
  expect([...current.armedIds]).toEqual(['a', 'b', 'c']);
  await act(async () => current.clear());
  let handled = false;
  await act(async () => { handled = current.undo(); });
  expect(handled).toBe(true);
  expect([...current.armedIds]).toEqual(['a']); expect(current.selectedIds).toEqual([]);
  await act(async () => { handled = current.undo(); }); expect(handled).toBe(false);
  await act(async () => current.selectOnly('a'));
  await act(async () => current.toggleArmed());
  expect([...current.armedIds]).toEqual([]);
  await act(async () => { handled = current.undo(); }); expect(handled).toBe(true);
  expect([...current.armedIds]).toEqual(['a']);
});

it('keeps a previous Undo record after no-op W and invalidates it when its Asset becomes locked', async () => {
  await render([item('a')]);
  await act(async () => current.selectOnly('a'));
  await act(async () => current.toggleArmed());
  await act(async () => current.clear());
  expect(current.toggleArmed()).toBe(false);
  let handled = false;
  await act(async () => { handled = current.undo(); });
  expect(handled).toBe(true); expect([...current.armedIds]).toEqual([]);

  await act(async () => current.selectOnly('a'));
  await act(async () => current.toggleArmed());
  await render([item('a', 'waiting')]);
  expect(current.undo()).toBe(false); expect([...current.armedIds]).toEqual([]);
});

it('replaces a W undo record only after a later W changes state', async () => {
  await render([item('a')]);
  await act(async () => current.selectOnly('a'));
  await act(async () => current.toggleArmed());
  await act(async () => current.toggleArmed());
  await act(async () => { expect(current.undo()).toBe(true); });
  expect([...current.armedIds]).toEqual(['a']);
});

it('undoes successful Q removals only, requeues them, and restores armed state only for successes', async () => {
  const original = [item('a'), item('b', 'failed'), item('c')];
  queue.dequeue = vi.fn(async (id: string) => {
    if (id === 'b') throw new Error('delete failed');
    queue.items.splice(queue.items.findIndex(row => row.assetId === id), 1);
  });
  queue.enqueue = vi.fn(async (ids: readonly string[]) => {
    if (ids[0] === 'c') throw new Error('enqueue failed');
    queue.items.push(item(ids[0], 'queued'));
  });
  await render(original);
  await act(async () => current.selectOnly('a'));
  await act(async () => current.toggleArmed());
  await act(async () => current.selectOnly('c'));
  await act(async () => current.toggleArmed());
  await act(async () => current.selectOnly('b'));
  await act(async () => current.toggleSelection('a'));
  await act(async () => current.toggleSelection('c'));
  await settle(() => current.removeSelected());
  expect(queue.dequeue).toHaveBeenCalledTimes(3);
  expect(queue.items.map(row => row.assetId)).toEqual(['b']);
  await settle(() => { expect(current.undo()).toBe(true); });
  expect(queue.enqueue).toHaveBeenCalledTimes(2);
  expect(queue.items.map(row => row.assetId).sort()).toEqual(['a', 'b']);
  expect([...current.armedIds].sort()).toEqual(['a']);
  expect(current.selectedIds).toEqual(['b']);
  expect(current.removalError).toBe('queueRestorePartialFailed');
});

it('preserves the prior Undo record when all Q removals fail', async () => {
  queue.dequeue = vi.fn(async () => { throw new Error('delete failed'); });
  await render([item('a')]);
  await act(async () => current.selectOnly('a'));
  await act(async () => current.toggleArmed());
  await settle(() => current.removeSelected());
  expect(current.removalError).toBe('removeFailed');
  let handled = false;
  await act(async () => { handled = current.undo(); });
  expect(handled).toBe(true); expect([...current.armedIds]).toEqual([]);
});

it('does not duplicate-enqueue a Q Undo target already present in the latest Queue snapshot', async () => {
  queue.dequeue = vi.fn(async () => { queue.items = []; });
  await render([item('a')]);
  await act(async () => current.selectOnly('a'));
  await settle(() => current.removeSelected());
  await render([item('a')]);
  expect(current.undo()).toBe(false);
  expect(queue.enqueue).not.toHaveBeenCalled();
});
