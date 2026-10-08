import { afterEach, describe, expect, it, vi } from 'vitest';
import { dequeueExportAsset, enqueueExportAssets, ExportQueueApiError, isExportQueueMutationOutcomeUnknown, listExportQueue, retryExportAssets, listExportRuntime, stopExportRuntime, startExportRuntime } from './exportQueueApi';

const id = '12345678-1234-4234-9234-123456789abc';
const secondId = '22345678-1234-4234-9234-123456789abc';
const item = { assetId: id, status: 'queued', queuedAt: '2026-10-06T01:02:03.004Z', updatedAt: '2026-10-06T01:02:03.004Z' };
const signal = () => new AbortController().signal;
const runtime = { runId: id, status: 'active', stopRequested: false, stopAllowed: true, currentAssetId: secondId };
function mockBody(body: unknown) {
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());

it.each([
  [new ExportQueueApiError('network'), true],
  [new ExportQueueApiError('invalid_response', 200), true],
  [new ExportQueueApiError('unavailable', 503), true],
  [new ExportQueueApiError('unavailable', 503, 'persistence_unavailable'), false],
  [new ExportQueueApiError('unavailable', 503, 'unsupported_db_schema'), false],
  [new ExportQueueApiError('unexpected', 500), true],
  [new ExportQueueApiError('locked', 409), false],
  [new ExportQueueApiError('not_eligible', 422), false],
  [new ExportQueueApiError('invalid_request', 422), false],
])('classifies Queue mutation outcome uncertainty for %s', (error, expected) => {
  expect(isExportQueueMutationOutcomeUnknown(error)).toBe(expected);
});

it('posts Retry intent and accepts only canonical Queue response', async () => {
  const fetcher = mockBody({ items: [item] });
  expect(await retryExportAssets([id.toUpperCase()], signal())).toEqual([item]);
  expect(fetcher.mock.calls[0][0]).toBe('/api/export/queue/retry');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ assetIds: [id] });
  await expect(retryExportAssets([id, id.toUpperCase()], signal())).rejects.toMatchObject({ kind: 'duplicate' });
  await expect(retryExportAssets(Array(101).fill(id), signal())).rejects.toMatchObject({ kind: 'invalid_request' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('posts ordered Start targets and strictly validates its acknowledgement', async () => {
  const fetcher = mockBody(runtime);
  expect(await startExportRuntime([secondId, id], signal())).toEqual(runtime);
  expect(fetcher.mock.calls[0][0]).toBe('/api/export/runtime/start');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ assetIds: [secondId, id] });
  await expect(startExportRuntime([id, id], signal())).rejects.toMatchObject({ kind: 'duplicate' });
  await expect(startExportRuntime([], signal())).rejects.toMatchObject({ kind: 'invalid_request' });
  await expect(startExportRuntime(Array(101).fill(id), signal())).rejects.toMatchObject({ kind: 'invalid_request' });
  mockBody({ runId: null, status: null, stopRequested: false, stopAllowed: false, currentAssetId: null });
  await expect(startExportRuntime([id], signal())).rejects.toMatchObject({ kind: 'invalid_response' });
});
it('reads active runtime and validates Stop acknowledgement', async () => {
  mockBody(runtime); expect(await listExportRuntime(signal())).toEqual(runtime);
  const stopped = { ...runtime, stopRequested: true, stopAllowed: false };
  const fetcher = mockBody(stopped);
  expect(await stopExportRuntime(id, signal())).toEqual(stopped);
  expect(fetcher.mock.calls[0][0]).toBe(`/api/export/runs/${id}/stop`);
});
it.each([
  { ...runtime, extra: 'private' }, { ...runtime, stopAllowed: false }, { ...runtime, stopRequested: true },
  { ...runtime, runId: 'invalid' }, { ...runtime, currentAssetId: 'invalid' }, { ...runtime, status: 'completed' },
  { runId: null, status: null, stopRequested: true, stopAllowed: false, currentAssetId: null },
])('rejects invalid runtime shape %j', async value => {
  mockBody(value);
  await expect(listExportRuntime(signal())).rejects.toMatchObject({ kind: 'invalid_response' });
});
it('rejects Stop acknowledgement for another run or without persistent intent', async () => {
  mockBody({ ...runtime, runId: secondId, stopRequested: true, stopAllowed: false });
  await expect(stopExportRuntime(id, signal())).rejects.toMatchObject({ kind: 'invalid_response' });
  mockBody(runtime);
  await expect(stopExportRuntime(id, signal())).rejects.toMatchObject({ kind: 'invalid_response' });
});

