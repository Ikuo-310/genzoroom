// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportQueueApiError, type ExportQueueItem } from './exportQueueApi';
import { ExportQueueMutationBusyError, useExportQueue } from './useExportQueue';

const api = vi.hoisted(() => ({ list: vi.fn(), enqueue: vi.fn(), dequeue: vi.fn() }));
vi.mock('./exportQueueApi', async importOriginal => ({
  ...await importOriginal<typeof import('./exportQueueApi')>(),
  listExportQueue: api.list,
  enqueueExportAssets: api.enqueue,
  dequeueExportAsset: api.dequeue,
}));

const A = '12345678-1234-4234-9234-123456789abc';
const B = '22345678-1234-4234-9234-123456789abc';
const ABSENT = '92345678-1234-4234-9234-123456789abc';
const item = (assetId: string, status: ExportQueueItem['status'] = 'queued'): ExportQueueItem => ({
  assetId, status, queuedAt: '2026-10-06T01:02:03.004Z', updatedAt: '2026-10-06T01:02:03.004Z',
});
let root: Root;
let host: HTMLDivElement;
let current: ReturnType<typeof useExportQueue>;
function Harness() { current = useExportQueue(); return null; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function render() { await act(async () => root.render(<Harness />)); }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.list.mockReset().mockResolvedValue([]);
  api.enqueue.mockReset().mockImplementation(async (ids: string[]) => ids.map(id => item(id)));
  api.dequeue.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('useExportQueue', () => {
  it('loads all statuses and provides efficient asset lookups', async () => {
    api.list.mockResolvedValue(['queued', 'waiting', 'encoding', 'registering', 'failed'].map((status, index) => item(`${index}${A.slice(1)}`, status as ExportQueueItem['status'])));
    await render();
    expect(current.loaded).toBe(true);
    expect(current.items.map(value => value.status)).toEqual(['queued', 'waiting', 'encoding', 'registering', 'failed']);
    expect(current.getStatus(current.items[0].assetId)).toBe('queued');
    expect(current.getItem(current.items[1].assetId)).toEqual(current.items[1]);
    expect(current.hasAsset(current.items[0].assetId)).toBe(true);
    expect(current.hasAsset(ABSENT)).toBe(false);
    expect(current.itemsByAssetId.size).toBe(5);
    expect(api.list).toHaveBeenCalledOnce();
  });

  it('distinguishes an unknown initial state from a loaded empty queue', async () => {
    const pending = deferred<ExportQueueItem[]>(); api.list.mockReturnValue(pending.promise);
    await render();
    expect(current.loading).toBe(true); expect(current.loaded).toBe(false); expect(current.hasAsset(A)).toBeUndefined();
    await act(async () => pending.resolve([]));
    expect(current.loading).toBe(false); expect(current.loaded).toBe(true); expect(current.hasAsset(A)).toBe(false);
  });

  it('retains initial load error and retries successfully with refresh', async () => {
    const failure = new ExportQueueApiError('unavailable', 503, 'persistence_unavailable');
    api.list.mockRejectedValueOnce(failure).mockResolvedValueOnce([item(A, 'failed')]);
    await render();
    expect(current.error).toBe(failure); expect(current.loaded).toBe(false);
    await act(async () => current.refresh());
    expect(current.error).toBeNull(); expect(current.loaded).toBe(true); expect(current.getStatus(A)).toBe('failed');
  });

  it('retains a valid Queue snapshot when a later refresh fails', async () => {
    const failure = new ExportQueueApiError('network');
    api.list.mockResolvedValueOnce([item(A)]).mockRejectedValueOnce(failure);
    await render();
    await act(async () => current.refresh());
    expect(current.items).toEqual([item(A)]);
    expect(current.loaded).toBe(true);
    expect(current.error).toBe(failure);
  });

  it('aborts initial load on unmount', async () => {
    api.list.mockReturnValue(new Promise(() => {}));
    await render();
    const signal = api.list.mock.calls[0][0] as AbortSignal;
    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
  });

  it('uses a successful enqueue response as canonical state, including other status changes', async () => {
    api.list.mockResolvedValue([item(A, 'queued')]);
    await render();
    api.enqueue.mockResolvedValue([item(A, 'waiting'), item(B, 'queued')]);
    await act(async () => current.enqueue([B]));
    expect(current.getStatus(A)).toBe('waiting'); expect(current.hasAsset(B)).toBe(true);
    expect(current.mutationFor(B).operation).toBeNull();
    expect(api.enqueue.mock.calls[0][0]).toEqual([B]);
  });

  it('marks only targeted assets busy and prevents overlapping same-asset mutations', async () => {
    const pending = deferred<ExportQueueItem[]>(); api.enqueue.mockReturnValue(pending.promise);
    await render();
    let mutation!: Promise<void>;
    act(() => { mutation = current.enqueue([A]); });
    expect(current.mutationFor(A).operation).toBe('enqueue');
    expect(current.mutationFor(B).operation).toBeNull();
    await expect(current.enqueue([A.toUpperCase()])).rejects.toBeInstanceOf(ExportQueueMutationBusyError);
    await act(async () => pending.resolve([item(A)])); await act(async () => mutation);
    expect(current.mutationFor(A).operation).toBeNull();
  });

  it('preserves state and exposes the original API error after enqueue failure', async () => {
    api.list.mockResolvedValue([item(A)]); await render();
    const failure = new ExportQueueApiError('not_eligible', 422, 'asset_not_eligible');
    api.enqueue.mockRejectedValue(failure);
    await act(async () => { await expect(current.enqueue([B])).rejects.toBe(failure); });
    expect(current.items).toEqual([item(A)]);
    expect(current.mutationFor(B)).toEqual({ operation: null, error: failure });
    expect(current.mutationFor(A).operation).toBeNull();
  });

  it('removes only the dequeued asset after success', async () => {
    api.list.mockResolvedValue([item(A), item(B, 'failed')]); await render();
    const pending = deferred<void>(); api.dequeue.mockReturnValue(pending.promise);
    let mutation!: Promise<void>;
    act(() => { mutation = current.dequeue(A); });
    expect(current.mutationFor(A).operation).toBe('dequeue');
    expect(current.mutationFor(B).operation).toBeNull();
    await act(async () => pending.resolve(undefined)); await act(async () => mutation);
    expect(current.items).toEqual([item(B, 'failed')]);
    expect(api.dequeue.mock.calls[0][0]).toBe(A);
  });

  it('does not infer a complete Queue snapshot from a successful dequeue before initial load', async () => {
    const pending = deferred<ExportQueueItem[]>(); api.list.mockReturnValue(pending.promise);
    await render();
    api.dequeue.mockResolvedValue(undefined);
    await act(async () => current.dequeue(A));
    expect(current.loaded).toBe(false);
    expect(current.hasAsset(B)).toBeUndefined();
  });

  it.each([
    ['locked', new ExportQueueApiError('locked', 409, 'queue_item_locked')],
    ['network', new ExportQueueApiError('network')],
  ])('preserves Queue on dequeue %s error and exposes it', async (_label, failure) => {
    api.list.mockResolvedValue([item(A), item(B)]); await render();
    api.dequeue.mockRejectedValue(failure);
    await act(async () => { await expect(current.dequeue(A)).rejects.toBe(failure); });
    expect(current.items).toEqual([item(A), item(B)]);
    expect(current.mutationFor(A)).toEqual({ operation: null, error: failure });
  });

  it('ignores a list response started before a successful mutation', async () => {
    const oldList = deferred<ExportQueueItem[]>(); api.list.mockReturnValueOnce(oldList.promise).mockResolvedValueOnce([]);
    await render();
    api.enqueue.mockResolvedValue([item(A)]);
    await act(async () => current.enqueue([A]));
    await act(async () => oldList.resolve([item(B)]));
    expect(current.items).toEqual([item(A)]);
  });

  it('ignores an old refresh response that arrives after a mutation', async () => {
    api.list.mockResolvedValueOnce([]); await render();
    const oldRefresh = deferred<ExportQueueItem[]>(); api.list.mockReturnValueOnce(oldRefresh.promise);
    let refresh!: Promise<void>;
    act(() => { refresh = current.refresh(); });
    api.enqueue.mockResolvedValue([item(A)]);
    await act(async () => current.enqueue([A]));
    await act(async () => oldRefresh.resolve([item(B)])); await act(async () => refresh);
    expect(current.items).toEqual([item(A)]);
  });

  it('keeps mutation results scoped when unrelated mutations complete out of order', async () => {
    await render();
    const older = deferred<ExportQueueItem[]>();
    api.enqueue.mockReturnValueOnce(older.promise).mockResolvedValueOnce([item(B)]);
    let first!: Promise<void>;
    act(() => { first = current.enqueue([A]); });
    await act(async () => current.enqueue([B]));
    await act(async () => older.resolve([item(A)])); await act(async () => first);
    expect(current.items.map(value => value.assetId)).toEqual([B, A]);
  });

  it('aborts pending requests on unmount and ignores late mutation completion', async () => {
    const pending = deferred<ExportQueueItem[]>(); api.enqueue.mockReturnValue(pending.promise);
    await render();
    let mutation!: Promise<void>;
    act(() => { mutation = current.enqueue([A]).catch(() => {}); });
    const signal = api.enqueue.mock.calls[0][1] as AbortSignal;
    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve([item(A)])); await act(async () => mutation);
  });
});
