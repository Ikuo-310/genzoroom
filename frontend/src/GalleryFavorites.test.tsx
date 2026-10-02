// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';
import type { RecentAsset, WorkspaceNavigationState } from './assets';
import { homeScrollContent } from './homeReturn';
import { clearWorkspaceSession, rememberWorkspaceSession } from './workspaceResume';
import { EDIT_STATUS_FILTER_SESSION_KEYS, PHOTO_FILTER_SESSION_KEYS } from './photoFilters';
import i18n from './i18n';

const api = vi.hoisted(() => ({ recent: vi.fn(), favorites: vi.fn(), statuses: vi.fn() }));
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()),
  fetchRecentAssets: api.recent, fetchFavoriteAssets: api.favorites }));
vi.mock('./editStateApi', async original => ({ ...(await original<typeof import('./editStateApi')>()), getAssetEditStatuses: api.statuses }));

const photos: RecentAsset[] = Array.from({ length: 4 }, (_, index) => ({ id: `photo-${index}`,
  filename: `photo-${index}`, date: '2026-09-01', thumbnail_url: `/thumb/${index}`,
  format: index === 1 || index === 2 ? 'DNG' : 'JPEG', is_raw: index === 1 || index === 2 }));
let host: HTMLDivElement;
let root: Root;
let navigation: WorkspaceNavigationState | null;

function WorkspaceProbe() {
  navigation = useLocation().state as WorkspaceNavigationState;
  const navigate = useNavigate();
  return <button className="return-home" onClick={() => navigate('/', { state: { homeReturn: navigation?.homeReturn } })}>Home</button>;
}
async function mount() {
  await act(async () => root.render(<MemoryRouter><Routes>
    <Route path="/" element={<GalleryPage />} />
    <Route path="/anshitsu/:assetId" element={<WorkspaceProbe />} />
  </Routes></MemoryRouter>));
}
async function click(selector: string) { await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click()); }
async function pressD(target: EventTarget = window, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'D', bubbles: true, cancelable: true, ...options });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}
async function change(selector: string, value: string) {
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>(selector)!;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function setScroll(page: number, content: number) {
  const element = host.querySelector<HTMLElement>('.home-page')!;
  element.scrollTop = page; homeScrollContent(element)!.scrollTop = content;
}
function expectScroll(page: number, content: number) {
  const element = host.querySelector<HTMLElement>('.home-page')!;
  expect(element.scrollTop).toBe(page); expect(homeScrollContent(element)!.scrollTop).toBe(content);
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en'); sessionStorage.clear(); navigation = null;
  clearWorkspaceSession();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.recent.mockReset().mockResolvedValue([photos[0]]);
  api.favorites.mockReset().mockResolvedValue(photos);
  api.statuses.mockReset().mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, id === 'photo-0' || id === 'photo-2'])));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
});
afterEach(() => { act(() => root.unmount()); host.remove(); sessionStorage.clear(); clearWorkspaceSession(); vi.unstubAllGlobals(); });

