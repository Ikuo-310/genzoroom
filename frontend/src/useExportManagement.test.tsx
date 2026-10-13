// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useExportManagement, type ExportManagementQueue, type ExportManagementState } from './useExportManagement';
import { ExportQueueApiError, type ExportQueueItem } from './exportQueueApi';
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
  queue = { items: [], loaded: true, canonical: true, loading: false, error: null, enqueue: vi.fn(), dequeue: vi.fn(), refresh: vi.fn(), mutationFor: () => ({ operation: null }) };
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
it('preserves one-shot Arm Undo when invoked during metadata refetch', async () => {
  const fetchDetail = api.detail.getMockImplementation()!;
  await render([item('a')]);
  await act(async () => current.selectOnly('a')); await act(async () => current.toggleArmed());
  await render(queue.items, false);
  let finish!: () => void;
  api.detail.mockImplementation((id: string) => new Promise(resolve => { finish = () => resolve(fetchDetail(id)); }));
  await render(queue.items, true);
  expect(current.message).toBe('metadataLoading'); expect(current.undo()).toBe(false);
  expect([...current.armedIds]).toEqual(['a']);
  await act(async () => finish());
  expect(current.selectedIds).toEqual(['a']);
  await act(async () => { expect(current.undo()).toBe(true); });
  expect(current.armedIds.size).toBe(0); expect(current.undo()).toBe(false);
});
it('retains selection, Arm and Undo across Stack failure while blocking operations until recovery', async () => {
  queue.runtime = { runId: null, status: null, stopRequested: false, stopAllowed: false, currentAssetId: null };
  queue.startRuntime = vi.fn(); queue.retry = vi.fn();
  await render([item('a')]);
  await act(async () => current.selectOnly('a')); await act(async () => current.toggleArmed());
  await render(queue.items, false); api.stacks.mockRejectedValue(new Error('Stack refresh failed'));
  await render(queue.items, true);
  expect(current.message).toBe('metadataLoadFailed'); expect([...current.armedIds]).toEqual(['a']);
  expect(current.selectedIds).toEqual([]); expect(current.selectAll()).toBe(false);
  expect(current.toggleArmed()).toBe(false); expect(current.removeSelected()).toBe(false);
  expect(current.requestStart()).toBe(false); expect(current.requestRetryFailed()).toBe(false);
  expect(current.undo()).toBe(false);
  expect(queue.enqueue).not.toHaveBeenCalled(); expect(queue.dequeue).not.toHaveBeenCalled();
  expect(queue.startRuntime).not.toHaveBeenCalled(); expect(queue.retry).not.toHaveBeenCalled();
  await render(queue.items, false); api.stacks.mockResolvedValue([]); await render(queue.items, true);
  expect(current.message).toBeNull(); expect(current.selectedIds).toEqual(['a']);
  expect([...current.armedIds]).toEqual(['a']); expect(current.canStart).toBe(true);
  await act(async () => { expect(current.undo()).toBe(true); });
  expect(current.armedIds.size).toBe(0); expect(current.undo()).toBe(false);
});
it('limits retained state and Arm Undo to successful details after partial refetch failure', async () => {
  const fetchDetail = api.detail.getMockImplementation()!;
  await render([item('a'), item('b')]);
  await act(async () => current.selectAll()); await act(async () => current.toggleArmed());
  await act(async () => current.toggleArmed());
  await render(queue.items, false);
  api.detail.mockImplementation((id: string) => id === 'a' ? Promise.reject(new Error('HTTP 400')) : fetchDetail(id));
  await render(queue.items, true);
  expect(current.message).toBeNull(); expect(current.selectedIds).toEqual(['b']);
  await act(async () => { current.selectOnly('a'); current.toggleSelection('a'); current.extendRange('a'); });
  expect(current.selectedIds).toEqual(['b']);
  await act(async () => { expect(current.undo()).toBe(true); });
  expect([...current.armedIds]).toEqual(['b']); expect(current.undo()).toBe(false);
  expect(queue.items).toEqual([item('a'), item('b')]);
  expect(queue.enqueue).not.toHaveBeenCalled(); expect(queue.dequeue).not.toHaveBeenCalled();
});
it('treats hidden failed items as empty without changing persistent Queue records', async () => {
  const original = [item('hidden', 'failed')];
  api.detail.mockRejectedValue(new Error('HTTP 400'));
  await render(original);
  expect(current.message).toBe('empty'); expect(current.rows).toEqual([]);
  expect(current.failedIds).toEqual([]); expect(current.retryPriority).toBe(false);
  await act(async () => { current.selectOnly('hidden'); current.toggleSelection('hidden'); current.extendRange('hidden'); });
  expect(current.selectedIds).toEqual([]); expect(current.selectAll()).toBe(false);
  expect(current.toggleArmed()).toBe(false); expect(current.removeSelected()).toBe(false);
  expect(current.requestRetryFailed()).toBe(false); expect(current.requestStart()).toBe(false);
  expect(queue.items).toEqual(original);
  expect(queue.enqueue).not.toHaveBeenCalled(); expect(queue.dequeue).not.toHaveBeenCalled();
  expect(queue.refresh).not.toHaveBeenCalled();
});
it('starts visible queued items despite hidden failures and excludes hidden queued items from selection and removal', async () => {
  const fetchDetail = api.detail.getMockImplementation()!;
  api.detail.mockImplementation((id: string) => id.startsWith('hidden') ? Promise.reject(new Error('HTTP 400')) : fetchDetail(id));
  queue.runtime = { runId: null, status: null, stopRequested: false, stopAllowed: false, currentAssetId: null };
  queue.startRuntime = vi.fn().mockResolvedValue(undefined); queue.retry = vi.fn();
  const original = [item('hidden-failed', 'failed'), item('b'), item('hidden-queued'), item('a')];
  await render(original);
  expect(current.failedIds).toEqual([]); expect(current.retryPriority).toBe(false); expect(current.message).toBeNull();
  await act(async () => current.selectAll()); expect(current.selectedIds).toEqual(['b', 'a']);
  await act(async () => current.toggleArmed()); expect([...current.armedIds]).toEqual(['b', 'a']);
  expect(current.canStart).toBe(true);
  await act(async () => current.requestStart()); expect(current.confirmation).toEqual({ kind: 'start', assetIds: ['b', 'a'] });
  await settle(() => current.confirmExport()); expect(queue.startRuntime).toHaveBeenCalledWith(['b', 'a']);
  expect(queue.retry).not.toHaveBeenCalled();
  await settle(() => current.removeSelected());
  expect(vi.mocked(queue.dequeue).mock.calls).toEqual([['b'], ['a']]); expect(queue.items).toEqual(original);
});
it('retries only visible failed items and retains their priority over visible queued items', async () => {
  const fetchDetail = api.detail.getMockImplementation()!;
  api.detail.mockImplementation((id: string) => id === 'hidden' ? Promise.reject(new Error('HTTP 400')) : fetchDetail(id));
  queue.runtime = { runId: null, status: null, stopRequested: false, stopAllowed: false, currentAssetId: null };
  queue.startRuntime = vi.fn().mockResolvedValue(undefined); queue.retry = vi.fn();
  await render([item('hidden', 'failed'), item('queued'), item('b', 'failed'), item('a', 'failed')]);
  expect(current.retryPriority).toBe(true); expect(current.failedIds).toEqual(['b', 'a']);
  await act(async () => current.selectAll()); expect(current.selectedIds).toEqual(['b', 'a']);
  await act(async () => current.requestRetryFailed()); expect(current.confirmation).toEqual({ kind: 'retry', assetIds: ['b', 'a'] });
  await settle(() => current.confirmExport());
  expect(queue.retry).toHaveBeenCalledWith(['b', 'a']); expect(queue.startRuntime).toHaveBeenCalledWith(['b', 'a']);
});
it('refetches on tab reentry, prunes unavailable local intent and Undo, and restores original Queue status on recovery', async () => {
  const original = [item('a', 'failed')];
  const fetchDetail = api.detail.getMockImplementation()!;
  await render(original); await act(async () => current.selectOnly('a')); await act(async () => current.toggleArmed());
  await act(async () => current.toggleArmed());
  await render(original, false);
  let reject!: (error: Error) => void;
  api.detail.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  await render(original, true);
  expect(current.selectedIds).toEqual([]); expect(current.requestRetryFailed()).toBe(false);
  await act(async () => reject(new Error('HTTP 400')));
  expect(current.message).toBe('empty'); expect(current.armedIds.size).toBe(0); expect(current.undo()).toBe(false);
  expect(queue.items).toEqual(original); expect(queue.enqueue).not.toHaveBeenCalled(); expect(queue.dequeue).not.toHaveBeenCalled();
  await render(original, false); api.detail.mockImplementation(fetchDetail); await render(original, true);
  expect(api.detail).toHaveBeenCalledTimes(3); expect(current.message).toBeNull();
  expect(current.failedIds).toEqual(['a']); expect(current.retryPriority).toBe(true); expect(queue.items).toEqual(original);
});
it('confirms and retries every failed item in Queue order, then starts exactly those IDs without replacing W Undo', async () => {
  const starts = vi.fn(async (ids: readonly string[]) => ({ runId: 'run', status: 'active' as const,
    stopRequested: false, stopAllowed: true, currentAssetId: ids[0] }));
  queue.runtime = { runId: null, status: null, stopRequested: false, stopAllowed: false, currentAssetId: null };
  queue.startRuntime = starts;
  queue.retry = vi.fn(async ids => {
    queue.items = queue.items.map(row => ids.includes(row.assetId) ? { ...row, status: 'queued' } : row);
  });
  await render([item('b')]); await act(async () => current.selectOnly('b')); await act(async () => current.toggleArmed());
  await render([item('b'), item('a', 'failed'), item('c', 'failed')]);
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
it('blocks Export management actions while Queue state is noncanonical', async () => {
  queue.canonical = false;
  queue.items = [item('a')];
  await render(queue.items);
  expect(current.message).toBe('queueLoadFailed');
  expect(current.selectAll()).toBe(false);
  expect(current.removeSelected()).toBe(false);
  expect(current.canStart).toBe(false);
  expect(queue.dequeue).not.toHaveBeenCalled();
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
  const original = [item('a'), item('b'), item('c')];
  queue.dequeue = vi.fn(async (id: string) => {
    if (id === 'b') throw new ExportQueueApiError('unavailable', 503, 'persistence_unavailable');
    queue.items.splice(queue.items.findIndex(row => row.assetId === id), 1);
  });
  queue.enqueue = vi.fn(async (ids: readonly string[]) => {
    if (ids[0] === 'c') throw new ExportQueueApiError('unavailable', 503, 'persistence_unavailable');
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

it('targets one photo for Arm and removal without replacing multi-selection, and shares one-shot Undo', async () => {
  queue.dequeue = vi.fn().mockResolvedValue(undefined);
  queue.enqueue = vi.fn().mockResolvedValue(undefined);
  await render([item('a'), item('b'), item('c')]);
  await act(async () => current.selectAll());
  await act(async () => { expect(current.toggleAssetArmed('B')).toBe(true); });
  expect([...current.armedIds]).toEqual(['b']); expect(current.selectedIds).toEqual(['a', 'b', 'c']);
  await act(async () => { expect(current.undo()).toBe(true); });
  expect(current.armedIds.size).toBe(0); expect(current.undo()).toBe(false);
  await act(async () => current.toggleAssetArmed('b'));
  await settle(() => { expect(current.removeAsset('B')).toBe(true); });
  await render([item('a'), item('c')]);
  expect(queue.dequeue).toHaveBeenCalledExactlyOnceWith('b');
  expect(current.selectedIds).toEqual(['a', 'c']); expect(current.armedIds.size).toBe(0);
  expect(current.canOperateAsset('b')).toBe(false);
  expect(current.removeAsset('b')).toBe(false); expect(current.toggleAssetArmed('b')).toBe(false);
  await settle(() => { expect(current.undo()).toBe(true); });
  await render([item('a'), item('c'), item('b')]);
  expect(queue.enqueue).toHaveBeenCalledExactlyOnceWith(['b']);
  expect([...current.armedIds]).toEqual(['b']); expect(current.selectedIds).toEqual(['a', 'c']);
  expect(current.undo()).toBe(false);
});

it.each(['locked', 'unavailable', 'network'] as const)('uses the existing single removal failure and Undo semantics for %s', async kind => {
  queue.dequeue = vi.fn(async () => { throw new ExportQueueApiError(kind, kind === 'locked' ? 409 : undefined,
    kind === 'unavailable' ? 'persistence_unavailable' : undefined); });
  await render([item('a'), item('b')]);
  await act(async () => current.selectAll()); await act(async () => current.toggleAssetArmed('b'));
  await settle(() => current.removeAsset('a'));
  expect(queue.dequeue).toHaveBeenCalledExactlyOnceWith('a');
  expect(current.selectedIds).toEqual(['a', 'b']); expect([...current.armedIds]).toEqual(['b']);
  expect(current.removalError).toBe(kind === 'locked' ? 'locked' : 'removeFailed');
  expect(queue.refresh).toHaveBeenCalledTimes(kind === 'network' ? 0 : 1);
  await act(async () => { expect(current.undo()).toBe(true); });
  expect(current.armedIds.size).toBe(0); expect(queue.enqueue).not.toHaveBeenCalled();
});

it('blocks single commands and Preview availability during an operation, and prevents duplicate removal', async () => {
  let finish!: () => void;
  queue.dequeue = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  await render([item('a'), item('b')]); await act(async () => current.selectAll());
  await act(async () => {
    expect(current.removeAsset('a')).toBe(true);
    expect(current.removeAsset('a')).toBe(false);
    expect(current.toggleAssetArmed('b')).toBe(false);
  });
  expect(current.canOpenPreview).toBe(false);
  expect(current.canOperateAsset('b')).toBe(false);
  await act(async () => finish());
  expect(queue.dequeue).toHaveBeenCalledTimes(1);
});

it.each(['noncanonical', 'loading', 'error', 'mutation', 'waiting', 'encoding', 'registering', 'retryExcluded', 'inactive'] as const)(
  'blocks single Q/W while %s', async condition => {
    await render([item('a')]);
    if (condition === 'noncanonical') queue.canonical = false;
    if (condition === 'loading') queue.loading = true;
    if (condition === 'error') queue.error = new Error('queue');
    if (condition === 'mutation') queue.mutationFor = () => ({ operation: 'dequeue' });
    const rows = ['waiting', 'encoding', 'registering'].includes(condition)
      ? [item('a', condition as 'waiting' | 'encoding' | 'registering')]
      : condition === 'retryExcluded' ? [item('a'), item('failed', 'failed')] : queue.items;
    await render(rows, condition !== 'inactive');
    expect(current.canOperateAsset('a')).toBe(false);
    expect(current.removeAsset('a')).toBe(false); expect(current.toggleAssetArmed('a')).toBe(false);
    expect(queue.dequeue).not.toHaveBeenCalled(); expect(current.armedIds.size).toBe(0);
  },
);