describe('Export Queue API contract', () => {
  it.each(['queued', 'waiting', 'encoding', 'registering', 'failed'])('accepts status %s', async status => {
    const value = { ...item, status };
    mockBody({ items: [value] });
    expect(await listExportQueue(signal())).toEqual([value]);
  });
  it('accepts an empty queue and preserves server insertion order', async () => {
    mockBody({ items: [] }); expect(await listExportQueue(signal())).toEqual([]);
    const second = { ...item, assetId: secondId };
    mockBody({ items: [second, item] }); expect(await listExportQueue(signal())).toEqual([second, item]);
  });
  it.each([
    null, [], {}, { items: {} }, { items: [], extra: true },
    { items: [null] }, { items: [item, item] }, { items: [item, { ...item, assetId: id.toUpperCase() }] },
    { items: [{ ...item, assetId: 'invalid' }] }, { items: [{ ...item, status: 'done' }] },
    { items: [{ ...item, status: null }] }, { items: [{ ...item, updatedAt: 1 }] },
    { items: [{ ...item, queuedAt: 'not-date' }] }, { items: [{ ...item, extra: true }] },
    { items: [{ assetId: id, status: 'queued', queuedAt: item.queuedAt }] },
  ])('rejects unexpected response shape %j', async body => {
    mockBody(body);
    await expect(listExportQueue(signal())).rejects.toMatchObject({ kind: 'invalid_response' });
    await expect(enqueueExportAssets([id], signal())).rejects.toMatchObject({ kind: 'invalid_response' });
  });
  it.each(['2026-02-30T01:02:03Z', '2026-10-06T24:00:00Z', '2026-10-06',
    '2026-10-06T01:02:03', '2026-10-06T01:02:03+09:00', '2026-10-06T01:02:03.1234Z'])
    ('rejects malformed UTC timestamp %s', async timestamp => {
      mockBody({ items: [{ ...item, queuedAt: timestamp }] });
      await expect(listExportQueue(signal())).rejects.toMatchObject({ kind: 'invalid_response' });
    });
  it.each(['2024-02-29T01:02:03Z', '2026-10-06T01:02:03.1Z', '2026-10-06T01:02:03.12Z'])
    ('accepts valid UTC timestamp %s', async timestamp => {
      mockBody({ items: [{ ...item, queuedAt: timestamp }] });
      expect((await listExportQueue(signal()))[0].queuedAt).toBe(timestamp);
    });
  it('rejects non-JSON success responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('not-json')));
    await expect(listExportQueue(signal())).rejects.toMatchObject({ kind: 'invalid_response' });
  });
  it.each([
    [422, 'duplicate_asset_ids', 'duplicate'], [422, 'asset_not_eligible', 'not_eligible'],
    [409, 'queue_item_locked', 'locked'], [503, 'persistence_unavailable', 'unavailable'],
    [503, 'unsupported_db_schema', 'unavailable'], [422, 'invalid_asset_ids', 'invalid_request'],
    [500, 'error', 'unexpected'],
  ])('classifies HTTP %i / %s', async (status, code, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ detail: { code } }), { status })));
    await expect(enqueueExportAssets([id], signal())).rejects.toMatchObject({ kind, status, code });
  });
  it('preserves HTTP failure when its body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('proxy failure', { status: 503 })));
    await expect(listExportQueue(signal())).rejects.toMatchObject({ kind: 'unavailable', status: 503 });
  });
  it('propagates signal/no-store and sends canonical IDs in enqueue body and dequeue path', async () => {
    const abortSignal = signal();
    const fetcher = mockBody({ items: [item] });
    await listExportQueue(abortSignal);
    expect(fetcher.mock.calls[0]).toEqual(['/api/export/queue', { signal: abortSignal, cache: 'no-store' }]);
    await enqueueExportAssets([id.toUpperCase()], abortSignal);
    expect(fetcher.mock.calls[1]).toEqual(['/api/export/queue', {
      method: 'POST', signal: abortSignal, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetIds: [id] }),
    }]);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await dequeueExportAsset(id.toUpperCase(), abortSignal);
    expect(fetcher.mock.calls[2]).toEqual([`/api/export/queue/${id}`, { method: 'DELETE', signal: abortSignal, cache: 'no-store' }]);
  });
  it('rejects invalid or duplicate enqueue requests without sending them', async () => {
    const fetcher = mockBody({ items: [] });
    for (const ids of [[], ['invalid'], Array.from({ length: 101 }, () => id)]) {
      await expect(enqueueExportAssets(ids, signal())).rejects.toMatchObject({ kind: 'invalid_request' });
    }
    await expect(enqueueExportAssets([id, id.toUpperCase()], signal())).rejects.toMatchObject({ kind: 'duplicate' });
    await expect(dequeueExportAsset('invalid/path', signal())).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires DELETE to acknowledge with 204', async () => {
    mockBody({ items: [] });
    await expect(dequeueExportAsset(id, signal())).rejects.toMatchObject({ kind: 'invalid_response' });
  });
  it('handles abort/network failures without exposing transport details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private host and credentials')));
    const error = await listExportQueue(signal()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ExportQueueApiError);
    expect(error).toMatchObject({ kind: 'network', message: 'network' });
    const controller = new AbortController(); controller.abort();
    await expect(enqueueExportAssets([id], controller.signal)).rejects.toMatchObject({ kind: 'network' });
  });
});