describe('Home favorites', () => {
  it('loads lazily, reuses the grid and avoids refetching the successful list on tab switches or reactivation', async () => {
    await mount(); expect(api.favorites).not.toHaveBeenCalled();
    await click('#home-favorites-tab');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(4);
    expect(host.querySelectorAll('.edited-badge')).toHaveLength(2);
    expect(host.querySelectorAll('.format-badge')).toHaveLength(4);
    expect(host.querySelector('.recent-count-control')).toBeNull();
    expect(host.querySelector('.thumbnail-size-control')).not.toBeNull();
    await click('#home-recent-tab'); await click('#home-favorites-tab'); await click('#home-favorites-tab');
    expect(api.favorites).toHaveBeenCalledTimes(1);
    await act(async () => i18n.changeLanguage('ja'));
    expect(host.querySelector('#home-favorites-tab')?.textContent).toBe('お気に入り');
  });

  it('shows loading and empty results', async () => {
    let resolve!: (assets: RecentAsset[]) => void;
    api.favorites.mockReturnValue(new Promise<RecentAsset[]>(yes => { resolve = yes; }));
    await mount(); await click('#home-favorites-tab');
    expect(host.querySelector('#home-favorites-panel [role="status"]')?.textContent).toBe('Loading favorites…');
    await act(async () => resolve([]));
    expect(host.querySelector('.gallery-message')?.textContent).toBe('No favorite photos');
  });

  it('shows fetch errors and aborts stale results when leaving before completion', async () => {
    let resolve!: (assets: RecentAsset[]) => void;
    api.favorites.mockReturnValueOnce(new Promise<RecentAsset[]>(yes => { resolve = yes; })).mockRejectedValueOnce(new Error('Failed'));
    await mount(); await click('#home-favorites-tab'); await click('#home-recent-tab');
    expect((api.favorites.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
    await click('#home-favorites-tab');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Failed to load favorites');
    await act(async () => resolve(photos));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Failed to load favorites');
    expect(host.querySelector('.photo-card')).toBeNull();
  });

  it('keeps tab filters independent and applies RAW and edit status with AND', async () => {
    await mount(); await change('.photo-filter-control select', 'raw'); await click('#home-favorites-tab');
    expect(host.querySelector<HTMLSelectElement>('.photo-filter-control select')?.value).toBe('both');
    await change('.edit-status-filter-control select', 'edited');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(2);
    await change('.photo-filter-control select', 'raw');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(1);
    expect(host.querySelector('.photo-info p')?.textContent).toBe('photo-2');
    await change('.edit-status-filter-control select', 'unedited');
    expect(host.querySelector('.photo-info p')?.textContent).toBe('photo-1');
    expect(sessionStorage.getItem(PHOTO_FILTER_SESSION_KEYS.favorites)).toBe('raw');
    expect(sessionStorage.getItem(EDIT_STATUS_FILTER_SESSION_KEYS.favorites)).toBe('unedited');
    await click('#home-recent-tab');
    expect(host.querySelector<HTMLSelectElement>('.edit-status-filter-control select')?.value).toBe('both');
    await click('#home-favorites-tab');
    expect(host.querySelector<HTMLSelectElement>('.edit-status-filter-control select')?.value).toBe('unedited');
    expect(host.querySelector('.photo-info p')?.textContent).toBe('photo-1');
    act(() => root.render(<div />)); await mount(); await click('#home-favorites-tab');
    expect(host.querySelector<HTMLSelectElement>('.photo-filter-control select')?.value).toBe('raw');
    expect(host.querySelector<HTMLSelectElement>('.edit-status-filter-control select')?.value).toBe('unedited');
    expect(host.querySelector('.photo-info p')?.textContent).toBe('photo-1');
  });

  it('owns selection and range anchor independently, clears selection and sends only Favorites selections', async () => {
    await mount(); await click('.photo-selection-input'); await click('#home-favorites-tab');
    expect(host.querySelector('.photo-card.selected')).toBeNull();
    await click('.photo-selection-input');
    await act(async () => host.querySelectorAll('.photo-card-button')[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(3);
    await click('#home-recent-tab'); expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(1);
    await click('#home-favorites-tab'); expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(3);
    await click('.selection-clear'); expect(host.querySelector('.selection-bar')).toBeNull();
    await click('.photo-selection-input');
    await pressD();
    expect(navigation?.selectedAssets.map(asset => asset.id)).toEqual(['photo-0']);
    expect(navigation?.homeReturn?.tab).toBe('favorites');
  });

  it('opens the selected Recent photo with D and ignores D without a selection', async () => {
    await mount();
    expect((await pressD()).defaultPrevented).toBe(false);
    await click('.photo-selection-input');
    const event = await pressD();
    expect(event.defaultPrevented).toBe(true);
    expect(navigation?.selectedAssets.map(asset => asset.id)).toEqual(['photo-0']);
    expect(navigation?.homeReturn?.tab).toBe('recent');
  });

  it('resumes the last workspace when D is pressed without a selection and refreshes Home return context', async () => {
    rememberWorkspaceSession({ selectedAssets: photos.slice(0, 3), activeAssetId: 'photo-2', homeReturn: {
      tab: 'recent', album: null, year: 2026, month: 9, date: null, calendarMode: 'month',
      pageScrollTop: 1, contentScrollTop: 2,
    } });
    await mount(); await click('#home-favorites-tab');
    setScroll(45, 120);
    const event = await pressD();
    expect(event.defaultPrevented).toBe(true);
    expect(navigation?.selectedAssets.map(asset => asset.id)).toEqual(['photo-0', 'photo-1', 'photo-2']);
    expect(navigation?.activeAssetId).toBe('photo-2');
    expect(navigation?.homeReturn).toMatchObject({ tab: 'favorites', pageScrollTop: 45, contentScrollTop: 120 });
    await click('.return-home');
    expect(host.querySelector('#home-favorites-tab')?.getAttribute('aria-selected')).toBe('true');
    expectScroll(45, 120);
  });

  it('prefers the current selection over a remembered workspace', async () => {
    rememberWorkspaceSession({ selectedAssets: photos.slice(1, 3), activeAssetId: 'photo-2' });
    await mount(); await click('.photo-selection-input');
    expect((await pressD()).defaultPrevented).toBe(true);
    expect(navigation?.selectedAssets.map(asset => asset.id)).toEqual(['photo-0']);
    expect(navigation?.activeAssetId).toBe('photo-0');
  });

  it('keeps D inert without a selection when a resume is blocked by its event guards', async () => {
    rememberWorkspaceSession({ selectedAssets: photos.slice(0, 2), activeAssetId: 'photo-1' });
    await mount();
    for (const options of [{ repeat: true }, { isComposing: true }, { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      expect((await pressD(window, options)).defaultPrevented).toBe(false);
    }
    const target = document.createElement('input'); host.append(target);
    expect((await pressD(target)).defaultPrevented).toBe(false);
    target.remove();
    const dialog = document.createElement('dialog'); dialog.open = true; document.body.append(dialog);
    try { expect((await pressD()).defaultPrevented).toBe(false); } finally { dialog.remove(); }
    expect(navigation).toBeNull();
  });

  it('ignores D with modifiers, during editing, IME, repeats, or an open menu', async () => {
    await mount(); await click('#home-favorites-tab'); await click('.photo-selection-input');
    for (const options of [{ repeat: true }, { isComposing: true }, { shiftKey: true }, { ctrlKey: true },
      { altKey: true }, { metaKey: true }]) {
      expect((await pressD(window, options)).defaultPrevented).toBe(false);
    }
    const prevented = new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true });
    prevented.preventDefault(); await act(async () => { window.dispatchEvent(prevented); });
    const nativeTargets = ['<input type="text">', '<input type="number">', '<textarea></textarea>', '<select></select>',
      '<div contenteditable="true"></div>', '<div role="textbox"></div>'];
    for (const markup of nativeTargets) {
      const wrapper = document.createElement('div'); wrapper.innerHTML = markup; host.append(wrapper);
      expect((await pressD(wrapper.firstElementChild!)).defaultPrevented).toBe(false);
      wrapper.remove();
    }
    for (const role of ['dialog', 'alertdialog', 'menu']) {
      const overlay = document.createElement(role === 'dialog' ? 'dialog' : 'div');
      if (role === 'dialog') overlay.setAttribute('open', ''); else overlay.setAttribute('role', role);
      document.body.append(overlay);
      try { expect((await pressD()).defaultPrevented).toBe(false); } finally { overlay.remove(); }
    }
    const menu = document.createElement('details'); menu.className = 'edit-settings-menu'; menu.open = true; document.body.append(menu);
    try { expect((await pressD()).defaultPrevented).toBe(false); } finally { menu.remove(); }
    expect(navigation).toBeNull();
  });

  it('clears only the active selection with Escape when both tabs remain in selection mode', async () => {
    await mount();
    await click('.photo-selection-input');
    await click('#home-favorites-tab');
    await click('.photo-selection-input');
    expect(host.querySelector('.photo-card.selected')).not.toBeNull();

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('.photo-card.selected')).toBeNull();
    await click('#home-recent-tab');
    expect(host.querySelector('.photo-card.selected')).not.toBeNull();

    await click('#home-favorites-tab');
    await click('.photo-selection-input');
    await click('#home-recent-tab');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('.photo-card.selected')).toBeNull();
    await click('#home-favorites-tab');
    expect(host.querySelector('.photo-card.selected')).not.toBeNull();
  });

  it('restores Favorite offsets across tabs and prioritizes the captured darkroom return position', async () => {
    await mount(); setScroll(10, 120); await click('#home-favorites-tab'); setScroll(20, 420);
    await click('#home-recent-tab'); expectScroll(10, 120);
    await click('#home-favorites-tab'); expectScroll(20, 420);
    setScroll(30, 640); await click('.photo-card-button');
    expect(navigation?.homeReturn?.contentScrollTop).toBe(640);
    await click('.return-home'); expectScroll(30, 640);
    expect(host.querySelector('#home-favorites-tab')?.getAttribute('aria-selected')).toBe('true');
    await click('#home-recent-tab'); await click('#home-favorites-tab'); expectScroll(30, 640);
  });

  it('supports keyboard End, wraparound, and Home over four tabs', async () => {
    await mount(); expect(host.querySelectorAll('[role="tab"]')).toHaveLength(4);
    async function key(tab: string, key: string) {
      await act(async () => host.querySelector(tab)!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    }
    await key('#home-recent-tab', 'End'); expect(document.activeElement?.id).toBe('home-favorites-tab');
    await key('#home-favorites-tab', 'ArrowRight'); expect(document.activeElement?.id).toBe('home-recent-tab');
    await key('#home-recent-tab', 'ArrowLeft'); expect(document.activeElement?.id).toBe('home-favorites-tab');
    await key('#home-favorites-tab', 'Home'); expect(document.activeElement?.id).toBe('home-recent-tab');
  });
});
