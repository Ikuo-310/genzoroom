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

const mocked = vi.hoisted(() => ({ detail: vi.fn(), get: vi.fn(), put: vi.fn(), statuses: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()), fetchAssetDetail: mocked.detail,
}));
vi.mock('./editStateApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./editStateApi')>()),
  getAssetEditState: mocked.get, putAssetEditState: mocked.put, getAssetEditStatuses: mocked.statuses,
}));
vi.mock('./ImageViewer', () => ({ ImageViewer: () => <div className="viewer-panel">Viewer</div> }));

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
function hoverFilmstrip() {
  const event = new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 20 });
  Object.defineProperty(event, 'movementX', { value: 1 });
  act(() => container.querySelector('.filmstrip-scroll')!.dispatchEvent(event));
}
function leaveFilmstrip() {
  const event = new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 20 });
  Object.defineProperty(event, 'movementX', { value: 1 });
  act(() => document.body.dispatchEvent(event));
}
async function filmstripKey(value = 'ArrowRight', init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  await act(async () => { target.dispatchEvent(event); });
  await flush();
  return event;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en');
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
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Anshitsu Filmstrip persistence', () => {
  it('shows saved status for inactive photos and prioritizes live edits over a delayed bulk response', async () => {
    const waiting = deferred<Record<string, boolean>>();
    mocked.statuses.mockReturnValueOnce(waiting.promise);
    await mount();
    expect(container.querySelector('.edited-badge')).toBeNull();
    await click('button[aria-label="Disable Basic"]');
    expect(container.querySelector('.filmstrip-item[aria-current="true"] .edited-badge')).not.toBeNull();
    await act(async () => waiting.resolve({ [first.id]: false, [second.id]: true }));
    expect(container.querySelectorAll('.filmstrip .edited-badge')).toHaveLength(2);
    await click('.filmstrip-item[aria-label="second.jpg"]');
    // The full GET validates this photo as initial, superseding the older summary.
    expect(container.querySelector('.filmstrip-item[aria-current="true"] .edited-badge')).toBeNull();
    expect(container.querySelector('.filmstrip-item[aria-label="first.jpg"] .edited-badge')).not.toBeNull();
    expect(mocked.statuses).toHaveBeenCalledTimes(1);
  });
  it('navigates in both directions after route changes without saving a clean photo', async () => {
    await mount(); hoverFilmstrip();
    await filmstripKey(); expect(currentPhoto()).toBe('second.jpg');
    await filmstripKey(); expect(currentPhoto()).toBe('second.jpg');
    await filmstripKey('ArrowLeft'); expect(currentPhoto()).toBe('first.jpg');
    expect(mocked.put).not.toHaveBeenCalled();
    expect(mocked.get.mock.calls.map(([id]) => id)).toEqual([first.id, second.id, first.id]);
  });

  it('saves before keyboard navigation and ignores repeated switches during the pending save', async () => {
    vi.useFakeTimers();
    const pending = deferred<any>();
    mocked.put.mockReturnValueOnce(pending.promise);
    await mount(); await click('button[aria-label="Disable Basic"]'); hoverFilmstrip();
    await filmstripKey();
    expect(currentPhoto()).toBe('first.jpg');
    expect(mocked.put).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 4; index++) await filmstripKey('ArrowRight', { repeat: true });
    await filmstripKey('ArrowLeft');
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
    await mount(); await click('button[aria-label="Disable Basic"]'); hoverFilmstrip();
    await filmstripKey();
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(currentPhoto()).toBe('first.jpg');
    await filmstripKey();
    expect(container.querySelector('.filmstrip-item[aria-current="true"] .edited-badge')).not.toBeNull();
    expect(mocked.put).toHaveBeenCalledTimes(1);
    const stay = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Stay on this photo')!;
    await act(async () => stay.click());
    expect(container.querySelector('button[aria-label="Enable Basic"]')).not.toBeNull();
    expect(container.querySelector('.edit-history')?.textContent).toContain('Basic OFF');
    expect(currentPhoto()).toBe('first.jpg');
  });

  it('prioritizes hovered Filmstrip arrows, then preserves slider, Shift and number editing after pointer exit', async () => {
    vi.useFakeTimers(); await mount(); hoverFilmstrip();
    const ranges = container.querySelectorAll<HTMLInputElement>('.adjustment-range');
    await act(async () => ranges[0].focus());
    await filmstripKey('ArrowRight', {}, ranges[0]);
    expect(ranges[0].value).toBe('0');
    expect(currentPhoto()).toBe('second.jpg');
    leaveFilmstrip();
    const activeRange = container.querySelectorAll<HTMLInputElement>('.adjustment-range')[0];
    await act(async () => activeRange.focus());
    await filmstripKey('ArrowRight', {}, activeRange);
    expect(activeRange.value).toBe('1');
    await filmstripKey('ArrowDown', { shiftKey: true }, activeRange);
    const nextRange = container.querySelectorAll<HTMLInputElement>('.adjustment-range')[1];
    expect(document.activeElement).toBe(nextRange);
    await filmstripKey('ArrowRight', { shiftKey: true }, nextRange);
    expect(document.activeElement).toBe(container.querySelectorAll('.adjustment-number')[1]);
    await filmstripKey('ArrowRight', {}, document.activeElement!);
    expect(currentPhoto()).toBe('second.jpg');
    expect(mocked.put).not.toHaveBeenCalled();
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
    await click('button[aria-label="Disable Basic"]'); hoverFilmstrip();
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

  it('compacts and saves before the existing Home navigation', async () => {
    await mount();
    await click('button[aria-label="Disable Basic"]');
    const home = container.querySelector<HTMLButtonElement>('.workspace-actions button');
    if (!home) throw new Error('Missing Home navigation button');
    await act(async () => { home.click(); });
    await flush();
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

  it('offers stay or exit without saving when final exit save fails', async () => {
    mocked.put.mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await mount();
    await click('button[aria-label="Disable Basic"]');
    const home = container.querySelector<HTMLButtonElement>('.workspace-actions button');
    if (!home) throw new Error('Missing Home navigation button');
    await act(async () => { home.click(); }); await flush();
    expect(currentPhoto()).toBe('first.jpg');
    expect(container.querySelector('[role="alertdialog"]')?.textContent)
      .toContain('Some edits could not be saved.');

    const stay = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Stay in Anshitsu');
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
    const exit = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Exit without saving');
    if (!exit) throw new Error('Missing discard exit button');
    await act(async () => { exit.click(); }); await flush();
    expect(container.querySelector('.workspace-page')).toBeNull();
    expect(container.textContent).toContain('Recent photos');
    expect(mocked.put).toHaveBeenCalledTimes(1);
  });

  it('disables repeated Home requests while the final save is in flight', async () => {
    const pending = deferred<{ state: unknown; revision: number; updatedAt: string; lastSaveId: string }>();
    mocked.put.mockImplementationOnce(() => pending.promise);
    await mount();
    await click('button[aria-label="Disable Basic"]');
    const home = container.querySelector<HTMLButtonElement>('.workspace-actions button');
    if (!home) throw new Error('Missing Home navigation button');
    await act(async () => { home.click(); });
    expect(home.disabled).toBe(true);
    expect(container.textContent).toContain('Saving edits before leaving Anshitsu');
    await act(async () => { home.click(); });
    expect(mocked.put).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ state: mocked.put.mock.calls[0][1], revision: 1, updatedAt: '2026-09-25T00:00:00Z', lastSaveId: mocked.put.mock.calls[0][3] });
      await pending.promise;
    });
    await flush();
    expect(container.querySelector('.workspace-page')).toBeNull();
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
