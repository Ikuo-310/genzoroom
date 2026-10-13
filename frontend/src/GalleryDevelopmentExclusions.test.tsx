// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';
import type { RecentAsset } from './assets';
import { ExportQueueApiError, type ExportQueueItem, type ExportQueueStatus } from './exportQueueApi';
import type { HomeTab } from './homeReturn';
import { writeEditStatusFilterMode, writePhotoFilterMode, writeStackFilterMode } from './photoFilters';
import { updateSetting } from './appSettings';
import i18n from './i18n';

const api = vi.hoisted(() => ({ photos: vi.fn(), albums: vi.fn(), minYear: vi.fn(), heatmap: vi.fn(),
  statuses: vi.fn(), editState: vi.fn(), list: vi.fn(), enqueue: vi.fn(), dequeue: vi.fn(), exclusions: vi.fn(), save: vi.fn() }));
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(),
  fetchRecentAssets: api.photos, fetchFavoriteAssets: api.photos, fetchAlbumAssets: api.photos,
  fetchCalendarDayAssets: api.photos, fetchAlbums: api.albums, fetchCalendarMinYear: api.minYear,
  fetchCalendarHeatmap: api.heatmap }));
vi.mock('./editStateApi', async original => ({ ...await original<typeof import('./editStateApi')>(),
  getAssetEditStatuses: api.statuses, getAssetEditState: api.editState }));
vi.mock('./exportQueueApi', async original => ({ ...await original<typeof import('./exportQueueApi')>(),
  listExportQueue: api.list, enqueueExportAssets: api.enqueue, dequeueExportAsset: api.dequeue }));

vi.mock('./StackManagementPage', () => ({ StackManagementPage: () => null }));
vi.mock('./developmentExclusionsApi', async original => ({ ...await original<typeof import('./developmentExclusionsApi')>(),
  getExclusionStatuses: api.exclusions, saveExclusion: api.save }));
const ids = ['12345678-1234-4234-9234-123456789abc', '87654321-4321-4321-8321-cba987654321',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const photos: RecentAsset[] = ids.map((id, index) => ({ id, filename: `photo-${index}.${index === 1 ? 'dng' : 'jpg'}`,
  date: '2026-10-06', thumbnail_url: `/thumb/${index}`, format: index === 1 ? 'DNG' : 'JPEG', is_raw: index === 1 }));
const album = { id: 'album', albumName: 'Photos', albumThumbnailAssetId: null,
  assetCount: 4, startDate: null, endDate: null };
const item = (assetId: string, status: ExportQueueStatus = 'queued'): ExportQueueItem => ({ assetId, status,
  queuedAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z' });
const tabs: HomeTab[] = ['recent', 'albums', 'calendar', 'favorites'];
let items: ExportQueueItem[];
let excluded: Set<string>;
let host: HTMLDivElement;
let root: Root;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function resetFilters() {
  sessionStorage.clear();
  for (const tab of tabs) { writeEditStatusFilterMode('both', tab); writePhotoFilterMode('both', tab); }
  for (const tab of ['recent', 'albums', 'calendar'] as const) writeStackFilterMode('both', tab);
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en'); resetFilters(); updateSetting('showKeyboardShortcuts', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  Object.values(api).forEach(mock => mock.mockReset()); items = []; excluded = new Set();
  api.exclusions.mockImplementation(async (targets: { kind: string; id: string }[]) => targets.map(t => ({ ...t, excluded: excluded.has(t.id), configuration: t.kind === 'stack' ? 'confirmed' : 'single' })));
  api.save.mockImplementation(async (target: { id: string }, on: boolean) => { if (on) excluded.add(target.id); else excluded.delete(target.id); });
  api.photos.mockResolvedValue(photos); api.albums.mockResolvedValue([album]);
  api.minYear.mockResolvedValue(2002); api.heatmap.mockResolvedValue({ year: 2026, month: 10, days: [] });
  api.statuses.mockImplementation(async (requested: string[]) => Object.fromEntries(requested.map(id => [id, id !== ids[3]])));
  api.list.mockImplementation(async () => [...items]);
  api.enqueue.mockImplementation(async (requested: string[]) => {
    for (const id of requested) if (!items.some(value => value.assetId === id)) items.push(item(id));
    return [...items];
  });
  api.dequeue.mockImplementation(async (id: string) => { items = items.filter(value => value.assetId !== id); });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
});
afterEach(() => { act(() => root.unmount()); host.remove(); resetFilters(); vi.unstubAllGlobals(); });
async function mount(tab: HomeTab = 'recent') {
  const homeReturn = { tab, album: tab === 'albums' ? album : null, year: 2026, month: 10,
    date: tab === 'calendar' ? '2026-10-06' : null, calendarMode: 'month', pageScrollTop: 0, contentScrollTop: 0 };
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: '/', state: { homeReturn } }]}>
    <Routes><Route path="/" element={<GalleryPage />} />
      <Route path="/anshitsu/:assetId" element={<p className="workspace-probe">Develop</p>} /></Routes>
  </MemoryRouter>));
}
const card = (index = 0) => [...host.querySelectorAll<HTMLElement>('.photo-card')]
  .find(node => node.querySelector('.photo-info p')?.textContent === photos[index].filename)!;
