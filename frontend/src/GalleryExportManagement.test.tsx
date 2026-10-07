// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';
import { SettingsProvider } from './SettingsDialog';
import { homeScrollContent, type HomeTab } from './homeReturn';
import { updateSetting, useAppSettings } from './appSettings';
import { clearWorkspaceSession, rememberWorkspaceSession } from './workspaceResume';
import i18n from './i18n';

const api = vi.hoisted(() => ({ recent: vi.fn(), favorites: vi.fn(), albums: vi.fn(), album: vi.fn(),
  day: vi.fn(), heatmap: vi.fn(), minYear: vi.fn(), statuses: vi.fn() }));
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(),
  fetchRecentAssets: api.recent, fetchFavoriteAssets: api.favorites, fetchAlbums: api.albums,
  fetchAlbumAssets: api.album, fetchCalendarDayAssets: api.day, fetchCalendarHeatmap: api.heatmap,
  fetchCalendarMinYear: api.minYear }));
vi.mock('./editStateApi', async original => ({ ...await original<typeof import('./editStateApi')>(),
  getAssetEditStatuses: api.statuses }));
vi.mock('./exportQueueApi', async original => ({ ...await original<typeof import('./exportQueueApi')>(),
  listExportQueue: async () => [] }));

const photos = Array.from({ length: 3 }, (_, index) => ({ id: `photo-${index}`, filename: `photo-${index}.jpg`,
  date: '2026-09-01', thumbnail_url: `/thumb/${index}`, format: index === 1 ? 'DNG' : 'JPEG', is_raw: index === 1 }));
const album = { id: 'album-a', albumName: 'Album A', albumThumbnailAssetId: null,
  assetCount: 3, startDate: null, endDate: null };
let host: HTMLDivElement;
let root: Root;

function Probe() {
  const location = useLocation();
  return <output data-path={location.pathname}>{useAppSettings().homeThumbnailColumns}</output>;
}
async function mount(tab: HomeTab = 'recent', contentScrollTop = 0) {
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: '/', state: { homeReturn: {
    tab, album: tab === 'albums' ? album : null, year: 2026, month: 9,
    date: tab === 'calendar' ? '2026-09-01' : null, pageScrollTop: 0, contentScrollTop,
  } } }]}><SettingsProvider><GalleryPage /><Probe /></SettingsProvider></MemoryRouter>));
}
async function click(selector: string) {
  const element = host.querySelector<HTMLButtonElement>(selector)!;
  expect(element).not.toBeNull();
  await act(async () => element.click());
}
async function key(key: string, options: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  await act(async () => target.dispatchEvent(event));
  return event;
}
async function filter(value: string) {
  const select = host.querySelector<HTMLSelectElement>('.photo-filter-control select')!;
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false; } });
  sessionStorage.clear(); clearWorkspaceSession(); await i18n.changeLanguage('en');
  updateSetting('showKeyboardShortcuts', true); updateSetting('homeThumbnailColumns', 5);
  for (const reader of [api.recent, api.favorites, api.album, api.day]) reader.mockReset().mockResolvedValue(photos);
  api.albums.mockReset().mockResolvedValue([album]); api.minYear.mockReset().mockResolvedValue(2002);
  api.heatmap.mockReset().mockResolvedValue({ year: 2026, month: 9, days: [] });
  api.statuses.mockReset().mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, false])));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); sessionStorage.clear(); clearWorkspaceSession(); vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

