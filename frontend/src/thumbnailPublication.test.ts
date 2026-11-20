import { afterEach, expect, it, vi } from 'vitest';
import { closeThumbnailPublicationStream, getThumbnailPublication, resumeThumbnailPublicationStream,
  subscribeThumbnailPublication } from './thumbnailPublication';

const generation = 'a'.repeat(32);
const nextGeneration = 'b'.repeat(32);
const pub = (value: number) => value.toString(16).padStart(32, '0');

class Stream extends EventTarget {
  static latest: Stream;
  close = vi.fn();
  constructor() { super(); Stream.latest = this; }
  emit(generationId: string, sequence: number, assetId: string, publicationVersion?: string) {
    this.dispatchEvent(new MessageEvent('publication', {
      data: JSON.stringify({ generationId, sequence, assetId, state: 'running',
        ...(publicationVersion === undefined ? {} : { publicationVersion }) }),
    }));
  }
}

const subscriptions: Array<() => void> = [];
function watch(ids: string[]) {
  subscriptions.push(...ids.map(id => subscribeThumbnailPublication(id, () => {})));
}

afterEach(async () => {
  subscriptions.splice(0).forEach(stop => stop());
  await vi.advanceTimersByTimeAsync(1100);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function deferredStatus({ abortable = true } = {}) {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', Stream);
  const requests: Array<{
    ids: string[]; signal: AbortSignal; fail: () => void;
    reply: (sequence: number, version: string | null, id?: string, recipeRevision?: number | null,
      state?: string) => void;
  }> = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const ids: string[] = JSON.parse(String(init.body)).assetIds;
    if (abortable) {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }
    requests.push({ ids, signal: init.signal!, fail: () => resolve(new Response(null, { status: 503 })),
      reply: (sequence, version, generationId = generation, recipeRevision = 1, state = 'published') => resolve(new Response(JSON.stringify({
        sequence, generationId, items: Object.fromEntries(ids.map(id => [id, {
          state, publicationVersion: version, recipeRevision,
        }])),
      }))) });
  }));
  return requests;
}

it('orders snapshots per Asset across batches and rejects a response from before a generation change', async () => {
  const requests = deferredStatus();
  watch(Array.from({ length: 1001 }, (_, index) => String(index)));
  const stream = Stream.latest;
  stream.emit(generation, 1, '1000', pub(1));
  await vi.advanceTimersByTimeAsync(25);
  expect(requests[0].ids).toHaveLength(1000);
  requests[0].reply(8, pub(8));
  await vi.advanceTimersByTimeAsync(0);
  expect(requests[1].ids).toEqual(['1000']);
  stream.emit(generation, 2, '1000', pub(2));
  requests[1].reply(1, pub(1));
  await vi.advanceTimersByTimeAsync(0);
  expect(getThumbnailPublication('1000')?.publicationVersion).toBe(pub(2));
  stream.dispatchEvent(new Event('open'));
  await vi.advanceTimersByTimeAsync(25);
  stream.emit(nextGeneration, 1, '0', pub(19));
  expect(requests[2].signal.aborted).toBe(true);
  requests[2].reply(99, pub(99));
  await vi.advanceTimersByTimeAsync(25);
  expect(getThumbnailPublication('0')?.publicationVersion).toBe(pub(19));
  subscriptions.splice(0).forEach(stop => stop());
  expect(getThumbnailPublication('0')).toBeUndefined();
  stream.emit(nextGeneration, 2, 'never-watched', pub(20));
  expect(getThumbnailPublication('never-watched')).toBeUndefined();
  requests[3].reply(1, pub(19), nextGeneration);
  await vi.advanceTimersByTimeAsync(1000);
  expect(stream.close).toHaveBeenCalledOnce();
});

it('keeps the last good image version for state-only publication events', async () => {
  const requests = deferredStatus();
  watch(['asset-with-last-good-image']);
  const stream = Stream.latest;
  await vi.advanceTimersByTimeAsync(25);
  stream.emit(generation, 1, 'asset-with-last-good-image');
  expect(getThumbnailPublication('asset-with-last-good-image')).toBeUndefined();
  requests[0].reply(0, pub(41));
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(25);
  expect(requests).toHaveLength(2);
  requests[1].reply(1, pub(41));
  await vi.advanceTimersByTimeAsync(0);
  expect(getThumbnailPublication('asset-with-last-good-image')).toMatchObject({
    state: 'published', publicationVersion: pub(41),
  });
});

