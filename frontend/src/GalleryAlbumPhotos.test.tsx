// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';
import type { RecentAsset } from './assets';
import { updateSetting } from './appSettings';
import { PHOTO_FILTER_SESSION_KEYS, writePhotoFilterMode } from './photoFilters';
import i18n from './i18n';

const api = vi.hoisted(() => ({ recent: vi.fn(), albums: vi.fn(), albumAssets: vi.fn(), statuses: vi.fn() }));
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()),
  fetchRecentAssets: api.recent, fetchAlbums: api.albums, fetchAlbumAssets: api.albumAssets }));
vi.mock('./editStateApi', async original => ({ ...(await original<typeof import('./editStateApi')>()),
  getAssetEditStatuses: api.statuses }));

const albumA = { id: 'album-a', albumName: '車両整備関係', albumThumbnailAssetId: null, assetCount: 3,
  startDate: null, endDate: null };
const albumB = { ...albumA, id: 'album-b', albumName: '次のアルバム' };
const recent: RecentAsset[] = [{ id: 'recent-1', filename: 'recent.jpg', date: '2026-09-27',
  thumbnail_url: '/thumb/recent', format: 'JPEG', is_raw: false }];
const albumPhotos: RecentAsset[] = Array.from({ length: 3 }, (_, index) => ({
  id: `album-${index}`, filename: `photo-${index}.dng`, date: '2026-09-27',
  thumbnail_url: `/thumb/album-${index}`, format: index === 1 ? 'JPEG' : 'DNG', is_raw: index !== 1,
}));
let host: HTMLDivElement;
let root: Root;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function NavigationProbe() {
  const state = useLocation().state as { selectedAssets?: RecentAsset[] } | null;
  return <output className="navigation-probe">{state?.selectedAssets?.map(asset => asset.id).join('|')}</output>;
}

async function mount() {
  await act(async () => { root.render(<MemoryRouter><Routes>
    <Route path="/" element={<GalleryPage />} />
    <Route path="/anshitsu/:assetId" element={<NavigationProbe />} />
  </Routes></MemoryRouter>); });
}

function click(selector: string) { act(() => host.querySelector<HTMLButtonElement>(selector)!.click()); }
function pressD() { act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }))); }
async function settle() { await act(async () => { await Promise.resolve(); }); }
function changeFilter(value: 'both' | 'raw' | 'nonRaw') {
  const select = host.querySelector<HTMLSelectElement>('.photo-filter-control select')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await i18n.changeLanguage('en');
  sessionStorage.clear();
  writePhotoFilterMode('both', 'recent'); writePhotoFilterMode('both', 'albums'); writePhotoFilterMode('both', 'calendar');
  updateSetting('recentPhotoCount', 100); updateSetting('homeThumbnailColumns', 6);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.recent.mockReset().mockResolvedValue(recent);
  api.albums.mockReset().mockResolvedValue([albumA, albumB]);
  api.albumAssets.mockReset().mockResolvedValue(albumPhotos);
  api.statuses.mockReset().mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, id === 'album-0'])));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); sessionStorage.clear();
  writePhotoFilterMode('both', 'recent'); writePhotoFilterMode('both', 'albums'); writePhotoFilterMode('both', 'calendar');
  updateSetting('recentPhotoCount', 100); updateSetting('homeThumbnailColumns', 6); vi.unstubAllGlobals();
});