describe('Home Export management', () => {
  it.each(['en', 'ja'])('keeps the common shell and accessible tab/panel with the minimal toolbar in %s', async language => {
    await i18n.changeLanguage(language); await mount();
    expect(host.querySelectorAll('.home-tabs-gallery [role="tab"]')).toHaveLength(4);
    expect(host.querySelectorAll('.home-tabs-management [role="tab"]')).toHaveLength(1);
    await click('#home-export-tab');
    expect(host.querySelector('output')!.dataset.path).toBe('/');
    expect([...host.querySelector('.home-page')!.children].map(element => element.classList[0]))
      .toEqual(['app-header', 'home-tabs-bar', 'home-toolbar', 'home-content']);
    expect(host.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(1);
    const tab = host.querySelector('#home-export-tab')!;
    expect(tab.getAttribute('role')).toBe('tab');
    expect(tab.textContent).toBe(language === 'ja' ? '出力管理[E]' : 'Export[E]');
    const panel = host.querySelector(`#${tab.getAttribute('aria-controls')}`)!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    expect(panel.textContent).toBe(language === 'ja' ? '出力待ちの写真はありません' : 'No photos waiting for export');
    expect(host.querySelectorAll('.home-content [role="tabpanel"]')).toHaveLength(1);
    expect(host.querySelector('.photo-grid, .home-toolbar-title')).toBeNull();
    const toolbar = host.querySelector('.export-toolbar')!;
    const selection = toolbar.querySelector<HTMLElement>('.export-selection')!;
    expect(selection.classList.contains('selection-bar')).toBe(true);
    expect(selection.querySelector('.selection-count')?.textContent).toBe(language === 'ja' ? '0件選択' : '0 selected');
    const selectionButtons = [...selection.querySelectorAll<HTMLButtonElement>('.selection-actions button')];
    expect(selectionButtons.map(button => button.className)).toEqual(['selection-all', 'selection-clear']);
    expect(selectionButtons.map(button => button.textContent)).toEqual(language === 'ja'
      ? ['すべて選択', '選択解除'] : ['Select all', 'Clear selection']);
    expect(selectionButtons.every(button => button.disabled)).toBe(true);
    expect(selection.querySelector('.selection-open-stacks, .selection-open-workspace')).toBeNull();
    expect(toolbar.querySelector('.thumbnail-size-control')).not.toBeNull();
    const action = toolbar.querySelector<HTMLButtonElement>('.export-action-group .immich-action-button')!;
    expect(action.textContent).toBe(language === 'ja' ? 'Immichへ出力' : 'Export to Immich');
    expect(action.disabled).toBe(true);
    expect(toolbar.querySelectorAll('.export-action-group button')).toHaveLength(1);
    expect(toolbar.querySelector('[aria-haspopup], [role="menu"], .selection-open-stacks, .selection-open-workspace')).toBeNull();
    await click('.thumbnail-size-icon:last-of-type');
    expect(host.querySelector('output')?.textContent).toBe('4');
  });

  it.each(['recent', 'favorites', 'albums', 'calendar'] as const)('retains %s detail, filters, hidden selection, anchor and scroll across Export', async tab => {
    await mount(tab);
    await click('.photo-card-button');
    await act(async () => host.querySelectorAll('.photo-card-button')[1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    await filter('raw');
    homeScrollContent(host.querySelector('.home-page')!)!.scrollTop = 390;
    await key('e');
    expect(host.querySelector('#home-export-panel')).not.toBeNull();
    expect(host.querySelector('.photo-card')).toBeNull();
    await click(`#home-${tab}-tab`);
    expect(host.querySelector<HTMLSelectElement>('.photo-filter-control select')!.value).toBe('raw');
    expect(host.querySelector('.selection-count')?.textContent).toBe('2 selected');
    expect(homeScrollContent(host.querySelector('.home-page')!)!.scrollTop).toBe(390);
    expect(host.querySelector('.photo-card.selected .photo-info p')?.textContent).toBe('photo-1.jpg');
    if (tab === 'albums') expect(host.querySelector('.home-toolbar-title')?.textContent).toBe('Album A');
    if (tab === 'calendar') expect(host.querySelector('.calendar-detail-navigation')).not.toBeNull();
    await filter('both');
    await act(async () => host.querySelectorAll('.photo-card-button')[2]
      .dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(3);
  });

  it('uses E/e with the existing Home guards and does not run hidden Gallery actions', async () => {
    await mount();
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }]) {
      expect((await key('e', options)).defaultPrevented).toBe(false);
    }
    for (const tag of ['input', 'textarea', 'select', 'div']) {
      const target = document.createElement(tag); if (tag === 'div') target.setAttribute('contenteditable', 'true');
      host.append(target); expect((await key('E', {}, target)).defaultPrevented).toBe(false); target.remove();
    }
    for (const role of ['dialog', 'alertdialog', 'menu']) {
      const overlay = document.createElement('div'); overlay.setAttribute('role', role); host.append(overlay);
      expect((await key('e')).defaultPrevented).toBe(false); overlay.remove();
    }
    await click('.settings-button');
    const settingsControl = host.querySelector('dialog button')!;
    expect((await key('e', {}, settingsControl)).defaultPrevented).toBe(false);
    await key('Escape', {}, settingsControl);
    expect(host.querySelector('#home-export-tab')?.getAttribute('aria-selected')).toBe('false');
    await click('.photo-card-button');
    rememberWorkspaceSession({ selectedAssets: photos, activeAssetId: photos[0].id });
    expect((await key('E')).defaultPrevented).toBe(true);
    for (const value of ['s', 'd', 'q', 'p', 'Escape', 'ArrowLeft']) expect((await key(value)).defaultPrevented).toBe(false);
    expect((await key('a', { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(host.querySelector('output')!.dataset.path).toBe('/');
    expect((await key('r')).defaultPrevented).toBe(true);
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(1);
    expect((await key('e')).defaultPrevented).toBe(true);
    act(() => updateSetting('showKeyboardShortcuts', false));
    expect(host.querySelector('#home-export-tab')?.textContent).toBe('Export');
  });

  it('retains a pending Album return offset when its data arrives while Export is visible', async () => {
    let resolve!: (value: typeof photos) => void;
    api.album.mockReturnValueOnce(new Promise<typeof photos>(yes => { resolve = yes; }));
    await mount('albums', 840);
    expect(host.querySelector('.photo-card')).toBeNull();
    await key('e');
    await act(async () => resolve(photos));
    expect(host.querySelector('#home-export-panel')).not.toBeNull();
    await key('a');
    expect(host.querySelector('.home-toolbar-title')?.textContent).toBe('Album A');
    expect(homeScrollContent(host.querySelector('.home-page')!)!.scrollTop).toBe(840);
    expect(api.album).toHaveBeenCalledTimes(1);
  });
});
