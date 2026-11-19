// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