describe('album photo view', () => {
  it('only returns to the album list when reactivating Albums, preserving ordinary tab switches', async () => {
    await mount();
    click('.photo-selection-input');
    click('#home-recent-tab');
    expect(host.querySelector('.photo-card.selected')).not.toBeNull();
    expect(api.recent).toHaveBeenCalledTimes(1);
    click('#home-albums-tab'); await settle();
    click('#home-albums-tab'); await settle();
    expect(api.albums).toHaveBeenCalledTimes(1);
    expect(api.albumAssets).not.toHaveBeenCalled();
    click('.album-card'); await settle(); click('.photo-selection-input');
    click('#home-recent-tab'); click('#home-albums-tab'); await settle();
    expect(host.querySelector('.album-detail-heading h2')?.textContent).toBe(albumA.albumName);
    expect(host.querySelector('.photo-card.selected')).not.toBeNull();
    click('#home-albums-tab'); await settle();
    expect(host.querySelector('#home-albums-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('.album-detail-heading')).toBeNull();
    expect(host.querySelectorAll('.album-card')).toHaveLength(2);
    expect(api.albums).toHaveBeenCalledTimes(1);
    click('#home-recent-tab');
    expect(host.querySelector('.photo-card.selected .photo-info p')?.textContent).toBe('recent.jpg');
    click('#home-albums-tab'); await settle();
    expect(host.querySelectorAll('.album-card')).toHaveLength(2);
  });

  it('opens a keyboard-ready card, shows photo controls and badges, and returns without refetching albums', async () => {
    await mount(); click('#home-albums-tab'); await settle();
    expect(host.querySelector('.home-toolbar-controls .photo-filter-control')).toBeNull();
    const card = host.querySelector<HTMLButtonElement>('.album-card')!;
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute('aria-label')).toContain(albumA.albumName);
    click('.album-card'); await settle();
    expect(host.querySelector('#home-albums-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('.album-detail-heading h2')?.textContent).toBe(albumA.albumName);
    expect(host.querySelector('.home-toolbar-controls .photo-filter-control')).not.toBeNull();
    expect(host.querySelector('.recent-count-control')).toBeNull();
    expect(host.querySelectorAll('.photo-card')).toHaveLength(3);
    expect(host.querySelectorAll('.format-badge.raw')).toHaveLength(2);
    await settle();
    expect(host.querySelectorAll('.edited-badge')).toHaveLength(1);
    expect(api.albumAssets).toHaveBeenCalledWith(albumA.id, expect.any(AbortSignal));
    click('.album-back');
    expect(host.querySelectorAll('.album-card')).toHaveLength(2);
    expect(host.querySelector('.home-toolbar-controls .photo-filter-control')).toBeNull();
    expect(api.albums).toHaveBeenCalledTimes(1);
  });

  it('shows loading, error, and empty states with a usable way back', async () => {
    const pending = deferred<RecentAsset[]>();
    api.albumAssets.mockReset().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('Failed')).mockResolvedValueOnce([]);
    await mount(); click('#home-albums-tab'); await settle();
    click('.album-card');
    expect(host.querySelector('.home-tab-panel .gallery-message[role="status"]')?.textContent).toContain('Loading album photos');
    click('#home-albums-tab');
    expect((api.albumAssets.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    click('.album-card'); await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Album photos could not be loaded.');
    click('.album-back'); click('.album-card'); await settle();
    expect(host.querySelector('.gallery-message')?.textContent).toBe('No photos in this album');
    await act(async () => pending.resolve(albumPhotos));
    expect(host.querySelector('.photo-card')).toBeNull();
    expect(api.albums).toHaveBeenCalledTimes(1);
  });

  it('keeps Album B after a stale Album A request resolves', async () => {
    const stale = deferred<RecentAsset[]>();
    api.albumAssets.mockReset().mockReturnValueOnce(stale.promise).mockResolvedValueOnce([albumPhotos[1]]);
    await mount(); click('#home-albums-tab'); await settle();
    click('.album-card');
    click('.album-back');
    expect((api.albumAssets.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    const cards = [...host.querySelectorAll<HTMLButtonElement>('.album-card')];
    act(() => cards[1].click()); await settle();
    await act(async () => stale.resolve(albumPhotos));
    expect(host.querySelector('.album-detail-heading h2')?.textContent).toBe(albumB.albumName);
    expect(host.querySelectorAll('.photo-card')).toHaveLength(1);
    expect(host.querySelector('.photo-card .photo-info p')?.textContent).toBe('photo-1.dng');
  });

  it('clears Album selection and its Shift anchor before opening another album', async () => {
    api.albumAssets.mockImplementation(async (id: string) => id === albumA.id ? albumPhotos : [{ ...albumPhotos[0], id: 'other-photo' }]);
    await mount(); click('#home-albums-tab'); await settle(); click('.album-card'); await settle();
    click('.photo-selection-input');
    expect(host.querySelector('.selection-bar')?.textContent).toContain('1 selected');
    click('.album-back');
    const cards = [...host.querySelectorAll<HTMLButtonElement>('.album-card')];
    act(() => cards[1].click()); await settle();
    expect(host.querySelector('.photo-card.selected')).toBeNull();
    expect(host.querySelector('.selection-bar')).toBeNull();
    act(() => host.querySelector<HTMLInputElement>('.photo-selection-input')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })));
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(1);
  });

  it('shares filter state, keeps Recent selection, and isolates Album selection with Shift ranges', async () => {
    await mount();
    click('.photo-selection-input');
    click('#home-albums-tab'); await settle(); click('.album-card'); await settle();
    expect(host.querySelector('.photo-card.selected')).toBeNull();
    changeFilter('raw');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(2);
    expect(sessionStorage.getItem(PHOTO_FILTER_SESSION_KEYS.albums)).toBe('raw');
    changeFilter('both');
    const boxes = [...host.querySelectorAll<HTMLInputElement>('.photo-selection-input')];
    act(() => boxes[0].click());
    act(() => boxes[2].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })));
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(3);
    expect(host.querySelector('.selection-bar')?.textContent).toContain('3 selected');
    act(() => boxes[1].click());
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(2);
    click('#home-recent-tab');
    expect(host.querySelector('.photo-card.selected .photo-info p')?.textContent).toBe('recent.jpg');
    expect(host.querySelector('.selection-bar')?.textContent).toContain('1 selected');
    click('#home-albums-tab');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(2);
    pressD();
    expect(host.querySelector('.navigation-probe')?.textContent).toBe('album-0|album-2');
  });

  it('keeps Album filters independent from Recent and shared across Album A and B', async () => {
    await mount();
    changeFilter('raw');
    click('#home-albums-tab'); await settle();
    click('.album-card'); await settle();
    changeFilter('nonRaw');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(1);
    expect(sessionStorage.getItem(PHOTO_FILTER_SESSION_KEYS.recent)).toBe('raw');
    expect(sessionStorage.getItem(PHOTO_FILTER_SESSION_KEYS.albums)).toBe('nonRaw');
    click('.album-back');
    const cards = [...host.querySelectorAll<HTMLButtonElement>('.album-card')];
    act(() => cards[1].click()); await settle();
    expect(host.querySelector<HTMLSelectElement>('.photo-filter-control select')?.value).toBe('nonRaw');
    click('#home-recent-tab');
    expect(host.querySelector<HTMLSelectElement>('.photo-filter-control select')?.value).toBe('raw');
    click('#home-albums-tab'); await settle();
    expect(host.querySelector<HTMLSelectElement>('.photo-filter-control select')?.value).toBe('nonRaw');
  });

  it('loads edit statuses in batches of 100 for large albums', async () => {
    api.albumAssets.mockResolvedValue(Array.from({ length: 151 }, (_, index) => ({ ...albumPhotos[0], id: `album-${index}` })));
    await mount(); click('#home-albums-tab'); await settle();
    api.statuses.mockClear();
    click('.album-card'); await settle(); await settle();
    expect(api.statuses.mock.calls.map(([ids]) => ids.length)).toEqual([100, 51]);
    expect(host.querySelectorAll('.edited-badge')).toHaveLength(1);
  });

  it('opens a single Album photo in the darkroom', async () => {
    await mount(); click('#home-albums-tab'); await settle(); click('.album-card'); await settle();
    click('.photo-card-button');
    expect(host.querySelector('.navigation-probe')?.textContent).toBe('album-0');
  });
});
