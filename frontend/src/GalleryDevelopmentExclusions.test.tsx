// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';
import type { RecentAsset } from './assets';
import { ExportQueueApiError, type ExportQueueItem, type ExportQueueStatus } from './exportQueueApi';
import type { HomeTab } from './homeReturn';
import { writeEditStatusFilterMode, writePhotoFilterMode, writeStackFilterMode } from './photoFilters';
import { updateSetting } from './appSettings';
import i18n from './i18n';
import { frontendLogger } from './frontendLogging';

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

vi.mock('./StackManagementPage', () => ({ StackManagementPage: ({ sessionAssets }: { sessionAssets: RecentAsset[] }) =>
  <div data-testid="stack-session">{sessionAssets.map(asset => asset.id).join(',')}</div> }));
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
function WorkspaceProbe() {
  const location = useLocation();
  const selected = (location.state as { selectedAssets?: RecentAsset[] } | null)?.selectedAssets ?? [];
  return <p className="workspace-probe" data-assets={selected.map(asset => asset.id).join(',')}>Develop</p>;
}
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
afterEach(() => { frontendLogger.setLevel('off'); frontendLogger.clear(); act(() => root.unmount()); host.remove(); resetFilters(); vi.unstubAllGlobals(); });
async function mount(tab: HomeTab = 'recent', strict = false) {
  const homeReturn = { tab, album: tab === 'albums' ? album : null, year: 2026, month: 10,
    date: tab === 'calendar' ? '2026-10-06' : null, calendarMode: 'month', pageScrollTop: 0, contentScrollTop: 0 };
  const page = <MemoryRouter initialEntries={[{ pathname: '/', state: { homeReturn } }]}>
    <Routes><Route path="/" element={<GalleryPage />} />
      <Route path="/anshitsu/:assetId" element={<WorkspaceProbe />} /></Routes>
  </MemoryRouter>;
  await act(async () => root.render(strict ? <StrictMode>{page}</StrictMode> : page));
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
async function pressD(target: EventTarget = window) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true })));
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
  it('saves only unexcluded mixed selections, then turns all excluded selections OFF', async () => {
    excluded.add(ids[0]); await mount(); await select(); await select(2);
    await pressX(); expect(api.save.mock.calls.map(([t, on]) => [t.id, on])).toEqual([[ids[2], true]]);
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
  it('does not open Immersive Preview from an excluded card', async () => {
    excluded.add(ids[0]); await mount(); await select(); await doubleClickPhoto(0);
    expect(host.querySelector('.immersive-preview')).toBeNull(); expect(card().classList.contains('selected')).toBe(true);
  });
  it('filters excluded and unconfirmed cards from mixed D selections', async () => {
    const stackId = family(); excluded.add(stackId);
    api.exclusions.mockImplementation(async targets => targets.map((target: { kind: string; id: string }) => ({
      ...target, excluded: excluded.has(target.id), configuration: target.id === ids[3] ? 'unknown'
        : target.kind === 'stack' ? 'confirmed' : 'single',
    })));
    await mount(); await select(); await select(2); await select(3); await pressD();
    expect(host.querySelector('.workspace-probe')?.getAttribute('data-assets')).toBe(ids[2]);
  });
  it('filters an excluded whole Stack from S while passing selected standalone photos', async () => {
    const stackId = family(); excluded.add(stackId);
    await mount(); await select(); await select(2); await clickSelector('#home-stacks-tab');
    expect(host.querySelector('[data-testid="stack-session"]')?.textContent).toBe(ids[2]);
  });
  it('does nothing when every selected card is excluded for D and S', async () => {
    const stackId = family(); excluded.add(stackId); excluded.add(ids[2]);
    await mount(); await select(); await select(2); await pressD();
    expect(host.querySelector('.workspace-probe')).toBeNull();
    await clickSelector('#home-stacks-tab');
    expect(host.querySelector('[data-testid="stack-session"]')).toBeNull();
  });
  it('filters excluded targets from selected and individual Queue additions', async () => {
    excluded.add(ids[0]); await mount(); await select(); await select(2); await pressQ();
    expect(api.enqueue).toHaveBeenCalledTimes(1);
    expect(api.enqueue).toHaveBeenCalledWith([ids[2]], expect.any(AbortSignal));
    api.enqueue.mockClear(); await click(card(0).querySelector<HTMLButtonElement>('.edited-badge')!);
    expect(api.enqueue).not.toHaveBeenCalled();
  });
  it('filters an unknown exclusion state from Queue additions without blocking known cards', async () => {
    api.exclusions.mockImplementation(async targets => targets.map((target: { kind: string; id: string }) => ({
      ...target, excluded: false, configuration: target.id === ids[0] ? 'unknown' : 'single',
    })));
    await mount(); await select(); await select(2); await pressQ();
    expect(api.enqueue).toHaveBeenCalledWith([ids[2]], expect.any(AbortSignal));
    expect(api.enqueue).not.toHaveBeenCalledWith(expect.arrayContaining([ids[0]]), expect.any(AbortSignal));
  });
  it('disables the card Queue control while its exclusion state is unknown', async () => {
    api.exclusions.mockImplementation(async targets => targets.map((target: { kind: string; id: string }) => ({
      ...target, excluded: false, configuration: 'unknown',
    })));
    await mount(); await select(); await pressQ();
    expect(card().querySelector<HTMLButtonElement>('.edited-badge')?.disabled).toBe(true);
    expect(api.enqueue).not.toHaveBeenCalled();
  });
  it('does not queue members from an excluded Stack card', async () => {
    const stackId = family(); excluded.add(stackId); await mount(); await select(); await pressQ();
    expect(api.enqueue).not.toHaveBeenCalled();
    expect(card().querySelector<HTMLButtonElement>('.edited-badge')?.disabled).toBe(true);
  });
  it('does not expose excluded Stack members through the card context menu', async () => {
    const stackId = family(); excluded.add(stackId);
    const members = ids.slice(0, 2).map((id, index) => ({ ...photos[index], stackId, primaryAssetId: ids[0],
      stackAssetCount: 2, stackMemberIds: ids.slice(0, 2) }));
    api.photos.mockResolvedValue([{ ...members[0], stackMembers: members }]);
    await mount();
    await act(async () => card().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    const menu = document.querySelector('.stack-photo-context-menu');
    expect(menu).not.toBeNull();
    expect(menu?.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(api.enqueue).not.toHaveBeenCalled();
  });
  it('keeps eligible Stack-member Queue additions in the context menu', async () => {
    const stackId = family();
    const members = ids.slice(0, 2).map((id, index) => ({ ...photos[index], stackId, primaryAssetId: ids[0],
      stackAssetCount: 2, stackMemberIds: ids.slice(0, 2), isGenzoRoomExport: false }));
    api.photos.mockResolvedValue([{ ...photos[0], stackId, primaryAssetId: ids[0], stackAssetCount: 2,
      stackMemberIds: ids.slice(0, 2), stackMembers: members }]);
    await mount();
    await act(async () => card().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    const queue = document.querySelector('[aria-labelledby="stack-queue-heading"]');
    const firstMember = queue?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(firstMember).not.toBeNull();
    await click(firstMember!);
    expect(api.enqueue).toHaveBeenCalledWith([ids[0]], expect.any(AbortSignal));
  });
  it('opens preview with confirmed eligible cards only and skips exclusions during navigation', async () => {
    excluded.add(ids[0]); await mount(); await select(); await select(1); await select(2); await pressV();
    const preview = host.querySelector('.immersive-preview')!;
    expect(preview.querySelector('.immersive-preview-position')?.textContent).toBe('1 / 2');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    expect(preview.querySelector('.immersive-preview-position')?.textContent).toBe('2 / 2');
    expect(preview.querySelector('img')?.getAttribute('alt')).toBe(photos[2].filename);
  });
  it('skips every member of an excluded Stack in the preview sequence', async () => {
    const stackId = family(); excluded.add(stackId); await mount(); await select(2); await pressV();
    const preview = host.querySelector('.immersive-preview')!;
    expect(preview.querySelector('.immersive-preview-position')?.textContent).toBe('1 / 2');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })));
    expect(preview.querySelector('img')?.getAttribute('alt')).toBe(photos[2].filename);
  });
  it('allows D again after the exclusion is removed', async () => {
    excluded.add(ids[0]); await mount(); await select(); await pressX();
    await pressD();
    expect(host.querySelector('.workspace-probe')?.getAttribute('data-assets')).toBe(ids[0]);
  });
  it('allows Queue and Immersive Preview after exclusion is removed', async () => {
    excluded.add(ids[0]); await mount(); await select(); await pressX(); await pressQ();
    expect(api.enqueue).toHaveBeenCalledWith([ids[0]], expect.any(AbortSignal));
    await click(card().querySelector<HTMLButtonElement>('.edited-badge')!);
    excluded.delete(ids[0]); await click(card().querySelector('.photo-selection-input')!);
    await doubleClickPhoto(0);
    expect(host.querySelector('.immersive-preview')).not.toBeNull();
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


it.each([false, true])('reproduces sequential A then B exclusions (StrictMode=%s)', async strict => {
  await mount('recent', strict); await select(); await pressX();
  await click(card(1).querySelector<HTMLButtonElement>('.photo-card-button')!); await pressX();
  expect(api.save.mock.calls.map(([target, on]) => [target.id, on])).toEqual([[ids[0], true], [ids[1], true]]);
  expect(card(1).classList.contains('development-excluded')).toBe(true);
});

it.each([false, true])('reproduces A exclusion followed by deselection and B/C batch (StrictMode=%s)', async strict => {
  await mount('recent', strict); await select(); await pressX(); await select(); await select(1); await select(2); await pressX();
  expect(api.save.mock.calls.map(([target]) => target.id)).toEqual([ids[0], ids[1], ids[2]]);
  expect(card(1).classList.contains('development-excluded')).toBe(true); expect(card(2).classList.contains('development-excluded')).toBe(true);
});


it('uses the latest plain-click selection when X arrives before React commits', async () => {
  await mount(); await select(); await pressX();
  await act(async () => {
    card(1).querySelector<HTMLButtonElement>('.photo-card-button')!.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
  });
  expect(api.save.mock.calls.map(([target, on]) => [target.id, on])).toEqual([[ids[0], true], [ids[1], true]]);
});

it('uses the latest deselection and multi-selection when X arrives before React commits', async () => {
  await mount(); await select(); await pressX();
  await act(async () => {
    card(0).querySelector<HTMLInputElement>('.photo-selection-input')!.click();
    card(1).querySelector<HTMLInputElement>('.photo-selection-input')!.click();
    card(2).querySelector<HTMLInputElement>('.photo-selection-input')!.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
  });
  expect(api.save.mock.calls.map(([target, on]) => [target.id, on])).toEqual([[ids[0], true], [ids[1], true], [ids[2], true]]);
});

it('uses the latest initially-empty multi-selection when X arrives before React commits', async () => {
  await mount();
  await act(async () => {
    card(1).querySelector<HTMLInputElement>('.photo-selection-input')!.click();
    card(2).querySelector<HTMLInputElement>('.photo-selection-input')!.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
  });
  expect(api.save.mock.calls.map(([target]) => target.id)).toEqual([ids[1], ids[2]]);
});


it('resolves a pending plain click before X without retaining the previous multi-selection', async () => {
  await mount(); await select(); await pressX(); await select(1);
  await act(async () => {
    card(2).querySelector<HTMLButtonElement>('.photo-card-button')!.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
  });
  expect(api.save.mock.calls.map(([target, on]) => [target.id, on])).toEqual([[ids[0], true], [ids[2], true]]);
  expect(card(2).classList.contains('selected')).toBe(true); expect(card(1).classList.contains('selected')).toBe(false);
});


function librarySamples(stacked: number, total = 10): RecentAsset[] {
  return Array.from({ length: total }, (_, index) => {
    const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
    const base = { ...photos[0], id, filename: `sample-${index}.jpg`, stackId: null, primaryAssetId: null, stackAssetCount: null, stackMembers: null };
    return index < stacked ? { ...base, stackId: `11111111-1111-4111-8111-${index.toString(16).padStart(12, '0')}`,
      primaryAssetId: id, stackAssetCount: 2, stackMemberIds: [id, `22222222-2222-4222-8222-${index.toString(16).padStart(12, '0')}`] } : base;
  });
}
async function selectSample(photo: RecentAsset) {
  const node = [...host.querySelectorAll<HTMLElement>('.photo-card')].find(card => card.querySelector('.photo-info p')?.textContent === photo.filename)!;
  await click(node.querySelector<HTMLButtonElement>('.photo-card-button')!);
}

it.each([0, 10])('keeps ten %s-Stack targets confirmed through delayed initial reads, saves and rerenders', async stacked => {
  const samples = librarySamples(stacked);
  const read = deferred<any>(); api.photos.mockResolvedValue(samples); api.exclusions.mockReturnValue(read.promise);
  await mount('recent', true);
  await act(async () => updateSetting('showKeyboardShortcuts', false));
  await act(async () => read.resolve(samples.map(photo => ({ kind: photo.stackId ? 'stack' : 'asset', id: photo.stackId ?? photo.id, excluded: false, configuration: photo.stackId ? 'confirmed' : 'single' }))));
  for (const photo of samples) {
    const write = deferred<void>(); api.save.mockImplementationOnce(async (target, on) => { await write.promise; if (on) excluded.add(target.id); });
    await selectSample(photo); await pressX();
    await act(async () => updateSetting('showKeyboardShortcuts', true));
    await act(async () => write.resolve());
    await act(async () => updateSetting('showKeyboardShortcuts', false));
  }
  expect(api.save.mock.calls.map(([target]) => target.id)).toEqual(samples.map(photo => photo.stackId ?? photo.id));
});

it('matches four Stack successes and six single-Asset blocks when the Backend returns unknown for singles', async () => {
  const samples = librarySamples(4); api.photos.mockResolvedValue(samples);
  api.exclusions.mockImplementation(async targets => targets.map((target: {kind: string; id: string}) => ({ ...target, excluded: false, configuration: target.kind === 'stack' ? 'confirmed' : 'unknown' })));
  await mount();
  for (const photo of samples) { await selectSample(photo); await pressX(); }
  expect(api.save.mock.calls.map(([target]) => target.id)).toEqual(samples.slice(0, 4).map(photo => photo.stackId));
  api.save.mockClear();
  for (const photo of samples.slice(0, 4)) { await selectSample(photo); await pressX(); }
  expect(api.save.mock.calls.map(([, on]) => on)).toEqual([false, false, false, false]);
});


it('logs unknown configuration separately from missing target resolution with bounded evidence', async () => {
  frontendLogger.clear(); frontendLogger.setLevel('debug');
  api.exclusions.mockImplementation(async targets => targets.map((target: {kind: string; id: string}) => ({ ...target, excluded: false, configuration: 'unknown' })));
  await mount(); await select(); await pressX();
  const blocked = frontendLogger.getEntries().find(entry => entry.event === 'mutation.blocked')!;
  expect(blocked.context).toMatchObject({ blockedCount: 1, targets: [{ assetId: ids[0], kind: 'asset', reason: 'configuration_unknown',
    configuration: 'unknown', loadPhase: 'completed', pending: false }] });
  expect(JSON.stringify(blocked)).not.toContain('photo-0');
  expect(api.save).not.toHaveBeenCalled();
});

it('records a locally unresolved Stack without pretending it is a single Asset', async () => {
  frontendLogger.clear(); frontendLogger.setLevel('debug'); const stackId = family();
  api.photos.mockResolvedValue([{ ...photos[0], stackId, primaryAssetId: ids[0], stackAssetCount: 2 }]);
  await mount(); await select(); await pressX();
  const blocked = frontendLogger.getEntries().find(entry => entry.event === 'mutation.blocked')!;
  expect(blocked.context).toMatchObject({ targets: [{ reason: 'target_unresolved', kind: 'stack', targetId: stackId }] });
  expect(api.save).not.toHaveBeenCalled();
});

it('distinguishes a missing loading entry from a received unknown configuration', async () => {
  frontendLogger.clear(); frontendLogger.setLevel('debug'); const read = deferred<any>(); api.exclusions.mockReturnValueOnce(read.promise);
  await mount(); await select(); await pressX();
  const blocked = frontendLogger.getEntries().find(entry => entry.event === 'mutation.blocked')!;
  expect(blocked.context).toMatchObject({ targets: [{ reason: 'loading', entryGeneration: null, configuration: null, loadPhase: 'loading' }] });
  await act(async () => read.resolve(photos.map(photo => ({ kind: 'asset', id: photo.id, excluded: false, configuration: 'single' }))));
  await pressX(); expect(api.save).toHaveBeenCalledTimes(1);
});

it('logs the generation mismatch when a new Reload view is waiting for status', async () => {
  frontendLogger.clear(); frontendLogger.setLevel('debug'); await mount(); await select();
  const read = deferred<any>(); api.exclusions.mockReturnValueOnce(read.promise); await clickSelector('.gallery-refresh'); await pressX();
  const blocked = frontendLogger.getEntries().find(entry => entry.event === 'mutation.blocked')!;
  expect(blocked.context).toMatchObject({ targets: [{ reason: 'generation_mismatch', loadPhase: 'loading' }] });
  expect(api.save).not.toHaveBeenCalled();
  await act(async () => read.resolve(photos.map(photo => ({ kind: 'asset', id: photo.id, excluded: false, configuration: 'single' }))));
});
