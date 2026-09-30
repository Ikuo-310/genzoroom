// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnshitsuPage } from './AnshitsuPage';
import { GalleryPage } from './GalleryPage';
import type { RecentAsset } from './assets';
import { useEditStatuses } from './useEditStatuses';
import i18n from './i18n';
import { updateSetting } from './appSettings';
import { PHOTO_FILTER_SESSION_KEY, writePhotoFilterMode } from './photoFilters';

const api = vi.hoisted(() => ({ recent: vi.fn(), statuses: vi.fn(), detail: vi.fn(), editState: vi.fn() }));
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), fetchRecentAssets: api.recent, fetchAssetDetail: api.detail }));
vi.mock('./editStateApi', async original => ({ ...(await original<typeof import('./editStateApi')>()),
  getAssetEditStatuses: api.statuses, getAssetEditState: api.editState }));
vi.mock('./ImageViewer', () => ({ ImageViewer: () => <div className="viewer-panel" /> }));
const assets = Array.from({ length: 100 }, (_, index) => ({ id: `asset-${index}`, filename: `photo-${index}.jpg`,
  date: '2026-09-27', thumbnail_url: `/thumb/${index}`, format: index % 2 ? 'DNG' : 'JPEG', is_raw: !!(index % 2) }));
let root: Root;
let host: HTMLDivElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function SelectionNavigationProbe() {
  const state = useLocation().state as { selectedAssets?: RecentAsset[] } | null;
  return <output className="selection-navigation-probe">{state?.selectedAssets?.map((asset) => asset.filename).join('|')}</output>;
}
async function mount() {
  await act(async () => {
    root.render(<MemoryRouter><Routes>
      <Route path="/" element={<GalleryPage />} />
      <Route path="/anshitsu/:assetId" element={<SelectionNavigationProbe />} />
    </Routes></MemoryRouter>);
  });
}
async function mountAnshitsuRoutes() {
  await act(async () => {
    root.render(<MemoryRouter><Routes>
      <Route path="/" element={<GalleryPage />} />
      <Route path="/anshitsu/:assetId" element={<AnshitsuPage />} />
    </Routes></MemoryRouter>);
  });
  await act(async () => { await Promise.resolve(); });
}
function visibleCardButtons() { return [...host.querySelectorAll<HTMLButtonElement>('.photo-card-button')]; }
function visibleSelectionInputs() { return [...host.querySelectorAll<HTMLInputElement>('.photo-selection-input')]; }
function selectedVisibleFilenames() {
  return [...host.querySelectorAll<HTMLElement>('.photo-card.selected .photo-info p')].map((node) => node.textContent);
}
function shiftClick(element: HTMLElement) {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })));
}
function changeFilter(value: 'both' | 'raw' | 'nonRaw') {
  const select = host.querySelector<HTMLSelectElement>('.photo-filter-control select')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en');
  sessionStorage.clear(); writePhotoFilterMode('both');
  updateSetting('recentPhotoCount', 100);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.recent.mockReset(); api.statuses.mockReset(); api.detail.mockReset(); api.editState.mockReset();
  api.recent.mockResolvedValue(assets);
  api.statuses.mockResolvedValue(Object.fromEntries(assets.map((asset, index) => [asset.id, index === 0])));
  api.detail.mockImplementation(async (id: string) => {
    const asset = assets.find((candidate) => candidate.id === id)!;
    return { ...asset, preview_url: asset.thumbnail_url, exif: {} };
  });
  api.editState.mockResolvedValue({ state: null });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
});
afterEach(() => { act(() => root.unmount()); host.remove(); sessionStorage.clear(); writePhotoFilterMode('both'); vi.unstubAllGlobals(); updateSetting('recentPhotoCount', 100); });

