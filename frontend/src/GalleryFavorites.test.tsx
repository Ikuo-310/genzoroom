// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';
import type { RecentAsset, WorkspaceNavigationState } from './assets';
import { homeScrollContent } from './homeReturn';
import { clearWorkspaceSession, rememberWorkspaceSession } from './workspaceResume';
import { updateSetting } from './appSettings';
import { DEVELOP_STATUS_FILTER_SESSION_KEYS, EDIT_STATUS_FILTER_SESSION_KEYS, PHOTO_FILTER_SESSION_KEYS,
  writeDevelopStatusFilterMode, writePhotoFilterMode } from './photoFilters';
import i18n from './i18n';
vi.mock('./exportQueueApi', async original => ({ ...await original<typeof import('./exportQueueApi')>(),
  listExportQueue: async () => [] }));

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
async function pressHome(key: string, options: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
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
  updateSetting('showKeyboardShortcuts', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.recent.mockReset().mockResolvedValue([photos[0]]);
  api.favorites.mockReset().mockResolvedValue(photos);
  api.statuses.mockReset().mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, id === 'photo-0' || id === 'photo-2'])));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
});
afterEach(() => { act(() => root.unmount()); host.remove(); sessionStorage.clear(); clearWorkspaceSession(); vi.unstubAllGlobals(); });

