// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AssetDetail, WorkspaceNavigationState } from './assets';
import * as editStateModule from './editState';
import { EditStateApiError } from './editStateApi';
import i18n from './i18n';
import { clearWorkspaceSession, readWorkspaceSession } from './workspaceResume';
import { updateSetting } from './appSettings';
import { formatShortcut } from './shortcutDisplay';
import { makeGalleryStack } from './gallerySelectionTestHelpers';
import { getManualGalleryStackSelection, restoreGalleryStackSelectionsFromSession, setManualGalleryStackSelection } from './useGalleryStackSelections';

const mocked = vi.hoisted(() => ({ detail: vi.fn(), get: vi.fn(), put: vi.fn(), statuses: vi.fn(), recent: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()), fetchAssetDetail: mocked.detail, fetchRecentAssets: mocked.recent,
}));
vi.mock('./editStateApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./editStateApi')>()),
  getAssetEditState: mocked.get, putAssetEditState: mocked.put, getAssetEditStatuses: mocked.statuses,
}));
vi.mock('./ImageViewer', () => ({ ImageViewer: () => <div className="viewer-panel">Viewer</div> }));
vi.mock('./exportQueueApi', async importOriginal => ({
  ...await importOriginal<typeof import('./exportQueueApi')>(), listExportQueue: async () => [],
}));

const first: AssetDetail = {
  id: '12345678-1234-4234-9234-123456789abc', filename: 'first.jpg', date: '2026-09-25T00:00:00Z',
  thumbnail_url: '/first-thumb', preview_url: '/first-preview', format: 'JPEG', is_raw: false, exif: {},
};
const second: AssetDetail = { ...first, id: '87654321-4321-4321-8321-cba987654321', filename: 'second.jpg' };