it('accepts the old-engine revision sentinel without retrying a valid status snapshot', async () => {
  const requests = deferredStatus();
  watch(['old-engine-asset']);
  await vi.advanceTimersByTimeAsync(25);
  requests[0].reply(0, null, generation, 0, 'recipe_default');
  await vi.advanceTimersByTimeAsync(0);
  expect(getThumbnailPublication('old-engine-asset')).toEqual({
    recipeRevision: 0, state: 'recipe_default', publicationVersion: null,
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(requests).toHaveLength(1);
});

it('retries a failed shared batch at bounded intervals and resynchronizes on reconnect', async () => {
  const requests = deferredStatus();
  watch(['a', 'b']);
  const stream = Stream.latest;
  await vi.advanceTimersByTimeAsync(25);
  for (const interval of [525, 1025, 2025]) {
    requests.at(-1)!.fail();
    await vi.advanceTimersByTimeAsync(interval);
    expect(requests.at(-1)!.ids).toEqual(['a', 'b']);
  }
  requests[3].fail();
  await vi.advanceTimersByTimeAsync(10000);
  expect(requests).toHaveLength(4);
  stream.dispatchEvent(new Event('open'));
  await vi.advanceTimersByTimeAsync(25);
  requests[4].reply(5, pub(5));
  await vi.advanceTimersByTimeAsync(0);
  expect(getThumbnailPublication('a')?.publicationVersion).toBe(pub(5));
});

it('times out a stalled batch, ignores its delayed reply, and resumes with a bounded retry', async () => {
  const requests = deferredStatus({ abortable: false });
  watch(['stalled-asset']);
  await vi.advanceTimersByTimeAsync(25);
  expect(requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(15000);
  expect(requests[0].signal.aborted).toBe(true);
  requests[0].reply(1, pub(40));
  await vi.advanceTimersByTimeAsync(0);
  expect(getThumbnailPublication('stalled-asset')).toBeUndefined();
  await vi.advanceTimersByTimeAsync(525);
  expect(requests).toHaveLength(2);
  requests[1].reply(2, pub(42));
  await vi.advanceTimersByTimeAsync(0);
  expect(getThumbnailPublication('stalled-asset')?.publicationVersion).toBe(pub(42));
});

it('retains current subscribers while stopped and resynchronizes only those still subscribed on resume', async () => {
  const requests = deferredStatus();
  const active = subscribeThumbnailPublication('shutdown-asset', () => {});
  const stream = Stream.latest;
  await vi.advanceTimersByTimeAsync(25);
  expect(requests).toHaveLength(1);
  closeThumbnailPublicationStream();
  expect(stream.close).toHaveBeenCalledOnce();
  expect(requests[0].signal.aborted).toBe(true);
  stream.emit(generation, 1, 'shutdown-asset', pub(2));
  const late = subscribeThumbnailPublication('late-asset', () => {});
  late();
  await vi.advanceTimersByTimeAsync(10000);
  expect(requests).toHaveLength(1);
  expect(Stream.latest).toBe(stream);
  resumeThumbnailPublicationStream();
  await vi.advanceTimersByTimeAsync(25);
  expect(requests[1].ids).toEqual(['shutdown-asset']);
  requests[1].reply(1, pub(2));
  await vi.advanceTimersByTimeAsync(0);
  expect(requests).toHaveLength(2);
  expect(requests[1].ids).not.toContain('late-asset');
  expect(getThumbnailPublication('shutdown-asset')?.publicationVersion).toBe(pub(2));
  expect(Stream.latest).not.toBe(stream);
  active();
  const resumedStream = Stream.latest;
  closeThumbnailPublicationStream();
  resumeThumbnailPublicationStream();
  expect(Stream.latest).toBe(resumedStream);
});
