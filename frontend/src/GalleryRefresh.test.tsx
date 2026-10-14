// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';
import type { RecentAsset } from './assets';
import { updateSetting } from './appSettings';
import { homeScrollContent } from './homeReturn';
import { writeDevelopStatusFilterMode, writeEditStatusFilterMode } from './photoFilters';
import { makeGalleryStack } from './gallerySelectionTestHelpers';
import { getManualGalleryStackSelection, resolveGalleryStackSelection, setManualGalleryStackSelection } from './useGalleryStackSelections';
import i18n from './i18n';

vi.mock('./useDevelopmentExclusions', () => ({ useDevelopmentExclusions: () => ({
  stateFor: () => ({ target: null, excluded: false, known: true }), setExcluded: async () => {}, generation: 0, failure: null,
}) }));
const api = vi.hoisted(() => ({ recent: vi.fn(), favorites: vi.fn(), albums: vi.fn(), album: vi.fn(), day: vi.fn(), heatmap: vi.fn(), minYear: vi.fn() }));
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(),
  fetchRecentAssets: api.recent, fetchFavoriteAssets: api.favorites, fetchAlbums: api.albums,
  fetchAlbumAssets: api.album, fetchCalendarDayAssets: api.day, fetchCalendarHeatmap: api.heatmap, fetchCalendarMinYear: api.minYear }));
vi.mock('./useEditStatuses', () => ({ useEditStatusesSnapshot: () => ({ statuses: {}, state: 'ready' }) }));
vi.mock('./exportQueueApi', async original => ({ ...await original<typeof import('./exportQueueApi')>(), listExportQueue: async () => [] }));
vi.mock('./StackManagementPage', () => ({ StackManagementPage: ({ onWriteComplete }: { onWriteComplete?: () => void }) =>
  createElement('button', { type: 'button', id: 'test-stack-write-complete', onClick: onWriteComplete }, 'Complete Stack write') }));

const photos: RecentAsset[] = ['one', 'two'].map(id => ({ id, filename: `${id}.jpg`, date: '2026-09-01',
  thumbnail_url: `/thumb/${id}`, format: 'JPEG', is_raw: false }));

