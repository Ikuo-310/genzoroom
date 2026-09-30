// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';
import { updateSetting } from './appSettings';
import { writePhotoFilterMode } from './photoFilters';
import i18n from './i18n';

const api = vi.hoisted(() => ({ recent: vi.fn(), albums: vi.fn() }));
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()),
  fetchRecentAssets: api.recent, fetchAlbums: api.albums }));
vi.mock('./useEditStatuses', () => ({ useEditStatuses: () => ({}) }));

const photo = { id: 'photo-1', filename: 'photo.jpg', date: '2026-09-27', thumbnail_url: '/thumb/1', format: 'JPEG', is_raw: false };
const album = { id: 'album-1', albumName: '旅行 2026', albumThumbnailAssetId: 'cover-1', assetCount: 2,
  startDate: '2026-04-01T00:00:00.000Z', endDate: '2026-05-01T00:00:00.000Z' };
let host: HTMLDivElement;
let root: Root;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function mount() {
  await act(async () => { root.render(<MemoryRouter><GalleryPage /></MemoryRouter>); });
}
function clickTab(id: string) { act(() => host.querySelector<HTMLButtonElement>(id)!.click()); }

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await i18n.changeLanguage('en');
  sessionStorage.clear(); writePhotoFilterMode('both');
  updateSetting('dateLocale', 'en-US'); updateSetting('recentPhotoCount', 100);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.recent.mockReset().mockResolvedValue([photo]);
  api.albums.mockReset().mockResolvedValue([album]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); sessionStorage.clear(); writePhotoFilterMode('both');
  updateSetting('dateLocale', 'auto'); vi.unstubAllGlobals();
});

describe('Home album tab', () => {
  it('starts with Recent, renders albums, and keeps the recent photo state when returning', async () => {
    await mount();
    expect(host.querySelector('#home-recent-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(api.recent).toHaveBeenCalledTimes(1);
    expect(api.albums).not.toHaveBeenCalled();
    expect(host.querySelectorAll('.photo-card')).toHaveLength(1);
    act(() => host.querySelector<HTMLInputElement>('.photo-selection-input')!.click());
    const filter = host.querySelector<HTMLSelectElement>('.photo-filter-control select')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(filter, 'nonRaw');
      filter.dispatchEvent(new Event('change', { bubbles: true }));
    });
    clickTab('#home-albums-tab');
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('#home-albums-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(api.albums).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.album-card h3')?.textContent).toBe('旅行 2026');
    expect(host.querySelector<HTMLImageElement>('.album-cover img')?.getAttribute('src')).toBe('/api/assets/cover-1/thumbnail');
    expect(host.querySelector('.album-period')?.textContent).toBe('Apr 2026 – May 2026');
    expect(host.querySelector('.album-count')?.textContent).toBe('2 items');
    expect(host.querySelector('.photo-filter-control')).toBeNull();
    expect(host.querySelector('.recent-count-control')).toBeNull();
    expect(host.querySelector('.thumbnail-size-setting')).toBeNull();
    expect(host.querySelector('.selection-bar')).toBeNull();
    clickTab('#home-recent-tab');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(1);
    expect(host.querySelector('.photo-card.selected')).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('.photo-filter-control select')?.value).toBe('nonRaw');
    expect(api.recent).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.photo-filter-control')).not.toBeNull();
  });

  it('shows a cover placeholder, no period, and zero items for an empty album', async () => {
    api.albums.mockResolvedValue([{ ...album, albumThumbnailAssetId: null, assetCount: 0, startDate: null, endDate: null }]);
    await mount(); clickTab('#home-albums-tab');
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('.album-cover img')).toBeNull();
    expect(host.querySelector('.album-cover-placeholder')?.textContent).toBe('No cover');
    expect(host.querySelector('.album-period')).toBeNull();
    expect(host.querySelector('.album-count')?.textContent).toBe('0 items');
  });

  it('shows one month once and a one-sided album period', async () => {
    api.albums.mockResolvedValue([
      { ...album, startDate: '2026-04-01T00:00:00.000Z', endDate: '2026-04-30T00:00:00.000Z' },
      { ...album, id: 'album-2', startDate: null },
    ]);
    await mount(); clickTab('#home-albums-tab');
    await act(async () => { await Promise.resolve(); });
    expect([...host.querySelectorAll('.album-period')].map(node => node.textContent)).toEqual(['Apr 2026', 'May 2026']);
  });

  it('shows loading, ignores an aborted request, and handles empty and error states', async () => {
    const stale = deferred<typeof album[]>();
    api.albums.mockReset().mockReturnValueOnce(stale.promise).mockResolvedValueOnce([]);
    await mount(); clickTab('#home-albums-tab');
    expect(host.querySelector('.home-tab-panel .gallery-message[role="status"]')?.textContent).toContain('Loading albums');
    clickTab('#home-recent-tab');
    expect((api.albums.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
    clickTab('#home-albums-tab');
    await act(async () => { await Promise.resolve(); });
    await act(async () => stale.resolve([album]));
    expect(host.querySelector('.gallery-message')?.textContent).toBe('No albums');
    expect(host.querySelector('.album-card')).toBeNull();
    clickTab('#home-recent-tab');
    api.albums.mockRejectedValueOnce(new Error('Failed'));
    clickTab('#home-albums-tab');
    await act(async () => { await Promise.resolve(); });
    // A previously loaded list remains visible if a later refresh fails.
    expect(host.querySelector('.gallery-message')?.textContent).toBe('No albums');
  });

  it('shows an initial album error and supports keyboard tab switching', async () => {
    api.albums.mockRejectedValue(new Error('Failed'));
    await mount();
    const recent = host.querySelector<HTMLButtonElement>('#home-recent-tab')!;
    act(() => recent.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('#home-albums-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Albums could not be loaded.');
  });

  it('keeps user album names while translating fixed UI and date locale', async () => {
    await i18n.changeLanguage('ja');
    updateSetting('dateLocale', 'ja-JP');
    await mount(); clickTab('#home-albums-tab');
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('#home-albums-tab')?.textContent).toBe('アルバム');
    expect(host.querySelector('.album-card h3')?.textContent).toBe('旅行 2026');
    expect(host.querySelector('.album-period')?.textContent).toBe('2026年4月〜2026年5月');
    expect(host.querySelector('.album-count')?.textContent).toBe('2枚');
  });
});
