// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AssetDetail, WorkspaceNavigationState } from './assets';
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
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('Anshitsu Filmstrip persistence', () => {
  it('switches a clean photo without PUT and loads the next photo', async () => {
    await mount();
    await click('button[aria-label="second.jpg"]'); await flush();
    expect(mocked.put).not.toHaveBeenCalled();
    expect(currentPhoto()).toBe('second.jpg');
    expect(mocked.get.mock.calls.map(([id]) => id)).toEqual([first.id, second.id]);
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
});
