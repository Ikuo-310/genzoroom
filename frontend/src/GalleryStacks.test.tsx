// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';
import type { RecentAsset, WorkspaceNavigationState } from './assets';
import type { HomeTab } from './homeReturn';
import { writeEditStatusFilterMode, writePhotoFilterMode, writeStackFilterMode } from './photoFilters';
import i18n from './i18n';
import { makeGalleryStack } from './gallerySelectionTestHelpers';
import { clearWorkspaceSession, rememberWorkspaceSession } from './workspaceResume';
import { restoreGalleryStackSelectionsFromSession, setManualGalleryStackSelection } from './useGalleryStackSelections';
import { updateSetting } from './appSettings';
vi.mock('./exportQueueApi', async original => ({ ...await original<typeof import('./exportQueueApi')>(),
  listExportQueue: async () => [] }));

const api = vi.hoisted(() => ({ recent: vi.fn(), album: vi.fn(), day: vi.fn(), favorites: vi.fn(),
  albums: vi.fn(), minYear: vi.fn(), heatmap: vi.fn(), statuses: vi.fn() }));
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()),
  fetchRecentAssets: api.recent, fetchAlbumAssets: api.album, fetchCalendarDayAssets: api.day,
  fetchFavoriteAssets: api.favorites, fetchAlbums: api.albums, fetchCalendarMinYear: api.minYear,
  fetchCalendarHeatmap: api.heatmap }));
vi.mock('./editStateApi', async original => ({ ...(await original<typeof import('./editStateApi')>()),
  getAssetEditStatuses: api.statuses }));

function asset(id: string, isRaw = false): RecentAsset {
  return { id, filename: `${id}.${isRaw ? 'dng' : 'jpg'}`, date: '2026-09-01',
    thumbnail_url: `/thumb/${id}`, format: isRaw ? 'DNG' : 'JPEG', is_raw: isRaw };
}
const stackMetadata = { stackId: 'stack-s', primaryAssetId: 'primary', stackAssetCount: 4 };
const photos = [asset('x'), { ...asset('member', true), ...stackMetadata }, asset('y'),
  { ...asset('primary'), ...stackMetadata }];
const album = { id: 'album-a', albumName: 'Stack album', albumThumbnailAssetId: null,
  assetCount: photos.length, startDate: null, endDate: null };
const tabs: HomeTab[] = ['recent', 'albums', 'calendar', 'favorites'];
let root: Root;
let host: HTMLDivElement;
let navigation: WorkspaceNavigationState | null;

function WorkspaceProbe() {
  navigation = useLocation().state as WorkspaceNavigationState;
  return <div>Workspace</div>;
}

function resetFilters() {
  sessionStorage.clear();
  restoreGalleryStackSelectionsFromSession();
  clearWorkspaceSession();
  for (const tab of ['recent', 'albums', 'calendar'] as const) writeStackFilterMode('both', tab);
  for (const tab of tabs) {
    writePhotoFilterMode('both', tab);
    writeEditStatusFilterMode('both', tab);
  }
}

beforeEach(async () => {
  navigation = null;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en');
  resetFilters();
  updateSetting('anshitsuInitialSelection', 'nonRaw');
  for (const reader of [api.recent, api.album, api.day, api.favorites]) {
    reader.mockReset().mockResolvedValue(photos);
  }
  api.albums.mockReset().mockResolvedValue([album]);
  api.minYear.mockReset().mockResolvedValue(2002);
  api.heatmap.mockReset().mockResolvedValue({ year: 2026, month: 9, days: [] });
  api.statuses.mockReset().mockImplementation(async (ids: string[]) =>
    Object.fromEntries(ids.map(id => [id, id === 'member'])));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount()); host.remove(); resetFilters(); vi.unstubAllGlobals();
});

async function mount(tab: HomeTab = 'recent') {
  const homeReturn = { tab, album: tab === 'albums' ? album : null,
    year: 2026, month: 9, date: tab === 'calendar' ? '2026-09-01' : null,
    calendarMode: 'month', pageScrollTop: 0, contentScrollTop: 0 };
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: '/', state: { homeReturn } }]}>
    <Routes>
      <Route path="/" element={<GalleryPage />} />
      <Route path="/anshitsu/:assetId" element={<WorkspaceProbe />} />
    </Routes>
  </MemoryRouter>));
}

function filenames() {
  return [...host.querySelectorAll('.photo-card .photo-info p')].map(p => p.textContent);
}