async function click(target: HTMLElement) { await act(async () => target.click()); }
async function clickSelector(selector: string) { await click(host.querySelector<HTMLElement>(selector)!); }
async function pressQ(target: EventTarget = window, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true, ...modifiers });
  await act(async () => target.dispatchEvent(event));
  return event;
}
async function pressV(target: EventTarget = window, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true, ...modifiers });
  await act(async () => target.dispatchEvent(event));
  return event;
}
async function doubleClickPhoto(index: number) {
  const photo = card(index).querySelector<HTMLButtonElement>('.photo-card-button')!;
  await act(async () => {
    photo.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }));
    photo.dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true, cancelable: true }));
    photo.dispatchEvent(new MouseEvent('dblclick', { detail: 2, bubbles: true, cancelable: true }));
  });
}
async function pressX(modifiers: KeyboardEventInit = {}, target: EventTarget = window) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true, ...modifiers })));
}
async function select(index = 0) { await click(card(index).querySelector<HTMLInputElement>('.photo-selection-input')!); }
function family() {
  const stackId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const primary = { ...photos[0], stackId, primaryAssetId: ids[0], stackAssetCount: 2, stackMemberIds: [ids[0], ids[1]] };
  api.photos.mockResolvedValue([primary, photos[2], photos[3]]);
  return stackId;
}

