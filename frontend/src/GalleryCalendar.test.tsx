// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';
import { HOME_THUMBNAIL_COLUMNS_KEY, updateSetting } from './appSettings';
import type { RecentAsset } from './assets';
import type { CalendarHeatmap } from './HomeCalendar';
import { PHOTO_FILTER_SESSION_KEY, writePhotoFilterMode } from './photoFilters';
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
    count: day === 1 ? 1558 : day === 3 ? 2 : 0,
  })) };
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
  sessionStorage.clear(); writePhotoFilterMode('both');
  updateSetting('weekStart', 'sunday'); updateSetting('dateLocale', 'en-US');
  updateSetting('recentPhotoCount', 100); updateSetting('homeThumbnailColumns', 6);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.recent.mockReset().mockResolvedValue(recent);
  api.albums.mockReset().mockResolvedValue([]);
  api.minYear.mockReset().mockResolvedValue(2002);
  api.albumAssets.mockReset().mockResolvedValue(dayPhotos.slice(0, 2));
  api.heatmap.mockReset().mockImplementation(async (year: number, month: number) => monthData(year, month));
  api.day.mockReset().mockResolvedValue(dayPhotos);
  api.statuses.mockReset().mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, id === 'day-0'])));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); sessionStorage.clear(); writePhotoFilterMode('both');
  updateSetting('weekStart', 'auto'); updateSetting('dateLocale', 'auto');
  updateSetting('recentPhotoCount', 100); updateSetting('homeThumbnailColumns', 6); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('Home calendar', () => {
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
    expect(host.querySelector('.calendar-current-month')?.textContent).toBe('今月');
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
    expect(days[0].querySelector('.calendar-day-count')?.textContent).toBe('1558');
    expect(days[2].querySelector('.calendar-day-count')?.textContent).toBe('2');
    expect(days[1].disabled).toBe(true);
    expect(days[1].querySelector('.calendar-day-count')).toBeNull();
    expect(days[1].className).not.toContain('has-assets');
    act(() => days[1].click());
    expect(api.day).not.toHaveBeenCalled();
    act(() => days[0].click()); await settle();
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
    expect(sessionStorage.getItem(PHOTO_FILTER_SESSION_KEY)).toBe('raw');
    selectValue('.photo-filter-control select', 'both');
    const boxes = [...host.querySelectorAll<HTMLInputElement>('.photo-selection-input')];
    act(() => boxes[0].click());
    act(() => boxes[2].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })));
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(3);
    click('.selection-bar button:last-child');
    expect(host.querySelector('.navigation-probe')?.textContent).toBe('day-0|day-1|day-2');
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
    click('.album-back');
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
