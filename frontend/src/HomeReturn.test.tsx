// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import i18n from './i18n';
import { homeScrollContent, readHomeReturn, type HomeReturnContext } from './homeReturn';
import { activateWorkspaceAsset } from './photoSelection';
import type { AssetDetail } from './assets';
import { writePhotoFilterMode } from './photoFilters';
import { EditStateApiError } from './editStateApi';

const api = vi.hoisted(() => ({ recent: vi.fn(), favorites: vi.fn(), albums: vi.fn(), albumAssets: vi.fn(),
  heatmap: vi.fn(), minYear: vi.fn(), day: vi.fn(), detail: vi.fn(), get: vi.fn(), put: vi.fn(), statuses: vi.fn() }));
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()),
  fetchRecentAssets: api.recent, fetchAlbums: api.albums, fetchAlbumAssets: api.albumAssets,
  fetchFavoriteAssets: api.favorites,
  fetchCalendarHeatmap: api.heatmap, fetchCalendarMinYear: api.minYear,
  fetchCalendarDayAssets: api.day, fetchAssetDetail: api.detail }));
vi.mock('./editStateApi', async original => ({ ...(await original<typeof import('./editStateApi')>()),
  getAssetEditState: api.get, putAssetEditState: api.put, getAssetEditStatuses: api.statuses }));
vi.mock('./ImageViewer', () => ({ ImageViewer: () => <div className="viewer-panel" /> }));

const photo: AssetDetail = { id: '12345678-1234-4234-9234-123456789abc', filename: 'photo.jpg',
  date: '2026-09-01', thumbnail_url: '/thumb', preview_url: '/preview', format: 'JPEG', is_raw: false, exif: {} };
const second = { ...photo, id: '87654321-4321-4321-8321-cba987654321', filename: 'second.jpg' };
const album = { id: 'album-1', albumName: '車両整備関係', albumThumbnailAssetId: null,
  assetCount: 2, startDate: null, endDate: null };
const context: HomeReturnContext = { tab: 'recent', album: null, year: 2026, month: 9, date: null,
  pageScrollTop: 32, contentScrollTop: 840 };
let host: HTMLDivElement;
let root: Root;
async function settle() { await act(async () => { await Promise.resolve(); }); }
async function click(selector: string) {
  const element = host.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  await act(async () => element.click());
}
async function mount(state?: unknown) {
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: '/', state }]}><App /></MemoryRouter>));
}
function change(selector: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(selector)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function openCalendarDay() {
  await click('#home-calendar-tab');
  change('#calendar-year', '2026'); change('#calendar-month', '9'); await settle();
  await click('.calendar-day.has-assets');
}
function setScroll(page: number, content: number) {
  const element = host.querySelector<HTMLElement>('.home-page')!;
  element.scrollTop = page;
  homeScrollContent(element)!.scrollTop = content;
}
function expectScroll(page: number, content: number) {
  const element = host.querySelector<HTMLElement>('.home-page')!;
  expect(element.scrollTop).toBe(page);
  expect(homeScrollContent(element)!.scrollTop).toBe(content);
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en');
  writePhotoFilterMode('both', 'recent'); writePhotoFilterMode('both', 'albums'); writePhotoFilterMode('both', 'calendar');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.recent.mockReset().mockResolvedValue([photo]);
  api.favorites.mockReset().mockResolvedValue([photo, second]);
  api.albums.mockReset().mockResolvedValue([album]);
  api.minYear.mockReset().mockResolvedValue(2002);
  api.albumAssets.mockReset().mockResolvedValue([photo, second]);
  api.heatmap.mockReset().mockImplementation(async (year: number, month: number) => ({ year, month,
    days: [{ date: `${year}-${String(month).padStart(2, '0')}-01`, hasAssets: true, count: 1 }] }));
  api.day.mockReset().mockResolvedValue([photo]);
  api.heatmap.mockReset().mockImplementation(async (year: number, month: number) => ({ year, month,
    days: [{ date: `${year}-${String(month).padStart(2, '0')}-01`, hasAssets: true, count: 1 }] }));
  api.detail.mockReset().mockImplementation(async (id: string) => id === photo.id ? photo : second);
  api.get.mockReset().mockResolvedValue({ state: null });
  api.put.mockReset().mockImplementation(async (_id, state, revision, saveId) => ({
    state, revision: revision + 1, updatedAt: '2026-09-01T00:00:00Z', lastSaveId: saveId }));
  api.statuses.mockReset().mockResolvedValue({});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
});
afterEach(() => { act(() => root.unmount()); host.remove();
  writePhotoFilterMode('both', 'recent'); writePhotoFilterMode('both', 'albums'); writePhotoFilterMode('both', 'calendar');
  vi.unstubAllGlobals(); });

