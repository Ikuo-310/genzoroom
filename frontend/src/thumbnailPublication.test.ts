import { afterEach, expect, it, vi } from 'vitest';
import { getThumbnailPublication, subscribeThumbnailPublication } from './thumbnailPublication';

const generation = 'a'.repeat(32);
const nextGeneration = 'b'.repeat(32);

class Stream extends EventTarget {
  static latest: Stream;
  close = vi.fn();
  constructor() { super(); Stream.latest = this; }
  emit(generationId: string, sequence: number, assetId: string, publicationVersion: string) {
    this.dispatchEvent(new MessageEvent('publication', {
      data: JSON.stringify({ generationId, sequence, assetId, state: 'published', publicationVersion }),
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

function deferredStatus() {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', Stream);
  const requests: Array<{
    ids: string[]; signal: AbortSignal; fail: () => void;
    reply: (sequence: number, version: string, id?: string) => void;
  }> = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise<Response>(resolve => {
    const ids: string[] = JSON.parse(String(init.body)).assetIds;
    requests.push({ ids, signal: init.signal!, fail: () => resolve(new Response(null, { status: 503 })),
      reply: (sequence, version, generationId = generation) => resolve(new Response(JSON.stringify({
        sequence, generationId, items: Object.fromEntries(ids.map(id => [id, {
          state: 'published', publicationVersion: version, recipeRevision: 1,
        }])),
      }))) });
  }));
  return requests;
}

it('orders snapshots per Asset across batches and rejects a response from before a generation change', async () => {
  const requests = deferredStatus();
  watch(Array.from({ length: 1001 }, (_, index) => String(index)));
  const stream = Stream.latest;
  stream.emit(generation, 1, '1000', '1');
  await vi.advanceTimersByTimeAsync(25);
  expect(requests[0].ids).toHaveLength(1000);
  requests[0].reply(8, '8');
  await vi.advanceTimersByTimeAsync(0);
  expect(requests[1].ids).toEqual(['1000']);
  stream.emit(generation, 2, '1000', '2');
  requests[1].reply(1, '1');
  await vi.advanceTimersByTimeAsync(0);
  expect(getThumbnailPublication('1000')?.publicationVersion).toBe('2');
  stream.dispatchEvent(new Event('open'));
  await vi.advanceTimersByTimeAsync(25);
  stream.emit(nextGeneration, 1, '0', '19');
  expect(requests[2].signal.aborted).toBe(true);
  requests[2].reply(99, '99');
  await vi.advanceTimersByTimeAsync(25);
  expect(getThumbnailPublication('0')?.publicationVersion).toBe('19');
  subscriptions.splice(0).forEach(stop => stop());
  expect(getThumbnailPublication('0')).toBeUndefined();
  stream.emit(nextGeneration, 2, 'never-watched', '20');
  expect(getThumbnailPublication('never-watched')).toBeUndefined();
  requests[3].reply(1, '19', nextGeneration);
  await vi.advanceTimersByTimeAsync(1000);
  expect(stream.close).toHaveBeenCalledOnce();
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
  requests[4].reply(5, '5');
  await vi.advanceTimersByTimeAsync(0);
  expect(getThumbnailPublication('a')?.publicationVersion).toBe('5');
});