describe('Gallery development exclusions', () => {
  it('toggles a single card without changing selection, scroll or restoring Queue', async () => {
    await mount(); await pressX(); expect(api.save).not.toHaveBeenCalled();
    await select();
    const content = host.querySelector<HTMLElement>('.home-content')!; content.scrollTop = 132;
    await pressX(); expect(api.save).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'asset', id: ids[0] }), true, expect.any(AbortSignal));
    expect(card().classList.contains('development-excluded')).toBe(true);
    expect(card().classList.contains('selected')).toBe(true); expect(content.scrollTop).toBe(132);
    await pressX(); expect(card().classList.contains('development-excluded')).toBe(false);
    expect(api.enqueue).not.toHaveBeenCalled(); expect(api.dequeue).not.toHaveBeenCalled();
  });
  it('unifies mixed selections to ON, then all excluded selections to OFF', async () => {
    excluded.add(ids[0]); await mount(); await select(); await select(2);
    await pressX(); expect(api.save.mock.calls.map(([t, on]) => [t.id, on])).toEqual([[ids[0], true], [ids[2], true]]);
    api.save.mockClear(); await pressX(); expect(api.save.mock.calls.map(([t, on]) => [t.id, on])).toEqual([[ids[0], false], [ids[2], false]]);
  });
  it('removes queued and failed members before saving the whole Stack', async () => {
    const stackId = family(); items = [item(ids[0]), item(ids[1], 'failed')];
    await mount(); await select(); await pressX();
    expect(api.dequeue.mock.calls.map(([id]) => id)).toEqual([ids[0], ids[1]]);
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stack', id: stackId }), true, expect.any(AbortSignal));
    expect(api.dequeue.mock.invocationCallOrder[1]).toBeLessThan(api.save.mock.invocationCallOrder[0]);
  });
  it.each(['waiting', 'encoding', 'registering'] as const)('rejects Stack member lock %s', async status => {
    family(); items = [item(ids[1], status)]; await mount(); await select(); await pressX();
    expect(api.dequeue).not.toHaveBeenCalled(); expect(api.save).not.toHaveBeenCalled();
    expect(host.textContent).toContain('cannot be removed');
  });
  it('retains partial Queue removals and does not exclude the failed Stack', async () => {
    family(); items = [item(ids[0]), item(ids[1])]; api.dequeue.mockImplementation(async id => {
      if (id === ids[1]) throw new ExportQueueApiError('locked', 409);
      items = items.filter(i => i.assetId !== id);
    });
    await mount(); await select(); await pressX();
    expect(items.map(i => i.assetId)).toEqual([ids[1]]); expect(api.save).not.toHaveBeenCalled();
    expect(card().classList.contains('development-excluded')).toBe(false); expect(api.list.mock.calls.length).toBeGreaterThan(1);
  });
  it('excludes a successful independent target after another Stack fails', async () => {
    family(); items = [item(ids[1])]; api.dequeue.mockRejectedValue(new ExportQueueApiError('locked', 409));
    await mount(); await select(); await select(2); await pressX();
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'asset', id: ids[2] }), true, expect.any(AbortSignal));
    expect(card().classList.contains('development-excluded')).toBe(false); expect(card(2).classList.contains('development-excluded')).toBe(true);
  });
  it('suppresses repeated X and Q while a target mutation is pending', async () => {
    const pending = deferred<void>(); api.save.mockReturnValueOnce(pending.promise);
    await mount(); await select(); await pressX(); await pressX(); await pressQ();
    expect(api.save).toHaveBeenCalledTimes(1); expect(api.enqueue).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
  });
  it('rejects unknown or mismatched configuration without losing saved dimming', async () => {
    excluded.add(ids[0]); await mount(); await select();
    api.exclusions.mockImplementation(async targets => targets.map((t: {id: string; kind: string}) => ({ ...t, excluded: false, configuration: 'unknown' })));
    await clickSelector('.gallery-refresh'); await pressX();
    expect(api.save).not.toHaveBeenCalled(); expect(card().classList.contains('development-excluded')).toBe(true);
  });
  it('does not display a failed save as success and blocks uncertain retries', async () => {
    api.save.mockRejectedValue(new Error('network')); await mount(); await select(); await pressX(); await pressX();
    expect(api.save).toHaveBeenCalledTimes(1); expect(card().classList.contains('development-excluded')).toBe(false);
    expect(host.textContent).toContain('Could not save development exclusion');
  });
  it('blocks X in inputs, dialogs and immersive preview', async () => {
    await mount(); await select();
    const input = document.createElement('input'); host.append(input); await pressX({}, input); input.remove();
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); host.append(dialog); await pressX(); dialog.remove();
    await pressV(); expect(host.querySelector('.immersive-preview')).not.toBeNull(); await pressX();
    expect(api.save).not.toHaveBeenCalled();
  });
  it('preserves double click preview and selection when excluded', async () => {
    excluded.add(ids[0]); await mount(); await select(); await doubleClickPhoto(0);
    expect(host.querySelector('.immersive-preview')).not.toBeNull(); expect(card().classList.contains('selected')).toBe(true);
  });
  it('ignores stale status responses after Reload', async () => {
    const pending = deferred<any>(); api.exclusions.mockReturnValueOnce(pending.promise);
    await mount(); await select(); await clickSelector('.gallery-refresh');
    await act(async () => pending.resolve([{ kind: 'asset', id: ids[0], excluded: true, configuration: 'single' }]));
    expect(card().classList.contains('development-excluded')).toBe(false);
    await pressX(); expect(api.save).toHaveBeenCalled();
  });
});


it('batches the visible Gallery targets at the Backend limit', async () => {
  const large = Array.from({ length: 201 }, (_, index) => ({ ...photos[0], id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, filename: `many-${index}.jpg` }));
  api.photos.mockResolvedValue(large); await mount();
  expect(api.exclusions.mock.calls.map(([targets]) => targets.length)).toEqual([100, 100, 1]);
});

it('ignores old status responses after switching tabs with the same Asset IDs', async () => {
  const pending = deferred<any>(); api.exclusions.mockReturnValueOnce(pending.promise);
  await mount(); await clickSelector('#home-favorites-tab');
  await act(async () => pending.resolve(photos.map(p => ({ kind: 'asset', id: p.id, excluded: true, configuration: 'single' }))));
  expect(card().classList.contains('development-excluded')).toBe(false);
});

it('keeps cached dimming after status fetch failure without authorizing X', async () => {
  excluded.add(ids[0]); await mount(); await select(); api.exclusions.mockRejectedValue(new Error('network'));
  await clickSelector('.gallery-refresh'); await pressX();
  expect(card().classList.contains('development-excluded')).toBe(true); expect(api.save).not.toHaveBeenCalled();
});

it('does not authorize ON while Queue canonical state has not loaded', async () => {
  const pending = deferred<ExportQueueItem[]>(); api.list.mockReturnValueOnce(pending.promise);
  await mount(); await select(); await pressX(); expect(api.save).not.toHaveBeenCalled();
  await act(async () => pending.resolve([])); await pressX(); expect(api.save).toHaveBeenCalledTimes(1);
});

it('keeps unrelated card operations available while an exclusion save is pending', async () => {
  const pending = deferred<void>(); api.save.mockReturnValueOnce(pending.promise);
  await mount(); await select(); await pressX(); await select(); await select(2); await pressX();
  expect(api.save).toHaveBeenCalledTimes(2); expect(card(2).classList.contains('development-excluded')).toBe(true);
  await act(async () => pending.resolve());
});