describe('Home return context', () => {
  it('returns from the darkroom to Favorites and restores its scroll after the list arrives', async () => {
    await mount(); await click('#home-favorites-tab'); setScroll(22, 622);
    await click('.photo-card-button'); await click('.workspace-actions button');
    expect(host.querySelector('#home-favorites-tab')?.getAttribute('aria-selected')).toBe('true');
    expectScroll(22, 622);
    expect(readHomeReturn({ ...context, tab: 'favorites' })?.tab).toBe('favorites');
  });
  it('keeps Year view scroll separate from months and other years across tabs and date details', async () => {
    api.heatmap.mockImplementation(async (year: number, month: number | null) => ({ year, month,
      days: [{ date: `${year}-${String(month ?? 8).padStart(2, '0')}-01`, hasAssets: true, count: 1 }] }));
    await mount(); await click('#home-calendar-tab'); change('#calendar-year', '2026'); change('#calendar-month', '8'); await settle();
    setScroll(8, 180);
    await click('.calendar-view-toggle'); setScroll(26, 626);
    await click('#home-albums-tab'); await click('#home-calendar-tab'); expectScroll(26, 626);
    await click('.calendar-view-toggle'); expectScroll(8, 180);
    await click('.calendar-view-toggle'); expectScroll(26, 626);
    change('#calendar-year', '2025'); await settle(); expectScroll(0, 0); setScroll(25, 525);
    change('#calendar-year', '2026'); await settle(); expectScroll(26, 626);
    await click('.calendar-day.has-assets'); setScroll(15, 415);
    await click('#home-calendar-tab'); expectScroll(26, 626);
    expect(host.querySelector('.calendar-year')).not.toBeNull();
    await click('.calendar-day.has-assets'); expectScroll(15, 415);
    await click('.album-back'); expectScroll(26, 626);
    change('#calendar-year', '2025'); await settle(); expectScroll(25, 525);
  });

  it('restores the annual parent mode after the darkroom and prioritizes the day scroll from navigation state', async () => {
    api.heatmap.mockImplementation(async (year: number, month: number | null) => ({ year, month,
      days: [{ date: `${year}-${String(month ?? 8).padStart(2, '0')}-01`, hasAssets: true, count: 1 }] }));
    await mount(); await click('#home-calendar-tab'); change('#calendar-year', '2026'); await settle();
    await click('.calendar-view-toggle'); await click('.calendar-day.has-assets'); setScroll(31, 931);
    await click('.photo-card-button'); await click('.workspace-actions button'); expectScroll(31, 931);
    await click('#home-albums-tab'); await click('#home-calendar-tab'); expectScroll(31, 931);
    await click('#home-calendar-tab');
    expect(host.querySelector('.calendar-year')).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')?.value).toBe('8');
    expect(readHomeReturn(context)?.calendarMode).toBe('month');
    expect(readHomeReturn({ ...context, calendarMode: 'invalid' })?.calendarMode).toBe('month');
  });

  it('keeps Recent and Album-list offsets separate across mouse and keyboard tab navigation', async () => {
    await mount(); setScroll(12, 480);
    await click('#home-albums-tab'); expectScroll(0, 0); setScroll(24, 260);
    await click('#home-recent-tab'); expectScroll(12, 480);
    await click('#home-recent-tab'); expectScroll(12, 480);
    await act(async () => host.querySelector('#home-recent-tab')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expectScroll(24, 260);
    expect(api.recent).toHaveBeenCalledTimes(1);
    expect(api.albums).toHaveBeenCalledTimes(1);
  });

  it('remembers each album and the list when returning with either the back button or active tab', async () => {
    const otherAlbum = { ...album, id: 'album-2', albumName: 'Other album' };
    api.albums.mockResolvedValue([album, otherAlbum]);
    await mount(); await click('#home-albums-tab'); setScroll(10, 210);
    await click('.album-card'); expectScroll(0, 0); setScroll(20, 520);
    await click('#home-calendar-tab'); await click('#home-albums-tab'); expectScroll(20, 520);
    await click('#home-albums-tab'); expectScroll(10, 210);
    await click('.album-card:last-child'); expectScroll(0, 0); setScroll(30, 730);
    await click('.album-back'); expectScroll(10, 210);
    await click('.album-card'); expectScroll(20, 520);
    await click('.album-back'); await click('.album-card:last-child'); expectScroll(30, 730);
    await click('#home-albums-tab'); await click('#home-recent-tab'); await click('#home-albums-tab');
    expect(host.querySelector('.album-detail-heading')).toBeNull();
    expectScroll(10, 210);
    expect(api.albums).toHaveBeenCalledTimes(1);
  });

  it('remembers each Calendar month and date when returning through tabs and the parent view', async () => {
    api.heatmap.mockImplementation(async (year: number, month: number) => ({ year, month,
      days: [1, 15].map(day => ({ date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        hasAssets: true, count: 1 })) }));
    await mount(); await click('#home-calendar-tab');
    change('#calendar-year', '2026'); change('#calendar-month', '8'); await settle(); setScroll(10, 110);
    await click('.calendar-day.has-assets'); expectScroll(0, 0); setScroll(20, 420);
    await click('#home-albums-tab'); await click('#home-calendar-tab'); expectScroll(20, 420);
    await click('#home-calendar-tab'); expectScroll(10, 110);
    await click('.calendar-day[aria-label*="2026-08-15"]'); expectScroll(0, 0); setScroll(30, 630);
    await click('.album-back'); expectScroll(10, 110);
    change('#calendar-month', '9'); await settle(); expectScroll(0, 0); setScroll(40, 140);
    await click('.calendar-day.has-assets'); expectScroll(0, 0); setScroll(50, 850);
    await click('.album-back'); expectScroll(40, 140);
    change('#calendar-month', '8'); await settle(); expectScroll(10, 110);
    await click('.calendar-day.has-assets'); expectScroll(20, 420);
    await click('.album-back'); await click('.calendar-day[aria-label*="2026-08-15"]'); expectScroll(30, 630);
    await click('#home-calendar-tab'); await click('#home-recent-tab'); await click('#home-calendar-tab');
    expect(host.querySelector('.album-detail-heading')).toBeNull(); expectScroll(10, 110);
    change('#calendar-year', '2025'); await settle(); expectScroll(0, 0); setScroll(60, 160);
    change('#calendar-year', '2026'); await settle(); expectScroll(10, 110);
  });

  it.each(['albums', 'calendar'] as const)('waits for %s detail data and cancels stale restoration without losing its offset', async tab => {
    await mount(); setScroll(10, 110);
    if (tab === 'albums') { await click('#home-albums-tab'); await click('.album-card'); }
    else await openCalendarDay();
    setScroll(20, 520);
    await click('#home-recent-tab');
    let resolve!: (assets: AssetDetail[]) => void;
    const request = tab === 'albums' ? api.albumAssets : api.day;
    request.mockReturnValueOnce(new Promise<AssetDetail[]>(yes => { resolve = yes; }));
    await click(`#home-${tab}-tab`);
    // The retained grid must not receive the saved offset before its refetch completes.
    expect(host.querySelector<HTMLElement>('.photo-grid')!.scrollTop).toBe(0);
    const signal = request.mock.calls.at(-1)![1] as AbortSignal;
    await click(tab === 'albums' ? '#home-calendar-tab' : '#home-albums-tab');
    expect(signal.aborted).toBe(true); setScroll(30, 130);
    await act(async () => resolve([photo, second])); expectScroll(30, 130);
    await click(`#home-${tab}-tab`); expectScroll(20, 520);
    await click('#home-recent-tab'); expectScroll(10, 110);
  });

  it('waits for new-month heatmap data before applying that month offset', async () => {
    await mount(); await click('#home-calendar-tab');
    change('#calendar-year', '2026'); change('#calendar-month', '8'); await settle(); setScroll(8, 180);
    change('#calendar-month', '9'); await settle(); setScroll(9, 190);
    let resolve!: (value: { year: number; month: number; days: [] }) => void;
    api.heatmap.mockReturnValueOnce(new Promise<{ year: number; month: number; days: [] }>(yes => { resolve = yes; }));
    change('#calendar-month', '8'); await settle();
    expect(host.querySelector<HTMLElement>('.calendar-month')!.scrollTop).toBe(190);
    await act(async () => resolve({ year: 2026, month: 8, days: [] })); expectScroll(8, 180);
  });

  it.each(['albums', 'calendar'] as const)('restores %s detail after tab switches and darkroom exit, then allows reactivation to go up', async tab => {
    await mount();
    if (tab === 'albums') { await click('#home-albums-tab'); await click('.album-card'); }
    else await openCalendarDay();
    await click('#home-recent-tab'); await click(`#home-${tab}-tab`);
    await click('.photo-card-button'); await click('.workspace-actions button');
    expect(host.querySelector(`#home-${tab}-tab`)?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('.album-detail-heading h2')).not.toBeNull();
    if (tab === 'albums') expect(api.albumAssets).toHaveBeenLastCalledWith(album.id, expect.any(AbortSignal));
    else expect(api.day).toHaveBeenLastCalledWith('2026-09-01', expect.any(AbortSignal));
    await click(`#home-${tab}-tab`);
    expect(host.querySelector('.album-detail-heading')).toBeNull();
    if (tab === 'albums') expect(host.querySelector('.album-card')).not.toBeNull();
    else {
      expect(host.querySelector<HTMLSelectElement>('#calendar-year')!.value).toBe('2026');
      expect(host.querySelector<HTMLSelectElement>('#calendar-month')!.value).toBe('9');
    }
  });

  it.each(['albums', 'calendar'] as const)('cancels pending %s detail scroll restoration when its active tab is reactivated', async tab => {
    let resolve!: (assets: AssetDetail[]) => void;
    const pending = new Promise<AssetDetail[]>(yes => { resolve = yes; });
    (tab === 'albums' ? api.albumAssets : api.day).mockReturnValueOnce(pending);
    await mount({ homeReturn: { ...context, tab, album: tab === 'albums' ? album : null,
      date: tab === 'calendar' ? '2026-09-01' : null } });
    const request = (tab === 'albums' ? api.albumAssets : api.day).mock.calls[0];
    await click(`#home-${tab}-tab`);
    expect((request[1] as AbortSignal).aborted).toBe(true);
    await act(async () => resolve([photo]));
    expect(host.querySelector('.photo-grid')).toBeNull();
    expect(host.querySelector<HTMLElement>('.home-page')!.scrollTop).toBe(0);
    expect(host.querySelector('.album-detail-heading')).toBeNull();
  });

  it('starts normally in Recent and returns to Recent after a successful save', async () => {
    await mount();
    expect(host.querySelector('#home-recent-tab')?.getAttribute('aria-selected')).toBe('true');
    await click('.photo-card-button');
    await click('button[aria-label="Disable Basic"]');
    await click('.workspace-actions button');
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(host.querySelector('#home-recent-tab')?.getAttribute('aria-selected')).toBe('true');
  });

  it('returns to the same album after multi-photo navigation and restores scroll only after assets render', async () => {
    await mount(); await click('#home-albums-tab'); await click('.album-card');
    host.querySelector<HTMLElement>('.home-page')!.scrollTop = 32;
    host.querySelector<HTMLElement>('.photo-grid')!.scrollTop = 840;
    for (const box of host.querySelectorAll<HTMLInputElement>('.photo-selection-input')) await act(async () => box.click());
    await click('.selection-bar button:last-child');
    await click('.filmstrip-item:last-child');
    expect(host.querySelector('.filmstrip-item[aria-current="true"]')?.getAttribute('aria-label')).toBe(second.filename);
    let resolve!: (assets: AssetDetail[]) => void;
    api.albumAssets.mockReturnValueOnce(new Promise<AssetDetail[]>(yes => { resolve = yes; }));
    await click('.workspace-title-link');
    expect(host.querySelector('#home-albums-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('.album-detail-heading h2')?.textContent).toBe(album.albumName);
    expect(host.querySelector('.photo-grid')).toBeNull();
    expect(host.querySelector<HTMLElement>('.home-page')!.scrollTop).toBe(0);
    await act(async () => resolve([photo, second]));
    expect(host.querySelector<HTMLElement>('.home-page')!.scrollTop).toBe(32);
    expect(host.querySelector<HTMLElement>('.photo-grid')!.scrollTop).toBe(840);
    expect(api.albumAssets).toHaveBeenLastCalledWith(album.id, expect.any(AbortSignal));
    await click('#home-recent-tab'); await click('#home-albums-tab'); expectScroll(32, 840);
    await click('.album-back'); expect(host.querySelector('.album-card')).not.toBeNull();
    await click('#home-recent-tab'); expect(host.querySelector('.photo-card.selected')).toBeNull();
  });

  it('returns to the same Calendar day, keeps its month, and leaves other modes separate', async () => {
    await mount(); await openCalendarDay();
    host.querySelector<HTMLElement>('.photo-grid')!.scrollTop = 520;
    await click('.photo-card-button'); await click('.workspace-actions button');
    expect(host.querySelector('#home-calendar-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(api.day).toHaveBeenLastCalledWith('2026-09-01', expect.any(AbortSignal));
    expect(host.querySelector<HTMLElement>('.photo-grid')!.scrollTop).toBe(520);
    expect(host.querySelector('.recent-count-control')).toBeNull();
    await click('#home-albums-tab'); await click('#home-calendar-tab'); expectScroll(0, 520);
    await click('.album-back');
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')!.value).toBe('2026');
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')!.value).toBe('9');
    await click('#home-albums-tab'); expect(host.querySelector('.album-detail-heading')).toBeNull();
    await click('#home-recent-tab'); expect(host.querySelector('.recent-count-control')).not.toBeNull();
  });

  it('retains the Calendar month context while returning to Recent', async () => {
    await mount(); await click('#home-calendar-tab');
    change('#calendar-year', '2024'); change('#calendar-month', '2'); await settle();
    await click('#home-recent-tab'); await click('.photo-card-button'); await click('.workspace-actions button');
    expect(host.querySelector('#home-recent-tab')?.getAttribute('aria-selected')).toBe('true');
    await click('#home-calendar-tab');
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')!.value).toBe('2024');
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')!.value).toBe('2');
  });

  it('keeps the month selected by This month when returning from the darkroom', async () => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    await mount(); await click('#home-calendar-tab'); await settle();
    change('#calendar-year', String(currentYear - 1)); change('#calendar-month', '2'); await settle();
    await click('.calendar-current-month'); await settle();
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')!.value).toBe(String(currentYear));
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')!.value).toBe(String(currentMonth));
    await click('.calendar-day.has-assets'); await settle();
    await click('.photo-card-button'); await click('.workspace-actions button');
    expect(host.querySelector('#home-calendar-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('.album-detail-heading h2')).not.toBeNull();
    await click('.album-back');
    expect(host.querySelector<HTMLSelectElement>('#calendar-year')!.value).toBe(String(currentYear));
    expect(host.querySelector<HTMLSelectElement>('#calendar-month')!.value).toBe(String(currentMonth));
  });

  it('keeps a failed exit in the darkroom and restores the album when exiting without saving', async () => {
    await mount(); await click('#home-albums-tab'); await click('.album-card'); await click('.photo-card-button');
    await click('button[aria-label="Disable Basic"]');
    api.put.mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await click('.workspace-actions button');
    expect(host.querySelector('.workspace-page')).not.toBeNull();
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    await click('[role="alertdialog"] button:last-child');
    expect(host.querySelector('#home-albums-tab')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('.album-detail-heading h2')?.textContent).toBe(album.albumName);
    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it.each(['albums', 'calendar'] as const)('can restore the %s overview via an explicit return context', async tab => {
    await mount({ homeReturn: { ...context, tab } });
    expect(host.querySelector(`#home-${tab}-tab`)?.getAttribute('aria-selected')).toBe('true');
    if (tab === 'calendar') {
      expect(host.querySelector<HTMLSelectElement>('#calendar-year')!.value).toBe('2026');
      expect(host.querySelector<HTMLSelectElement>('#calendar-month')!.value).toBe('9');
    } else expect(host.querySelector('.album-card')).not.toBeNull();
  });

  it('does not apply a pending Calendar offset after the user switches to Recent', async () => {
    let resolve!: (assets: AssetDetail[]) => void;
    api.day.mockReturnValueOnce(new Promise<AssetDetail[]>(yes => { resolve = yes; }));
    await mount({ homeReturn: { ...context, tab: 'calendar', date: '2026-09-01' } });
    await click('#home-recent-tab'); await act(async () => resolve([photo]));
    expect(host.querySelector<HTMLElement>('.photo-grid')!.scrollTop).toBe(0);
    expect(host.querySelector('#home-recent-tab')?.getAttribute('aria-selected')).toBe('true');
  });

  it('falls back safely for unknown modes, missing albums, and invalid dates', async () => {
    expect(readHomeReturn({ ...context, tab: 'unknown' })).toBeNull();
    expect(readHomeReturn({ ...context, tab: 'albums', album: { id: '' } })?.album).toBeNull();
    expect(readHomeReturn({ ...context, tab: 'calendar', date: '2026-09-31' })?.date).toBeNull();
    expect(readHomeReturn({ ...context, date: '2026-08-01' })?.date).toBeNull();
    expect(readHomeReturn({ ...context, pageScrollTop: -1, contentScrollTop: Infinity })).toMatchObject({ pageScrollTop: 0, contentScrollTop: 0 });
    await mount({ homeReturn: { tab: 'unknown' } });
    expect(host.querySelector('#home-recent-tab')?.getAttribute('aria-selected')).toBe('true');
  });

  it('preserves the return context when activating a different workspace asset', () => {
    expect(activateWorkspaceAsset({ selectedAssets: [photo, second], activeAssetId: photo.id, homeReturn: context }, second.id))
      .toMatchObject({ activeAssetId: second.id, homeReturn: context });
  });
});