let root: Root;
let container: HTMLDivElement;
async function flush() { await act(async () => { await Promise.resolve(); }); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function click(selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing button: ${selector}`);
  await act(async () => { button.click(); });
}
async function mount() {
  const state: WorkspaceNavigationState = { selectedAssets: [first, second], activeAssetId: first.id };
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[{ pathname: `/anshitsu/${first.id}`, state }]}><App /></MemoryRouter>);
  });
  await flush();
}
const currentPhoto = () => container.querySelector('.filmstrip-item[aria-current="true"]')?.getAttribute('aria-label');
async function filmstripKey(value = 'ArrowRight', init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  await act(async () => { target.dispatchEvent(event); });
  await flush();
  return event;
}
function currentHistoryEntry() {
  return container.querySelector('.edit-history [aria-current="step"]')?.textContent;
}
async function editWithUndoAndRedoAvailable() {
  await click('button[aria-label="Disable Basic"]');
  await click('button[aria-label="Disable Color"]');
  const undo = [...container.querySelectorAll<HTMLButtonElement>('.edit-actions button')]
    .find((button) => button.textContent === i18n.t('workspace.undo'))!;
  await act(async () => undo.click());
  await flush();
  expect(currentHistoryEntry()).toContain('Basic OFF');
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en');
  clearWorkspaceSession();
  sessionStorage.clear(); restoreGalleryStackSelectionsFromSession();
  mocked.recent.mockReset().mockRejectedValue(new Error('Unavailable'));
  updateSetting('showKeyboardShortcuts', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  mocked.detail.mockReset(); mocked.get.mockReset(); mocked.put.mockReset();
  mocked.detail.mockImplementation(async (id: string) => id === first.id ? first : second);
  mocked.get.mockResolvedValue({ state: null });
  mocked.statuses.mockReset();
  mocked.statuses.mockResolvedValue({ [first.id]: false, [second.id]: true });
  mocked.put.mockImplementation(async (_id, snapshot, revision, saveId) => ({
    state: snapshot, revision: revision + 1, updatedAt: '2026-09-25T00:00:00Z', lastSaveId: saveId,
  }));
});
afterEach(() => { act(() => root.unmount()); container.remove(); clearWorkspaceSession(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Anshitsu Filmstrip persistence', () => {
  it('round-trips an expanded mixed Stack, saving JPEGs independently and resuming the last non-JPEG Asset', async () => {
    const stack = makeGalleryStack(1, ['JPEG', 'JPEG', 'DNG', 'PNG']);
    const members = stack.stackMembers!;
    setManualGalleryStackSelection(stack, new Set(members.map(asset => asset.id)));
    mocked.recent.mockResolvedValue([stack]);
    mocked.detail.mockImplementation(async (id: string) => ({ ...members.find(asset => asset.id === id)!, preview_url: '/preview', exif: {} }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok', configured: true, connected: true }))));
    await act(async () => root.render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>));
    await flush();
    await click('.photo-selection-input');
    await filmstripKey('d');
    expect(container.querySelectorAll('.filmstrip-item')).toHaveLength(4);
    expect(currentPhoto()).toBe(members[0].filename);
    await click('button[aria-label="Disable Basic"]');
    await click(`.filmstrip-item[aria-label="${members[1].filename}"]`);
    expect(currentPhoto()).toBe(members[1].filename);
    await click('button[aria-label="Disable Basic"]');
    await click(`.filmstrip-item[aria-label="${members[2].filename}"]`);
    expect(currentPhoto()).toBe(members[2].filename);
    const ranges = [...container.querySelectorAll<HTMLInputElement>('.develop-panel input[type="range"]')];
    expect(ranges).toHaveLength(0);
    expect(container.querySelector('.develop-panel')?.textContent).toContain(i18n.t('workspace.jpegOnly'));
    await click(`.filmstrip-item[aria-label="${members[3].filename}"]`);
    expect(currentPhoto()).toBe(members[3].filename);
    expect(container.querySelector('.develop-panel')?.textContent).toContain(i18n.t('workspace.jpegOnly'));
    expect(mocked.put.mock.calls.map(call => call[0])).toEqual([members[0].id, members[1].id]);
    await filmstripKey('g');
    expect(container.querySelector('.home-page')).not.toBeNull();
    expect(readWorkspaceSession()?.selectedAssets.map(asset => asset.id)).toEqual(members.map(asset => asset.id));
    expect(readWorkspaceSession()?.activeAssetId).toBe(members[3].id);
    expect([...getManualGalleryStackSelection(stack.stackId!)!]).toEqual(members.map(asset => asset.id));
    await filmstripKey('d');
    expect(container.querySelectorAll('.filmstrip-item')).toHaveLength(4);
    expect(currentPhoto()).toBe(members[3].filename);
  });
  it('shows G and Undo/Redo hints without adding G to HomeTitle, and still exits with G when OFF', async () => {
    await mount();
    const home = container.querySelector<HTMLButtonElement>('.workspace-actions button')!;
    const historyButtons = [...container.querySelectorAll<HTMLButtonElement>('.edit-actions button')];
    expect(home.title).toContain(`(${formatShortcut('workspaceReturnHome')})`);
    for (const id of ['undo', 'redo'] as const) {
      const button = historyButtons.find(item => item.textContent === i18n.t(`workspace.${id}`))!;
      expect(button.title).toContain(`(${formatShortcut(id)})`);
    }
    expect(container.querySelector('.workspace-title-link')?.getAttribute('title') ?? '').not.toContain('(G)');
    act(() => updateSetting('showKeyboardShortcuts', false));
    expect(home.title).toBe(i18n.t('workspace.backToPhotos'));
    for (const id of ['undo', 'redo'] as const) {
      expect(historyButtons.find(item => item.textContent === i18n.t(`workspace.${id}`))!.title).toBe(i18n.t(`workspace.${id}`));
    }
    await filmstripKey('g');
    expect(container.querySelector('.workspace-page')).toBeNull();
    act(() => updateSetting('showKeyboardShortcuts', true));
  });
  it('preserves History, Undo/Redo, Filmstrip and the existing autosave deadline across Settings', async ({ onTestFinished }) => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false; } });
    onTestFinished(() => { Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close'); });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    vi.useFakeTimers(); await mount();
    await click('button[aria-label="Disable Basic"]');
    const history = container.querySelector('.edit-history')!.innerHTML;
    const getCount = mocked.get.mock.calls.length;
    await advance(3000);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!;
    trigger.focus(); await click('[aria-label="Settings"]');
    await filmstripKey(); await filmstripKey('z', { ctrlKey: true });
    const select = container.querySelector('dialog select')!;
    await filmstripKey('z', { ctrlKey: true }, select);
    expect(currentPhoto()).toBe('first.jpg');
    expect(container.querySelector('.edit-history')!.innerHTML).toBe(history);
    await advance(1999); expect(mocked.put).not.toHaveBeenCalled();
    await advance(1); expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(mocked.put.mock.calls[0][1].currentRecipe.basicEnabled).toBe(false);
    await filmstripKey('Escape', {}, container.querySelector('dialog button')!);
    expect(container.querySelector('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
    expect(mocked.get).toHaveBeenCalledTimes(getCount);
    await click('.edit-actions button'); expect(container.querySelector('button[aria-label="Disable Basic"]')).not.toBeNull();
    await click('.edit-actions button:nth-child(2)'); expect(container.querySelector('button[aria-label="Enable Basic"]')).not.toBeNull();
    expect(currentPhoto()).toBe('first.jpg');
  });
  it('keeps the confirmed saved badge after a later rejected save and discard without refetching statuses', async () => {
    vi.useFakeTimers();
    const bulk = deferred<Record<string, boolean>>();
    mocked.statuses.mockReturnValueOnce(bulk.promise);
    await mount();
    await click('button[aria-label="Disable Basic"]');
    await advance(5000);
    expect(mocked.put).toHaveBeenCalledTimes(1);
    await click('button[aria-label="Disable Color"]');
    mocked.put.mockRejectedValueOnce(new EditStateApiError('invalid_state', 422));
    await click('.filmstrip-item[aria-label="second.jpg"]');
    expect(currentPhoto()).toBe('first.jpg');
    const move = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find(button => button.textContent === 'Move without saving')!;
    await act(async () => move.click()); await flush();
    expect(currentPhoto()).toBe('second.jpg');
    expect(container.querySelector('.filmstrip-item[aria-label="first.jpg"] + .edited-badge')).not.toBeNull();
    await act(async () => bulk.resolve({ [first.id]: false, [second.id]: true }));
    expect(container.querySelector('.filmstrip-item[aria-label="first.jpg"] + .edited-badge')).not.toBeNull();
    expect(mocked.statuses).toHaveBeenCalledTimes(1);
    expect(mocked.get.mock.calls.map(([id]) => id)).toEqual([first.id, second.id]);
  });

  it('masks a delayed bulk result after an uncertain save is discarded until a fresh GET', async () => {
    const bulk = deferred<Record<string, boolean>>();
    mocked.statuses.mockReturnValueOnce(bulk.promise);
    await mount(); await click('button[aria-label="Disable Basic"]');
    mocked.put.mockRejectedValueOnce(new EditStateApiError('unexpected', 504, undefined, 'unknown'));
    await click('.filmstrip-item[aria-label="second.jpg"]');
    const savedSnapshot = mocked.put.mock.calls[0][1];
    const move = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find(button => button.textContent === 'Move without saving')!;
    await act(async () => move.click()); await flush();
    await act(async () => bulk.resolve({ [first.id]: true, [second.id]: true }));
    expect(currentPhoto()).toBe('second.jpg');
    expect(container.querySelector('.filmstrip-item[aria-label="first.jpg"] + .edited-badge')).toBeNull();
    expect(mocked.statuses).toHaveBeenCalledTimes(1);
    const get = deferred<any>();
    mocked.get.mockReturnValueOnce(get.promise);
    await click('.filmstrip-item[aria-label="first.jpg"]');
    expect(container.querySelector('.filmstrip-item[aria-label="first.jpg"] + .edited-badge')).toBeNull();
    await act(async () => get.resolve({ state: savedSnapshot, revision: 1,
      updatedAt: '2026-09-25T00:00:00Z', lastSaveId: mocked.put.mock.calls[0][3] }));
    expect(container.querySelector('.filmstrip-item[aria-label="first.jpg"] + .edited-badge')).not.toBeNull();
    expect(mocked.put).toHaveBeenCalledTimes(1);
  });

  it('replays an uncertain HTTP autosave before saving newer edits on a Filmstrip switch', async () => {
    vi.useFakeTimers();
    await mount(); await click('button[aria-label="Disable Basic"]');
    mocked.put.mockRejectedValueOnce(new EditStateApiError('unexpected', 504, undefined, 'unknown'));
    await advance(5000);
    await click('button[aria-label="Disable Color"]');
    await click('.filmstrip-item[aria-label="second.jpg"]');
    expect(currentPhoto()).toBe('second.jpg');
    expect(mocked.put).toHaveBeenCalledTimes(3);
    expect(mocked.put.mock.calls[1].slice(1, 4)).toEqual(mocked.put.mock.calls[0].slice(1, 4));
    expect(mocked.put.mock.calls[2][2]).toBe(1);
    expect(mocked.put.mock.calls[2][1].currentRecipe).toMatchObject({ basicEnabled: false, colorEnabled: false });
  });

  it('shows saved status for inactive photos and prioritizes live edits over a delayed bulk response', async () => {
    const waiting = deferred<Record<string, boolean>>();
    mocked.statuses.mockReturnValueOnce(waiting.promise);
    await mount();
    expect(container.querySelector('.edited-badge')).toBeNull();
    await click('button[aria-label="Disable Basic"]');
    expect(container.querySelector('.filmstrip-item[aria-current="true"] + .edited-badge')).not.toBeNull();
    await act(async () => waiting.resolve({ [first.id]: false, [second.id]: true }));
    expect(container.querySelectorAll('.filmstrip .edited-badge')).toHaveLength(2);
    await click('.filmstrip-item[aria-label="second.jpg"]');
    // The full GET validates this photo as initial, superseding the older summary.
    expect(container.querySelector('.filmstrip-item[aria-current="true"] + .edited-badge')).toBeNull();
    expect(container.querySelector('.filmstrip-item[aria-label="first.jpg"] + .edited-badge')).not.toBeNull();
    expect(mocked.statuses).toHaveBeenCalledTimes(1);
  });
  it('navigates globally in both directions without saving a clean photo', async () => {
    await mount();
    await filmstripKey('ArrowRight', { ctrlKey: true, shiftKey: true }); expect(currentPhoto()).toBe('second.jpg');
    await filmstripKey('ArrowRight', { ctrlKey: true, shiftKey: true }); expect(currentPhoto()).toBe('second.jpg');
    await filmstripKey('ArrowLeft', { ctrlKey: true, shiftKey: true }); expect(currentPhoto()).toBe('first.jpg');
    expect(mocked.put).not.toHaveBeenCalled();
    expect(mocked.get.mock.calls.map(([id]) => id)).toEqual([first.id, second.id, first.id]);
  });

  it('saves before keyboard navigation and ignores repeated switches during the pending save', async () => {
    vi.useFakeTimers();
    const pending = deferred<any>();
    mocked.put.mockReturnValueOnce(pending.promise);
    await mount(); await click('button[aria-label="Disable Basic"]');
    await filmstripKey('ArrowRight', { ctrlKey: true, shiftKey: true });
    expect(currentPhoto()).toBe('first.jpg');
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect((await filmstripKey('g')).defaultPrevented).toBe(false);
    expect(container.querySelector('.workspace-page')).not.toBeNull();
    for (let index = 0; index < 4; index++) await filmstripKey('ArrowRight', { ctrlKey: true, shiftKey: true, repeat: true });
    await filmstripKey('ArrowLeft', { ctrlKey: true, shiftKey: true });
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(mocked.get).toHaveBeenCalledTimes(1);
    const [id, state, revision, saveId] = mocked.put.mock.calls[0];
    expect(id).toBe(first.id);
    expect(state.history).toHaveLength(1);
    await act(async () => pending.resolve({ state, revision: revision + 1, lastSaveId: saveId, updatedAt: first.date }));
    await flush();
    expect(currentPhoto()).toBe('second.jpg');
    expect(mocked.get.mock.calls.map(([assetId]) => assetId)).toEqual([first.id, second.id]);
  });

  it('uses the existing save-failure confirmation and retains edits on Stay', async () => {
    vi.useFakeTimers();
    mocked.put.mockRejectedValueOnce(new EditStateApiError('conflict', 409, 'revision_conflict'));
    await mount(); await click('button[aria-label="Disable Basic"]');
    await filmstripKey('ArrowRight', { ctrlKey: true, shiftKey: true });
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(currentPhoto()).toBe('first.jpg');
    expect((await filmstripKey('g')).defaultPrevented).toBe(false);
    expect(container.querySelector('.workspace-page')).not.toBeNull();
    await filmstripKey('ArrowRight', { ctrlKey: true, shiftKey: true });
    expect(container.querySelector('.filmstrip-item[aria-current="true"] + .edited-badge')).not.toBeNull();
    expect(mocked.put).toHaveBeenCalledTimes(1);
    const stay = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Stay on this photo')!;
    await act(async () => stay.click());
    expect(container.querySelector('button[aria-label="Enable Basic"]')).not.toBeNull();
    expect(container.querySelector('.edit-history')?.textContent).toContain('Basic OFF');
    expect(currentPhoto()).toBe('first.jpg');
  });

  it('blocks every Undo/Redo shortcut while a Filmstrip save-failure dialog is open, then restores them on Stay', async () => {
    vi.useFakeTimers();
    mocked.put.mockRejectedValueOnce(new EditStateApiError('conflict', 409, 'revision_conflict'));
    await mount();
    await editWithUndoAndRedoAvailable();
    await filmstripKey('ArrowRight', { ctrlKey: true, shiftKey: true });
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('Stay on this photo');

    const before = currentHistoryEntry();
    for (const shortcut of [
      { key: 'z', ctrlKey: true }, { key: 'z', metaKey: true },
      { key: 'Z', ctrlKey: true, shiftKey: true }, { key: 'Z', metaKey: true, shiftKey: true },
      { key: 'y', ctrlKey: true }, { key: 'y', metaKey: true },
    ]) {
      await filmstripKey(shortcut.key, shortcut);
      expect(currentHistoryEntry()).toBe(before);
    }

    const stay = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Stay on this photo')!;
    await act(async () => stay.click());
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    await filmstripKey('z', { ctrlKey: true });
    expect(currentHistoryEntry()).toContain('Initial State');
    await filmstripKey('Z', { ctrlKey: true, shiftKey: true });
    expect(currentHistoryEntry()).toContain('Basic OFF');
  });

  it('blocks Undo behind the Home-exit save-failure dialog', async () => {
    mocked.put.mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await mount();
    await click('button[aria-label="Disable Basic"]');
    await filmstripKey('g');
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('Stay in Develop');
    const before = currentHistoryEntry();
    await filmstripKey('z', { ctrlKey: true });
    expect(currentHistoryEntry()).toBe(before);
    expect(currentPhoto()).toBe('first.jpg');
  });

  it('moves globally from slider focus while leaving ordinary slider arrows available', async () => {
    await mount();
    const range = container.querySelector<HTMLInputElement>('.adjustment-range')!;
    await act(async () => range.focus());
    await filmstripKey('ArrowRight', { ctrlKey: true, shiftKey: true }, range);
    expect(currentPhoto()).toBe('second.jpg');
    expect(mocked.put).not.toHaveBeenCalled();
    const activeRange = container.querySelector<HTMLInputElement>('.adjustment-range')!;
    await act(async () => activeRange.focus());
    await filmstripKey('ArrowRight', {}, activeRange);
    expect(currentPhoto()).toBe('second.jpg');
  });

  it('blocks Filmstrip keys while a History menu or confirmation dialog is open', async ({ onTestFinished }) => {
    const show = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
    onTestFinished(() => {
      if (show) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', show);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
      if (close) Object.defineProperty(HTMLDialogElement.prototype, 'close', close);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    });
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; };
    vi.useFakeTimers(); await mount();
    await click('button[aria-label="Disable Basic"]');
    await click('.history-menu-trigger');
    await filmstripKey(); expect(currentPhoto()).toBe('first.jpg');
    const clear = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')]
      .find((button) => button.textContent === 'Clear all history')!;
    await act(async () => clear.click());
    expect(container.querySelector('dialog')).not.toBeNull();
    await filmstripKey(); expect(currentPhoto()).toBe('first.jpg');
    expect(mocked.put).not.toHaveBeenCalled();
  });

  it('keeps History controls and cursor unchanged when EXIF is collapsed and expanded', async () => {
    vi.useFakeTimers();
    await mount();
    await click('button[aria-label="Disable Basic"]');
    const history = container.querySelector('.left-history-section')!;
    const scroll = history.querySelector('.history-scroll-region')!;
    const actions = history.querySelector('.edit-actions')!;
    expect(history.querySelector('h2')?.textContent).toBe('History');
    expect(history.querySelector('.history-menu-trigger')).not.toBeNull();
    expect(actions.textContent).toBe('UndoRedo');
    expect(scroll.contains(actions)).toBe(false);
    expect(scroll.contains(history.querySelector('.workspace-section-header'))).toBe(false);
    const toggle = container.querySelector<HTMLButtonElement>('.exif-toggle')!;
    const content = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(content.hidden).toBe(false);
    expect(content.querySelector('.exif-list')).not.toBeNull();
    const before = scroll.innerHTML;
    for (const expanded of [false, true]) {
      await click('.exif-toggle');
      expect(toggle.getAttribute('aria-expanded')).toBe(String(expanded));
      expect(content.hidden).toBe(!expanded);
      expect(scroll.innerHTML).toBe(before);
      expect(container.querySelector('button[aria-label="Enable Basic"]')).not.toBeNull();
    }
    expect(mocked.put).not.toHaveBeenCalled();
    await act(async () => { (actions.querySelectorAll('button')[0] as HTMLButtonElement).click(); });
    expect(container.querySelector('button[aria-label="Disable Basic"]')).not.toBeNull();
    await click('.exif-toggle');
    await act(async () => { (actions.querySelectorAll('button')[1] as HTMLButtonElement).click(); });
    expect(container.querySelector('button[aria-label="Enable Basic"]')).not.toBeNull();
  });

  it('switches a clean photo without PUT and loads the next photo', async () => {
    await mount();
    await click('button[aria-label="second.jpg"]'); await flush();
    expect(mocked.put).not.toHaveBeenCalled();
    expect(currentPhoto()).toBe('second.jpg');
    expect(mocked.get.mock.calls.map(([id]) => id)).toEqual([first.id, second.id]);
  });

  it('marks the target active while its GET is pending and enables Develop after restore', async () => {
    let resolveLoad!: (result: { state: null }) => void;
    const pendingGet = new Promise<{ state: null }>((resolve) => { resolveLoad = resolve; });
    mocked.get.mockResolvedValueOnce({ state: null }).mockReturnValueOnce(pendingGet);
    await mount();
    await click('button[aria-label="second.jpg"]');
    expect(currentPhoto()).toBe('second.jpg');
    expect(container.querySelector('button[aria-label="Disable Basic"]')).toBeNull();
    expect(container.textContent).toContain('Loading saved edits');
    await act(async () => { resolveLoad({ state: null }); await pendingGet; });
    await flush();
    expect(container.querySelector('button[aria-label="Disable Basic"]')).not.toBeNull();
  });

  it('saves a dirty photo before switching and uses the full uncompressed History', async () => {
    await mount();
    await click('button[aria-label="Disable Basic"]');
    await click('button[aria-label="second.jpg"]'); await flush();
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(mocked.put.mock.calls[0][1].history).toHaveLength(1);
    expect(mocked.put.mock.calls[0][2]).toBe(0);
    expect(currentPhoto()).toBe('second.jpg');
  });

  it('confirms a lost autosave response before saving newer edits and switching photos', async () => {
    vi.useFakeTimers();
    let stored: { state: any; revision: number; saveId: string; expectedRevision: number } | null = null;
    let loseResponse = true;
    mocked.put.mockImplementation(async (_id: string, state: any, expectedRevision: number, saveId: string) => {
      if (stored?.saveId === saveId) {
        if (stored.expectedRevision !== expectedRevision || JSON.stringify(stored.state) !== JSON.stringify(state)) {
          throw new EditStateApiError('conflict', 409, 'save_id_reused');
        }
        return { state: stored.state, revision: stored.revision, updatedAt: '2026-09-25T00:00:00Z', lastSaveId: saveId };
      }
      if (expectedRevision !== (stored?.revision ?? 0)) {
        throw new EditStateApiError('conflict', 409, 'revision_conflict');
      }
      stored = { state, revision: expectedRevision + 1, saveId, expectedRevision };
      if (loseResponse) {
        loseResponse = false;
        throw new EditStateApiError('network');
      }
      return { state, revision: stored.revision, updatedAt: '2026-09-25T00:00:00Z', lastSaveId: saveId };
    });
    await mount();
    await click('button[aria-label="Disable Basic"]');
    await advance(5000);
    expect(mocked.put).toHaveBeenCalledTimes(1);
    await click('button[aria-label="Enable Basic"]');
    await click('button[aria-label="second.jpg"]'); await flush();
    expect(mocked.put).toHaveBeenCalledTimes(3);
    expect(mocked.put.mock.calls[1].slice(1, 4)).toEqual(mocked.put.mock.calls[0].slice(1, 4));
    expect(mocked.put.mock.calls[2][2]).toBe(1);
    expect((stored as { revision: number } | null)?.revision).toBe(2);
    expect(currentPhoto()).toBe('second.jpg');
  });

  it('switches after a successful PUT for a numeric adjustment edit', async () => {
    await mount();
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => { bytes.fill(0); return bytes; } } as unknown as Crypto);
    const exposure = container.querySelectorAll<HTMLInputElement>('.adjustment-category input[type="range"]')[2];
    if (!exposure) throw new Error('Missing Exposure slider');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(exposure, '0.5');
      exposure.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(exposure.value).toBe('0.5');
    await click('button[aria-label="second.jpg"]'); await flush();
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(mocked.put.mock.calls[0][1].currentRecipe.adjustments.exposure).toBe(0.5);
    expect(currentPhoto()).toBe('second.jpg');
  });

  it.each([
    ['revision_conflict', 'changed elsewhere'],
    ['save_id_reused', 'could not be retried'],
  ])('keeps local edits for %s when the user stays', async (code, message) => {
    mocked.put.mockRejectedValueOnce(new EditStateApiError('conflict', 409, code));
    await mount(); await click('button[aria-label="Disable Basic"]');
    await click('button[aria-label="second.jpg"]');
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(message);
    const stay = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Stay on this photo');
    if (!stay) throw new Error('Missing stay button');
    await act(async () => { stay.click(); });
    expect(currentPhoto()).toBe('first.jpg');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Enable Basic"]')).not.toBeNull();
  });

  it('discards uncertain local state without rollback and re-GETs when revisited', async () => {
    mocked.put.mockRejectedValueOnce(new EditStateApiError('network'));
    await mount(); await click('button[aria-label="Disable Basic"]');
    await click('button[aria-label="second.jpg"]');
    const discard = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Move without saving');
    if (!discard) throw new Error('Missing discard button');
    await act(async () => { discard.click(); }); await flush();
    expect(currentPhoto()).toBe('second.jpg');
    await click('button[aria-label="first.jpg"]'); await flush();
    expect(mocked.get.mock.calls.map(([id]) => id)).toEqual([first.id, second.id, first.id]);
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="Disable Basic"]')).not.toBeNull();
  });

  it('shows load failure and retries before enabling controls', async () => {
    mocked.get.mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await mount();
    expect(container.textContent).toContain('Saved edits could not be loaded');
    expect(container.querySelector('button[aria-label="Disable Basic"]')).toBeNull();
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry');
    if (!retry) throw new Error('Missing retry button');
    await act(async () => { retry.click(); }); await flush();
    expect(container.querySelector('button[aria-label="Disable Basic"]')).not.toBeNull();
  });

  it('shows a nonblocking localized warning when autosave fails and keeps Develop available', async () => {
    vi.useFakeTimers();
    mocked.put.mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await mount();
    await click('button[aria-label="Disable Basic"]');
    await advance(5000); await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Autosave failed');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Enable Basic"]')).not.toBeNull();
    expect(mocked.put).toHaveBeenCalledTimes(1);
    await advance(15000);
    expect(mocked.put).toHaveBeenCalledTimes(1);
  });

  it('cancels the debounce before a Filmstrip save so the same dirty state is not PUT twice', async () => {
    vi.useFakeTimers();
    await mount();
    await click('button[aria-label="Disable Basic"]');
    await advance(4999);
    await click('button[aria-label="second.jpg"]'); await flush();
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(currentPhoto()).toBe('second.jpg');
    await advance(5000);
    expect(mocked.put).toHaveBeenCalledTimes(1);
  });

  it('joins an in-flight autosave and saves edits made during it before switching', async () => {
    vi.useFakeTimers();
    const pending = deferred<{ state: unknown; revision: number; updatedAt: string; lastSaveId: string }>();
    mocked.put.mockImplementationOnce(() => pending.promise);
    await mount();
    await click('button[aria-label="Disable Basic"]');
    await advance(5000);
    expect(mocked.put).toHaveBeenCalledTimes(1);
    await click('button[aria-label="Enable Basic"]');
    await click('button[aria-label="second.jpg"]');
    expect(mocked.put).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ state: mocked.put.mock.calls[0][1], revision: 1, updatedAt: '2026-09-25T00:00:00Z', lastSaveId: mocked.put.mock.calls[0][3] });
      await pending.promise;
    });
    await flush();
    expect(mocked.put).toHaveBeenCalledTimes(2);
    expect(mocked.put.mock.calls[1][2]).toBe(1);
    expect(currentPhoto()).toBe('second.jpg');
  });

  it('does not start a second autosave while the transition PUT is in flight', async () => {
    vi.useFakeTimers();
    const pending = deferred<{ state: unknown; revision: number; updatedAt: string; lastSaveId: string }>();
    mocked.put.mockImplementationOnce(() => pending.promise);
    await mount();
    await click('button[aria-label="Disable Basic"]');
    await click('button[aria-label="second.jpg"]');
    expect(mocked.put).toHaveBeenCalledTimes(1);
    await advance(5000);
    expect(mocked.put).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ state: mocked.put.mock.calls[0][1], revision: 1, updatedAt: '2026-09-25T00:00:00Z', lastSaveId: mocked.put.mock.calls[0][3] });
      await pending.promise;
    });
    await flush();
    expect(currentPhoto()).toBe('second.jpg');
    expect(mocked.put).toHaveBeenCalledTimes(1);
  });

  it('saves through the existing exit flow when G is pressed from Viewer focus mode', async () => {
    await mount();
    await click('button[aria-label="Disable Basic"]');
    await filmstripKey('f');
    expect(container.querySelector('.workspace-page')?.classList.contains('viewer-focus-mode')).toBe(true);
    expect((await filmstripKey('G')).defaultPrevented).toBe(true);
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(mocked.put.mock.calls[0][1].history).toHaveLength(1);
    expect(container.querySelector('.workspace-page')).toBeNull();
    expect(container.textContent).toContain('Recent photos');
  });

  it('routes the shared title through the same save-before-exit flow', async () => {
    await mount();
    await click('button[aria-label="Disable Basic"]');
    await click('.workspace-title-link');
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(mocked.put.mock.calls[0][1].history).toHaveLength(1);
    expect(container.querySelector('.workspace-page')).toBeNull();
    expect(container.textContent).toContain('Recent photos');
  });

  it('keeps the shared title from retrying or bypassing a failed exit save', async () => {
    mocked.put.mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await mount();
    await click('button[aria-label="Disable Basic"]');
    await click('.workspace-title-link'); await flush();
    expect(currentPhoto()).toBe('first.jpg');
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    const title = container.querySelector<HTMLButtonElement>('.workspace-title-link')!;
    expect(title.disabled).toBe(true);
    await act(async () => title.click()); await flush();
    expect(currentPhoto()).toBe('first.jpg');
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(mocked.put).toHaveBeenCalledTimes(1);
  });

  it('ignores H and modified, repeated, composing, native-editing, and dialog G events', async () => {
    await mount();
    expect((await filmstripKey('h')).defaultPrevented).toBe(false);
    expect((await filmstripKey('H')).defaultPrevented).toBe(false);
    for (const options of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { metaKey: true },
      { altKey: true }, { shiftKey: true }]) {
      expect((await filmstripKey('g', options)).defaultPrevented).toBe(false);
    }
    const prevented = new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true });
    prevented.preventDefault(); await act(async () => { window.dispatchEvent(prevented); });
    for (const markup of ['<input type="text">', '<input type="number">', '<textarea></textarea>',
      '<select></select>', '<div contenteditable="true"></div>', '<div role="textbox"></div>']) {
      const wrapper = document.createElement('div'); wrapper.innerHTML = markup; container.append(wrapper);
      expect((await filmstripKey('g', {}, wrapper.firstElementChild!)).defaultPrevented).toBe(false);
      wrapper.remove();
    }
    for (const markup of ['<dialog open></dialog>', '<div role="dialog"></div>', '<div role="alertdialog"></div>',
      '<div role="menu"></div>', '<details class="edit-settings-menu" open></details>']) {
      const wrapper = document.createElement('div'); wrapper.innerHTML = markup; container.append(wrapper);
      expect((await filmstripKey('g')).defaultPrevented).toBe(false);
      wrapper.remove();
    }
    expect(container.querySelector('.workspace-page')).not.toBeNull();
    expect(mocked.put).not.toHaveBeenCalled();
  });

  it('offers stay or exit without saving when final exit save fails', async () => {
    mocked.put.mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await mount();
    await click('button[aria-label="Disable Basic"]');
    await filmstripKey('g');
    expect(currentPhoto()).toBe('first.jpg');
    expect(container.querySelector('[role="alertdialog"]')?.textContent)
      .toContain('Some edits could not be saved.');
    expect((await filmstripKey('g')).defaultPrevented).toBe(false);

    const stay = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Stay in Develop');
    if (!stay) throw new Error('Missing stay button');
    await act(async () => { stay.click(); });
    expect(currentPhoto()).toBe('first.jpg');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Enable Basic"]')).not.toBeNull();
  });

  it('discards local edits without another write when the user exits after a failed final save', async () => {
    mocked.put.mockRejectedValueOnce(new EditStateApiError('network'));
    await mount();
    await click('button[aria-label="Disable Basic"]');
    const home = container.querySelector<HTMLButtonElement>('.workspace-actions button');
    if (!home) throw new Error('Missing Home navigation button');
    await act(async () => { home.click(); }); await flush();
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(readWorkspaceSession()).toBeNull();
    const exit = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Exit without saving');
    if (!exit) throw new Error('Missing discard exit button');
    await act(async () => { exit.click(); }); await flush();
    expect(container.querySelector('.workspace-page')).toBeNull();
    expect(container.textContent).toContain('Recent photos');
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(readWorkspaceSession()).toMatchObject({ selectedAssets: [{ id: first.id }, { id: second.id }], activeAssetId: first.id });
  });

  it('disables repeated Home requests while the final save is in flight', async () => {
    const pending = deferred<{ state: unknown; revision: number; updatedAt: string; lastSaveId: string }>();
    mocked.put.mockImplementationOnce(() => pending.promise);
    await mount();
    await click('button[aria-label="Disable Basic"]');
    const homeEvent = await filmstripKey('g');
    expect(homeEvent.defaultPrevented).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('.workspace-actions button')!.disabled).toBe(true);
    expect(container.textContent).toContain('Saving edits before leaving Develop');
    expect((await filmstripKey('g')).defaultPrevented).toBe(false);
    expect(mocked.put).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ state: mocked.put.mock.calls[0][1], revision: 1, updatedAt: '2026-09-25T00:00:00Z', lastSaveId: mocked.put.mock.calls[0][3] });
      await pending.promise;
    });
    await flush();
    expect(container.querySelector('.workspace-page')).toBeNull();
  });

  it('remembers the active Filmstrip photo when Home is reached through the normal G exit', async () => {
    await mount();
    const secondPhoto = container.querySelector<HTMLButtonElement>('.filmstrip-item[aria-label="second.jpg"]');
    if (!secondPhoto) throw new Error('Missing second Filmstrip photo');
    await act(async () => { secondPhoto.click(); }); await flush();
    expect(currentPhoto()).toBe('second.jpg');
    await filmstripKey('g'); await flush();
    expect(readWorkspaceSession()).toMatchObject({
      selectedAssets: [{ id: first.id }, { id: second.id }], activeAssetId: second.id,
    });
  });

  it('does not show the exit save failure message when compaction fails but the fallback save succeeds', async () => {
    const compact = vi.spyOn(editStateModule, 'compactEditStateSnapshot')
      .mockReturnValueOnce({ ok: false, issues: [] });
    await mount();
    await click('button[aria-label="Disable Basic"]');
    const home = container.querySelector<HTMLButtonElement>('.workspace-actions button');
    if (!home) throw new Error('Missing Home navigation button');
    await act(async () => { home.click(); }); await flush();
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.textContent).toContain('Recent photos');
    compact.mockRestore();
  });
});