function change(selector: string, value: string) {
  act(() => {
    const select = host.querySelector<HTMLSelectElement>(selector)!;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function galleryPhotos(input: RecentAsset[]) {
  for (const reader of [api.recent, api.album, api.day, api.favorites]) reader.mockResolvedValue(input);
}

describe('Gallery Stack target navigation', () => {
  it.each(tabs)('expands multiple Stacks and a direct PNG in selection order on %s', async tab => {
    const first = makeGalleryStack(1, ['JPEG', 'JPEG', 'DNG']);
    const last = makeGalleryStack(2, ['DNG', 'DNG']);
    const png = { ...asset('solo'), format: 'PNG', filename: 'solo.png' };
    galleryPhotos([first, png, last]);
    await mount(tab);
    act(() => {
      const controls = host.querySelectorAll<HTMLInputElement>('.photo-selection-input');
      for (const index of [2, 0, 1]) controls[index].click();
    });
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true })));
    expect(navigation?.selectedAssets).toEqual([...last.stackMembers!, ...first.stackMembers!.slice(0, 2), png]);
    expect(navigation?.activeAssetId).toBe(last.id);
    expect(navigation?.homeReturn?.tab).toBe(tab);
  });

  it.each(tabs.flatMap(tab => ['empty', 'unavailable', 'manualOff'].map(state => [tab, state] as const)))
  ('never resumes a previous workspace for a selected %s Stack with %s targets', async (tab, state) => {
    const stack = makeGalleryStack(1, ['JPEG', 'DNG'], state === 'empty' ? [0, 1] : []);
    const representative = state === 'unavailable' ? { ...stack, stackMembers: null } : stack;
    if (state === 'manualOff') setManualGalleryStackSelection(stack, new Set());
    galleryPhotos([representative]);
    rememberWorkspaceSession({ selectedAssets: [asset('previous')], activeAssetId: 'previous' });
    await mount(tab);
    act(() => host.querySelector<HTMLInputElement>('.photo-selection-input')!.click());
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true })));
    expect(navigation).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(state === 'unavailable' ? 'information is unavailable' : 'No photos are selected');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(1);
  });

  it.each(tabs)('preserves remembered Filmstrip order and last active Asset without resolving on %s', async tab => {
    const stack = makeGalleryStack(1, ['DNG', 'JPEG']);
    galleryPhotos([{ ...stack, stackMembers: null }]);
    const saved = stack.stackMembers!;
    rememberWorkspaceSession({ selectedAssets: saved, activeAssetId: saved[1].id });
    await mount(tab);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true })));
    expect(navigation?.selectedAssets).toEqual(saved);
    expect(navigation?.activeAssetId).toBe(saved[1].id);
    expect(navigation?.homeReturn?.tab).toBe(tab);
  });

  it.each(['empty', 'unavailable'] as const)('handles mixed direct assets and %s Stacks atomically', async state => {
    const stack = makeGalleryStack(1, ['JPEG', 'DNG'], [0, 1]);
    galleryPhotos([asset('solo'), state === 'empty' ? stack : { ...stack, stackMembers: undefined }]);
    await mount();
    act(() => host.querySelector<HTMLButtonElement>('.selection-all')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('.selection-open-workspace')!.click());
    if (state === 'empty') expect(navigation?.selectedAssets.map(item => item.id)).toEqual(['solo']);
    else {
      expect(navigation).toBeNull();
      expect(host.querySelector('.selection-bar')?.textContent).toContain('2 selected');
    }
  });

  it('honors session manual RAW selection without changing card checkbox behavior', async () => {
    const stack = makeGalleryStack(1, ['JPEG', 'DNG']);
    setManualGalleryStackSelection(stack, new Set([stack.stackMembers![1].id]));
    galleryPhotos([stack]);
    await mount();
    act(() => host.querySelector<HTMLInputElement>('.photo-selection-input')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('.selection-open-workspace')!.click());
    expect(navigation?.selectedAssets).toEqual([stack.stackMembers![1]]);
  });
});

