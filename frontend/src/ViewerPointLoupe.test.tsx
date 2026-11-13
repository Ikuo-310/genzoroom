// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ViewerPointLoupe } from './ViewerPointLoupe';
import { regionRequest, regionResponse } from './test/rawRegion';
import type { RawRegionLayer } from './rawRegionOverlay';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('magnifies the displayed Whole image at the same normalized point and aligns its Region overlay', () => {
  const metadata = regionResponse(regionRequest({ window: { x: 10, y: 5, w: 10, h: 10 },
    validRegion: { x: 12, y: 6, w: 6, h: 8 } }));
  const region = { url: 'blob:region', metadata, planGeneration: 1,
    nativePlacement: { x0: 10, y0: 5, x1: 20, y1: 15 },
    validNativeRect: { x0: 12, y0: 6, x1: 18, y1: 14 } } as RawRegionLayer;
  act(() => root.render(<ViewerPointLoupe viewport={{ x: 400, y: 300 }} anchor={{ x: 200, y: 180 }} imagePoint={{ x: .25, y: .4 }}
    imageSize={{ x: 100, y: 50 }} scale={2} source="blob:whole" region={region} fixed />));

  const loupe = host.querySelector<HTMLElement>('[data-testid="viewer-point-loupe"]')!;
  const image = host.querySelector<HTMLElement>('.viewer-point-loupe-image')!;
  const [whole, overlay] = host.querySelectorAll<HTMLImageElement>('.viewer-point-loupe-image img');
  expect(loupe.style.width).toBe('120px'); expect(loupe.style.pointerEvents).toBe('none');
  expect(loupe.dataset.fixed).toBe('true'); expect(loupe.dataset.pointX).toBe('0.25');
  expect(whole.src).toBe('blob:whole'); expect(overlay.src).toBe('blob:region');
  expect(image.style.width).toBe('800px'); expect(image.style.height).toBe('400px');
  expect(image.style.left).toBe('-140px'); expect(image.style.top).toBe('-100px');
  expect(overlay.style.left).toBe('80px'); expect(overlay.style.top).toBe('40px');
  expect(overlay.style.width).toBe('80px'); expect(overlay.style.height).toBe('80px');
  expect(host.querySelector('.viewer-point-crosshair')).toBeNull();
  expect(host.querySelector('.viewer-point-loupe-crosshair')).not.toBeNull();

  act(() => root.render(<ViewerPointLoupe viewport={{ x: 400, y: 300 }} anchor={{ x: 200, y: 180 }} imagePoint={{ x: .25, y: .4 }}
    imageSize={{ x: 100, y: 50 }} scale={2} source="blob:whole-draft" region={{ ...region, url: 'blob:region-draft' }} fixed />));
  expect(host.querySelectorAll<HTMLImageElement>('.viewer-point-loupe-image img')[0].src).toBe('blob:whole-draft');
  expect(host.querySelectorAll<HTMLImageElement>('.viewer-point-loupe-image img')[1].src).toBe('blob:region-draft');
  expect(host.querySelector<HTMLElement>('.viewer-point-loupe-image')?.style.left).toBe('-140px');
});
