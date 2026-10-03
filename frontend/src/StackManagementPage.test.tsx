// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { PhotoSelectionBar } from './PhotoSelectionBar';
import i18n from './i18n';
import { updateSetting } from './appSettings';
const api = vi.hoisted(() => ({ recent: vi.fn(), favorites: vi.fn(), statuses: vi.fn() }));
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), fetchRecentAssets: api.recent, fetchFavoriteAssets: api.favorites }));
vi.mock('./editStateApi', async original => ({ ...(await original<typeof import('./editStateApi')>()), getAssetEditStatuses: api.statuses }));
const photos = [
  { id: 'raw', filename: 'selected.dng', format: 'DNG', is_raw: true, date: '2026-09-01', thumbnail_url: '/raw' },
  { id: 'jpeg', filename: 'selected.jpg', format: 'JPEG', is_raw: false, date: '2026-09-01', thumbnail_url: '/jpeg' },
];
let host: HTMLDivElement, root: Root;
async function mount(path = '/', state?: unknown) { await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: path, state }]}><App /></MemoryRouter>)); }
async function click(selector: string) { await act(async () => host.querySelector<HTMLElement>(selector)!.click()); }
async function press(key: string, options: KeyboardEventInit = {}, target: EventTarget = window) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })); });
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  await i18n.changeLanguage('en'); sessionStorage.clear(); localStorage.clear(); updateSetting('showKeyboardShortcuts', true);
  api.recent.mockResolvedValue(photos); api.favorites.mockResolvedValue(photos); api.statuses.mockResolvedValue({});
  document.title = 'GenzoRoom'; host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); await i18n.changeLanguage('en'); });
it('preserves D and adds the Stack selection callback', async () => {
  const open = vi.fn(), stacks = vi.fn();
  await act(async () => root.render(<PhotoSelectionBar active count={2} onClear={vi.fn()} onOpen={open} onOpenStacks={stacks} />));
  await click('button[title="Manage Stacks (S)"]'); expect(stacks).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
  await click('button[title="Open in Anshitsu (D)"]'); expect(open).toHaveBeenCalledOnce();
  await act(async () => root.render(<PhotoSelectionBar active count={0} onClear={vi.fn()} onOpen={open} onOpenStacks={stacks} />));
  expect(host.querySelector<HTMLButtonElement>('button[title="Manage Stacks (S)"]')!.disabled).toBe(true);
});
it('passes ordered concrete favorites with RAW via S and returns to the same Home tab', async () => {
  await mount(); await click('#home-favorites-tab'); await click('.photo-card:last-child input'); await click('.photo-card:first-child input'); await press('S');
  expect(Array.from(host.querySelectorAll('.stack-filename')).map(e => e.textContent)).toEqual(['selected.jpg', 'selected.dng']);
  await press('H'); expect(host.querySelector('#home-favorites-tab')?.getAttribute('aria-selected')).toBe('true');
});
it('guards S and opens concrete RAW through the button', async () => {
  await mount(); await press('s'); expect(host.querySelector('.stack-management-page')).toBeNull(); await click('.photo-card input');
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { repeat: true }]) await press('s', options);
  const input = document.createElement('input'); host.append(input); await press('s', {}, input); input.remove();
  const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); host.append(menu); await press('s'); menu.remove();
  expect(host.querySelector('.stack-management-page')).toBeNull(); await click('button[title="Manage Stacks (S)"]'); expect(host.querySelector('.stack-filename')?.textContent).toBe('selected.dng');
});
it('renders compact header, isolated scroll sections and local selection with disabled future actions', async () => {
  await mount('/stack', { selectedAssets: photos });
  const content = host.querySelector('.stack-content')!;
  expect(content.contains(host.querySelector('.stack-management-header'))).toBe(false); expect(content.contains(host.querySelector('.stack-control-bar'))).toBe(false);
  expect(host.querySelector('.stack-home-title')?.textContent).toBe('GenzoRoom'); expect(host.querySelector('h1')?.textContent).toBe('Stack Management');
  expect(host.querySelector('[aria-label="Settings"]')).not.toBeNull(); expect(host.querySelector('#stack-candidates-heading')).not.toBeNull();
  expect(host.querySelector('#stack-unmatched-heading')?.parentElement?.querySelectorAll('.stack-photo')).toHaveLength(2);
  expect(host.querySelectorAll('.stack-control-bar button:disabled')).toHaveLength(4);
  await click('.stack-photo'); expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('1 selected');
  await click('.stack-control-bar button'); expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('0 selected');
  await click('.stack-home-title'); expect(host.querySelector('.home-page')).not.toBeNull();
});
it.each([undefined, { selectedAssets: [{}] }])('handles missing or invalid route state safely: %j', async state => {
  await mount('/stack', state); expect(host.querySelectorAll('.stack-photo')).toHaveLength(0); expect(host.textContent).toContain('Select photos on Home');
  await click('.stack-header-actions button'); expect(host.querySelector('.home-page')).not.toBeNull();
});
it('localizes and restores title, guards H, and ignores D/S', async () => {
  await mount('/stack'); expect(document.title).toBe('Stack Management - GenzoRoom'); await act(async () => i18n.changeLanguage('ja')); expect(document.title).toBe('STACK管理 - GenzoRoom');
  const input = document.createElement('textarea'); host.append(input); await press('h', {}, input); input.remove();
  for (const role of ['dialog', 'alertdialog', 'menu']) { const blocker = document.createElement('div'); blocker.setAttribute('role', role); host.append(blocker); await press('h'); blocker.remove(); }
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { repeat: true }]) await press('h', options);
  await press('d'); await press('s'); expect(host.querySelector('.stack-management-page')).not.toBeNull(); await press('h'); expect(document.title).toBe('GenzoRoom');
});
it('retains shared Settings and Primary+Settings developer behavior and blocks H while Settings is open', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false; } });
  vi.stubGlobal('isSecureContext', false);
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  await mount('/stack');
  await act(async () => { host.querySelector('.settings-button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); });
  expect(open).toHaveBeenCalledWith('/developer', '_blank', 'noopener,noreferrer'); expect(host.querySelector('dialog')).toBeNull();
  await click('.settings-button'); expect(host.querySelector('dialog[open]')).not.toBeNull();
  await press('h'); expect(host.querySelector('.stack-management-page')).not.toBeNull(); open.mockRestore();
});