describe('Home favorites', () => {
  it('shows the developed filter and applies it to Favorites Assets including unknown tags', async () => {
    api.favorites.mockResolvedValue(photos.map((photo, index) => ({ ...photo,
      isGenzoRoomExport: index === 1 ? true : index === 2 ? false : undefined })));
    await mount(); await click('#home-favorites-tab');
    expect(host.querySelector('.develop-status-filter-control')).not.toBeNull();
    expect(host.querySelectorAll('.photo-card')).toHaveLength(4);
    await change('.develop-status-filter-control select', 'developed');
    expect([...host.querySelectorAll('.photo-info p')].map(node => node.textContent)).toEqual(['photo-1']);
    await click('.selection-all');
    expect(host.querySelector('.selection-count')?.textContent).toBe('1 selected');
    await change('.develop-status-filter-control select', 'undeveloped');
    expect([...host.querySelectorAll('.photo-info p')].map(node => node.textContent)).toEqual(['photo-0', 'photo-2', 'photo-3']);
    expect(host.querySelector('.selection-count')?.textContent).toBe('1 selected');
  });

  it('keeps developed filter choices separate by tab and restores each choice', async () => {
    writeDevelopStatusFilterMode('developed', 'recent');
    writeDevelopStatusFilterMode('undeveloped', 'favorites');
    await mount();
    expect((host.querySelector('.develop-status-filter-control select') as HTMLSelectElement).value).toBe('developed');
    await click('#home-favorites-tab');
    expect((host.querySelector('.develop-status-filter-control select') as HTMLSelectElement).value).toBe('undeveloped');
    expect(sessionStorage.getItem(DEVELOP_STATUS_FILTER_SESSION_KEYS.recent)).toBe('developed');
    expect(sessionStorage.getItem(DEVELOP_STATUS_FILTER_SESSION_KEYS.favorites)).toBe('undeveloped');
  });

  it('switches tabs with registry commands and keeps commands enabled when hints are hidden', async () => {
    await mount();
    for (const [key, tab, label] of [['f', 'favorites', 'Favorites[F]'], ['A', 'albums', 'Albums[A]'],
      ['c', 'calendar', 'Calendar[C]'], ['R', 'recent', 'Recent[R]']]) {
      expect((await pressHome(key)).defaultPrevented).toBe(true);
      expect(host.querySelector(`#home-${tab}-tab`)?.getAttribute('aria-selected')).toBe('true');
      expect(host.querySelector(`#home-${tab}-tab`)?.textContent).toBe(label);
    }
    act(() => updateSetting('showKeyboardShortcuts', false));
    await pressHome('f');
    expect(host.querySelector('#home-favorites-tab')?.textContent).toBe('Favorites');
    expect(host.querySelector('#home-stacks-tab')?.textContent).toBe('Stacks');
    expect(host.querySelector('.home-open-workspace')?.textContent).toBe('Develop');
    expect(host.querySelector('.selection-all')?.textContent).toBe('Select all');
    expect(host.querySelector('.selection-all')?.getAttribute('title')).toBeNull();
    await act(async () => i18n.changeLanguage('ja'));
    expect(host.querySelector('#home-favorites-tab')?.textContent).toBe('お気に入り');
    act(() => updateSetting('showKeyboardShortcuts', true));
    expect(host.querySelector('#home-recent-tab')?.textContent).toBe('最近の写真[R]');
    expect(host.querySelector('#home-albums-tab')?.textContent).toBe('アルバム[A]');
    expect(host.querySelector('#home-calendar-tab')?.textContent).toBe('カレンダー[C]');
    expect(host.querySelector('#home-favorites-tab')?.textContent).toBe('お気に入り[F]');
    act(() => updateSetting('showKeyboardShortcuts', false));
    expect((await pressHome('a', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(4);
  });

  it('selects all Favorite photo types with Primary+A and consumes repeated all-selection', async () => {
    await mount(); await pressHome('f'); await click('.photo-selection-input');
    expect(host.querySelector('.photo-filter-control')).toBeNull();
    expect((await pressHome('a', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect((await pressHome('A', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(host.querySelector('.selection-count')?.textContent).toBe('4 selected');
    await click('.home-open-workspace');
    expect(navigation?.selectedAssets.map(asset => asset.id)).toEqual(['photo-0', 'photo-1', 'photo-2', 'photo-3']);
  });

  it('ignores an initial Shift click and extends a range from a normal selection anchor', async () => {
    api.recent.mockResolvedValue(photos);
    await mount();
    const card = (index: number) => host.querySelectorAll<HTMLButtonElement>('.photo-card-button')[index];
    await act(async () => card(2).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })));
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(0);
    expect(navigation).toBeNull();
    await act(async () => card(2).dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host.querySelectorAll('.photo-card.selected .photo-info p')[0].textContent).toBe('photo-2');
    await act(async () => card(0).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })));
    expect([...host.querySelectorAll('.photo-card.selected .photo-info p')].map(node => node.textContent))
      .toEqual(['photo-0', 'photo-1', 'photo-2']);
  });

  it('leaves Primary+A native while photos are loading or empty', async () => {
    let resolve!: (assets: RecentAsset[]) => void;
    api.favorites.mockReturnValue(new Promise<RecentAsset[]>(yes => { resolve = yes; }));
    await mount(); await pressHome('f');
    expect((await pressHome('a', { ctrlKey: true })).defaultPrevented).toBe(false);
    await act(async () => resolve([]));
    expect((await pressHome('a', { ctrlKey: true })).defaultPrevented).toBe(false);
  });

  it('does not steal native editing, modal, modifier or unavailable-view shortcuts', async () => {
    await mount();
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }]) {
      expect((await pressHome('f', options)).defaultPrevented).toBe(false);
      expect(host.querySelector('#home-recent-tab')?.getAttribute('aria-selected')).toBe('true');
    }
    for (const tag of ['input', 'textarea', 'select', 'div']) {
      const target = document.createElement(tag); if (tag === 'div') target.setAttribute('contenteditable', 'true'); host.append(target);
      expect((await pressHome('a', { ctrlKey: true }, target)).defaultPrevented).toBe(false);
      expect((await pressHome('f', {}, target)).defaultPrevented).toBe(false); target.remove();
    }
    for (const role of ['dialog', 'alertdialog', 'menu']) {
      const modal = document.createElement('div'); modal.setAttribute('role', role); host.append(modal);
      expect((await pressHome('a', { ctrlKey: true })).defaultPrevented).toBe(false);
      expect((await pressHome('f')).defaultPrevented).toBe(false); modal.remove();
    }
    for (const type of ['checkbox', 'range']) {
      const target = document.createElement('input'); target.type = type; host.append(target);
      expect((await pressHome('a', { ctrlKey: true }, target)).defaultPrevented).toBe(false); target.remove();
    }
    await pressHome('a');
    expect((await pressHome('a', { ctrlKey: true })).defaultPrevented).toBe(false);
    await pressHome('c');
    expect((await pressHome('a', { ctrlKey: true })).defaultPrevented).toBe(false);
  });
  it('keeps toolbar actions visible at zero and safely ignores opening without a session', async () => {
    await mount();
    expect(host.querySelector('.home-toolbar .selection-bar')?.textContent).toContain('0 selected');
    expect(host.querySelector('.home-toolbar .selection-bar')?.getAttribute('role')).toBe('group');
    expect(host.querySelector('.selection-count')?.tagName).toBe('STRONG');
    expect(host.querySelector('.selection-count')?.closest('button')).toBeNull();
    expect(host.querySelectorAll('.selection-actions button')).toHaveLength(2);
    expect(host.querySelector('.home-content .selection-bar')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('#home-stacks-tab')!.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('.selection-clear')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.home-open-workspace')!.disabled).toBe(false);
    await click('.home-open-workspace');
    expect(navigation).toBeNull();
    for (const tab of ['albums', 'calendar']) {
      await click(`#home-${tab}-tab`);
      expect(host.querySelector('.home-toolbar .selection-bar')).toBeNull();
    }
  });

  it('adds edited and all Favorite IDs without duplicates, then clears selection', async () => {
    await mount(); await click('#home-favorites-tab');
    await click('.photo-selection-input');
    await change('.edit-status-filter-control select', 'edited');
    await click('.selection-all');
    expect(host.querySelector('.selection-bar')?.textContent).toContain('2 selected');
    expect(host.querySelector<HTMLButtonElement>('.selection-all')!.disabled).toBe(true);
    await change('.edit-status-filter-control select', 'both');
    await click('.selection-all');
    expect(host.querySelector('.selection-bar')?.textContent).toContain('4 selected');
    expect(host.querySelector<HTMLButtonElement>('.selection-all')!.disabled).toBe(true);
    await click('.home-open-workspace');
    expect(navigation?.selectedAssets.map(asset => asset.id)).toEqual(['photo-0', 'photo-2', 'photo-1', 'photo-3']);
    await click('.return-home');
    await click('.selection-clear');
    expect(host.querySelector('.selection-bar')?.textContent).toContain('0 selected');
    expect(host.querySelector('.photo-card.selected')).toBeNull();
  });

  it('shows the selection group on Favorites and keeps Anshitsu enabled', async () => {
    await mount(); await click('#home-favorites-tab');
    expect(host.querySelector('.home-toolbar .selection-bar')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.home-open-workspace')!.disabled).toBe(false);
  });

  it('resumes the previous workspace from the unselected toolbar button', async () => {
    rememberWorkspaceSession({ selectedAssets: photos.slice(0, 3), activeAssetId: 'photo-2' });
    await mount(); await click('#home-favorites-tab');
    setScroll(0, 120);
    await click('.home-open-workspace');
    expect(navigation?.activeAssetId).toBe('photo-2');
    expect(navigation?.selectedAssets.map(asset => asset.id)).toEqual(['photo-0', 'photo-1', 'photo-2']);
    expect(navigation?.homeReturn).toMatchObject({ tab: 'favorites', contentScrollTop: 120 });
  });

  it('preserves the existing range anchor across the full Favorites set', async () => {
    await mount(); await click('#home-favorites-tab');
    await click('.photo-selection-input');
    await act(async () => host.querySelectorAll('.photo-card-button')[3].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(4);
    await click('.home-open-workspace');
    expect(navigation?.selectedAssets.map(asset => asset.id)).toEqual(['photo-0', 'photo-1', 'photo-2', 'photo-3']);
  });

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
    expect(host.querySelector('#home-favorites-tab')?.textContent).toBe('お気に入り[F]');
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

  it('ignores saved photo type filters in Favorites and preserves edit status filtering', async () => {
    writePhotoFilterMode('raw', 'recent');
    writePhotoFilterMode('nonRaw', 'favorites');
    await mount(); await click('#home-favorites-tab');
    expect(host.querySelector('.photo-filter-control')).toBeNull();
    expect(host.querySelectorAll('.photo-card')).toHaveLength(4);
    await change('.edit-status-filter-control select', 'edited');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(2);
    await change('.edit-status-filter-control select', 'unedited');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(2);
    expect(sessionStorage.getItem(PHOTO_FILTER_SESSION_KEYS.recent)).toBe('raw');
    expect(sessionStorage.getItem(PHOTO_FILTER_SESSION_KEYS.favorites)).toBe('nonRaw');
    expect(sessionStorage.getItem(EDIT_STATUS_FILTER_SESSION_KEYS.favorites)).toBe('unedited');
    await click('#home-recent-tab');
    expect(host.querySelector<HTMLSelectElement>('.edit-status-filter-control select')?.value).toBe('both');
    await click('#home-favorites-tab');
    expect(host.querySelector<HTMLSelectElement>('.edit-status-filter-control select')?.value).toBe('unedited');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(2);
    act(() => root.render(<div />)); await mount(); await click('#home-favorites-tab');
    expect(host.querySelector('.photo-filter-control')).toBeNull();
    expect(host.querySelector<HTMLSelectElement>('.edit-status-filter-control select')?.value).toBe('unedited');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(2);
  });

  it('owns selection and range anchor independently, clears selection and sends only Favorites selections', async () => {
    await mount(); await click('.photo-selection-input'); await click('#home-favorites-tab');
    expect(host.querySelector('.photo-card.selected')).toBeNull();
    await click('.photo-selection-input');
    await act(async () => host.querySelectorAll('.photo-card-button')[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(3);
    await click('#home-recent-tab'); expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(1);
    await click('#home-favorites-tab'); expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(3);
    await click('.selection-clear'); expect(host.querySelector('.home-toolbar .selection-bar')?.textContent).toContain('0 selected');
    await click('.photo-selection-input');
    await pressD();
    expect(navigation?.selectedAssets.map(asset => asset.id)).toEqual(['photo-0']);
    expect(navigation?.homeReturn?.tab).toBe('favorites');
  });

  it('opens the selected Recent photo with D and ignores D without a selection', async () => {
    await mount();
    expect((await pressD()).defaultPrevented).toBe(false);
    await click('.photo-selection-input');
    act(() => updateSetting('showKeyboardShortcuts', false));
    expect(host.querySelector<HTMLButtonElement>('.home-open-workspace')!.title).toBe(i18n.t('photos.openSelected'));
    const event = await pressD();
    expect(event.defaultPrevented).toBe(true);
    expect(navigation?.selectedAssets.map(asset => asset.id)).toEqual(['photo-0']);
    expect(navigation?.homeReturn?.tab).toBe('recent');
    act(() => updateSetting('showKeyboardShortcuts', true));
  });

  it('resumes the last workspace when D is pressed without a selection and refreshes Home return context', async () => {
    rememberWorkspaceSession({ selectedAssets: photos.slice(0, 3), activeAssetId: 'photo-2', homeReturn: {
      tab: 'recent', album: null, year: 2026, month: 9, date: null, calendarMode: 'month',
      pageScrollTop: 1, contentScrollTop: 2,
    } });
    await mount(); await click('#home-favorites-tab');
    setScroll(0, 120);
    const event = await pressD();
    expect(event.defaultPrevented).toBe(true);
    expect(navigation?.selectedAssets.map(asset => asset.id)).toEqual(['photo-0', 'photo-1', 'photo-2']);
    expect(navigation?.activeAssetId).toBe('photo-2');
    expect(navigation?.homeReturn).toMatchObject({ tab: 'favorites', pageScrollTop: 0, contentScrollTop: 120 });
    await click('.return-home');
    expect(host.querySelector('#home-favorites-tab')?.getAttribute('aria-selected')).toBe('true');
    expectScroll(0, 120);
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
    await mount(); setScroll(0, 120); await click('#home-favorites-tab'); setScroll(0, 420);
    await click('#home-recent-tab'); expectScroll(0, 120);
    await click('#home-favorites-tab'); expectScroll(0, 420);
    setScroll(0, 640); await click('.photo-card-button'); await click('.home-open-workspace');
    expect(navigation?.homeReturn?.contentScrollTop).toBe(640);
    await click('.return-home'); expectScroll(0, 640);
    expect(host.querySelector('#home-favorites-tab')?.getAttribute('aria-selected')).toBe('true');
    await click('#home-recent-tab'); await click('#home-favorites-tab'); expectScroll(0, 640);
  });

  it('keeps all six tabs reachable without Arrow/Home/End tab navigation', async () => {
    await mount(); expect(host.querySelectorAll('[role="tab"]')).toHaveLength(6);
    for (const tab of host.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      expect(tab.tabIndex).toBe(0);
      act(() => tab.focus());
      for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        await act(async () => tab.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(tab);
        expect(host.querySelector('#home-recent-tab')?.getAttribute('aria-selected')).toBe('true');
      }
    }
  });
});