it.each(['recent', 'favorites', 'album-detail', 'calendar-day'])('uses rendered photo URLs and reloads retained images in %s', async view => {
  await mount(); await openView(view);
  const source = () => host.querySelector('.photo-card img')?.getAttribute('src');
  expect(source()).toContain('/rendered-thumbnail');
  const initial = source();
  await click('.gallery-refresh');
  expect(source()).not.toBe(initial);
  const refreshed = source();
  await mount(false); await mount(true);
  expect(source()).not.toBe(refreshed);
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
const album = { id: 'album-a', albumName: 'Original album', albumThumbnailAssetId: null, assetCount: 2, startDate: null, endDate: null };
let host: HTMLDivElement;
let root: Root;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function mount(active = true) { await act(async () => root.render(<MemoryRouter><GalleryPage active={active} /></MemoryRouter>)); }
async function click(selector: string) { await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click()); }
async function clickBlankAt(selector: string, button = 0) {
  const target = host.querySelector<HTMLElement>(selector)!;
  await act(async () => target.dispatchEvent(new MouseEvent('click', { button, bubbles: true, cancelable: true })));
}
async function press(options: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key: 'R', shiftKey: true, bubbles: true, cancelable: true, ...options });
  await act(async () => target.dispatchEvent(event));
  return event;
}
async function change(selector: string, value: string) {
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function refreshButton() { return host.querySelector<HTMLButtonElement>('.gallery-refresh')!; }
function filenames() { return [...host.querySelectorAll('.photo-info p')].map(node => node.textContent); }
async function openView(view: string) {
  if (view === 'recent') return;
  await click(`#home-${view.startsWith('album') ? 'albums' : view.startsWith('calendar') ? 'calendar' : 'favorites'}-tab`);
  if (view === 'album-detail') await click('.album-card');
  if (view === 'calendar-year') await click('.calendar-view-toggle');
  if (view === 'calendar-day') await click('.calendar-day.has-assets');
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  await i18n.changeLanguage('en'); sessionStorage.clear();
  updateSetting('recentPhotoCount', 150); updateSetting('showKeyboardShortcuts', true);
  updateSetting('dateLocale', 'en-US'); updateSetting('homeThumbnailColumns', 6);
  for (const tab of ['recent', 'favorites', 'albums', 'calendar'] as const) {
    writeEditStatusFilterMode('both', tab); writeDevelopStatusFilterMode('both', tab);
  }
  api.recent.mockReset().mockResolvedValue(photos);
  api.favorites.mockReset().mockResolvedValue(photos);
  api.albums.mockReset().mockResolvedValue([album]);
  api.album.mockReset().mockResolvedValue(photos);
  api.day.mockReset().mockResolvedValue(photos);
  api.minYear.mockReset().mockResolvedValue(2020);
  api.heatmap.mockReset().mockImplementation(async (year: number, month: number | null) => ({ year, month,
    days: [1, 3].map(day => ({ date: `${year}-${String(month ?? 9).padStart(2, '0')}-0${day}`, hasAssets: true, count: 2 })) }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers();
  updateSetting('recentPhotoCount', 100); updateSetting('dateLocale', 'auto');
});

describe('Gallery manual refresh', () => {
  it.each(['recent', 'favorites', 'album-list', 'album-detail', 'calendar-year', 'calendar-month', 'calendar-day'])
    ('reloads only the current %s view after a Stack write', async view => {
      await mount(); await openView(view);
      const loader = view === 'album-list' ? 'albums' : view === 'album-detail' ? 'album'
        : view === 'calendar-day' ? 'day' : view.startsWith('calendar') ? 'heatmap' : view;
      const before = Object.fromEntries(Object.entries(api).map(([key, mock]) => [key, mock.mock.calls.length]));
      await click('#home-stacks-tab');
      await click('#test-stack-write-complete');
      expect(api[loader as keyof typeof api].mock.calls.length).toBe(before[loader]);
      await click(`#home-${view.startsWith('album') ? 'albums' : view.startsWith('calendar') ? 'calendar' : view}-tab`);
      expect(api[loader as keyof typeof api].mock.calls.length).toBe(before[loader] + 1);
      for (const name of ['recent', 'favorites', 'albums', 'album', 'day', 'heatmap'] as const) {
        if (view === 'calendar-day' && name === 'heatmap') continue;
        if (name !== loader) expect(api[name].mock.calls.length).toBe(before[name]);
      }
    });

  it('coalesces multiple Stack writes and keeps cached Gallery data when none completed', async () => {
    await mount();
    const recentCalls = api.recent.mock.calls.length;
    await click('#home-stacks-tab');
    await click('#test-stack-write-complete'); await click('#test-stack-write-complete');
    expect(api.recent).toHaveBeenCalledTimes(recentCalls);
    await click('#home-recent-tab');
    expect(api.recent).toHaveBeenCalledTimes(recentCalls + 1);

    await click('#home-stacks-tab'); await click('#home-recent-tab');
    expect(api.recent).toHaveBeenCalledTimes(recentCalls + 1);
  });

  it('waits for the active Gallery data load and preserves selection, filter and scroll on return', async () => {
    const pending = deferred<RecentAsset[]>(); api.recent.mockReturnValueOnce(pending.promise);
    await mount();
    await click('#home-stacks-tab'); await click('#test-stack-write-complete');
    expect(api.recent).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(photos));
    expect(api.recent).toHaveBeenCalledOnce();
    await click('#home-recent-tab');
    expect(api.recent).toHaveBeenCalledTimes(2);
    await click('.selection-all'); await change('.develop-status-filter-control select', 'undeveloped');
    const page = host.querySelector<HTMLElement>('.home-page')!; const content = homeScrollContent(page)!;
    page.scrollTop = 35; content.scrollTop = 240;
    await click('#home-stacks-tab'); await click('#test-stack-write-complete'); await click('#home-recent-tab');
    expect(host.querySelector('.selection-count')?.textContent).toBe('2 selected');
    expect((host.querySelector('.develop-status-filter-control select') as HTMLSelectElement).value).toBe('undeveloped');
    expect(page.scrollTop).toBe(0); expect(content.scrollTop).toBe(240);
  });

  it('preserves the Stack-write reload requirement when returning through Export', async () => {
    await mount(); const recentCalls = api.recent.mock.calls.length;
    await click('#home-stacks-tab'); await click('#test-stack-write-complete');
    await click('#home-export-tab'); await click('#home-recent-tab');
    expect(api.recent).toHaveBeenCalledTimes(recentCalls + 1);
  });

  it('reloads each previously cached browsing view once after a Stack write', async () => {
    await mount(); await openView('favorites'); await openView('calendar-day');
    const beforeRecent = api.recent.mock.calls.length, beforeFavorites = api.favorites.mock.calls.length;
    await click('#home-stacks-tab'); await click('#test-stack-write-complete'); await click('#home-calendar-tab');
    expect(api.recent).toHaveBeenCalledTimes(beforeRecent);
    expect(api.favorites).toHaveBeenCalledTimes(beforeFavorites);
    await click('#home-recent-tab'); expect(api.recent).toHaveBeenCalledTimes(beforeRecent + 1);
    await click('#home-favorites-tab'); expect(api.favorites).toHaveBeenCalledTimes(beforeFavorites + 1);
    await click('#home-recent-tab'); expect(api.recent).toHaveBeenCalledTimes(beforeRecent + 1);
    await click('#home-favorites-tab'); expect(api.favorites).toHaveBeenCalledTimes(beforeFavorites + 1);
  });

  it('records a send completing while Export is visible and reloads only after returning to Gallery', async () => {
    await mount(); const before = api.recent.mock.calls.length;
    await click('#home-stacks-tab'); await click('#home-export-tab'); await click('#test-stack-write-complete');
    expect(api.recent).toHaveBeenCalledTimes(before);
    await click('#home-recent-tab'); expect(api.recent).toHaveBeenCalledTimes(before + 1);
  });

  it('does not let a read started before a late Stack-write completion fulfill its reload', async () => {
    await mount(); await click('#home-stacks-tab'); await click('#home-recent-tab');
    const old = deferred<RecentAsset[]>(); api.recent.mockReturnValueOnce(old.promise);
    await click('.gallery-refresh');
    // The retained manager can finish its send while Gallery is already visible.
    await click('#test-stack-write-complete');
    const before = api.recent.mock.calls.length;
    await act(async () => old.resolve(photos));
    expect(api.recent).toHaveBeenCalledTimes(before + 1);
    expect(refreshButton().disabled).toBe(false);
  });

  it.each(['recent', 'favorites', 'album-list', 'album-detail', 'calendar-year', 'calendar-month', 'calendar-day'])
    ('owns the leftmost toolbar position and updates only %s without changing its hierarchy', async view => {
      await mount(); await openView(view);
      const toolbar = host.querySelector('.home-toolbar')!;
      expect(toolbar.firstElementChild?.className).toBe('home-toolbar-start');
      expect(toolbar.firstElementChild?.firstElementChild).toBe(refreshButton());
      expect(refreshButton().closest('.selection-bar')).toBeNull();
      const before = Object.fromEntries(Object.entries(api).map(([key, mock]) => [key, mock.mock.calls.length]));
      const loader = view === 'album-list' ? 'albums' : view === 'album-detail' ? 'album'
        : view === 'calendar-day' ? 'day' : view.startsWith('calendar') ? 'heatmap' : view;
      const tab = host.querySelector('[role="tab"][aria-selected="true"]')?.id;
      const title = host.querySelector('.home-toolbar-title')?.textContent;
      const page = host.querySelector<HTMLElement>('.home-page')!;
      const content = homeScrollContent(page)!;
      page.scrollTop = 25; content.scrollTop = 150;
      await press();
      expect(page.scrollTop).toBe(25); expect(content.scrollTop).toBe(150);
      expect(api[loader as keyof typeof api].mock.calls.length).toBe(before[loader] + 1);
      expect(host.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe(tab);
      expect(host.querySelector('.home-toolbar-title')?.textContent).toBe(title);
      for (const name of ['recent', 'favorites', 'albums', 'album', 'day'] as const) {
        if (name !== loader) expect(api[name].mock.calls.length).toBe(before[name]);
      }
      if (view.startsWith('calendar')) expect(api.minYear.mock.calls.length).toBe(before.minYear + 1);
      if (view === 'album-detail') expect(api.album).toHaveBeenLastCalledWith(album.id, expect.any(AbortSignal));
      if (view === 'calendar-day') expect(api.day).toHaveBeenLastCalledWith('2026-09-01', expect.any(AbortSignal));
      if (view === 'calendar-year') expect(api.heatmap).toHaveBeenLastCalledWith(2026, null, expect.any(AbortSignal));
      if (view === 'calendar-month') expect(api.heatmap).toHaveBeenLastCalledWith(2026, 9, expect.any(AbortSignal));
    });

  it('uses the current Recent count, keeps selection, filters, thumbnail size and scroll, and prevents duplicate requests', async () => {
    await mount(); await change('.develop-status-filter-control select', 'undeveloped'); await click('.selection-all');
    const page = host.querySelector<HTMLElement>('.home-page')!;
    const content = homeScrollContent(page)!;
    page.scrollTop = 50; content.scrollTop = 320;
    const pending = deferred<RecentAsset[]>(); api.recent.mockReturnValueOnce(pending.promise);
    await click('.gallery-refresh');
    expect(api.recent).toHaveBeenLastCalledWith(150, expect.any(AbortSignal));
    expect(refreshButton().disabled).toBe(true); expect(filenames()).toEqual(['one.jpg', 'two.jpg']);
    await press(); await click('.gallery-refresh'); expect(api.recent).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve([photos[1]]));
    expect(host.querySelector('.selection-count')?.textContent).toBe('1 selected');
    expect(host.querySelector('.photo-card.selected .photo-info p')?.textContent).toBe('two.jpg');
    expect(page.scrollTop).toBe(50); expect(content.scrollTop).toBe(320);
    expect((host.querySelector('.recent-count-control select') as HTMLSelectElement).value).toBe('150');
    expect((host.querySelector('.develop-status-filter-control select') as HTMLSelectElement).value).toBe('undeveloped');
    expect(host.querySelector('.photo-grid')?.getAttribute('style')).toContain('6');
  });

  it.each(['favorites', 'album-detail', 'calendar-day'])('retains only surviving selection in %s', async view => {
    await mount(); await openView(view); await click('.selection-all');
    const mock = view === 'favorites' ? api.favorites : view === 'album-detail' ? api.album : api.day;
    mock.mockResolvedValueOnce([photos[1]]); await click('.gallery-refresh');
    expect(host.querySelector('.selection-count')?.textContent).toBe('1 selected');
    expect(host.querySelector('.photo-card.selected .photo-info p')?.textContent).toBe('two.jpg');
  });

  it.each(['recent', 'favorites', 'album-list', 'album-detail', 'calendar-month', 'calendar-day'])
    ('keeps previously displayed %s data on failure and permits retry', async view => {
      await mount(); await openView(view);
      const before = host.querySelector('.home-tab-panel')?.innerHTML;
      const mock = view === 'album-list' ? api.albums : view === 'album-detail' ? api.album : view === 'calendar-day' ? api.day
        : view === 'calendar-month' ? api.heatmap : view === 'favorites' ? api.favorites : api.recent;
      mock.mockRejectedValueOnce(new Error('Failed')); await click('.gallery-refresh');
      expect(host.querySelector('.home-tab-panel')?.innerHTML).toBe(before);
      expect(host.textContent).toContain('Could not refresh photos'); expect(refreshButton().disabled).toBe(false);
      await click('.gallery-refresh'); expect(host.textContent).not.toContain('Could not refresh photos');
    });

  it('refreshes Album names, covers and counts in the list while preserving the cached Favorites tab', async () => {
    await mount(); await openView('favorites'); await openView('album-list');
    api.albums.mockResolvedValueOnce([{ ...album, albumName: 'Renamed album', assetCount: 8, albumThumbnailAssetId: 'new-cover' }]);
    await click('.gallery-refresh');
    expect(host.querySelector('.album-name')?.textContent).toBe('Renamed album');
    expect(host.querySelector('.album-count')?.textContent).toContain('8');
    expect(host.querySelector('.album-cover img')?.getAttribute('src')).toContain('new-cover');
    await openView('favorites'); expect(api.favorites).toHaveBeenCalledTimes(1);
  });

  it('keeps a historical Calendar period while refreshing its minimum year and date adjacency', async () => {
    await mount(); await openView('calendar-month'); await change('#calendar-year', '2024'); await change('#calendar-month', '2');
    api.minYear.mockResolvedValueOnce(2010); await click('.gallery-refresh');
    expect(api.heatmap).toHaveBeenLastCalledWith(2024, 2, expect.any(AbortSignal));
    expect((host.querySelector('#calendar-year') as HTMLSelectElement).value).toBe('2024');
    expect(host.querySelector('#calendar-year option[value="2010"]')).not.toBeNull();
    await click('.calendar-day.has-assets');
    api.heatmap.mockImplementation(async (year: number, month: number | null) => ({ year, month, days: [
      { date: '2024-02-01', hasAssets: true, count: 1 }, { date: '2024-02-02', hasAssets: true, count: 1 } ] }));
    await click('.gallery-refresh'); await click('.calendar-detail-next');
    expect(api.day).toHaveBeenLastCalledWith('2024-02-02', expect.any(AbortSignal));
  });

  it('invalidates adjacent-date candidates after a parent Calendar refresh and skips removed photo days', async () => {
    let photoDays = [1, 3, 5];
    api.heatmap.mockImplementation(async (year: number, month: number | null) => ({ year, month, days: photoDays.map(day => ({
      date: `2026-09-${String(day).padStart(2, '0')}`, hasAssets: true, count: 1,
    })) }));
    await mount(); await openView('calendar-month');
    await click('[aria-label^="2026-09-01,"]');
    expect(host.querySelector<HTMLButtonElement>('.calendar-detail-next')?.disabled).toBe(false);
    await click('.album-back');

    photoDays = [1, 2, 5];
    await click('.gallery-refresh');
    await click('[aria-label^="2026-09-01,"]');
    expect(host.querySelector<HTMLButtonElement>('.calendar-detail-next')?.disabled).toBe(false);
    await click('.calendar-detail-next');
    expect(api.day).toHaveBeenLastCalledWith('2026-09-02', expect.any(AbortSignal));
    await click('.album-back'); await click('[aria-label^="2026-09-05,"]');
    expect(host.querySelector<HTMLButtonElement>('.calendar-detail-previous')?.disabled).toBe(false);
    await click('.calendar-detail-previous');
    expect(api.day).toHaveBeenLastCalledWith('2026-09-02', expect.any(AbortSignal));
  });

  it('keeps a day refresh busy through adjacent Heatmap completion and rejects duplicate refresh', async () => {
    await mount(); await openView('calendar-day');
    const pending = deferred<{ year: number; month: null; days: { date: string; hasAssets: boolean; count: number }[] }>();
    const original = api.heatmap.getMockImplementation()!;
    api.heatmap.mockImplementation((year, month, signal) => month === null ? pending.promise : original(year, month, signal));
    const dayCalls = api.day.mock.calls.length;
    await click('.gallery-refresh');
    expect(refreshButton().disabled).toBe(true);
    expect(api.day).toHaveBeenCalledTimes(dayCalls + 1);
    await press();
    expect(api.day).toHaveBeenCalledTimes(dayCalls + 1);
    expect(refreshButton().disabled).toBe(true);
    await act(async () => pending.resolve({ year: 2026, month: null, days: [
      { date: '2026-09-01', hasAssets: true, count: 1 }, { date: '2026-09-03', hasAssets: true, count: 1 },
    ] }));
    expect(refreshButton().disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('.calendar-detail-next')?.disabled).toBe(false);
  });

  it.each([
    ['previous', '2026-09-02'],
    ['next', '2026-09-04'],
  ] as const)('keeps the manual Reload %s candidate when an older ordinary Heatmap completes last', async (direction, expectedDate) => {
    const ordinary = deferred<{ year: number; month: null; days: { date: string; hasAssets: boolean; count: number }[] }>();
    const manual = deferred<{ year: number; month: null; days: { date: string; hasAssets: boolean; count: number }[] }>();
    const original = api.heatmap.getMockImplementation()!;
    let annualRequest = 0;
    api.heatmap.mockImplementation((year, month, signal) => {
      if (month !== null) return original(year, month, signal);
      annualRequest += 1;
      return annualRequest === 1 ? ordinary.promise : manual.promise;
    });
    await mount(); await click('#home-calendar-tab'); await click('[aria-label^="2026-09-03,"]');
    expect(annualRequest).toBe(1);

    await click('.gallery-refresh');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(annualRequest).toBe(2);
    expect(refreshButton().disabled).toBe(true);

    await act(async () => {
      manual.resolve({ year: 2026, month: null, days: [
        { date: '2026-09-02', hasAssets: true, count: 1 }, { date: '2026-09-03', hasAssets: true, count: 1 },
        { date: '2026-09-04', hasAssets: true, count: 1 },
      ] });
      await manual.promise;
      await Promise.resolve(); await Promise.resolve();
    });
    expect(refreshButton().disabled).toBe(false);
    const selector = `.calendar-detail-${direction}`;
    expect(host.querySelector<HTMLButtonElement>(selector)?.disabled).toBe(false);

    await act(async () => {
      ordinary.resolve({ year: 2026, month: null, days: [
        { date: '2026-09-01', hasAssets: true, count: 1 }, { date: '2026-09-03', hasAssets: true, count: 1 },
        { date: '2026-09-05', hasAssets: true, count: 1 },
      ] });
      await ordinary.promise;
      await Promise.resolve(); await Promise.resolve();
    });
    expect(host.querySelector<HTMLButtonElement>(selector)?.disabled).toBe(false);
    await click(selector);
    expect(api.day).toHaveBeenLastCalledWith(expectedDate, expect.any(AbortSignal));
  });

  it('does not restore ordinary candidates when a manual Reload fails before the old request completes', async () => {
    const ordinary = deferred<{ year: number; month: null; days: { date: string; hasAssets: boolean; count: number }[] }>();
    const manual = deferred<{ year: number; month: null; days: { date: string; hasAssets: boolean; count: number }[] }>();
    const original = api.heatmap.getMockImplementation()!;
    let annualRequest = 0;
    api.heatmap.mockImplementation((year, month, signal) => {
      if (month !== null) return original(year, month, signal);
      annualRequest += 1;
      return annualRequest === 1 ? ordinary.promise : manual.promise;
    });
    await mount(); await click('#home-calendar-tab'); await click('[aria-label^="2026-09-03,"]');
    await click('.gallery-refresh');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(annualRequest).toBe(2);

    await act(async () => {
      manual.reject(new Error('Latest Heatmap unavailable'));
      await manual.promise.catch(() => {});
      await Promise.resolve(); await Promise.resolve();
    });
    expect(refreshButton().disabled).toBe(false);
    expect(host.textContent).toContain('Could not refresh photos');

    await act(async () => {
      ordinary.resolve({ year: 2026, month: null, days: [
        { date: '2026-09-01', hasAssets: true, count: 1 }, { date: '2026-09-03', hasAssets: true, count: 1 },
        { date: '2026-09-05', hasAssets: true, count: 1 },
      ] });
      await ordinary.promise;
      await Promise.resolve(); await Promise.resolve();
    });
    expect(host.querySelector<HTMLButtonElement>('.calendar-detail-previous')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.calendar-detail-next')?.disabled).toBe(true);
  });

  it('reports adjacent Heatmap failure and clears old candidates while retaining day photos', async () => {
    await mount(); await openView('calendar-day');
    const before = filenames();
    api.heatmap.mockRejectedValueOnce(new Error('Heatmap unavailable'));
    await click('.gallery-refresh');
    expect(refreshButton().disabled).toBe(false);
    expect(host.textContent).toContain('Could not refresh photos');
    expect(filenames()).toEqual(before);
    expect(host.querySelector<HTMLButtonElement>('.calendar-detail-previous')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.calendar-detail-next')?.disabled).toBe(true);
  });

  it.each(['parent Calendar', 'another date'])('aborts a day refresh and ignores its adjacent result after moving to %s', async destination => {
    await mount(); await openView('calendar-day');
    const pending = deferred<{ year: number; month: null; days: { date: string; hasAssets: boolean; count: number }[] }>();
    const original = api.heatmap.getMockImplementation()!;
    let delayedRequestUsed = false;
    api.heatmap.mockImplementation((year, month, signal) => {
      if (month === null && !delayedRequestUsed) { delayedRequestUsed = true; return pending.promise; }
      return original(year, month, signal);
    });
    await click('.gallery-refresh');
    const signal = api.heatmap.mock.calls.at(-1)!.at(-1) as AbortSignal;
    await click('.album-back');
    if (destination === 'another date') await click('[aria-label^="2026-09-03,"]');
    const title = host.querySelector('.home-toolbar-title')?.textContent;
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ year: 2026, month: null, days: [
      { date: '2026-09-01', hasAssets: true, count: 1 }, { date: '2026-09-02', hasAssets: true, count: 1 },
    ] }));
    expect(host.querySelector('.home-toolbar-title')?.textContent).toBe(title);
    if (destination === 'parent Calendar') expect(host.querySelector('.calendar-month')).not.toBeNull();
    else expect(host.querySelector('.home-toolbar-title')?.textContent).toContain('3');
    expect(refreshButton().disabled).toBe(false);
  });

  it.each(['recent', 'favorites', 'album-detail', 'calendar-month', 'calendar-day'])
    ('rejects a stale %s refresh after navigation even when transport ignores cancellation', async view => {
      await mount(); await openView(view);
      const pending = deferred<never>();
      const mock = view === 'recent' ? api.recent : view === 'favorites' ? api.favorites : view === 'album-detail' ? api.album
        : view === 'calendar-day' ? api.day : api.heatmap;
      mock.mockReturnValueOnce(pending.promise); await click('.gallery-refresh');
      const signal = mock.mock.calls.at(-1)!.at(-1) as AbortSignal;
      await click(view === 'recent' ? '#home-favorites-tab' : '#home-recent-tab');
      expect(signal.aborted).toBe(true);
      await act(async () => pending.resolve([] as never));
      expect(filenames()).toEqual(['one.jpg', 'two.jpg']); expect(refreshButton().disabled).toBe(false);
    });

  it('keeps an emptied historical date and finds the next photo beyond a new minimum year', async () => {
    await mount(); await openView('calendar-month'); await change('#calendar-year', '2024');
    api.minYear.mockResolvedValueOnce(2025); await click('.gallery-refresh');
    expect((host.querySelector('#calendar-year') as HTMLSelectElement).value).toBe('2024');
    await click('.calendar-day.has-assets');
    api.minYear.mockResolvedValueOnce(2025); api.day.mockResolvedValueOnce([]);
    api.heatmap.mockImplementation(async (year: number, month: number | null) => ({ year, month,
      days: year === 2025 ? [{ date: '2025-01-01', hasAssets: true, count: 1 }] : [] }));
    const title = host.querySelector('.home-toolbar-title')?.textContent;
    await click('.gallery-refresh'); expect(host.querySelector('.home-toolbar-title')?.textContent).toBe(title);
    expect((host.querySelector('.calendar-detail-previous') as HTMLButtonElement).disabled).toBe(true);
    await click('.calendar-detail-next'); expect(api.day).toHaveBeenLastCalledWith('2025-01-01', expect.any(AbortSignal));
  });

  it('keeps Calendar refresh locked until the minimum-year request also settles', async () => {
    await mount(); await openView('calendar-month');
    const bounds = deferred<number>(); api.minYear.mockReturnValueOnce(bounds.promise);
    await click('.gallery-refresh'); expect(refreshButton().disabled).toBe(true);
    const requests = api.heatmap.mock.calls.length; await press(); expect(api.heatmap).toHaveBeenCalledTimes(requests);
    await act(async () => bounds.reject(new Error('Bounds unavailable')));
    expect(refreshButton().disabled).toBe(false); expect(host.querySelector('.calendar-month')).not.toBeNull();
    expect(host.textContent).toContain('Could not refresh photos');
  });

  it('rejects a detail refresh after moving to another Album', async () => {
    api.albums.mockResolvedValueOnce([album, { ...album, id: 'album-b', albumName: 'Other album' }]);
    await mount(); await openView('album-detail');
    const pending = deferred<RecentAsset[]>(); api.album.mockReturnValueOnce(pending.promise);
    await click('.gallery-refresh'); await click('.album-back');
    api.album.mockResolvedValueOnce([{ ...photos[0], filename: 'other.jpg' }]);
    await click('.album-card:nth-child(2)');
    await act(async () => pending.resolve([photos[1]]));
    expect(filenames()).toEqual(['other.jpg']); expect(host.querySelector('.home-toolbar-title')?.textContent).toBe('Other album');
  });

  it('rejects a heatmap refresh after moving to another Calendar period', async () => {
    await mount(); await openView('calendar-month');
    const pending = deferred<{ year: number; month: number; days: [] }>(); api.heatmap.mockReturnValueOnce(pending.promise);
    await click('.gallery-refresh'); await change('#calendar-month', '8');
    await act(async () => pending.resolve({ year: 2026, month: 9, days: [] }));
    expect(host.querySelectorAll('.calendar-day.has-assets')).toHaveLength(2);
    expect((host.querySelector('#calendar-month') as HTMLSelectElement).value).toBe('8');
  });

  it('keeps R as Recent, leaves native reload alone and applies Home shortcut guards', async () => {
    await mount(); await openView('favorites');
    for (const options of [{ ctrlKey: true, shiftKey: false }, { metaKey: true, shiftKey: false }, { repeat: true }, { isComposing: true }]) {
      expect((await press(options)).defaultPrevented).toBe(false);
    }
    const input = document.createElement('input'); host.append(input); await press({}, input); input.remove();
    for (const role of ['dialog', 'alertdialog', 'menu']) {
      const overlay = document.createElement('div'); overlay.setAttribute('role', role); host.append(overlay);
      await press(); overlay.remove();
    }
    const event = new KeyboardEvent('keydown', { key: 'R', shiftKey: true, bubbles: true, cancelable: true }); event.preventDefault();
    await act(async () => window.dispatchEvent(event)); expect(api.favorites).toHaveBeenCalledTimes(1);
    await press({ key: 'r', shiftKey: false }); expect(host.querySelector('#home-recent-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(api.recent).toHaveBeenCalledTimes(1);
  });

  it('hides Refresh and ignores Shift+R in STACK and Export management and inactive Home', async () => {
    await mount();
    for (const tab of ['stacks', 'export']) {
      await click(`#home-${tab}-tab`); expect(refreshButton()).toBeNull();
      expect((await press()).defaultPrevented).toBe(false); expect(api.recent).toHaveBeenCalledTimes(1);
    }
    await click('#home-recent-tab'); await mount(false);
    await press(); expect(api.recent).toHaveBeenCalledTimes(1);
  });

  it('uses a localized text label and shared shortcut hints in both languages', async () => {
    await mount();
    expect(refreshButton().textContent).toBe('Reload');
    expect(refreshButton().querySelector('svg')).toBeNull();
    expect(refreshButton().title).toBe('Refresh photos [Shift+R]');
    expect(refreshButton().getAttribute('aria-label')).toBe('Refresh photos [Shift+R]');
    await act(async () => updateSetting('showKeyboardShortcuts', false));
    expect(refreshButton().getAttribute('aria-label')).toBe('Refresh photos');
    expect(refreshButton().title).toBe('Refresh photos');
    await act(async () => i18n.changeLanguage('ja'));
    expect(refreshButton().textContent).toBe('リロード');
    expect(refreshButton().title).toBe('写真を再読み込み');
    await act(async () => updateSetting('showKeyboardShortcuts', true));
    expect(refreshButton().title).toBe('写真を再読み込み [Shift+R]');
    expect(refreshButton().getAttribute('aria-label')).toBe('写真を再読み込み [Shift+R]');
  });

  it('replaces Stack Cover and members through the normal Gallery snapshot path', async () => {
    const oldStack = makeGalleryStack(1, ['JPEG', 'DNG']);
    api.recent.mockResolvedValueOnce([oldStack]); await mount(); await click('.selection-all');
    const members = oldStack.stackMembers!;
    await act(async () => { setManualGalleryStackSelection(oldStack, new Set([members[1].id])); });
    const newMember = { ...members[1], primaryAssetId: members[1].id, stackAssetCount: 1 };
    const newStack = { ...oldStack, ...newMember, stackMembers: [newMember],
      stackMemberIds: [members[1].id], stackAssetCount: 1, stackFormats: [{ format: 'DNG', isRaw: true }] };
    api.recent.mockResolvedValueOnce([newStack]); await click('.gallery-refresh');
    expect(filenames()).toEqual([members[1].filename]); expect(host.querySelector('.selection-count')?.textContent).toBe('0 selected');
    const snapshot = resolveGalleryStackSelection(oldStack, 'nonRaw');
    expect(snapshot.status).toBe('ready');
    expect([...snapshot.selectedAssetIds]).toEqual([newMember.id]);
    expect([...getManualGalleryStackSelection(oldStack.stackId!)!]).toEqual([newMember.id]);
  });
});

describe('Gallery blank photo-grid selection clearing', () => {
  it.each(['recent', 'favorites', 'album-detail', 'calendar-day'])('clears only the current %s selection from blank grid space', async view => {
    await mount(); await openView(view); await click('.selection-all');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(2);

    await clickBlankAt('.photo-grid');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(0);

    await click('.selection-all');
    await clickBlankAt('.home-tab-panel');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(0);

    await click('.selection-all');
    await clickBlankAt('.home-content');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(0);
  });

  it('does not clear selection for card, checkbox, right-click, or an empty selection', async () => {
    await mount(); await click('.selection-all');
    await click('.photo-card-button');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(1);
    await click('.selection-all');
    await click('.photo-selection-input');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(1);
    await click('.selection-all');
    await clickBlankAt('.photo-grid', 2);
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(2);

    await click('.selection-clear');
    await clickBlankAt('.home-content');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(0);
  });

  it('does not clear selection when a Stack format control is used', async () => {
    const stackMembers = photos.map(member => ({ ...member, stackId: 'stack-a', primaryAssetId: 'one',
      stackAssetCount: 2, stackMemberIds: ['one', 'two'], stackFormats: [{ format: 'JPEG', isRaw: false }, { format: 'RAW', isRaw: true }] }));
    const stackPhotos = photos.map(photo => ({ ...photo, stackId: 'stack-a', primaryAssetId: 'one',
      stackAssetCount: 2, stackMemberIds: ['one', 'two'],
      stackFormats: [{ format: 'JPEG', isRaw: false }, { format: 'RAW', isRaw: true }],
      stackMembers }));
    api.recent.mockResolvedValueOnce(stackPhotos);
    await mount(); await click('.selection-all');
    const selectionCount = host.querySelector('.selection-count')?.textContent;
    await click('.stack-format-switch');
    expect(host.querySelector('.selection-count')?.textContent).toBe(selectionCount);
  });

  it('keeps another tab selection and selections outside Gallery untouched', async () => {
    await mount(); await click('.selection-all');
    await click('#home-favorites-tab'); await click('.selection-all'); await clickBlankAt('.home-content');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(0);
    await click('#home-recent-tab');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(2);

    await click('#home-stacks-tab'); await click('#home-export-tab'); await click('#home-recent-tab');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(2);
  });

  it('does not clear selection when the Toolbar or Gallery tab is clicked', async () => {
    await mount(); await click('.selection-all');
    await click('.gallery-refresh');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(2);
    await click('#home-favorites-tab');
    await click('#home-recent-tab');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(2);
  });
});