describe('Home bulk edit status', () => {
  it('re-fetches the selected count while preserving the current grid and ignores stale responses', async () => {
    const stale = deferred<RecentAsset[]>();
    const latest = deferred<RecentAsset[]>();
    api.recent.mockReset().mockResolvedValueOnce(assets).mockReturnValueOnce(stale.promise).mockReturnValueOnce(latest.promise);
    await mount();
    const count = host.querySelector<HTMLSelectElement>('.recent-count-control select')!;
    expect(count.value).toBe('100');
    expect(api.recent.mock.calls[0][0]).toBe(100);
    act(() => host.querySelector<HTMLInputElement>('.photo-selection-input')!.click());
    const choose = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(count, value);
      count.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await choose('250');
    await choose('500');
    expect(api.recent.mock.calls.map(([limit]) => limit)).toEqual([100, 250, 500]);
    expect((api.recent.mock.calls[1][1] as AbortSignal).aborted).toBe(true);
    expect(host.querySelectorAll('.photo-card')).toHaveLength(100);
    expect(host.querySelector('.selection-bar')?.textContent).toContain('1 selected');
    await act(async () => latest.resolve([assets[0]]));
    await act(async () => stale.resolve(assets.slice(0, 3)));
    expect(host.querySelectorAll('.photo-card')).toHaveLength(1);
    expect(host.querySelector('.photo-card .photo-info p')?.textContent).toBe('photo-0.jpg');
    expect(host.querySelector('.photo-card.selected')).not.toBeNull();
  });

  it('fetches all 100 photos once, retains selection and does not refetch for filters', async () => {
    await mount();
    expect(host.querySelectorAll('.photo-card')).toHaveLength(100);
    expect(host.querySelectorAll('.edited-badge')).toHaveLength(1);
    expect(host.querySelector('.photo-card-button')?.getAttribute('aria-description')).toBe('Edited in GenzoRoom');
    expect(api.statuses).toHaveBeenCalledTimes(1);
    expect(api.statuses.mock.calls[0][0]).toEqual(assets.map(asset => asset.id));
    act(() => host.querySelector<HTMLInputElement>('.photo-selection-input')!.click());
    expect(host.querySelector('.selection-bar')?.textContent).toContain('1 selected');
    changeFilter('nonRaw');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(50);
    expect(host.querySelectorAll('.edited-badge')).toHaveLength(1);
    expect(api.statuses).toHaveBeenCalledTimes(1);
    changeFilter('both');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(100);
    expect(host.querySelector('.photo-card.selected')).not.toBeNull();
  });

  it('restores the selected type filter after Home unmounts and remounts', async () => {
    await mount();
    changeFilter('raw');
    expect(localStorage.getItem(PHOTO_FILTER_SESSION_KEY)).toBeNull();
    expect((host.querySelector('.photo-filter-control select') as HTMLSelectElement).value).toBe('raw');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(50);
    act(() => root.render(<div />));
    await mount();
    expect((host.querySelector('.photo-filter-control select') as HTMLSelectElement).value).toBe('raw');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(50);
  });

  it('continues filtering and retains the choice in memory when session storage is blocked', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked'); });
    try {
      await mount();
      changeFilter('nonRaw');
      expect((host.querySelector('.photo-filter-control select') as HTMLSelectElement).value).toBe('nonRaw');
      expect(host.querySelectorAll('.photo-card')).toHaveLength(50);
      act(() => root.render(<div />));
      await mount();
      expect((host.querySelector('.photo-filter-control select') as HTMLSelectElement).value).toBe('nonRaw');
      expect(host.querySelectorAll('.photo-card')).toHaveLength(50);
    } finally {
      getItem.mockRestore(); setItem.mockRestore();
    }
  });

  it('renders edited badges for a 150-photo Home list', async () => {
    const manyAssets = Array.from({ length: 150 }, (_, index) => ({ ...assets[index % assets.length],
      id: `large-${index}`, filename: `large-${index}.jpg` }));
    api.recent.mockResolvedValue(manyAssets);
    api.statuses.mockImplementation(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, true])));
    await mount();
    expect(host.querySelectorAll('.photo-card')).toHaveLength(150);
    expect(api.statuses.mock.calls.map(([ids]) => ids.length)).toEqual([100, 50]);
    expect(host.querySelectorAll('.edited-badge')).toHaveLength(150);
  });

  it('rechecks only service status and preserves a pending edit-status response', async () => {
    const waiting = deferred<Record<string, boolean>>();
    const recheck = deferred<Response>();
    let healthCalls = 0;
    api.statuses.mockReturnValueOnce(waiting.promise);
    vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/health' && healthCalls++ > 0
      ? recheck.promise : Promise.resolve(new Response(JSON.stringify(url === '/api/health'
        ? { status: 'ok' } : { configured: true, connected: true })))));
    await mount();
    expect(host.querySelector('.edited-badge')).toBeNull();
    expect(host.querySelector('.connection-control')?.classList.contains('connected')).toBe(true);
    act(() => host.querySelector<HTMLElement>('.connection-control summary')!.click());
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check again')!;
    await act(async () => {
      retry.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      retry.click();
    });
    expect(host.querySelector<HTMLDetailsElement>('.connection-control')?.open).toBe(true);
    expect(retry.disabled).toBe(true);
    expect(api.statuses).toHaveBeenCalledTimes(1);
    expect(api.recent).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.photo-card')).not.toBeNull();
    await act(async () => recheck.resolve(new Response(JSON.stringify({ status: 'ok' }))));
    expect(host.querySelector<HTMLDetailsElement>('.connection-control')?.open).toBe(true);
    await act(async () => waiting.resolve(Object.fromEntries(assets.map(asset => [asset.id, true]))));
    expect(host.querySelectorAll('.edited-badge')).toHaveLength(100);
  });

  it('shows detailed connection states and supports keyboard disclosure controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
      ? { status: 'ok' } : { configured: false, connected: false }))));
    await mount();
    const details = host.querySelector<HTMLDetailsElement>('.connection-control')!;
    const summary = details.querySelector<HTMLElement>('summary')!;
    const heading = host.querySelector('h1')!;
    expect(heading.children).toHaveLength(1);
    expect(heading.firstElementChild?.classList.contains('home-title-link')).toBe(true);
    expect(details.parentElement).toBe(heading.parentElement);
    expect(details.classList.contains('not-configured')).toBe(true);
    expect(summary.getAttribute('aria-label')).toContain('Immich not configured');
    await act(async () => summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('Backend: Connected');
    expect(details.textContent).toContain('Immich: Not configured');
    expect(details.textContent).toContain('Set the Immich URL');
    await act(async () => details.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it('closes on outside pointer without blocking the outside control and ignores inside pointers', async () => {
    await mount();
    const details = host.querySelector<HTMLDetailsElement>('.connection-control')!;
    const summary = details.querySelector<HTMLElement>('summary')!;
    act(() => summary.click());
    expect(details.open).toBe(true);
    act(() => details.querySelector('.detail')!.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(details.open).toBe(true);

    const outsideButton = document.createElement('button');
    let activated = 0;
    outsideButton.addEventListener('click', () => { activated += 1; });
    document.body.append(outsideButton);
    outsideButton.focus();
    await act(async () => {
      outsideButton.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      outsideButton.click();
    });
    expect(details.open).toBe(false);
    expect(activated).toBe(1);
    expect(document.activeElement).toBe(outsideButton);
    outsideButton.remove();
  });

  it('keeps the status neutral and the retry action disabled while checks are pending', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/health'
      ? pending.promise : Promise.resolve(new Response(JSON.stringify({ configured: true, connected: true })))));
    await mount();
    const details = host.querySelector<HTMLDetailsElement>('.connection-control')!;
    expect(details.classList.contains('checking')).toBe(true);
    expect(details.textContent).toContain('Checking');
    const summary = details.querySelector<HTMLElement>('summary')!;
    await act(async () => summary.click());
    expect(details.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    await act(async () => pending.resolve(new Response(JSON.stringify({ status: 'ok' }))));
    expect(details.classList.contains('connected')).toBe(true);
  });

  it('marks backend or Immich failures without conflating an unconfigured Immich', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
      ? { status: 'failed' } : { configured: true, connected: false }))));
    await mount();
    const details = host.querySelector('.connection-control')!;
    expect(details.classList.contains('error')).toBe(true);
    expect(details.querySelector('summary')?.getAttribute('aria-label')).toContain('Connection problem');
    expect(details.textContent).toContain('Backend: Connection failed');
    expect(details.textContent).toContain('Immich: Connection failed');
  });

  it('keeps the Home title interaction local without clearing photo selection', async () => {
    await mount();
    act(() => host.querySelector<HTMLInputElement>('.photo-selection-input')!.click());
    expect(host.querySelector('.selection-bar')?.textContent).toContain('1 selected');
    act(() => host.querySelector<HTMLButtonElement>('.home-title-link')!.click());
    expect(host.querySelector('.selection-bar')?.textContent).toContain('1 selected');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(100);
  });

  it('extends a forward range from a checkbox to a shifted checkbox click', async () => {
    await mount();
    act(() => visibleSelectionInputs()[1].click());
    shiftClick(visibleSelectionInputs()[4]);
    expect(selectedVisibleFilenames()).toEqual(['photo-1.jpg', 'photo-2.jpg', 'photo-3.jpg', 'photo-4.jpg']);
    expect(host.querySelector('.selection-bar')?.textContent).toContain('4 selected');
  });

  it('extends a backward card-click range, preserves existing selection order, and opens in that order', async () => {
    await mount();
    act(() => visibleSelectionInputs()[7].click());
    act(() => visibleSelectionInputs()[9].click());
    shiftClick(visibleCardButtons()[3]);
    expect(selectedVisibleFilenames()).toEqual([
      'photo-3.jpg', 'photo-4.jpg', 'photo-5.jpg', 'photo-6.jpg', 'photo-7.jpg', 'photo-8.jpg', 'photo-9.jpg',
    ]);
    expect(host.querySelector('.selection-bar')?.textContent).toContain('7 selected');
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('.selection-bar button')]
        .find((button) => button.textContent === 'Open in Anshitsu')!.click();
      for (let index = 0; index < 5; index++) await Promise.resolve();
    });
    expect(host.querySelector('.selection-navigation-probe')?.textContent).toBe(
      ['photo-7.jpg', 'photo-9.jpg', 'photo-3.jpg', 'photo-4.jpg', 'photo-5.jpg', 'photo-6.jpg', 'photo-8.jpg'].join('|'),
    );
  });

  it('keeps range-selection order in the Anshitsu Filmstrip after opening the selection', async () => {
    await mountAnshitsuRoutes();
    act(() => visibleSelectionInputs()[7].click());
    act(() => visibleSelectionInputs()[9].click());
    shiftClick(visibleCardButtons()[3]);
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('.selection-bar button')]
        .find((button) => button.textContent === 'Open in Anshitsu')!.click();
      for (let index = 0; index < 5; index++) await Promise.resolve();
    });
    const filmstripOrder = [...host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')]
      .map((button) => button.getAttribute('aria-label'));
    expect(filmstripOrder).toEqual([
      'photo-7.jpg', 'photo-9.jpg', 'photo-3.jpg', 'photo-4.jpg', 'photo-5.jpg', 'photo-6.jpg', 'photo-8.jpg',
    ]);
  });

  it('starts safely on a shifted card click when there is no active selection', async () => {
    await mount();
    shiftClick(visibleCardButtons()[5]);
    expect(selectedVisibleFilenames()).toEqual(['photo-5.jpg']);
    expect(host.querySelector('.selection-navigation-probe')).toBeNull();
  });

  it('falls back to a new visible anchor when filtering hides the old one', async () => {
    await mount();
    act(() => visibleSelectionInputs()[1].click());
    changeFilter('nonRaw');
    shiftClick(visibleCardButtons()[2]);
    expect(host.querySelector('.selection-bar')?.textContent).toContain('2 selected');
    expect(selectedVisibleFilenames()).toEqual(['photo-4.jpg']);
    shiftClick(visibleCardButtons()[4]);
    expect(host.querySelector('.selection-bar')?.textContent).toContain('4 selected');
    expect(selectedVisibleFilenames()).toEqual(['photo-4.jpg', 'photo-6.jpg', 'photo-8.jpg']);
  });

  it('resets the range anchor when every photo is cleared', async () => {
    await mount();
    act(() => visibleSelectionInputs()[1].click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>('.selection-bar button')]
      .find((button) => button.textContent === 'Clear selection')!.click());
    shiftClick(visibleCardButtons()[4]);
    expect(host.querySelector('.selection-bar')?.textContent).toContain('1 selected');
    expect(selectedVisibleFilenames()).toEqual(['photo-4.jpg']);
  });

  it('keeps a failed lookup unknown and ignores responses after unmount', async () => {
    function Harness() {
      const statuses = useEditStatuses(['a']);
      return <p>{statuses.a === undefined ? 'unknown' : String(statuses.a)}</p>;
    }
    api.statuses.mockRejectedValueOnce(new Error('unavailable'));
    await act(async () => root.render(<Harness />));
    expect(host.textContent).toBe('unknown');
    const waiting = deferred<Record<string, boolean>>();
    api.statuses.mockReturnValueOnce(waiting.promise);
    await act(async () => root.render(<div />));
    await act(async () => root.render(<Harness />));
    const signal = api.statuses.mock.calls.at(-1)![1] as AbortSignal;
    await act(async () => root.render(<div />));
    await act(async () => waiting.resolve({ a: true }));
    expect(signal.aborted).toBe(true);
    expect(host.querySelector('.edited-badge')).toBeNull();
  });
});
