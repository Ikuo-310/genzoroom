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
import { ExportQueueApiError, type ExportQueueItem } from './exportQueueApi';
import { DEVELOP_STATUS_FILTER_SESSION_KEYS, PHOTO_FILTER_SESSION_KEYS, writeDevelopStatusFilterMode, writePhotoFilterMode } from './photoFilters';

const api = vi.hoisted(() => ({ recent: vi.fn(), favorites: vi.fn(), albums: vi.fn(), album: vi.fn(),
  day: vi.fn(), heatmap: vi.fn(), minYear: vi.fn(), statuses: vi.fn(), queue: vi.fn(), detail: vi.fn(), stackRefresh: vi.fn(), remove: vi.fn(), enqueue: vi.fn() }));
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(),
  fetchRecentAssets: api.recent, fetchFavoriteAssets: api.favorites, fetchAlbums: api.albums,
  fetchAlbumAssets: api.album, fetchCalendarDayAssets: api.day, fetchCalendarHeatmap: api.heatmap,
  fetchCalendarMinYear: api.minYear, fetchAssetDetail: api.detail, refreshSelectedImmichStacks: api.stackRefresh }));
vi.mock('./editStateApi', async original => ({ ...await original<typeof import('./editStateApi')>(),
  getAssetEditStatuses: api.statuses }));
