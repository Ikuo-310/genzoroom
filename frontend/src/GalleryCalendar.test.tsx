// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';
import { HOME_THUMBNAIL_COLUMNS_KEY, resolveDateLocale, updateSetting } from './appSettings';
import type { RecentAsset } from './assets';
import type { CalendarHeatmap } from './HomeCalendar';
import { PHOTO_FILTER_SESSION_KEYS, writePhotoFilterMode } from './photoFilters';
import i18n from './i18n';

const api = vi.hoisted(() => ({ recent: vi.fn(), albums: vi.fn(), albumAssets: vi.fn(), heatmap: vi.fn(), minYear: vi.fn(), day: vi.fn(), statuses: vi.fn() }));
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()),
  fetchRecentAssets: api.recent, fetchAlbums: api.albums, fetchAlbumAssets: api.albumAssets,
  fetchCalendarHeatmap: api.heatmap, fetchCalendarMinYear: api.minYear, fetchCalendarDayAssets: api.day }));
vi.mock('./editStateApi', async original => ({ ...(await original<typeof import('./editStateApi')>()),
  getAssetEditStatuses: api.statuses }));

const recent: RecentAsset[] = [{ id: 'recent-1', filename: 'recent.jpg', date: '2026-09-30',
  thumbnail_url: '/thumb/recent', format: 'JPEG', is_raw: false }];
const dayPhotos: RecentAsset[] = Array.from({ length: 3 }, (_, index) => ({
  id: `day-${index}`, filename: `day-${index}.${index === 1 ? 'jpg' : 'dng'}`, date: '2026-09-30',
  thumbnail_url: `/thumb/day-${index}`, format: index === 1 ? 'JPEG' : 'DNG', is_raw: index !== 1,
}));
let host: HTMLDivElement;
let root: Root;

function monthData(year: number, month: number): CalendarHeatmap {
  return { year, month, days: [1, 2, 3].map(day => ({
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    hasAssets: day === 1 || day === 3,
    // Legacy heatmap counts can include archives; only hasAssets enables a calendar day.
    count: day === 1 ? 1558 : day === 3 ? 2 : 9,
    thumbnail_url: day === 1 ? `/api/assets/${year}-${month}-cover/thumbnail` : null,
  })) };
}

