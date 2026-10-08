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
  statuses: vi.fn(), editState: vi.fn(), list: vi.fn(), enqueue: vi.fn(), dequeue: vi.fn() }));
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(),
  fetchRecentAssets: api.photos, fetchFavoriteAssets: api.photos, fetchAlbumAssets: api.photos,
  fetchCalendarDayAssets: api.photos, fetchAlbums: api.albums, fetchCalendarMinYear: api.minYear,
  fetchCalendarHeatmap: api.heatmap }));
vi.mock('./editStateApi', async original => ({ ...await original<typeof import('./editStateApi')>(),
  getAssetEditStatuses: api.statuses, getAssetEditState: api.editState }));
vi.mock('./exportQueueApi', async original => ({ ...await original<typeof import('./exportQueueApi')>(),
  listExportQueue: api.list, enqueueExportAssets: api.enqueue, dequeueExportAsset: api.dequeue }));

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
  Object.values(api).forEach(mock => mock.mockReset()); items = [];
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
const badge = (index = 0) => card(index).querySelector<HTMLButtonElement>('.edited-badge')!;
async function click(target: HTMLElement) { await act(async () => target.click()); }
async function pressQ(target: EventTarget = window, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true, ...modifiers });
  await act(async () => target.dispatchEvent(event));
  return event;
}
async function flushQueueRefresh() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
function useStack(statuses: Record<string, boolean | undefined> = { [ids[0]]: true, [ids[1]]: true }) {
  const primary = { ...photos[0], stackId: 'stack', primaryAssetId: ids[0], stackAssetCount: 2,
    stackMemberIds: [ids[0], ids[1]] };
  api.photos.mockResolvedValue([primary, photos[2], photos[3]]);
  api.statuses.mockResolvedValue({ ...statuses, [ids[2]]: true, [ids[3]]: false });
}
function useLargeStack(memberCount: number) {
  const members = Array.from({ length: memberCount }, (_, index) => index === 0 ? ids[0]
    : `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
  const primary = { ...photos[0], stackId: 'large-stack', primaryAssetId: ids[0], stackAssetCount: members.length,
    stackMemberIds: members };
  api.photos.mockResolvedValue([primary, photos[2], photos[3]]);
  api.statuses.mockImplementation(async (requested: string[]) => Object.fromEntries(requested.map(id => [id, true])));
  return members;
}

describe('Home Export Queue', () => {
  it.each(tabs)('uses the shared Queue snapshot for the %s photo grid', async tab => {
    await mount(tab); await click(badge());
    expect(api.enqueue).toHaveBeenCalledWith([ids[0]], expect.any(AbortSignal));
    expect(badge().classList.contains('queue-queued')).toBe(true);
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.editState).not.toHaveBeenCalled();
    expect(host.querySelector('.workspace-probe')).toBeNull();
  });

  it('keeps membership unknown and disabled until the initial list succeeds', async () => {
    const pending = deferred<ExportQueueItem[]>(); api.list.mockReturnValue(pending.promise);
    await mount();
    expect(badge().disabled).toBe(true);
    expect(badge().getAttribute('aria-pressed')).toBeNull();
    expect(badge().classList.contains('queue-inactive')).toBe(false);
    await click(badge()); expect(api.enqueue).not.toHaveBeenCalled();
    await act(async () => pending.resolve([item(ids[0])]));
    expect(badge().getAttribute('aria-pressed')).toBe('true');
    expect(badge().disabled).toBe(false);
    expect(badge().title).not.toContain('[Q]');
  });

  it.each(['queued', 'failed', 'waiting', 'encoding', 'registering'] as const)('handles standalone %s with existing locking semantics', async status => {
    items = [item(ids[0], status)]; await mount();
    const locked = status !== 'queued' && status !== 'failed';
    expect(badge().disabled).toBe(locked);
    await click(badge());
    expect(api.dequeue.mock.calls.map(([id]) => id)).toEqual(locked ? [] : [ids[0]]);
    expect(badge().getAttribute('aria-pressed')).toBe(String(locked));
    expect(api.enqueue).not.toHaveBeenCalled();
  });

  it.each(['queued', 'failed'] as const)('removes a standalone %s entry even when edit status is false or unknown', async status => {
    items = [item(ids[0], status)];
    api.statuses.mockImplementation(async (requested: string[]) => Object.fromEntries(requested.map(id => [id, id === ids[0] ? undefined : false])));
    await mount();
    expect(badge().getAttribute('aria-pressed')).toBe('true');
    expect(badge().disabled).toBe(false);
    await click(badge());
    expect(api.dequeue).toHaveBeenCalledWith(ids[0], expect.any(AbortSignal));
    expect(api.enqueue).not.toHaveBeenCalled();
  });

  it('preserves the existing multi-selection direction when an unedited queued card is mixed with an eligible unqueued card', async () => {
    items = [item(ids[0])];
    api.statuses.mockImplementation(async (requested: string[]) => Object.fromEntries(requested.map(id => [id, id !== ids[0] && id !== ids[3]])));
    await mount();
    await click(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!);
    await click(card(2).querySelector<HTMLInputElement>('.photo-selection-input')!);
    await pressQ();
    expect(api.enqueue).toHaveBeenCalledWith([ids[2]], expect.any(AbortSignal));
    expect(api.dequeue).not.toHaveBeenCalled();
  });

  it('does not display a badge for unedited or History-only default assets', async () => {
    await mount();
    expect(card(3).querySelector('.edited-badge, .filmstrip-history-badge')).toBeNull();
    expect(api.editState).not.toHaveBeenCalled();
  });

  it('isolates badge clicks, replaces selection on card click, and lets Home Q operate the selection', async () => {
    await mount();
    await click(card().querySelector<HTMLInputElement>('.photo-selection-input')!);
    await click(badge(2));
    expect(api.enqueue).toHaveBeenCalledWith([ids[2]], expect.any(AbortSignal));
    expect(host.querySelector('.selection-bar')?.textContent).toContain('1 selected');
    await act(async () => card(1).querySelector('.photo-card-button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect([...host.querySelectorAll<HTMLInputElement>('.photo-selection-input')].map(input => input.checked)).toEqual([true, true, false, false]);
    await click(card(1).querySelector<HTMLButtonElement>('.photo-card-button')!);
    expect(host.querySelector('.selection-bar')?.textContent).toContain('1 selected');
    const event = new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(api.enqueue).toHaveBeenCalledTimes(2);
    expect(api.enqueue).toHaveBeenLastCalledWith([ids[1]], expect.any(AbortSignal));
    expect(api.dequeue).not.toHaveBeenCalled();
    expect(host.querySelector('.workspace-probe')).toBeNull();
    await click(host.querySelector<HTMLButtonElement>('.selection-clear')!);
    await click(card().querySelector<HTMLButtonElement>('.photo-card-button')!);
    expect(host.querySelector('.workspace-probe')).toBeNull();
    expect(host.querySelector('.photo-card.selected')).toBe(card());
  });

  it('blocks a busy card while allowing a different card mutation', async () => {
    const pending = deferred<ExportQueueItem[]>();
    api.enqueue.mockImplementation(async (requested: string[]) => requested[0] === ids[0] ? pending.promise : [item(ids[2])]);
    await mount(); await click(badge()); await click(badge());
    expect(badge().disabled).toBe(true); expect(badge(2).disabled).toBe(false);
    await click(badge(2));
    await act(async () => pending.resolve([item(ids[0])]));
    expect(api.enqueue).toHaveBeenCalledTimes(2);
    expect(badge().getAttribute('aria-pressed')).toBe('true');
    expect(badge(2).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows a localized load failure without treating unknown as Queue-out', async () => {
    api.list.mockRejectedValue(new ExportQueueApiError('network'));
    await i18n.changeLanguage('ja'); await mount();
    expect(host.querySelector('.home-queue-error')?.textContent).toBe('出力キューを読み込めませんでした。');
    expect(badge().disabled).toBe(true);
    expect(badge().getAttribute('aria-pressed')).toBeNull();
  });

  it('blocks representative and batch Q actions after an uncertain POST until a later refresh confirms Queue', async () => {
    await mount();
    api.enqueue.mockRejectedValueOnce(new ExportQueueApiError('network'));
    api.list.mockRejectedValueOnce(new ExportQueueApiError('network'));
    await click(badge());
    await flushQueueRefresh();
    expect(api.enqueue).toHaveBeenCalledOnce();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(badge().disabled).toBe(true);

    await click(card().querySelector<HTMLInputElement>('.photo-selection-input')!);
    await pressQ();
    expect(api.enqueue).toHaveBeenCalledOnce();
    expect(api.dequeue).not.toHaveBeenCalled();

    items = [item(ids[0])];
    await click(host.querySelector<HTMLButtonElement>('#home-favorites-tab')!);
    await flushQueueRefresh();
    expect(api.list).toHaveBeenCalledTimes(3);
    expect(badge().getAttribute('aria-pressed')).toBe('true');
    expect(badge().disabled).toBe(false);
    await click(badge());
    expect(api.dequeue).toHaveBeenCalledWith(ids[0], expect.any(AbortSignal));
  });

  it.each(tabs)('toggles eligible multi-selection with Q in the %s photo view', async tab => {
    await mount(tab);
    await click(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!);
    await click(card(2).querySelector<HTMLInputElement>('.photo-selection-input')!);
    const event = await pressQ();
    expect(event.defaultPrevented).toBe(true);
    expect(api.enqueue).toHaveBeenCalledWith([ids[0], ids[2]], expect.any(AbortSignal));
    expect(items.map(value => value.assetId)).toEqual([ids[0], ids[2]]);
    expect(badge(0).classList.contains('queue-queued')).toBe(true);
    expect(badge(2).classList.contains('queue-queued')).toBe(true);
    expect([...host.querySelectorAll<HTMLInputElement>('.photo-selection-input')].map(input => input.checked)).toEqual([true, false, true, false]);
    expect(host.querySelector('.selection-bar')?.textContent).toContain('2 selected');
  });

  it('uses one batch direction, leaving queued selections alone when turning Queue on and removing all when off', async () => {
    items = [item(ids[0])]; await mount();
    await click(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!);
    await click(card(2).querySelector<HTMLInputElement>('.photo-selection-input')!);
    await pressQ();
    expect(api.enqueue).toHaveBeenCalledWith([ids[2]], expect.any(AbortSignal));
    expect(api.dequeue).not.toHaveBeenCalled();

    api.enqueue.mockClear(); items = [item(ids[0]), item(ids[2])];
    await pressQ();
    expect(api.dequeue.mock.calls.map(([id]) => id)).toEqual([ids[0], ids[2]]);
    expect(items).toEqual([]);
    expect(badge(0).classList.contains('queue-inactive')).toBe(true);
    expect(badge(2).classList.contains('queue-inactive')).toBe(true);
    expect(api.enqueue).not.toHaveBeenCalled();
    expect([...host.querySelectorAll<HTMLInputElement>('.photo-selection-input')].map(input => input.checked)).toEqual([true, false, true, false]);
  });

  it('rejects the entire Q batch when any eligible selection has a locked Queue status', async () => {
    items = [item(ids[0]), item(ids[2], 'waiting')]; await mount();
    await click(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!);
    await click(card(2).querySelector<HTMLInputElement>('.photo-selection-input')!);
    await pressQ();
    expect(api.dequeue).not.toHaveBeenCalled(); expect(api.enqueue).not.toHaveBeenCalled();
    expect(host.querySelector('.home-queue-error')?.textContent).toContain('cannot be removed');
  });

  it('does not start a duplicate batch while the first Q enqueue is pending', async () => {
    const pending = deferred<ExportQueueItem[]>(); api.enqueue.mockReturnValue(pending.promise);
    await mount();
    await click(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!);
    await click(card(2).querySelector<HTMLInputElement>('.photo-selection-input')!);
    await pressQ(); await pressQ();
    expect(api.enqueue).toHaveBeenCalledTimes(1);
    items = [item(ids[0]), item(ids[2])];
    await act(async () => pending.resolve([item(ids[0]), item(ids[2])]));
    expect(items.map(value => value.assetId)).toEqual([ids[0], ids[2]]);
    expect(badge(0).classList.contains('queue-queued')).toBe(true);
    expect(badge(2).classList.contains('queue-queued')).toBe(true);
    expect([...host.querySelectorAll<HTMLInputElement>('.photo-selection-input')].map(input => input.checked)).toEqual([true, false, true, false]);
  });

  it.each([[100, [100]], [101, [100, 1]]] as const)('chunks a %s-member Q enqueue at the API limit', async (count, chunkSizes) => {
    const members = useLargeStack(count);
    await mount(); await click(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!); await pressQ();
    const requests = api.enqueue.mock.calls.map(([assetIds]) => assetIds as string[]);
    expect(requests.map(request => request.length)).toEqual(chunkSizes);
    expect(requests.flat()).toEqual(members);
    expect(items.map(value => value.assetId)).toEqual(members);
    expect(badge(0).classList.contains('queue-queued')).toBe(true);
    expect(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!.checked).toBe(true);
  });

  it('keeps successful Q enqueue chunks, refreshes canonical membership, and retains selection after a later chunk fails', async () => {
    const members = useLargeStack(101);
    api.enqueue.mockImplementationOnce(async (requested: string[]) => {
      for (const id of requested) items.push(item(id));
      return [...items];
    }).mockRejectedValueOnce(new ExportQueueApiError('network'));
    await mount(); await click(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!); await pressQ();
    await flushQueueRefresh();
    expect(api.enqueue.mock.calls.map(([requested]) => (requested as string[]).length)).toEqual([100, 1]);
    expect(items.map(value => value.assetId)).toEqual(members.slice(0, 100));
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(badge(0).classList.contains('queue-queued')).toBe(true);
    expect(host.querySelector('.home-queue-error')?.textContent).toContain('Could not add');
    expect(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!.checked).toBe(true);
  });

  it('keeps successful Q dequeues, refreshes canonical membership, and retains selection after a later member fails', async () => {
    useStack(); items = [item(ids[0]), item(ids[1]), item(ids[2])];
    api.dequeue.mockImplementation(async id => {
      if (id === ids[1]) throw new ExportQueueApiError('network');
      items = items.filter(value => value.assetId !== id);
    });
    await mount(); await click(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!); await pressQ();
    await flushQueueRefresh();
    expect(api.dequeue.mock.calls.map(([id]) => id)).toEqual([ids[0], ids[1]]);
    expect(items.map(value => value.assetId)).toEqual([ids[1], ids[2]]);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(badge(0).classList.contains('queue-queued')).toBe(true);
    expect(badge(2).classList.contains('queue-queued')).toBe(true);
    expect(host.querySelector('.home-queue-error')?.textContent).toContain('Could not remove');
    expect(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!.checked).toBe(true);
  });

  it.each(['checkbox', 'range'] as const)('ignores Home Q while a %s input has focus', async type => {
    await mount(); await click(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!);
    const input = type === 'checkbox' ? card(2).querySelector<HTMLInputElement>('.photo-selection-input')!
      : document.createElement('input');
    if (type === 'range') { input.type = 'range'; host.append(input); }
    input.focus();
    const event = await pressQ(input);
    expect(event.defaultPrevented).toBe(false);
    expect(api.enqueue).not.toHaveBeenCalled();
    expect(api.dequeue).not.toHaveBeenCalled();
    expect(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!.checked).toBe(true);
  });

  it.each([{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }] as const)
  ('keeps modified Q from toggling the selection batch (%j)', async modifiers => {
    await mount(); await click(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!);
    const event = await pressQ(window, modifiers);
    expect(event.defaultPrevented).toBe(false);
    expect(api.enqueue).not.toHaveBeenCalled(); expect(api.dequeue).not.toHaveBeenCalled();
  });

  it('runs Home Q from a focused non-input control', async () => {
    await mount(); await click(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!);
    const focusTarget = card(0).querySelector<HTMLButtonElement>('.photo-card-button')!;
    focusTarget.focus();
    const event = await pressQ(focusTarget);
    expect(event.defaultPrevented).toBe(true);
    expect(api.enqueue).toHaveBeenCalledWith([ids[0]], expect.any(AbortSignal));
    expect(items.map(value => value.assetId)).toEqual([ids[0]]);
  });

  it.each([[100, [100]], [101, [100, 1]]] as const)('chunks a %s-member Stack badge enqueue at the API limit', async (count, chunkSizes) => {
    const members = useLargeStack(count);
    await mount(); await click(badge());
    const requests = api.enqueue.mock.calls.map(([assetIds]) => assetIds as string[]);
    expect(requests.map(request => request.length)).toEqual(chunkSizes);
    expect(requests.flat()).toEqual(members);
    expect(items.map(value => value.assetId)).toEqual(members);
    expect(badge(0).classList.contains('queue-queued')).toBe(true);
  });

  it('keeps successful Stack badge chunks and refreshes canonical Queue state after a later chunk fails', async () => {
    const members = useLargeStack(101);
    api.enqueue.mockImplementationOnce(async (requested: string[]) => {
      for (const id of requested) items.push(item(id));
      return [...items];
    }).mockRejectedValueOnce(new ExportQueueApiError('network'));
    await mount(); await click(badge()); await flushQueueRefresh();
    expect(api.enqueue.mock.calls.map(([requested]) => (requested as string[]).length)).toEqual([100, 1]);
    expect(items.map(value => value.assetId)).toEqual(members.slice(0, 100));
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(badge(0).classList.contains('queue-queued')).toBe(true);
    expect(host.querySelector('.home-queue-error')?.textContent).toContain('Could not add');
  });

  it.each([
    ['network', 'Could not add'], ['not_eligible', 'current adjustments'], ['locked', 'cannot be removed'],
  ] as const)('reports enqueue %s safely and retains selection and view', async (kind, description) => {
    api.enqueue.mockRejectedValue(new ExportQueueApiError(kind));
    await mount(); await click(card().querySelector<HTMLInputElement>('.photo-selection-input')!);
    host.querySelector('.home-content')!.scrollTop = 150;
    await click(badge());
    expect(host.querySelector('.home-queue-error')?.textContent).toContain(description);
    expect(card().querySelector<HTMLInputElement>('.photo-selection-input')!.checked).toBe(true);
    expect(badge().getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('.home-content')!.scrollTop).toBe(150);
    expect(host.querySelector('#home-recent-tab')?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('Home Stack Queue aggregation', () => {
  it.each([
    [true, false, [ids[0]]], [false, true, [ids[1]]], [true, true, [ids[0], ids[1]]],
    [true, undefined, [ids[0]]],
  ] as const)('batch enqueues only known non-default members (JPEG=%s RAW=%s)', async (jpeg, raw, expected) => {
    useStack({ [ids[0]]: jpeg, [ids[1]]: raw }); await mount();
    expect(badge().classList.contains('queue-inactive')).toBe(true);
    await click(badge());
    expect(api.enqueue).toHaveBeenCalledTimes(1);
    expect(api.enqueue).toHaveBeenCalledWith(expected, expect.any(AbortSignal));
    expect(api.dequeue).not.toHaveBeenCalled();
  });

  it.each([[[ids[0]]], [[ids[1]]], [[ids[0], ids[1]]]])('uses one ON state and removes only currently queued members (%j)', async queued => {
    useStack(); items = queued.map(id => item(id)); await mount();
    expect(badge().getAttribute('aria-pressed')).toBe('true');
    expect(badge().classList.contains('queue-queued')).toBe(true);
    expect(badge().className).not.toContain('partial');
    await click(badge());
    expect(api.dequeue.mock.calls.map(([id]) => id)).toEqual(queued);
    expect(badge().classList.contains('queue-inactive')).toBe(true);
    expect(badge().getAttribute('aria-pressed')).toBe('false');
    expect(api.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['queued', 'waiting', 'Waiting for export', true],
    ['failed', 'encoding', 'Encoding JPEG', true],
    ['waiting', 'registering', 'Registering with Immich', true],
    ['queued', 'failed', 'Export failed', false],
  ] as const)('aggregates runtime priority %s / %s without a partial state', async (jpeg, raw, label, locked) => {
    useStack(); items = [item(ids[0], jpeg), item(ids[1], raw)]; await mount();
    expect(badge().disabled).toBe(locked); expect(badge().title).toContain(label);
    expect(badge().getAttribute('aria-pressed')).toBe('true');
    await click(badge());
    expect(api.dequeue).toHaveBeenCalledTimes(locked ? 0 : 2);
  });

  it('leaves a partially queued Stack untouched while turning Queue on for another selected card', async () => {
    useStack(); items = [item(ids[1])]; await mount();
    await click(card(0).querySelector<HTMLInputElement>('.photo-selection-input')!);
    await click(card(2).querySelector<HTMLInputElement>('.photo-selection-input')!);
    await pressQ();
    expect(api.enqueue).toHaveBeenCalledWith([ids[2]], expect.any(AbortSignal));
    expect(api.dequeue).not.toHaveBeenCalled();
    expect(items.map(value => value.assetId)).toEqual([ids[1], ids[2]]);
  });

  it('retains successful removals and unrelated membership after a later member fails', async () => {
    useStack(); items = [item(ids[0]), item(ids[1]), item(ids[2])];
    api.dequeue.mockImplementation(async id => {
      if (id === ids[1]) throw new ExportQueueApiError('network');
      items = items.filter(value => value.assetId !== id);
    });
    await mount(); await click(card().querySelector<HTMLInputElement>('.photo-selection-input')!);
    await click(badge());
    expect(api.dequeue.mock.calls.map(([id]) => id)).toEqual([ids[0], ids[1]]);
    expect(items.map(value => value.assetId)).toEqual([ids[1], ids[2]]);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(badge().getAttribute('aria-pressed')).toBe('true');
    expect(badge(2).getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.home-queue-error')?.textContent).toContain('Could not remove');
    expect(card().querySelector<HTMLInputElement>('.photo-selection-input')!.checked).toBe(true);
    expect(api.enqueue).not.toHaveBeenCalled();
  });

  it('does not continue sequential removals or refresh after unmount', async () => {
    useStack(); items = [item(ids[0]), item(ids[1])];
    const pending = deferred<void>(); api.dequeue.mockReturnValue(pending.promise);
    await mount(); await click(badge());
    const signal = api.dequeue.mock.calls[0][1] as AbortSignal;
    await act(async () => root.render(<div />));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve());
    expect(api.dequeue).toHaveBeenCalledTimes(1); expect(api.list).toHaveBeenCalledTimes(1);
  });
});