vi.mock('./exportQueueApi', async original => ({ ...await original<typeof import('./exportQueueApi')>(),
  listExportQueue: api.queue, dequeueExportAsset: api.remove, enqueueExportAssets: api.enqueue }));

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
beforeEach(async () => {
  api.queue.mockReset().mockResolvedValue([]);
  api.detail.mockReset().mockImplementation(async (id: string) => ({ ...photos[0], id, preview_url: '', exif: {} }));
  api.stackRefresh.mockReset().mockResolvedValue([]);
  api.remove.mockReset().mockResolvedValue(undefined);
  api.enqueue.mockReset().mockResolvedValue([]);
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
  it('places the Retry priority explanation beside the tabs and keeps it out of the action toolbar', async () => {
    api.queue.mockResolvedValue([{ assetId: 'failed-a', status: 'failed', queuedAt: 'q', updatedAt: 'u' }]);
    await mount(); expect(host.querySelector('.home-tabs-bar .export-retry-notice')).toBeNull();
    await key('e');
    expect(host.querySelector('.home-tabs-bar .export-retry-notice')?.textContent)
      .toBe('Some photos failed to export, so only failed photos can be managed.');
    expect(host.querySelector('.export-toolbar .export-retry-notice')).toBeNull();
    expect(host.querySelector('.home-tabs-bar')?.lastElementChild?.classList.contains('export-retry-notice')).toBe(true);
  });
  it('shares the Gallery Queue snapshot and fetches metadata only while Export is visible', async () => {
    api.queue.mockResolvedValue([{ assetId: 'queued-a', status: 'queued', queuedAt: 'q', updatedAt: 'u' }]);
    await mount(); expect(api.queue).toHaveBeenCalledTimes(1); expect(api.detail).not.toHaveBeenCalled();
    await key('e'); expect(api.detail).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll('.export-queue-card')).toHaveLength(1);
    expect(host.querySelector('.photo-grid')).toBeNull();
    await key('r'); expect(host.querySelectorAll('.photo-grid .photo-card')).toHaveLength(3);
    expect(host.querySelector('.export-queue-card')).toBeNull(); expect(api.queue).toHaveBeenCalledTimes(1);
  });
  it('renders only queued members from refreshed Immich Stack snapshots', async () => {
    const queue = ['asset-a', 'asset-c'].map(assetId => ({ assetId, status: 'queued', queuedAt: 'q', updatedAt: 'u' }));
    api.queue.mockResolvedValue(queue);
    api.stackRefresh.mockResolvedValue([{ id: 'stack-x', primaryAssetId: 'asset-a', assets: ['asset-a', 'asset-b', 'asset-c'].map(id => ({
      ...photos[0], id, stackId: 'stack-x', primaryAssetId: 'asset-a', stackAssetCount: 3,
    })) }]);
    await mount(); await key('e');
    expect(api.stackRefresh).toHaveBeenCalledWith(['asset-a', 'asset-c'], expect.any(AbortSignal));
    expect(host.querySelectorAll('.export-stack-group')).toHaveLength(1);
    expect([...host.querySelectorAll<HTMLElement>('.export-queue-card')].map(card => card.dataset.assetId)).toEqual(['asset-a', 'asset-c']);
    expect(host.textContent).not.toContain('asset-b');
  });
  it.each(['en', 'ja'])('keeps the common shell and accessible tab/panel with the minimal toolbar in %s', async language => {
    await i18n.changeLanguage(language); await mount();
    expect(host.querySelectorAll('.home-tabs-gallery [role="tab"]')).toHaveLength(4);
    expect(host.querySelectorAll('.home-tabs-management [role="tab"]')).toHaveLength(2);
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
    expect(selectionButtons.map(button => button.className)).toEqual(['selection-all', 'selection-clear', 'export-arm-toggle', 'export-queue-remove']);
    expect(selectionButtons.map(button => button.textContent)).toEqual(language === 'ja'
      ? ['すべて選択', '選択解除', '出力待機[W]', 'Queueから外す[Q]'] : ['Select all', 'Clear selection', 'Ready for export[W]', 'Remove from Queue[Q]']);
    expect(selectionButtons.every(button => button.disabled)).toBe(true);
    expect(selection.querySelector('#home-stacks-tab, .home-open-workspace')).toBeNull();
    expect(toolbar.querySelector('.thumbnail-size-control')).not.toBeNull();
    const action = toolbar.querySelector<HTMLButtonElement>('.export-action-group .immich-action-button')!;
    expect(action.textContent).toBe(language === 'ja' ? 'Immichへ出力' : 'Export to Immich');
    expect(action.disabled).toBe(true);
    expect(toolbar.querySelectorAll('.export-action-group button')).toHaveLength(1);
    expect(toolbar.querySelector('[aria-haspopup], [role="menu"], #home-stacks-tab, .home-open-workspace')).toBeNull();
    await click('.thumbnail-size-icon:last-of-type');
    expect(host.querySelector('output')?.textContent).toBe('4');
  });

  it.each(['recent', 'favorites', 'albums', 'calendar'] as const)('retains %s detail, selection, anchor and scroll across Export with saved type filter ignored', async tab => {
    writePhotoFilterMode('raw', tab);
    writeDevelopStatusFilterMode('undeveloped', tab);
    await mount(tab);
    expect(host.querySelector('.photo-filter-control')).toBeNull();
    expect(host.querySelector<HTMLSelectElement>('.develop-status-filter-control select')?.value).toBe('undeveloped');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(3);
    await click('.photo-card-button');
    await act(async () => host.querySelectorAll('.photo-card-button')[1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    homeScrollContent(host.querySelector('.home-page')!)!.scrollTop = 390;
    await key('e');
    expect(host.querySelector('#home-export-panel')).not.toBeNull();
    expect(host.querySelector('.develop-status-filter-control')).toBeNull();
    expect(host.querySelector('.photo-card')).toBeNull();
    await click(`#home-${tab}-tab`);
    expect(host.querySelector('.photo-filter-control')).toBeNull();
    expect(host.querySelector<HTMLSelectElement>('.develop-status-filter-control select')?.value).toBe('undeveloped');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(3);
    expect(sessionStorage.getItem(PHOTO_FILTER_SESSION_KEYS[tab])).toBe('raw');
    expect(host.querySelector('.selection-count')?.textContent).toBe('2 selected');
    expect(homeScrollContent(host.querySelector('.home-page')!)!.scrollTop).toBe(390);
    expect(host.querySelector('.photo-card.selected .photo-info p')?.textContent).toBe('photo-0.jpg');
    if (tab === 'albums') expect(host.querySelector('.home-toolbar-title')?.textContent).toBe('Album A');
    if (tab === 'calendar') expect(host.querySelector('.calendar-detail-navigation')).not.toBeNull();
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
    for (const value of ['q', 'p', 'Escape', 'ArrowLeft']) expect((await key(value)).defaultPrevented).toBe(false);
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

const queued = (assetId: string, status: ExportQueueItem['status'] = 'queued'): ExportQueueItem => ({ assetId, status, queuedAt: 'q', updatedAt: 'u' });
async function openQueue(items = [queued('a'), queued('b', 'failed'), queued('c'), queued('waiting', 'waiting'), queued('encoding', 'encoding'), queued('registering', 'registering')]) {
  let backendItems = items;
  api.queue.mockImplementation(async () => backendItems);
  api.remove.mockImplementation(async (assetId: string) => { backendItems = backendItems.filter(item => item.assetId !== assetId); });
  api.detail.mockImplementation(async (id: string) => ({ ...photos[0], id, filename: `${id}.jpg`, preview_url: '', exif: {} }));
  api.stackRefresh.mockResolvedValue([{ id: 'stack-x', primaryAssetId: 'a', assets: ['a', 'c', 'outside'].map(id => ({ ...photos[0], id })) }]);
  await mount(); await key('e');
  return { setItems: (next: ExportQueueItem[]) => { backendItems = next; }, getItems: () => backendItems };
}
const exportCard = (id: string) => host.querySelector<HTMLElement>(`.export-queue-card[data-asset-id="${id}"]`)!;
async function cardClick(id: string, options: MouseEventInit = {}, checkbox = false) {
  await act(async () => exportCard(id).querySelector(checkbox ? 'input' : 'button')!
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...options })));
}
const exportSelected = () => [...host.querySelectorAll<HTMLElement>('.export-queue-card.selected')].map(card => card.dataset.assetId);
const exportArmed = () => [...host.querySelectorAll<HTMLElement>('.export-queue-card')]
  .filter(card => card.querySelector('.photo-card-button')?.getAttribute('aria-description') === i18n.t('exportManagement.armed')).map(card => card.dataset.assetId);

describe('Export selection, readiness and Queue removal', () => {
  it('shares Gallery selection semantics in grouped visual order and excludes every locked status', async () => {
    await openQueue([queued('a'), queued('b'), queued('c'), queued('waiting', 'waiting'), queued('encoding', 'encoding'), queued('registering', 'registering')]);
    expect(exportSelected()).toEqual([]); expect(exportArmed()).toEqual([]);
    expect([...host.querySelectorAll<HTMLElement>('.export-queue-card')].map(card => card.dataset.assetId))
      .toEqual(['a', 'c', 'b', 'waiting', 'encoding', 'registering']);
    await cardClick('b', { shiftKey: true }); expect(exportSelected()).toEqual([]);
    await cardClick('b', { shiftKey: true }, true); expect(exportSelected()).toEqual([]);
    await cardClick('a'); await cardClick('c', { ctrlKey: true }); expect(exportSelected()).toEqual(['a', 'c']);
    await cardClick('b'); expect(exportSelected()).toEqual(['b']);
    await cardClick('a'); await cardClick('b', { shiftKey: true }); expect(exportSelected()).toEqual(['a', 'c', 'b']);
    await cardClick('c', {}, true); expect(exportSelected()).toEqual(['a', 'b']);
    await cardClick('b', { shiftKey: true }, true); expect(exportSelected()).toEqual(['a', 'c', 'b']);
    await click('.export-selection .selection-clear'); expect(exportSelected()).toEqual([]);
    expect((await key('a', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(exportSelected()).toEqual(['a', 'c', 'b']);
    await key('Escape'); expect(exportSelected()).toEqual([]);
    await click('.export-selection .selection-all'); expect(exportSelected()).toEqual(['a', 'c', 'b']);
    for (const id of ['waiting', 'encoding', 'registering']) {
      expect(exportCard(id).getAttribute('aria-disabled')).toBe('true');
      expect(exportCard(id).querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
      await cardClick(id); expect(exportSelected()).toEqual(['a', 'c', 'b']);
    }
  });
  it('keeps armed state independent from selection and across Gallery tab visits', async () => {
    await openQueue([queued('a'), queued('b'), queued('c'), queued('waiting', 'waiting'), queued('encoding', 'encoding'), queued('registering', 'registering')]);
    await cardClick('a'); await key('w');
    expect(exportArmed()).toEqual(['a']); expect(host.querySelector('.export-arm-toggle')?.textContent).toBe('Clear export readiness[W]');
    const statusBar = exportCard('a').querySelector<HTMLElement>('.thumbnail .export-status-bar')!;
    expect(statusBar.textContent).toBe('Ready to export');
    expect(statusBar.classList.contains('export-status-armed')).toBe(true);
    const checkbox = exportCard('a').querySelector<HTMLInputElement>('input')!; checkbox.focus();
    await key('Escape', {}, checkbox); expect(exportSelected()).toEqual([]); expect(exportArmed()).toEqual(['a']);
    expect(document.activeElement).not.toBe(checkbox);
    await cardClick('b'); expect(exportArmed()).toEqual(['a']);
    await cardClick('a', { ctrlKey: true }); await key('w'); expect(exportArmed()).toEqual(['a', 'b']);
    await click('.export-arm-toggle'); expect(exportArmed()).toEqual([]);
    await key('w'); await key('r'); expect(host.querySelector('#home-export-panel')).toBeNull();
    await key('e'); expect(exportArmed()).toEqual(['a', 'b']);
    expect(host.querySelector<HTMLButtonElement>('.immich-action-button')!.disabled).toBe(true);
  });
  it('undoes W ON/OFF and mixed state after selection clear, without undoing Selection', async () => {
    await openQueue([queued('a'), queued('b'), queued('c')]);
    await cardClick('a'); await key('w');
    await cardClick('b', { ctrlKey: true }); await cardClick('c', { ctrlKey: true });
    await key('w'); expect(exportArmed()).toEqual(['a', 'c', 'b']);
    const undoMixed = await key('z', { ctrlKey: true });
    expect(undoMixed.defaultPrevented).toBe(true); expect(exportArmed()).toEqual(['a']);
    await key('w'); await key('w'); expect(exportArmed()).toEqual([]);
    const undoOff = await key('z', { ctrlKey: true });
    expect(undoOff.defaultPrevented).toBe(true); expect(exportArmed()).toEqual(['a', 'c', 'b']);
    await key('Escape'); expect(exportSelected()).toEqual([]);
    expect((await key('z', { ctrlKey: true })).defaultPrevented).toBe(false); expect(exportArmed()).toEqual(['a', 'c', 'b']);
  });
  it('uses Primary+Z only for an available Export undo and keeps existing guards', async () => {
    await openQueue([queued('a')]);
    expect((await key('z', { ctrlKey: true })).defaultPrevented).toBe(false);
    await cardClick('a'); await key('w');
    for (const target of [document.createElement('input'), document.createElement('textarea'), document.createElement('select')]) {
      host.append(target);
      expect((await key('z', { ctrlKey: true }, target)).defaultPrevented).toBe(false);
      target.remove();
    }
    const editable = document.createElement('div'); editable.setAttribute('contenteditable', 'true'); host.append(editable);
    expect((await key('z', { ctrlKey: true }, editable)).defaultPrevented).toBe(false); editable.remove();
    for (const options of [{ isComposing: true }, { repeat: true }]) expect((await key('z', { ctrlKey: true, ...options })).defaultPrevented).toBe(false);
    for (const role of ['menu', 'dialog', 'alertdialog']) {
      const overlay = document.createElement('div'); overlay.setAttribute('role', role); host.append(overlay);
      expect((await key('z', { ctrlKey: true })).defaultPrevented).toBe(false); overlay.remove();
    }
    const undo = await key('z', { ctrlKey: true });
    expect(undo.defaultPrevented).toBe(true); expect(exportArmed()).toEqual([]);
    await key('r'); expect((await key('z', { ctrlKey: true })).defaultPrevented).toBe(false);
  });
  it('retains one-shot Undo across tab visits and replaces the record with a later W operation', async () => {
    await openQueue([queued('a')]); await cardClick('a'); await key('w');
    await key('r'); await key('e');
    expect((await key('z', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(exportArmed()).toEqual([]);
    await key('w'); await key('w');
    expect((await key('z', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(exportArmed()).toEqual(['a']);
  });
  it.each(['Win32', 'MacIntel'])('matches Primary+Z using the OS modifier on %s', async platform => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
    try {
      await openQueue([queued('a')]); await cardClick('a'); await key('w');
      const primary = platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true };
      const other = platform === 'MacIntel' ? { ctrlKey: true } : { metaKey: true };
      expect((await key('z', other)).defaultPrevented).toBe(false);
      expect((await key('z', primary)).defaultPrevented).toBe(true);
      expect(exportArmed()).toEqual([]);
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'platform', descriptor); else Reflect.deleteProperty(navigator, 'platform');
    }
  });
  it.each(['Win32', 'MacIntel'])('uses the OS Primary for card toggle on %s', async platform => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
    try {
      await openQueue([queued('a'), queued('b')]); await cardClick('a');
      await cardClick('b', platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true });
      expect(exportSelected()).toEqual(['a', 'b']);
      await cardClick('a', platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true });
      expect(exportSelected()).toEqual(['b']);
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'platform', descriptor); else Reflect.deleteProperty(navigator, 'platform');
    }
  });
  it('applies native editing, modifier, composition, repeat and dialog guards to Export commands', async () => {
    await openQueue([queued('a')]); await cardClick('a');
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }]) {
      await key('w', options); await key('q', options);
    }
    expect(exportArmed()).toEqual([]); expect(api.remove).not.toHaveBeenCalled();
    for (const element of [document.createElement('input'), document.createElement('textarea'), document.createElement('select'), document.createElement('div')]) {
      if (element.tagName === 'DIV') { element.setAttribute('contenteditable', 'true'); Object.defineProperty(element, 'isContentEditable', { value: true }); }
      host.append(element);
      await key('w', {}, element); await key('q', {}, element); await key('Escape', {}, element); await key('a', { ctrlKey: true }, element);
      element.remove();
    }
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); host.append(menu);
    await key('w'); await key('q'); await key('Escape'); menu.remove();
    expect(exportSelected()).toEqual(['a']); expect(exportArmed()).toEqual([]); expect(api.remove).not.toHaveBeenCalled();
    await key('Escape'); await key('w'); await key('q'); expect(api.remove).not.toHaveBeenCalled();
  });
  it('removes an armed card immediately and collapses a two-member group while survivor metadata reloads', async () => {
    await openQueue([queued('a'), queued('c')]);
    await cardClick('a'); await key('w');
    api.detail.mockImplementation(() => new Promise(() => {}));
    await key('q');
    expect(api.remove).toHaveBeenCalledWith('a', expect.any(AbortSignal));
    expect(exportCard('a')).toBeNull(); expect(exportCard('c')).not.toBeNull();
    expect(host.querySelector('.export-stack-group')).toBeNull(); expect(exportArmed()).toEqual([]); expect(exportSelected()).toEqual([]);
    expect(host.querySelector('[data-asset-id="outside"]')).toBeNull(); expect(api.queue).toHaveBeenCalledTimes(1);
  });
  it('continues sequential removal after a middle failure and refreshes without rolling back successes', async () => {
    const backend = await openQueue([queued('a'), queued('b'), queued('c')]);
    api.remove.mockImplementation(async (id: string) => {
      if (id === 'b') throw new ExportQueueApiError('unexpected', 400);
      backend.setItems(backend.getItems().filter(item => item.assetId !== id));
    });
    await click('.export-selection .selection-all'); await key('w'); await click('.export-queue-remove');
    expect(api.remove.mock.calls.map(call => call[0])).toEqual(['a', 'b', 'c']); expect(api.queue).toHaveBeenCalledTimes(2);
    expect(exportSelected()).toEqual(['b']); expect(exportArmed()).toEqual(['b']);
    expect(host.querySelector('.export-removal-error[role="alert"]')?.textContent).toBe('Some photos could not be removed from Queue');
    expect(exportCard('a')).toBeNull(); expect(exportCard('c')).toBeNull(); expect(exportCard('b')).not.toBeNull();
  });
  it('undoes Q membership for queued and failed entries using enqueue, without restoring selection', async () => {
    const backend = await openQueue([queued('a'), queued('b', 'failed')]);
    await click('.export-selection .selection-all'); await key('q');
    expect(exportCard('a')).not.toBeNull(); expect(exportCard('b')).toBeNull();
    api.enqueue.mockImplementation(async (ids: string[]) => {
      backend.setItems([...backend.getItems(), ...ids.map(id => queued(id))]);
      return backend.getItems();
    });
    expect((await key('z', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(api.enqueue.mock.calls.map(call => call[0])).toEqual([['b']]);
    expect(exportCard('a').dataset.queueStatus).toBe('queued'); expect(exportCard('b').dataset.queueStatus).toBe('queued');
    expect(exportSelected()).toEqual([]);
    expect((await key('z', { ctrlKey: true })).defaultPrevented).toBe(false);
  });
  it('preserves the previous undo when Q fails completely', async () => {
    await openQueue([queued('a')]); await cardClick('a'); await key('w');
    api.remove.mockRejectedValue(new ExportQueueApiError('unavailable'));
    await key('q'); expect(exportCard('a')).not.toBeNull();
    expect((await key('z', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(exportArmed()).toEqual([]);
  });
  it('restores only successful Q removals when the restore batch partially fails', async () => {
    const backend = await openQueue([queued('a'), queued('b'), queued('c')]);
    await cardClick('a'); await key('w'); await cardClick('b', { ctrlKey: true }); await cardClick('c', { ctrlKey: true }); await key('w');
    api.remove.mockImplementation(async (id: string) => {
      if (id === 'b') throw new ExportQueueApiError('unavailable', 503, 'persistence_unavailable');
      backend.setItems(backend.getItems().filter(item => item.assetId !== id));
    });
    await key('q');
    api.enqueue.mockImplementation(async (ids: string[]) => {
      if (ids[0] === 'c') throw new ExportQueueApiError('unavailable', 503, 'persistence_unavailable');
      backend.setItems([...backend.getItems(), ...ids.map(id => queued(id))]);
      return backend.getItems();
    });
    expect((await key('z', { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(api.enqueue.mock.calls.map(call => call[0])).toEqual([['a'], ['c']]);
    expect(exportCard('a').dataset.queueStatus).toBe('queued'); expect(exportCard('c')).toBeNull();
    expect(exportArmed()).toEqual(['b', 'a']); expect(exportSelected()).toEqual(['b']);
    expect(host.querySelector('.export-removal-error[role="alert"]')?.textContent).toBe('Some photos could not be restored to Queue');
    expect((await key('z', { ctrlKey: true })).defaultPrevented).toBe(false);
    expect(exportArmed()).toEqual(['b', 'a']);
  });
  it('prevents duplicate execution and disables actions for the duration of removal', async () => {
    await openQueue([queued('a')]); await cardClick('a');
    let finish!: () => void;
    api.remove.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await key('q'); await key('q'); await click('.export-queue-remove');
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect([...host.querySelectorAll<HTMLButtonElement>('.export-selection button')].every(button => button.disabled)).toBe(true);
    await act(async () => finish()); expect(exportCard('a')).toBeNull();
  });
  it.each(['en', 'ja'])('reports locked removal failures in %s and refreshes the authoritative status', async language => {
    await i18n.changeLanguage(language);
    const backend = await openQueue([queued('a')]); await cardClick('a'); await key('w');
    api.remove.mockImplementation(async () => { backend.setItems([queued('a', 'waiting')]); throw new ExportQueueApiError('locked'); });
    await key('q');
    expect(host.querySelector('.export-removal-error')?.textContent).toBe(i18n.t('exportManagement.locked'));
    expect(exportSelected()).toEqual([]); expect(exportArmed()).toEqual([]);
    expect(exportCard('a').querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
  });
  it.each(['en', 'ja'])('reports general removal failure in %s while retaining the card and readiness', async language => {
    await i18n.changeLanguage(language); await openQueue([queued('a')]); await cardClick('a'); await key('w');
    api.remove.mockRejectedValue(new ExportQueueApiError('unavailable'));
    await key('q');
    expect(host.querySelector('.export-removal-error')?.textContent).toBe(i18n.t('exportManagement.removeFailed'));
    expect(exportArmed()).toEqual(['a']); expect(exportSelected()).toEqual(['a']); expect(api.queue).toHaveBeenCalledTimes(2);
  });
});