function yearData(year: number): CalendarHeatmap {
  return { year, month: null, days: Array.from({ length: 12 }, (_, month) => monthData(year, month + 1).days).flat() };
}

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
async function settle() { await act(async () => { await Promise.resolve(); }); }
function selectValue(selector: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(selector)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  await i18n.changeLanguage('en');
  sessionStorage.clear();
  writePhotoFilterMode('both', 'recent'); writePhotoFilterMode('both', 'albums'); writePhotoFilterMode('both', 'calendar');
  updateSetting('weekStart', 'sunday'); updateSetting('dateLocale', 'en-US');
  updateSetting('recentPhotoCount', 100); updateSetting('homeThumbnailColumns', 6);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.recent.mockReset().mockResolvedValue(recent);
  api.albums.mockReset().mockResolvedValue([]);
  api.minYear.mockReset().mockResolvedValue(2002);
  api.albumAssets.mockReset().mockResolvedValue(dayPhotos.slice(0, 2));
  api.heatmap.mockReset().mockImplementation(async (year: number, month: number | null) => month === null ? yearData(year) : monthData(year, month));
  api.day.mockReset().mockResolvedValue(dayPhotos);
  api.statuses.mockReset().mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, id === 'day-0'])));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); sessionStorage.clear();
  writePhotoFilterMode('both', 'recent'); writePhotoFilterMode('both', 'albums'); writePhotoFilterMode('both', 'calendar');
  updateSetting('weekStart', 'auto'); updateSetting('dateLocale', 'auto');
  updateSetting('recentPhotoCount', 100); updateSetting('homeThumbnailColumns', 6); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('Home calendar', () => {
  it('follows language for date order and Auto week start only in language-sync mode', async () => {
    vi.stubGlobal('navigator', { languages: ['en-GB'] });
    act(() => { updateSetting('dateLocale', 'auto-language'); updateSetting('weekStart', 'auto'); });
    await mount(); click('#home-calendar-tab'); await settle();
    const selectOrder = () => [...host.querySelectorAll<HTMLSelectElement>('.calendar-navigation select')].map(select => select.id);
    expect(selectOrder()).toEqual(['calendar-month', 'calendar-year']);
    expect(host.querySelector('.calendar-weekday')?.textContent).toBe('Sun');
    await act(async () => i18n.changeLanguage('ja'));
    expect(selectOrder()).toEqual(['calendar-year', 'calendar-month']);
    expect(host.querySelector('.calendar-weekday')?.textContent).toBe('日');
    click('.calendar-view-toggle'); await settle();
    expect(selectOrder()).toEqual(['calendar-year', 'calendar-month']);
    act(() => updateSetting('dateLocale', 'auto'));
    expect(selectOrder()).toEqual(['calendar-month', 'calendar-year']);
    expect(host.querySelector('.calendar-weekday')?.textContent).toBe('月');
    act(() => updateSetting('dateLocale', 'ja-JP'));
    await act(async () => i18n.changeLanguage('en'));
    expect(selectOrder()).toEqual(['calendar-year', 'calendar-month']);
    expect(host.querySelector('.calendar-weekday')?.textContent).toBe('Sun');
  });

  it('orders year and month selects by the resolved date locale, independently of UI language', async () => {
    await mount(); click('#home-calendar-tab'); await settle();
    const selectOrder = () => [...host.querySelectorAll<HTMLSelectElement>('.calendar-navigation select')]
      .map(select => select.id);
    expect(selectOrder()).toEqual(['calendar-month', 'calendar-year']);

    act(() => updateSetting('dateLocale', 'ja-JP'));
    expect(selectOrder()).toEqual(['calendar-year', 'calendar-month']);
    expect(host.querySelector('.calendar-current-month')?.textContent).toBe('This month');

    await act(async () => { await i18n.changeLanguage('ja'); });
    expect(host.querySelector('.calendar-current-month')?.textContent).toBe('今月へ');
    act(() => updateSetting('dateLocale', 'en-GB'));
    expect(selectOrder()).toEqual(['calendar-month', 'calendar-year']);

    act(() => updateSetting('dateLocale', 'auto'));
    const localeParts = new Intl.DateTimeFormat(resolveDateLocale('auto'), { year: 'numeric', month: 'long' })
      .formatToParts(new Date(Date.UTC(2026, 0, 1)));
    const expectedOrder = localeParts.findIndex(part => part.type === 'year') < localeParts.findIndex(part => part.type === 'month')
      ? ['calendar-year', 'calendar-month'] : ['calendar-month', 'calendar-year'];
    expect(selectOrder()).toEqual(expectedOrder);

    click('.calendar-view-toggle'); await settle();
    expect(host.querySelector('.calendar-current-month')?.textContent).toBe('今年へ');
  });

  it('switches month/year with one annual request, keeps month, and localizes the controls', async () => {
    await mount(); click('#home-calendar-tab'); await settle();
    selectValue('#calendar-month', '8'); await settle();
    expect(host.querySelector('.calendar-view-toggle')?.textContent).toBe('Year view');
    api.heatmap.mockClear(); click('.calendar-view-toggle'); await settle();
    expect(api.heatmap).toHaveBeenCalledTimes(1);
    expect(api.heatmap).toHaveBeenCalledWith(2026, null, expect.any(AbortSignal));
    expect(host.querySelectorAll('.calendar-mini-month')).toHaveLength(12);
    expect(host.querySelectorAll('.calendar-day.has-assets')).toHaveLength(24);
    expect(host.querySelectorAll('.calendar-day-count')).toHaveLength(0);
    expect(host.querySelectorAll('.calendar-day-thumbnail')).toHaveLength(0);
    expect(host.querySelector('.calendar-mini-month h3')?.textContent).toBe('January');
    expect(host.querySelector('.calendar-view-toggle')?.textContent).toBe('Month view');
    expect(host.querySelector('.calendar-current-month')?.textContent).toBe('This year');
    const requestCount = api.heatmap.mock.calls.length;
    click('#home-calendar-tab'); click('.calendar-current-month'); await settle();
    expect(api.heatmap).toHaveBeenCalledTimes(requestCount);
    await act(async () => { await i18n.changeLanguage('ja'); });
    expect(host.querySelector('.calendar-view-toggle')?.textContent).toBe('月表示へ');
    expect(host.querySelector('.calendar-current-month')?.textContent).toBe('今年へ');
    click('.calendar-view-toggle'); await settle();
    expect(host.querySelector('.calendar-month')).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('8');
    expect(host.querySelector('.calendar-view-toggle')?.textContent).toBe('年表示へ');
    expect(host.querySelector('.calendar-current-month')?.textContent).toBe('今月へ');
    click('.calendar-view-toggle'); await settle(); selectValue('#calendar-month', '3'); await settle();
    expect(host.querySelector('.calendar-month')).not.toBeNull();
    expect(api.heatmap).toHaveBeenLastCalledWith(2026, 3, expect.any(AbortSignal));
  });

  it('navigates years with selects, arrows and This year within the oldest/current year bounds', async () => {
    await mount(); click('#home-calendar-tab'); await settle(); click('.calendar-view-toggle'); await settle();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Next year"]')?.disabled).toBe(true);
    selectValue('#calendar-year', '2002'); await settle();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Previous year"]')?.disabled).toBe(true);
    click('[aria-label="Next year"]'); await settle();
    expect(api.heatmap).toHaveBeenLastCalledWith(2003, null, expect.any(AbortSignal));
    click('[aria-label="Previous year"]'); await settle();
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')?.value).toBe('2002');
    click('.calendar-current-month'); await settle();
    expect(host.querySelector('.calendar-year')).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')?.value).toBe('2026');
    expect(api.heatmap).toHaveBeenLastCalledWith(2026, null, expect.any(AbortSignal));
  });

  it('opens annual dates and returns to Year view through both back and tab reactivation', async () => {
    await mount(); click('#home-calendar-tab'); await settle(); click('.calendar-view-toggle'); await settle();
    click('[aria-label^="2026-08-01,"]'); await settle();
    expect(api.day).toHaveBeenLastCalledWith('2026-08-01', expect.any(AbortSignal));
    expect(host.querySelectorAll('.photo-card')).toHaveLength(3);
    expect(host.querySelector('.recent-count-control')).toBeNull();
    click('.album-back'); await settle();
    expect(host.querySelector('.calendar-year')).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('8');
    click('[aria-label^="2026-12-01,"]'); await settle();
    click('#home-calendar-tab'); await settle();
    expect(host.querySelector('.calendar-year')).not.toBeNull();
    click('.calendar-view-toggle'); await settle();
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('12');
  });

  it('opens a month from the card title or blank card area while date buttons retain exclusive actions', async () => {
    await mount(); click('#home-calendar-tab'); await settle(); click('.calendar-view-toggle'); await settle();
    const card = host.querySelectorAll<HTMLElement>('.calendar-mini-month')[1]!;
    const title = card.querySelector<HTMLButtonElement>('.calendar-mini-month-title')!;
    act(() => title.click()); await settle();
    expect(host.querySelector('.calendar-year')).toBeNull();
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')?.value).toBe('2026');
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('2');
    expect(host.querySelector('.calendar-view-toggle')?.textContent).toBe('Year view');
    click('.calendar-view-toggle'); await settle();
    const august = host.querySelectorAll<HTMLElement>('.calendar-mini-month')[7]!;
    const heatmapCalls = api.heatmap.mock.calls.length;
    const emptyDay = august.querySelector<HTMLButtonElement>('.calendar-day[aria-label="2026-08-02"]')!;
    act(() => emptyDay.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(api.heatmap).toHaveBeenCalledTimes(heatmapCalls);
    expect(host.querySelector('.calendar-year')).not.toBeNull();
    const photoDay = august.querySelector<HTMLButtonElement>('[aria-label^="2026-08-01,"]')!;
    act(() => photoDay.click()); await settle();
    expect(api.day).toHaveBeenLastCalledWith('2026-08-01', expect.any(AbortSignal));
    expect(api.heatmap).toHaveBeenCalledTimes(heatmapCalls);
    expect(host.querySelector('.calendar-year')).toBeNull();
    expect(host.querySelector('.album-detail-heading h2')).not.toBeNull();
    click('.album-back'); await settle();
    const december = host.querySelectorAll<HTMLElement>('.calendar-mini-month')[11]!;
    act(() => december.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')?.value).toBe('2026');
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('12');
    expect(host.querySelector('.calendar-view-toggle')?.textContent).toBe('Year view');
    click('.calendar-view-toggle'); await settle();
    expect(host.querySelector('.calendar-year')).not.toBeNull();
  });

  it('ignores stale annual and month responses after year and mode changes', async () => {
    const oldYear = deferred<CalendarHeatmap>();
    const oldMonth = deferred<CalendarHeatmap>();
    await mount(); click('#home-calendar-tab'); await settle();
    api.heatmap.mockReturnValueOnce(oldYear.promise);
    click('.calendar-view-toggle'); await settle();
    const yearSignal = api.heatmap.mock.calls.at(-1)![2] as AbortSignal;
    selectValue('#calendar-year', '2025'); await settle();
    expect(yearSignal.aborted).toBe(true);
    await act(async () => oldYear.resolve(yearData(2026)));
    expect(host.querySelector('[aria-label^="2026-"]')).toBeNull();
    api.heatmap.mockReturnValueOnce(oldMonth.promise);
    click('.calendar-view-toggle'); await settle();
    const monthSignal = api.heatmap.mock.calls.at(-1)![2] as AbortSignal;
    click('.calendar-view-toggle'); await settle();
    expect(monthSignal.aborted).toBe(true);
    await act(async () => oldMonth.resolve(monthData(2025, 9)));
    expect(host.querySelector('.calendar-year')).not.toBeNull();
    expect(host.querySelectorAll('.calendar-day.has-assets')).toHaveLength(24);
  });

  it('only returns to the same month when reactivating Calendar, preserving ordinary tab switches', async () => {
    await mount(); click('.photo-selection-input');
    click('#home-calendar-tab'); await settle();
    selectValue('#calendar-year', '2024'); selectValue('#calendar-month', '8'); await settle();
    const requestCount = api.heatmap.mock.calls.length;
    click('#home-calendar-tab'); await settle();
    expect(api.heatmap).toHaveBeenCalledTimes(requestCount);
    click('.calendar-day.has-assets'); await settle(); click('.photo-selection-input');
    click('#home-albums-tab'); await settle(); click('#home-calendar-tab'); await settle();
    expect(api.day).toHaveBeenLastCalledWith('2024-08-01', expect.any(AbortSignal));
    expect(host.querySelector('.photo-card.selected')).not.toBeNull();
    expect(host.querySelector('.calendar-month')).toBeNull();
    click('#home-calendar-tab'); await settle();
    expect(host.querySelector('#home-calendar-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')?.value).toBe('2024');
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('8');
    expect(host.querySelector('.selection-bar')).toBeNull();
    click('#home-recent-tab');
    expect(host.querySelector('.photo-card.selected .photo-info p')?.textContent).toBe('recent.jpg');
    click('#home-calendar-tab'); await settle();
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('8');
  });

  it('shares the selected thumbnail density across sparse Recent, Album, and Calendar photo grids', async () => {
    api.albums.mockResolvedValue([{ id: 'album-1', albumName: 'Album', albumThumbnailAssetId: null,
      assetCount: 2, startDate: null, endDate: null }]);
    api.day.mockResolvedValue(dayPhotos.slice(0, 1));
    function setSize(rank: string) {
      const slider = host.querySelector<HTMLInputElement>('.thumbnail-size-control input')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, rank);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    const gridWidth = () => host.querySelector<HTMLElement>('.photo-grid')?.style.getPropertyValue('--photo-column-width');
    await mount();
    expect(host.querySelectorAll('.photo-card')).toHaveLength(1);
    setSize('0');
    expect(gridWidth()).toBe('calc(10% - 14.4px)');
    click('#home-albums-tab'); await settle();
    expect(host.querySelector<HTMLElement>('.album-grid')?.style.getPropertyValue('--album-column-width')).toBe('calc(10% - 14.4px)');
    click('.album-card'); await settle();
    expect(host.querySelectorAll('.photo-card')).toHaveLength(2);
    expect(gridWidth()).toBe('calc(10% - 14.4px)');
    click('#home-calendar-tab'); await settle(); click('.calendar-day.has-assets'); await settle();
    expect(host.querySelectorAll('.photo-card')).toHaveLength(1);
    expect(gridWidth()).toBe('calc(10% - 14.4px)');
    setSize('6');
    expect(gridWidth()).toBe('calc(25% - 12px)');
    expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('4');
    click('#home-recent-tab'); expect(gridWidth()).toBe('calc(25% - 12px)');
    click('#home-albums-tab'); expect(gridWidth()).toBe('calc(25% - 12px)');
  });
  it('opens on the current month with localized weekdays, and supports year, month, and boundary navigation', async () => {
    await mount();
    expect(host.querySelector('#home-recent-tab')?.getAttribute('aria-selected')).toBe('true');
    click('#home-calendar-tab'); await settle();
    expect(host.querySelector('#home-calendar-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')?.value).toBe('2026');
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe(String(new Date().getMonth() + 1));
    expect(host.querySelector('.calendar-current-month')?.textContent).toBe('This month');
    expect(host.querySelectorAll('.calendar-weekday')[0]?.textContent).toBe('Sun');
    const years = [...host.querySelectorAll<HTMLOptionElement>('#calendar-year option')].map(option => Number(option.value));
    expect(years[0]).toBe(2002);
    expect(years.at(-1)).toBe(2026);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    expect(years).not.toContain(1900);
    expect(years).not.toContain(2027);
    expect(api.minYear).toHaveBeenCalledTimes(1);
    selectValue('#calendar-year', '2025'); selectValue('#calendar-month', '12'); await settle();
    click('[aria-label="Next month"]'); await settle();
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')?.value).toBe('2026');
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('1');
    click('[aria-label="Previous month"]'); await settle();
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('12');
    selectValue('#calendar-year', '2026'); selectValue('#calendar-month', '12'); await settle();
    expect(host.querySelector<HTMLButtonElement>('.calendar-arrow:last-child')?.disabled).toBe(true);
    selectValue('#calendar-month', '1'); await settle();
    click('[aria-label="Previous month"]'); await settle();
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')?.value).toBe('2025');
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('12');
    expect(api.heatmap).toHaveBeenCalledWith(2025, 12, expect.any(AbortSignal));
    click('#home-recent-tab'); click('#home-calendar-tab'); await settle();
    expect(api.minYear).toHaveBeenCalledTimes(1);
    act(() => updateSetting('weekStart', 'monday'));
    expect(host.querySelectorAll('.calendar-weekday')[0]?.textContent).toBe('Mon');
    expect(host.querySelectorAll('.calendar-blank')).toHaveLength(0);
    await act(async () => { await i18n.changeLanguage('ja'); });
    expect(host.querySelector('#home-calendar-tab')?.textContent).toBe('カレンダー');
    expect(host.querySelector('.calendar-current-month')?.textContent).toBe('今月へ');
    expect(host.querySelectorAll('.calendar-weekday')[0]?.textContent).toBe('月');
  });

  it('returns from another month to the current month and leaves an already-current month unchanged', async () => {
    await mount(); click('#home-calendar-tab'); await settle();
    selectValue('#calendar-year', '2024'); selectValue('#calendar-month', '4'); await settle();
    click('.calendar-current-month'); await settle();
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')?.value).toBe('2026');
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('9');
    expect(api.heatmap).toHaveBeenLastCalledWith(2026, 9, expect.any(AbortSignal));
    const requestCount = api.heatmap.mock.calls.length;
    click('.calendar-current-month'); await settle();
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')?.value).toBe('2026');
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('9');
    expect(api.heatmap).toHaveBeenCalledTimes(requestCount);
  });

  it('keeps an in-flight current-month request valid when This month is pressed', async () => {
    const pending = deferred<CalendarHeatmap>();
    api.heatmap.mockReset().mockReturnValueOnce(pending.promise);
    await mount(); click('#home-calendar-tab'); await settle();
    click('.calendar-current-month');
    await act(async () => pending.resolve(monthData(2026, 9)));
    expect(host.querySelector('.calendar-day.has-assets')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['empty', 'error'] as const)('falls back to only the current year when oldest-image metadata is %s', async result => {
    if (result === 'empty') api.minYear.mockResolvedValueOnce(null);
    else api.minYear.mockRejectedValueOnce(new Error('Unavailable'));
    await mount(); click('#home-calendar-tab'); await settle();
    const years = [...host.querySelectorAll<HTMLOptionElement>('#calendar-year option')].map(option => Number(option.value));
    expect(years).toEqual([2026]);
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')?.value).toBe('2026');
    expect(host.querySelector('.calendar-month')).not.toBeNull();
  });

  it('only opens days with data, reuses photo controls and selection, and preserves the month on return', async () => {
    await mount();
    click('.photo-selection-input');
    click('#home-calendar-tab'); await settle();
    selectValue('#calendar-year', '2026'); selectValue('#calendar-month', '9'); await settle();
    const days = [...host.querySelectorAll<HTMLButtonElement>('.calendar-day')];
    expect(days[0].disabled).toBe(false);
    expect(days[0].querySelector('.calendar-day-number')?.textContent).toBe('1');
    expect(host.querySelector('.calendar-day-count')).toBeNull();
    expect(days[0].querySelector('img')?.getAttribute('src')).toBe('/api/assets/2026-9-cover/thumbnail');
    expect(days[0].querySelector('img')?.getAttribute('loading')).toBe('lazy');
    expect(days[2].querySelector('img')).toBeNull();
    expect(days[2].disabled).toBe(false);
    expect(days[1].disabled).toBe(true);
    expect(days[1].querySelector('.calendar-day-count')).toBeNull();
    expect(days[1].className).not.toContain('has-assets');
    act(() => days[1].click());
    expect(api.day).not.toHaveBeenCalled();
    act(() => days[0].querySelector('img')!.click()); await settle();
    expect(host.querySelector('#home-calendar-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(api.day).toHaveBeenCalledWith('2026-09-01', expect.any(AbortSignal));
    expect(host.querySelector('.calendar-current-month')).toBeNull();
    expect(host.querySelector('.recent-count-control')).toBeNull();
    expect(host.querySelector('.photo-filter-control')).not.toBeNull();
    expect(host.querySelector('.thumbnail-size-setting')).not.toBeNull();
    expect(host.querySelectorAll('.photo-card')).toHaveLength(3);
    expect(host.querySelectorAll('.format-badge.raw')).toHaveLength(2);
    await settle();
    expect(host.querySelectorAll('.edited-badge')).toHaveLength(1);
    selectValue('.photo-filter-control select', 'raw');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(2);
    expect(sessionStorage.getItem(PHOTO_FILTER_SESSION_KEYS.calendar)).toBe('raw');
    selectValue('.photo-filter-control select', 'both');
    const boxes = [...host.querySelectorAll<HTMLInputElement>('.photo-selection-input')];
    act(() => boxes[0].click());
    act(() => boxes[2].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })));
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(3);
    click('.selection-bar button:last-child');
    expect(host.querySelector('.navigation-probe')?.textContent).toBe('day-0|day-1|day-2');
  });

  it('opens a day without a representative JPEG through the usual date cell', async () => {
    await mount(); click('#home-calendar-tab'); await settle();
    const cell = host.querySelector<HTMLButtonElement>('.calendar-day.has-assets[aria-label^="2026-09-03"]')!;
    expect(cell.querySelector('img')).toBeNull();
    expect(cell.disabled).toBe(false);
    act(() => cell.click()); await settle();
    expect(api.day).toHaveBeenCalledWith('2026-09-03', expect.any(AbortSignal));
    expect(host.querySelectorAll('.photo-card')).toHaveLength(3);
  });

  it('keeps Calendar filters independent from Recent and shared across date details', async () => {
    await mount();
    selectValue('.photo-filter-control select', 'raw');
    click('#home-calendar-tab'); await settle();
    click('.calendar-day.has-assets'); await settle();
    expect(host.querySelector<HTMLSelectElement>('.photo-filter-control select')?.value).toBe('both');
    selectValue('.photo-filter-control select', 'nonRaw');
    click('.album-back'); await settle();
    click('.calendar-day.has-assets'); await settle();
    expect(host.querySelector<HTMLSelectElement>('.photo-filter-control select')?.value).toBe('nonRaw');
    expect(sessionStorage.getItem(PHOTO_FILTER_SESSION_KEYS.recent)).toBe('raw');
    expect(sessionStorage.getItem(PHOTO_FILTER_SESSION_KEYS.calendar)).toBe('nonRaw');
    click('#home-recent-tab');
    expect(host.querySelector<HTMLSelectElement>('.photo-filter-control select')?.value).toBe('raw');
    click('#home-calendar-tab'); await settle();
    expect(host.querySelector<HTMLSelectElement>('.photo-filter-control select')?.value).toBe('nonRaw');
  });

  it('keeps Recent selection separate and restores the selected month when returning from a day', async () => {
    await mount(); click('.photo-selection-input'); click('#home-calendar-tab'); await settle();
    selectValue('#calendar-year', '2026'); selectValue('#calendar-month', '9'); await settle();
    click('.calendar-day.has-assets'); await settle();
    expect(host.querySelector('.photo-card.selected')).toBeNull();
    click('.photo-selection-input');
    click('.album-back'); await settle();
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')?.value).toBe('2026');
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('9');
    click('#home-recent-tab');
    expect(host.querySelector('.photo-card.selected .photo-info p')?.textContent).toBe('recent.jpg');
    click('#home-calendar-tab'); await settle();
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('9');
  });

  it('ignores an old month response after rapid navigation', async () => {
    const old = deferred<CalendarHeatmap>();
    api.heatmap.mockImplementationOnce(() => old.promise)
      .mockImplementation(async (year: number, month: number) => monthData(year, month));
    await mount(); click('#home-calendar-tab'); await settle();
    const firstSignal = api.heatmap.mock.calls[0][2] as AbortSignal;
    click('[aria-label="Next month"]'); await settle();
    expect(firstSignal.aborted).toBe(true);
    const year = Number(host.querySelector<HTMLSelectElement>('#calendar-year')?.value);
    const month = Number(host.querySelector<HTMLSelectElement>('#calendar-month')?.value);
    await act(async () => old.resolve(monthData(year, month === 1 ? 12 : month - 1)));
    expect(host.querySelector('.calendar-day.has-assets')).not.toBeNull();
    expect(host.querySelector('.calendar-day-thumbnail')?.getAttribute('src')).toBe(`/api/assets/${year}-${month}-cover/thumbnail`);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows a calendar error and opens a single day photo through the usual card action', async () => {
    api.heatmap.mockRejectedValueOnce(new Error('Denied'))
      .mockImplementation(async (year: number, month: number) => monthData(year, month));
    await mount(); click('#home-calendar-tab'); await settle();
    expect(host.querySelector('.home-tab-panel [role="alert"]')?.textContent).toContain('Calendar could not be loaded');
    click('[aria-label="Next month"]'); await settle();
    click('.calendar-day.has-assets'); await settle();
    click('.photo-card-button');
    expect(host.querySelector('.navigation-probe')?.textContent).toBe('day-0');
  });

  it('shows day loading, error, and empty states without mixing old results', async () => {
    const pending = deferred<RecentAsset[]>();
    api.day.mockReset().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('Failed')).mockResolvedValueOnce([]);
    await mount(); click('#home-calendar-tab'); await settle();
    click('.calendar-day.has-assets');
    expect(host.querySelector('.home-tab-panel [role="status"]')?.textContent).toContain('Loading photos');
    click('#home-calendar-tab');
    expect((api.day.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    await settle();
    click('.calendar-day.has-assets'); await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded');
    click('.album-back'); await settle(); click('.calendar-day.has-assets'); await settle();
    expect(host.querySelector('.gallery-message')?.textContent).toBe('No photos on this day');
    await act(async () => pending.resolve(dayPhotos));
    expect(host.querySelector('.photo-card')).toBeNull();
  });
});
