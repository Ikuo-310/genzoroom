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

const mocked = vi.hoisted(() => ({ detail: vi.fn(), get: vi.fn(), put: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()), fetchAssetDetail: mocked.detail,
}));
vi.mock('./editStateApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./editStateApi')>()),
  getAssetEditState: mocked.get, putAssetEditState: mocked.put,
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

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en');
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  mocked.detail.mockReset(); mocked.get.mockReset(); mocked.put.mockReset();
  mocked.detail.mockImplementation(async (id: string) => id === first.id ? first : second);
  mocked.get.mockResolvedValue({ state: null });
  mocked.put.mockImplementation(async (_id, snapshot, revision, saveId) => ({
    state: snapshot, revision: revision + 1, updatedAt: '2026-09-25T00:00:00Z', lastSaveId: saveId,
  }));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Anshitsu Filmstrip persistence', () => {
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
    expect(container.querySelector('button[aria-label="Bypass Basic adjustments"]')).toBeNull();
    expect(container.textContent).toContain('Loading saved edits');
    await act(async () => { resolveLoad({ state: null }); await pendingGet; });
    await flush();
    expect(container.querySelector('button[aria-label="Bypass Basic adjustments"]')).not.toBeNull();
  });

  it('saves a dirty photo before switching and uses the full uncompressed History', async () => {
    await mount();
    await click('button[aria-label="Bypass Basic adjustments"]');
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
    await click('button[aria-label="Bypass Basic adjustments"]');
    await advance(5000);
    expect(mocked.put).toHaveBeenCalledTimes(1);
    await click('button[aria-label="Enable Basic adjustments"]');
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
    await mount(); await click('button[aria-label="Bypass Basic adjustments"]');
    await click('button[aria-label="second.jpg"]');
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(message);
    const stay = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Stay on this photo');
    if (!stay) throw new Error('Missing stay button');
    await act(async () => { stay.click(); });
    expect(currentPhoto()).toBe('first.jpg');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Enable Basic adjustments"]')).not.toBeNull();
  });

  it('discards uncertain local state without rollback and re-GETs when revisited', async () => {
    mocked.put.mockRejectedValueOnce(new EditStateApiError('network'));
    await mount(); await click('button[aria-label="Bypass Basic adjustments"]');
    await click('button[aria-label="second.jpg"]');
    const discard = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Move without saving');
    if (!discard) throw new Error('Missing discard button');
    await act(async () => { discard.click(); }); await flush();
    expect(currentPhoto()).toBe('second.jpg');
    await click('button[aria-label="first.jpg"]'); await flush();
    expect(mocked.get.mock.calls.map(([id]) => id)).toEqual([first.id, second.id, first.id]);
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button[aria-label="Bypass Basic adjustments"]')).not.toBeNull();
  });

  it('shows load failure and retries before enabling controls', async () => {
    mocked.get.mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await mount();
    expect(container.textContent).toContain('Saved edits could not be loaded');
    expect(container.querySelector('button[aria-label="Bypass Basic adjustments"]')).toBeNull();
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Retry');
    if (!retry) throw new Error('Missing retry button');
    await act(async () => { retry.click(); }); await flush();
    expect(container.querySelector('button[aria-label="Bypass Basic adjustments"]')).not.toBeNull();
  });

  it('shows a nonblocking localized warning when autosave fails and keeps Develop available', async () => {
    vi.useFakeTimers();
    mocked.put.mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await mount();
    await click('button[aria-label="Bypass Basic adjustments"]');
    await advance(5000); await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Autosave failed');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Enable Basic adjustments"]')).not.toBeNull();
    expect(mocked.put).toHaveBeenCalledTimes(1);
    await advance(15000);
    expect(mocked.put).toHaveBeenCalledTimes(1);
  });

  it('cancels the debounce before a Filmstrip save so the same dirty state is not PUT twice', async () => {
    vi.useFakeTimers();
    await mount();
    await click('button[aria-label="Bypass Basic adjustments"]');
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
    await click('button[aria-label="Bypass Basic adjustments"]');
    await advance(5000);
    expect(mocked.put).toHaveBeenCalledTimes(1);
    await click('button[aria-label="Enable Basic adjustments"]');
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
    await click('button[aria-label="Bypass Basic adjustments"]');
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
    await click('button[aria-label="Bypass Basic adjustments"]');
    const home = container.querySelector<HTMLButtonElement>('.workspace-actions button');
    if (!home) throw new Error('Missing Home navigation button');
    await act(async () => { home.click(); });
    await flush();
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(mocked.put.mock.calls[0][1].history).toHaveLength(1);
    expect(container.querySelector('.workspace-page')).toBeNull();
    expect(container.textContent).toContain('Recent photos');
  });

  it('offers stay or exit without saving when final exit save fails', async () => {
    mocked.put.mockRejectedValueOnce(new EditStateApiError('unavailable'));
    await mount();
    await click('button[aria-label="Bypass Basic adjustments"]');
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
    expect(container.querySelector('button[aria-label="Enable Basic adjustments"]')).not.toBeNull();
  });

  it('discards local edits without another write when the user exits after a failed final save', async () => {
    mocked.put.mockRejectedValueOnce(new EditStateApiError('network'));
    await mount();
    await click('button[aria-label="Bypass Basic adjustments"]');
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
    await click('button[aria-label="Bypass Basic adjustments"]');
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
    await click('button[aria-label="Bypass Basic adjustments"]');
    const home = container.querySelector<HTMLButtonElement>('.workspace-actions button');
    if (!home) throw new Error('Missing Home navigation button');
    await act(async () => { home.click(); }); await flush();
    expect(mocked.put).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.textContent).toContain('Recent photos');
    compact.mockRestore();
  });
});
