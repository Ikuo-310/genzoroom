import { afterEach, describe, expect, it, vi } from 'vitest';
import { dequeueExportAsset, enqueueExportAssets, ExportQueueApiError, listExportQueue } from './exportQueueApi';

const id = '12345678-1234-4234-9234-123456789abc';
const secondId = '22345678-1234-4234-9234-123456789abc';
const item = { assetId: id, status: 'queued', queuedAt: '2026-10-06T01:02:03.004Z', updatedAt: '2026-10-06T01:02:03.004Z' };
const signal = () => new AbortController().signal;
function mockBody(body: unknown) {
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());

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
