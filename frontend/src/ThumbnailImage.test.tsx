// @vitest-environment jsdom
import { act, type MouseEvent as ReactMouseEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frontendLogger } from './frontendLogging';
import { isThumbnailRetryTarget, ThumbnailImage } from './ThumbnailImage';

const pub = (value: number) => value.toString(16).padStart(32, '0');

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frontendLogger.setLevel('off');
  frontendLogger.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  frontendLogger.setLevel('off');
  frontendLogger.clear();
  vi.unstubAllGlobals();
});

describe('ThumbnailImage diagnostics', () => {
  it('resolves the selected Asset rendition in the shared component', async () => {
    await act(async () => root.render(<div data-thumbnail-retry-host><button data-thumbnail-action><ThumbnailImage rendition="rendered-thumbnail" publicationVersion={pub(12345)} assetId="asset/id"
      surface="gallery" mode="rendered" alt="" /></button></div>));
    expect(host.querySelector('img')?.getAttribute('src')).toBe(`/api/assets/asset%2Fid/rendered-thumbnail?publication=${pub(12345)}`);
  });

  it('correlates image lifecycle and records load failures without exposing image URLs', async () => {
    frontendLogger.setLevel('debug');
    await act(async () => root.render(<div data-thumbnail-retry-host><button data-thumbnail-action><ThumbnailImage src="/private/image" assetId="asset" surface="stack"
      mode="original" alt="" loading="lazy" /></button></div>));
    const image = host.querySelector('img')!;
    const diagnosticId = new URL(image.src).searchParams.get('__diag');
    expect(diagnosticId).toBeTruthy();
    await act(async () => image.dispatchEvent(new Event('error')));
    expect(frontendLogger.getEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'image.sourceAssigned', context: expect.objectContaining({ diagnosticId, assetId: 'asset' }) }),
      expect.objectContaining({ event: 'image.loadFailed', level: 'warn', context: expect.objectContaining({ diagnosticId, naturalWidth: 0 }) }),
    ]));
    expect(JSON.stringify(frontendLogger.getEntries())).not.toContain('/private/image');
  });

  it('tracks loading, success and failure, then retries only the failed image on explicit activation', async () => {
    const unrelatedLoad = vi.fn(), parentAction = vi.fn(), parentCapture = vi.fn();
    const capture = (event: ReactMouseEvent<HTMLDivElement>) => { if (!isThumbnailRetryTarget(event.target)) parentCapture(); };
    await act(async () => root.render(<><div data-thumbnail-retry-host onClickCapture={capture}><button data-thumbnail-action onClick={parentAction}>
      <ThumbnailImage src="/photo/a" assetId="a" surface="gallery" mode="original" alt="" /></button></div>
      <div data-thumbnail-retry-host onClickCapture={capture}><button data-thumbnail-action onClick={parentAction}>
        <ThumbnailImage src="/photo/b" assetId="b" surface="gallery" mode="original" alt="" onLoad={unrelatedLoad} /></button></div></>));
    const [failed, healthy] = host.querySelectorAll('img');
    expect(failed.dataset.thumbnailState).toBe('loading');
    await act(async () => healthy.dispatchEvent(new Event('load')));
    expect(healthy.dataset.thumbnailState).toBe('loaded');
    await act(async () => healthy.closest('button')!.click());
    expect(parentAction).toHaveBeenCalledOnce();
    expect(parentCapture).toHaveBeenCalledOnce();
    parentAction.mockClear(); parentCapture.mockClear();
    await act(async () => failed.dispatchEvent(new Event('error')));
    expect(failed.dataset.thumbnailState).toBe('failed');
    expect(failed.getAttribute('src')).toContain('data:image/svg+xml');

    const retryButton = host.querySelector<HTMLButtonElement>('[data-thumbnail-retry]')!;
    expect(retryButton.parentElement?.hasAttribute('data-thumbnail-retry-host')).toBe(true);
    expect(retryButton.closest('button[data-thumbnail-action]')).toBeNull();
    retryButton.focus();
    await act(async () => retryButton.click());
    expect(parentAction).not.toHaveBeenCalled();
    expect(parentCapture).not.toHaveBeenCalled();
    const retried = host.querySelectorAll('img')[0];
    expect(retried).not.toBe(failed);
    expect(retried.dataset.thumbnailState).toBe('loading');
    expect(retried.getAttribute('src')).toBe('/photo/a');
    expect(host.querySelectorAll('img')[1].dataset.thumbnailState).toBe('loaded');
    expect(unrelatedLoad).toHaveBeenCalledOnce();

    await act(async () => retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })));
    await act(async () => retryButton.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })));
    expect(host.querySelectorAll('img')[0]).toBe(retried);
    expect(parentAction).not.toHaveBeenCalled();
    expect(parentCapture).not.toHaveBeenCalled();
    await act(async () => retried.dispatchEvent(new Event('load')));
    expect(document.activeElement).toBe(host.querySelector('button[data-thumbnail-action]'));
  });

  it.each(['Enter', ' '])('retries from %s and prevents the parent card key action', async key => {
    const parentKey = vi.fn();
    await act(async () => root.render(<div data-thumbnail-retry-host onKeyDown={parentKey}>
      <button data-thumbnail-action><ThumbnailImage src="/keyboard" assetId="keyboard" surface="gallery" mode="original" alt="" /></button>
    </div>));
    const image = host.querySelector('img')!;
    await act(async () => image.dispatchEvent(new Event('error')));
    const retryButton = host.querySelector<HTMLButtonElement>('[data-thumbnail-retry]')!;
    retryButton.focus();
    await act(async () => retryButton.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    expect(host.querySelector('img')).not.toBe(image);
    expect(host.querySelector('img')?.dataset.thumbnailState).toBe('loading');
    expect(parentKey).not.toHaveBeenCalled();
  });

  it('ignores events from an old source and resets when source or publication version changes', async () => {
    const renderImage = (src: string, publicationVersion: string) => <div data-thumbnail-retry-host>
      <button data-thumbnail-action><ThumbnailImage src={src} assetId="asset" surface="gallery" mode="rendered" alt="" publicationVersion={publicationVersion} /></button>
    </div>;
    await act(async () => root.render(renderImage('/photo/old', pub(1))));
    const oldImage = host.querySelector('img')!;
    await act(async () => root.render(renderImage('/photo/new', pub(1))));
    const newImage = host.querySelector('img')!;
    await act(async () => oldImage.dispatchEvent(new Event('error')));
    expect(newImage.dataset.thumbnailState).toBe('loading');
    expect(newImage.getAttribute('src')).toBe('/photo/new');

    await act(async () => newImage.dispatchEvent(new Event('load')));
    await act(async () => root.render(renderImage('/photo/new', pub(2))));
    const nextVersion = host.querySelector('img')!;
    expect(nextVersion).not.toBe(newImage);
    expect(nextVersion.dataset.thumbnailState).toBe('loading');
    expect(nextVersion.getAttribute('src')).toBe('/photo/new');
  });

  it('keeps lifecycle diagnostics through unmount without exposing request URLs', async () => {
    frontendLogger.setLevel('debug');
    await act(async () => root.render(<div data-thumbnail-retry-host><button data-thumbnail-action><ThumbnailImage src="/private/path" assetId="asset" surface="stack" mode="original" alt="" /></button></div>));
    const image = host.querySelector('img')!;
    const diagnosticId = new URL(image.src).searchParams.get('__diag');
    await act(async () => root.render(null));
    await act(async () => image.dispatchEvent(new Event('error')));
    expect(frontendLogger.getEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'image.sourceAssigned', context: expect.objectContaining({ diagnosticId }) }),
      expect.objectContaining({ event: 'image.elementReleased', context: expect.objectContaining({ diagnosticId }) }),
    ]));
    expect(frontendLogger.getEntries().some(entry => entry.event === 'image.loadFailed')).toBe(false);
    expect(JSON.stringify(frontendLogger.getEntries())).not.toContain('/private/path');
  });

  it('shares one publication stream, updates duplicate Assets only, and resynchronizes after reconnect', async () => {
    const sources: Array<{ emit: (name: string, data?: string) => void }> = [];
    class FakeEventSource {
      private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
      constructor(_url: string) { sources.push(this); }
      addEventListener(name: string, listener: EventListener) {
        const callbacks = this.listeners.get(name) ?? [];
        callbacks.push(listener as (event: MessageEvent<string>) => void);
        this.listeners.set(name, callbacks);
      }
      emit(name: string, data = '') {
        for (const listener of this.listeners.get(name) ?? []) listener({ data } as MessageEvent<string>);
      }
      close() {}
      get emitEvent() { return this.emit.bind(this); }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    let aVersion: string | null = pub(1);
    let statusSequence = 0;
    const generationId = 'a'.repeat(32);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const { assetIds } = JSON.parse(String(init?.body)) as { assetIds: string[] };
      return new Response(JSON.stringify({ generationId, sequence: statusSequence, items: Object.fromEntries(assetIds.map(assetId => [assetId, {
        recipeRevision: 4, state: 'published', publicationVersion: assetId === 'a' ? aVersion : pub(10),
      }])) }));
    });
    vi.stubGlobal('fetch', fetch);
    const view = () => <>
      <div data-thumbnail-retry-host><ThumbnailImage rendition="rendered-thumbnail" assetId="a" surface="gallery" mode="rendered" alt="" /></div>
      <div data-thumbnail-retry-host><ThumbnailImage rendition="rendered-thumbnail" assetId="a" surface="export" mode="rendered" alt="" /></div>
      <div data-thumbnail-retry-host><ThumbnailImage rendition="rendered-thumbnail" assetId="b" surface="stack" mode="rendered" alt="" /></div>
      <div data-thumbnail-retry-host><ThumbnailImage rendition="thumbnail" assetId="normal" surface="stack" mode="original" alt="" /></div>
    </>;
    vi.useFakeTimers();
    await act(async () => root.render(view()));
    expect(sources).toHaveLength(1);
    sources[0].emit('open');
    await act(async () => { await vi.advanceTimersByTimeAsync(30); });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [firstA, secondA, b, normal] = [...host.querySelectorAll('img')];
    expect(firstA.getAttribute('src')).toBe(`/api/assets/a/rendered-thumbnail?publication=${pub(1)}`);
    expect(secondA.getAttribute('src')).toBe(`/api/assets/a/rendered-thumbnail?publication=${pub(1)}`);
    expect(b.getAttribute('src')).toBe(`/api/assets/b/rendered-thumbnail?publication=${pub(10)}`);
    expect(normal.getAttribute('src')).toBe('/api/assets/normal/thumbnail');
    const bElement = b, normalElement = normal;
    for (const image of [...host.querySelectorAll('img')]) await act(async () => image.dispatchEvent(new Event('load')));
    expect(fetch).toHaveBeenCalledTimes(1);

    sources[0].emit('publication', JSON.stringify({ generationId, sequence: 1, assetId: 'a',
      state: 'published', publicationVersion: pub(2) }));
    await act(async () => {});
    expect([...host.querySelectorAll('img')].slice(0, 2).map(image => image.getAttribute('src'))).toEqual([
      `/api/assets/a/rendered-thumbnail?publication=${pub(2)}`, `/api/assets/a/rendered-thumbnail?publication=${pub(2)}`,
    ]);
    expect(host.querySelectorAll('img')[2]).toBe(bElement);
    expect(host.querySelectorAll('img')[3]).toBe(normalElement);
    expect(bElement.getAttribute('src')).toBe(`/api/assets/b/rendered-thumbnail?publication=${pub(10)}`);

    aVersion = pub(3);
    statusSequence = 2;
    sources[0].emit('open');
    await act(async () => { await vi.advanceTimersByTimeAsync(30); });
    expect(host.querySelectorAll('img')[0].getAttribute('src')).toBe(`/api/assets/a/rendered-thumbnail?publication=${pub(3)}`);
    sources[0].emit('publication', JSON.stringify({ generationId, sequence: 3, assetId: 'b',
      state: 'published', publicationVersion: pub(10) }));
    statusSequence = 5;
    aVersion = pub(4);
    sources[0].emit('publication', JSON.stringify({ generationId, sequence: 5, assetId: 'a',
      state: 'published', publicationVersion: pub(4) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30); });
    expect(host.querySelectorAll('img')[0].getAttribute('src')).toBe(`/api/assets/a/rendered-thumbnail?publication=${pub(4)}`);
    expect(sources).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);

    // A status response for A must not consume B's still in-flight SSE event.
    statusSequence = 9;
    aVersion = pub(9);
    await act(async () => host.querySelectorAll('img')[0].dispatchEvent(new Event('error')));
    await act(async () => { await vi.advanceTimersByTimeAsync(30); });
    expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body)).assetIds).toEqual(['a']);
    sources[0].emit('publication', JSON.stringify({ generationId, sequence: 6, assetId: 'b',
      state: 'published', publicationVersion: pub(11) }));
    await act(async () => {});
    expect(host.querySelectorAll('img')[2].getAttribute('src')).toContain(`publication=${pub(11)}`);

    statusSequence = 10;
    aVersion = null;
    const unaffected = host.querySelectorAll('img')[2];
    await act(async () => host.querySelectorAll('img')[0].dispatchEvent(new Event('error')));
    await act(async () => { await vi.advanceTimersByTimeAsync(30); });
    expect(host.querySelectorAll('img')[0].getAttribute('src')).toBe('/api/assets/a/thumbnail');
    expect(host.querySelectorAll('img')[2]).toBe(unaffected);
  });
});