describe('Home stack display', () => {
  it.each([true, false])('uses only the primary export identity when a child is tagged (primary tagged %s)', async primaryTagged => {
    api.recent.mockResolvedValue(photos.map(photo => ({ ...photo,
      isGenzoRoomExport: photo.id === 'member' || photo.id === 'primary' && primaryTagged })));
    await mount();
    expect(host.querySelectorAll('.genzoroom-export-badge')).toHaveLength(primaryTagged ? 1 : 0);
    if (primaryTagged) expect(host.querySelector('.genzoroom-export-badge')?.closest('.photo-card')?.querySelector('.photo-info p')?.textContent).toBe('primary.jpg');
  });
  it.each(tabs.flatMap(tab => ['none', 'child', 'primary', 'unknown'].map(state => [tab, state] as const)))
    ('filters primary-only %s cards using full Stack member statuses: %s', async (tab, state) => {
      const primary = { ...asset('primary'), stackId: 'stack-s', primaryAssetId: 'primary',
        stackAssetCount: 2, stackMemberIds: ['primary', 'member'] };
      for (const reader of [api.recent, api.album, api.day, api.favorites]) reader.mockResolvedValue([primary, asset('x')]);
      api.statuses.mockImplementation(async (ids: string[]) => Object.fromEntries(ids
        .filter(id => state !== 'unknown' || id !== 'member')
        .map(id => [id, state === 'child' ? id === 'member' : id === state])));
      await mount(tab);
      expect(api.statuses).toHaveBeenCalledWith(['primary', 'member', 'x'], expect.any(AbortSignal));
      expect(filenames()).toEqual(['primary.jpg', 'x.jpg']);
      change('.edit-status-filter-control select', 'edited');
      expect(filenames()).toEqual(state === 'none' ? [] : ['primary.jpg']);
      change('.edit-status-filter-control select', 'unedited');
      expect(filenames()).toEqual(state === 'child' || state === 'primary' ? ['x.jpg'] : ['primary.jpg', 'x.jpg']);
      expect(host.querySelector('img[src="/thumb/member"]')).toBeNull();
    });
  it.each(['recent', 'albums', 'calendar'] as const)('selects the displayed Stack representative on %s', async tab => {
    const representative = makeGalleryStack(1, ['DNG', 'JPEG']);
    const members = [representative];
    api.recent.mockResolvedValue(members); api.album.mockResolvedValue(members); api.day.mockResolvedValue(members);
    await mount(tab);
    await act(async () => host.querySelector<HTMLButtonElement>('.photo-card-button')!.click());
    expect(navigation).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('.selection-open-workspace')!.click());
    expect(navigation?.activeAssetId).toBe(representative.stackMembers![1].id);
    expect(navigation?.selectedAssets).toEqual([representative.stackMembers![1]]);
    expect(navigation?.homeReturn?.tab).toBe(tab);
  });

  it('selects the first visible card across all photo types', async () => {
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('.photo-card-button')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('.selection-open-workspace')!.click());
    expect(navigation?.selectedAssets.map(a => a.id)).toEqual(['x']);
  });

  it('resolves hidden selected members, preserves selection order and deduplicates before navigation', async () => {
    const representative = makeGalleryStack(1, ['JPEG', 'JPEG', 'DNG']);
    api.recent.mockResolvedValue([asset('x'), representative, asset('y')]);
    await mount();
    act(() => host.querySelector<HTMLInputElement>('.photo-selection-input')!.click());
    act(() => host.querySelectorAll<HTMLInputElement>('.photo-selection-input')[1].click());
    act(() => host.querySelectorAll<HTMLInputElement>('.photo-selection-input')[2].click());
    expect(host.querySelector('.selection-bar')?.textContent).toContain('3 selected');
    await act(async () => host.querySelector<HTMLButtonElement>('.selection-open-workspace')!.click());
    expect(navigation?.selectedAssets.map(a => a.id)).toEqual(['x', ...representative.stackMembers!.slice(0, 2).map(a => a.id), 'y']);
  });

  it.each([undefined, null])('blocks unavailable Stacks without discarding the card selection (%s)', async stackMembers => {
    const members = [asset('x'), { ...makeGalleryStack(1, ['JPEG', 'DNG']), stackMembers }, asset('y')];
    api.recent.mockResolvedValue(members);
    await mount();
    await act(async () => host.querySelectorAll<HTMLButtonElement>('.photo-card-button')[1].click());
    expect(navigation).toBeNull();
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(1);
    await act(async () => host.querySelector<HTMLButtonElement>('.selection-open-workspace')!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Cannot open the selection');
    act(() => host.querySelector<HTMLButtonElement>('.selection-clear')!.click());
    act(() => host.querySelector<HTMLInputElement>('.photo-selection-input')!.click());
    act(() => host.querySelectorAll<HTMLInputElement>('.photo-selection-input')[1].click());
    await act(async () => host.querySelector<HTMLButtonElement>('.selection-open-workspace')!.click());
    expect(navigation).toBeNull();
    expect(host.querySelector('.selection-bar')?.textContent).toContain('2 selected');
  });

  it('expands Favorites using Stack members rather than the old direct-card exception', async () => {
    const representative = makeGalleryStack(1, ['JPEG', 'JPEG', 'DNG'], [0]);
    api.favorites.mockResolvedValue([representative, asset('x')]);
    await mount('favorites');
    act(() => host.querySelectorAll<HTMLInputElement>('.photo-selection-input')[0].click());
    act(() => host.querySelectorAll<HTMLInputElement>('.photo-selection-input')[1].click());
    await act(async () => host.querySelector<HTMLButtonElement>('.selection-open-workspace')!.click());
    expect(navigation?.selectedAssets.map(a => a.id)).toEqual([representative.stackMembers![1].id, 'x']);
  });

  it('keeps Favorites selection order for a RAW Asset', async () => {
    api.favorites.mockResolvedValue([asset('x'), asset('soloRaw', true)]);
    await mount('favorites');
    await act(async () => host.querySelectorAll<HTMLButtonElement>('.photo-card-button')[1].click());
    await act(async () => host.querySelector<HTMLButtonElement>('.selection-open-workspace')!.click());
    expect(navigation?.activeAssetId).toBe('soloRaw');
  });

  it.each(['recent', 'albums', 'calendar'] as const)('collapses the %s grid and looks up statuses for all fetched IDs', async tab => {
    await mount(tab);
    expect(filenames()).toEqual(['x.jpg', 'primary.jpg', 'y.jpg']);
    expect(host.querySelectorAll('.photo-card img')[1].getAttribute('src')).toBe('/thumb/primary');
    expect(host.querySelector('.stack-asset-count')?.textContent).toBe('4');
    expect(host.querySelector('.stack-assets')?.getAttribute('aria-label')).toBe('Stack, 4 assets');
    expect(api.statuses).toHaveBeenCalledWith(photos.map(a => a.id), expect.any(AbortSignal));
    expect(photos.map(a => a.id)).toEqual(['x', 'member', 'y', 'primary']);
  });

  it.each(['albums', 'calendar'] as const)('retains the first member when the %s result omits the primary', async tab => {
    const subset = photos.slice(0, 3);
    api.album.mockResolvedValue(subset); api.day.mockResolvedValue(subset);
    await mount(tab);
    expect(filenames()).toEqual(['x.jpg', 'member.dng', 'y.jpg']);
    expect(host.querySelector('.stack-asset-count')?.textContent).toBe('4');
  });

  it('aggregates Stack edits while keeping the primary collapsed', async () => {
    await mount();
    expect(filenames()).toEqual(['x.jpg', 'primary.jpg', 'y.jpg']);
    expect(host.querySelectorAll('.edited-badge')).toHaveLength(0);
    change('.edit-status-filter-control select', 'edited');
    expect(filenames()).toEqual(['primary.jpg']);
    change('.edit-status-filter-control select', 'unedited');
    expect(filenames()).toEqual(['x.jpg', 'y.jpg']);
    expect(api.statuses).toHaveBeenCalledTimes(1);
    expect(api.recent).toHaveBeenCalledTimes(1);
  });

  it('filters mixed developed status with edit status using AND', async () => {
    const mixed = [
      { ...asset('developed'), isGenzoRoomExport: true },
      { ...asset('false'), isGenzoRoomExport: false },
      asset('unknown'),
    ];
    api.recent.mockResolvedValue(mixed);
    api.statuses.mockResolvedValue({ developed: true, false: true, unknown: false });
    await mount();
    expect(filenames()).toEqual(['developed.jpg', 'false.jpg', 'unknown.jpg']);
    expect(host.querySelector('.develop-status-filter-control')).not.toBeNull();
    change('.edit-status-filter-control select', 'edited');
    change('.develop-status-filter-control select', 'developed');
    expect(host.querySelector('.develop-status-filter-control .home-select-sizing option')?.textContent).toBe('Developed');
    expect(filenames()).toEqual(['developed.jpg']);
    change('.develop-status-filter-control select', 'undeveloped');
    expect(host.querySelector('.develop-status-filter-control .home-select-sizing option')?.textContent).toBe('Undeveloped');
    expect(filenames()).toEqual(['false.jpg']);
    change('.edit-status-filter-control select', 'unedited');
    expect(filenames()).toEqual(['unknown.jpg']);
  });

  it('filters Stack cards by the primary export tag, not child tags', async () => {
    const member = { ...asset('member', true), ...stackMetadata, isGenzoRoomExport: true };
    const primary = { ...asset('primary'), ...stackMetadata, isGenzoRoomExport: false };
    api.recent.mockResolvedValue([member, primary]);
    await mount();
    expect(filenames()).toEqual(['primary.jpg']);
    change('.develop-status-filter-control select', 'developed');
    expect(filenames()).toEqual([]);
    change('.develop-status-filter-control select', 'undeveloped');
    expect(filenames()).toEqual(['primary.jpg']);

    api.recent.mockResolvedValue([
      { ...member, isGenzoRoomExport: false },
      { ...primary, isGenzoRoomExport: true },
    ]);
    act(() => root.render(<div />));
    await mount();
    change('.develop-status-filter-control select', 'developed');
    expect(filenames()).toEqual(['primary.jpg']);
  });

  it('keeps Stack children out of the selectable Home card list', async () => {
    await mount();
    expect(filenames()).toEqual(['x.jpg', 'primary.jpg', 'y.jpg']);
    expect(host.querySelectorAll('.photo-selection-input')).toHaveLength(3);
    expect(host.querySelector('img[src="/thumb/member"]')).toBeNull();
  });

  it('Select All adds the collapsed visible cards', async () => {
    await mount();
    act(() => host.querySelector<HTMLButtonElement>('.selection-all')!.click());
    expect(host.querySelector('.selection-bar')?.textContent).toContain('3 selected');
    expect(host.querySelectorAll('.photo-card.selected')).toHaveLength(3);
    expect(host.querySelector<HTMLButtonElement>('.selection-all')!.disabled).toBe(true);
  });

  it('uses collapsed display order for Shift selection and excludes hidden members', async () => {
    await mount();
    act(() => host.querySelector<HTMLInputElement>('.photo-selection-input')!.click());
    act(() => host.querySelectorAll<HTMLButtonElement>('.photo-card-button')[2]
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })));
    expect(host.querySelector('.selection-bar')?.textContent).toContain('3 selected');
    expect([...host.querySelectorAll('.photo-card.selected .photo-info p')].map(p => p.textContent))
      .toEqual(['x.jpg', 'primary.jpg', 'y.jpg']);
  });

  it.each(['recent', 'albums', 'calendar'] as const)('hides Stack and type filters while preserving collapsed cards on %s', async tab => {
    writeStackFilterMode('unstacked', tab);
    writePhotoFilterMode('raw', tab);
    await mount(tab);
    const controls = [...host.querySelectorAll('.home-toolbar-controls > .home-control')];
    expect(host.querySelector('.stack-filter-control')).toBeNull();
    expect(host.querySelector('.photo-filter-control')).toBeNull();
    expect(host.querySelector('.edit-status-filter-control')).not.toBeNull();
    expect(controls.map(c => c.className)).toEqual([
      'home-control edit-status-filter-control', 'home-control develop-status-filter-control',
      'home-control recent-count-control', 'home-control thumbnail-size-setting',
    ].filter(className => tab === 'recent' || className !== 'home-control recent-count-control'));
    expect(filenames()).toEqual(['x.jpg', 'primary.jpg', 'y.jpg']);
    expect(host.querySelector('.stack-asset-count')?.textContent).toBe('4');
  });

  it('ignores saved Stack and type filter choices without deleting them', async () => {
    writeStackFilterMode('unstacked', 'recent');
    writePhotoFilterMode('raw', 'recent');
    await mount();
    expect(filenames()).toEqual(['x.jpg', 'primary.jpg', 'y.jpg']);
    expect(sessionStorage.getItem('genzoroom.homeStackFilter.recent')).toBe('unstacked');
    expect(sessionStorage.getItem('genzoroom.homePhotoFilter.recent')).toBe('raw');
  });

  it('preserves the existing Favorites member display', async () => {
    await mount('favorites');
    expect(filenames()).toEqual(photos.map(a => a.filename));
    expect(host.querySelector('.stack-filter-control')).toBeNull();
    expect(host.querySelector('.photo-filter-control')).toBeNull();
    change('.edit-status-filter-control select', 'edited');
    expect(filenames()).toEqual(['member.dng']);
  });
});
