// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { RecentAsset } from './assets';
import { Filmstrip } from './Filmstrip';
import i18n from './i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const first: RecentAsset = { id: 'first', filename: 'first.jpg', date: '', thumbnail_url: '/first', format: 'JPEG', is_raw: false };
const second: RecentAsset = { id: 'second', filename: 'second.jpg', date: '', thumbnail_url: '/second', format: 'JPEG', is_raw: false };
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

it('moves eager priority to the active Asset without replacing images or URLs', async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await i18n.changeLanguage('en');
  const render = (activeAssetId: string) => <Filmstrip assets={[first, second]} activeAssetId={activeAssetId} onActivate={vi.fn()} />;
  await act(async () => root?.render(render(first.id)));
  const firstImage = container.querySelectorAll('img')[0];
  const secondImage = container.querySelectorAll('img')[1];
  const urls = [firstImage.getAttribute('src'), secondImage.getAttribute('src')];
  expect(firstImage.getAttribute('loading')).toBe('eager');
  expect(firstImage.getAttribute('fetchpriority')).toBe('high');
  expect(secondImage.getAttribute('loading')).toBe('lazy');
  await act(async () => root?.render(render(second.id)));
  expect(container.querySelectorAll('img')[0]).toBe(firstImage);
  expect(container.querySelectorAll('img')[1]).toBe(secondImage);
  expect([firstImage.getAttribute('src'), secondImage.getAttribute('src')]).toEqual(urls);
  expect(firstImage.getAttribute('loading')).toBe('lazy');
  expect(firstImage.getAttribute('fetchpriority')).toBe('auto');
  expect(secondImage.getAttribute('loading')).toBe('eager');
  expect(secondImage.getAttribute('fetchpriority')).toBe('high');
});
