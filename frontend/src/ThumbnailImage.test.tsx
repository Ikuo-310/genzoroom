// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frontendLogger } from './frontendLogging';
import { ThumbnailImage } from './ThumbnailImage';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
});

describe('ThumbnailImage diagnostics', () => {
  it('resolves the selected Asset rendition in the shared component', async () => {
    await act(async () => root.render(<ThumbnailImage rendition="rendered-thumbnail" revision="view:2" assetId="asset/id"
      surface="gallery" mode="rendered" alt="" />));
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/assets/asset%2Fid/rendered-thumbnail?view=view%3A2');
  });

  it('correlates image lifecycle and records load failures without exposing image URLs', async () => {
    frontendLogger.setLevel('debug');
    await act(async () => root.render(<ThumbnailImage src="/private/image" assetId="asset" surface="stack"
      mode="original" alt="" loading="lazy" />));
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
    const unrelatedLoad = vi.fn(), parentAction = vi.fn();
    await act(async () => root.render(<><button onClick={parentAction}><ThumbnailImage src="/photo/a" assetId="a" surface="gallery" mode="original" alt="" /></button>
      <button onClick={parentAction}><ThumbnailImage src="/photo/b" assetId="b" surface="gallery" mode="original" alt="" onLoad={unrelatedLoad} /></button></>));
    const [failed, healthy] = host.querySelectorAll('img');
    expect(failed.dataset.thumbnailState).toBe('loading');
    await act(async () => healthy.dispatchEvent(new Event('load')));
    expect(healthy.dataset.thumbnailState).toBe('loaded');
    await act(async () => failed.dispatchEvent(new Event('error')));
    expect(failed.dataset.thumbnailState).toBe('failed');
    expect(failed.getAttribute('src')).toContain('data:image/svg+xml');

    await act(async () => failed.click());
    expect(parentAction).not.toHaveBeenCalled();
    const retried = host.querySelectorAll('img')[0];
    expect(retried).not.toBe(failed);
    expect(retried.dataset.thumbnailState).toBe('loading');
    expect(retried.getAttribute('src')).toBe('/photo/a');
    expect(host.querySelectorAll('img')[1].dataset.thumbnailState).toBe('loaded');
    expect(unrelatedLoad).toHaveBeenCalledOnce();
  });

  it('ignores events from an old source and resets when source or publication version changes', async () => {
    await act(async () => root.render(<ThumbnailImage src="/photo/old" assetId="asset" surface="gallery" mode="rendered" alt="" publicationVersion="1" />));
    const oldImage = host.querySelector('img')!;
    await act(async () => root.render(<ThumbnailImage src="/photo/new" assetId="asset" surface="gallery" mode="rendered" alt="" publicationVersion="1" />));
    const newImage = host.querySelector('img')!;
    await act(async () => oldImage.dispatchEvent(new Event('error')));
    expect(newImage.dataset.thumbnailState).toBe('loading');
    expect(newImage.getAttribute('src')).toBe('/photo/new');

    await act(async () => newImage.dispatchEvent(new Event('load')));
    await act(async () => root.render(<ThumbnailImage src="/photo/new" assetId="asset" surface="gallery" mode="rendered" alt="" publicationVersion="2" />));
    const nextVersion = host.querySelector('img')!;
    expect(nextVersion).not.toBe(newImage);
    expect(nextVersion.dataset.thumbnailState).toBe('loading');
    expect(nextVersion.getAttribute('src')).toBe('/photo/new');
  });

  it('keeps lifecycle diagnostics through unmount without exposing request URLs', async () => {
    frontendLogger.setLevel('debug');
    await act(async () => root.render(<ThumbnailImage src="/private/path" assetId="asset" surface="stack" mode="original" alt="" />));
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
});