it('reconciles a save that finishes after Reload without accepting its old read', async () => {
  const pending = deferred<void>(); api.save.mockImplementationOnce(async target => {
    await pending.promise; excluded.add(target.id);
  });
  await mount(); await select(); await pressX(); await clickSelector('.gallery-refresh');
  await pressX(); expect(api.save).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve());
  expect(card().classList.contains('development-excluded')).toBe(true);
  await pressX(); expect(api.save).toHaveBeenLastCalledWith(expect.objectContaining({ id: ids[0] }), false, expect.any(AbortSignal));
});

it('deduplicates selected favorite members into one Stack exclusion operation', async () => {
  const stackId = family();
  const metadata = { stackId, primaryAssetId: ids[0], stackAssetCount: 2, stackMemberIds: [ids[0], ids[1]] };
  api.photos.mockResolvedValue([{ ...photos[0], ...metadata }, { ...photos[1], ...metadata }]);
  await mount('favorites'); await select(); await select(1); await pressX();
  expect(api.save).toHaveBeenCalledTimes(1);
  expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stack', id: stackId }), true, expect.any(AbortSignal));
});

it('does not operate on the Stack when Gallery metadata is incomplete', async () => {
  const stackId = family();
  api.photos.mockResolvedValue([{ ...photos[0], stackId, primaryAssetId: ids[0], stackAssetCount: 2 }]);
  await mount(); await select(); await pressX(); expect(api.save).not.toHaveBeenCalled(); expect(api.dequeue).not.toHaveBeenCalled();
});

it.each([{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }])('keeps modified, repeated and composing X inactive: %j', async modifiers => {
  await mount(); await select(); await pressX(modifiers); expect(api.save).not.toHaveBeenCalled();
});


it('tracks partial success separately for two selected Stacks', async () => {
  const firstId = family(), secondId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  api.photos.mockResolvedValue([
    { ...photos[0], stackId: firstId, primaryAssetId: ids[0], stackAssetCount: 2, stackMemberIds: [ids[0], ids[1]] },
    { ...photos[2], stackId: secondId, primaryAssetId: ids[2], stackAssetCount: 2, stackMemberIds: [ids[2], ids[3]] },
  ]);
  items = [item(ids[1]), item(ids[2])];
  api.dequeue.mockImplementation(async id => {
    if (id === ids[1]) throw new ExportQueueApiError('locked', 409);
    items = items.filter(i => i.assetId !== id);
  });
  await mount(); await select(); await select(2); await pressX();
  expect(api.save.mock.calls.map(([target]) => target.id)).toEqual([secondId]);
  expect(card().classList.contains('development-excluded')).toBe(false);
  expect(card(2).classList.contains('development-excluded')).toBe(true);
});

it.each(['queued', 'failed'] as const)('removes a single Asset from %s before excluding it', async status => {
  items = [item(ids[0], status)]; await mount(); await select(); await pressX();
  expect(api.dequeue).toHaveBeenCalledWith(ids[0], expect.any(AbortSignal)); expect(api.save).toHaveBeenCalledTimes(1);
  expect(api.dequeue.mock.invocationCallOrder[0]).toBeLessThan(api.save.mock.invocationCallOrder[0]);
});

it.each(['export', 'stacks'])('keeps X inactive in the %s management view', async tab => {
  await mount(); await select(); await clickSelector(`#home-${tab}-tab`); await pressX();
  expect(api.save).not.toHaveBeenCalled();
});


it('does not save an exclusion if its Gallery snapshot changes during Queue removal', async () => {
  const pending = deferred<void>(); items = [item(ids[0])]; api.dequeue.mockReturnValueOnce(pending.promise);
  await mount(); await select(); await pressX(); await clickSelector('.gallery-refresh');
  await act(async () => pending.resolve());
  expect(api.save).not.toHaveBeenCalled(); expect(card().classList.contains('development-excluded')).toBe(false);
});


it('rejects conflicting Gallery Stack snapshots even when collapse hides one member', async () => {
  const stackId = family();
  api.photos.mockResolvedValue([
    { ...photos[0], stackId, primaryAssetId: ids[0], stackAssetCount: 2, stackMemberIds: [ids[0], ids[1]] },
    { ...photos[1], stackId, primaryAssetId: ids[0], stackAssetCount: 3, stackMemberIds: [ids[0], ids[1], ids[2]] },
  ]);
  await mount(); await select(); await pressX(); expect(api.save).not.toHaveBeenCalled();
});
