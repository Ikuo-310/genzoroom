// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { PhotoSelectionBar } from './PhotoSelectionBar';
import i18n from './i18n';
import { HOME_THUMBNAIL_COLUMNS_KEY, updateSetting } from './appSettings';
const api = vi.hoisted(() => ({ recent: vi.fn(), favorites: vi.fn(), statuses: vi.fn(), detail: vi.fn() }));
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), fetchRecentAssets: api.recent, fetchFavoriteAssets: api.favorites, fetchAssetDetail: api.detail }));
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
  await i18n.changeLanguage('en'); sessionStorage.clear(); localStorage.clear(); updateSetting('showKeyboardShortcuts', true); updateSetting('homeThumbnailColumns', 6);
  api.detail.mockReset().mockImplementation(async (id: string) => ({ ...photos.find(a => a.id === id), exif: {}, preview_url: '/preview' }));
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
  expect(host.querySelector('#stack-unmatched-heading')?.parentElement?.querySelectorAll('.stack-photo')).toHaveLength(0);
  expect(host.querySelector('#stack-candidates-heading')?.parentElement?.querySelectorAll('.stack-photo')).toHaveLength(2);
  expect(host.querySelectorAll('.stack-control-bar button:disabled')).toHaveLength(3);
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
it('shows NAME/TIME/CAM/GPS and COVER, partitions candidates and existing Stacks without duplicates', async () => {
  const stacked = { ...photos[1], id: 'stacked', stackId: '22345678-1234-4234-9234-123456789abc', primaryAssetId: '32345678-1234-4234-9234-123456789abc' };
  api.detail.mockImplementation(async (id: string) => ({ ...photos[0], id, exif: { date_time_original: '2026:10:01 08:25:49', make: 'Camera', model: 'Model', latitude: 35, longitude: 139 } }));
  await mount('/stack', { selectedAssets: [...photos, stacked, photos[0]] });
  expect(host.querySelectorAll('.stack-photo')).toHaveLength(3);
  expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
  expect(host.querySelector<HTMLElement>('.stack-candidate-group')!.style.getPropertyValue('--stack-member-count')).toBe('2');
  expect(host.querySelector('.stack-unmatched-grid .stack-filename')?.textContent).toBe('selected.jpg');
  expect(Array.from(host.querySelectorAll('.stack-evidence')).map(e => e.querySelector('[aria-hidden]')?.textContent)).toEqual(['NAME', 'TIME', 'CAM', 'GPS']);
  expect(host.querySelectorAll('.stack-evidence.matched')).toHaveLength(4);
  expect(host.querySelector('.stack-cover .stack-filename')?.textContent).toBe('selected.jpg');
  expect(host.querySelector('.stack-cover-badge')?.textContent).toBe('COVER');
  expect(host.querySelector('.stack-cover')?.getAttribute('aria-pressed')).toBe('false');
  await click('.stack-cover'); expect(host.querySelector('.stack-cover')?.getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector<HTMLButtonElement>('button:last-child[disabled]')).not.toBeNull();
});
it('preserves NAME drafts and offers retry after partial or total detail failure', async () => {
  api.detail.mockImplementation(async (id: string) => { if (id === 'raw') throw new Error('Failed'); return { ...photos[1], exif: { make: 'Camera', model: 'Model' } }; });
  await mount('/stack', { selectedAssets: photos });
  expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1); expect(host.querySelectorAll('.stack-evidence.error')).toHaveLength(3);
  expect(host.textContent).toContain('Some photo details could not be loaded');
  const detect = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Detect again')!;
  expect(detect.disabled).toBe(false);
  api.detail.mockRejectedValue(new Error('Offline')); await act(async () => detect.click());
  expect(host.textContent).toContain('Photo details could not be loaded. NAME candidates are preserved');
  expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
  api.detail.mockImplementation(async (id: string) => ({ ...photos.find(a => a.id === id), exif: {} })); await act(async () => detect.click());
  expect(host.querySelector('.stack-status')).toBeNull();
});
it('disables duplicate detection while loading and preserves photo selection after retry', async () => {
  const pending: Array<() => void> = [];
  api.detail.mockImplementation((id: string) => new Promise(resolve => pending.push(() => resolve({ ...photos.find(a => a.id === id), exif: {} }))));
  await mount('/stack', { selectedAssets: photos });
  expect(host.textContent).toContain('Detecting stack candidates');
  const detect = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Detect again')!;
  expect(detect.disabled).toBe(true); await act(async () => detect.click()); expect(api.detail).toHaveBeenCalledTimes(2);
  await click('.stack-photo');
  await act(async () => pending.splice(0).forEach(resolve => resolve())); expect(detect.disabled).toBe(false);
  await act(async () => detect.click()); expect(api.detail).toHaveBeenCalledTimes(4);
  await act(async () => pending.splice(0).forEach(resolve => resolve()));
  expect(host.querySelector('.stack-photo')?.getAttribute('aria-pressed')).toBe('true');
});
it('reuses the saved thumbnail controller outside content and updates shared column count immediately', async () => {
  await mount('/stack', { selectedAssets: [...photos, { ...photos[1], id: 'single', filename: 'single.jpg' }] });
  expect(host.querySelector('.stack-control-bar .thumbnail-size-control')).not.toBeNull(); expect(host.querySelector('.stack-content .thumbnail-size-control')).toBeNull();
  const page = host.querySelector<HTMLElement>('.stack-management-page')!;
  expect(page.style.getPropertyValue('--stack-columns')).toBe('6');
  await click('.thumbnail-size-control [aria-label="Make thumbnails larger"]');
  expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('5'); expect(page.style.getPropertyValue('--stack-columns')).toBe('5');
  expect(host.querySelectorAll('.stack-candidate-grid, .stack-unmatched-grid')).toHaveLength(2);
  const slider = host.querySelector<HTMLInputElement>('.thumbnail-size-control input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '7'); slider.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('3'); expect(page.style.getPropertyValue('--stack-columns')).toBe('3');
  await click('.stack-home-title'); expect(host.querySelector('.thumbnail-size-control input')?.getAttribute('aria-valuetext')).toBe('3 columns');
});

it('exposes translated status text and tooltips while labels stay English', async () => {
 api.detail.mockImplementation(async (id: string) => ({...photos.find(a => a.id === id), exif: {date_time_original: id === 'raw' ? '2026-10-01T00:00:00Z' : '2026-10-01T00:00:03Z'}, preview_url:'/preview'}));
 await mount('/stack', {selectedAssets:photos});
 for (const chip of host.querySelectorAll('.stack-evidence')) {
  expect(chip.querySelector('.visually-hidden')?.textContent).toContain(': ');
  expect(chip.getAttribute('title')).toContain(chip.querySelector('.visually-hidden')!.textContent);
  expect(chip.hasAttribute('aria-label')).toBe(false);
 }
 expect(host.querySelector('.stack-evidence.mismatch .visually-hidden')?.textContent).toBe('TIME: Mismatch');
 expect(host.querySelector('.stack-evidence.unavailable .visually-hidden')?.textContent).toBe('CAM: Information unavailable');
 await act(async () => { await i18n.changeLanguage('ja'); });
 expect(host.querySelector('.stack-evidence.mismatch .visually-hidden')?.textContent).toBe('TIME: 不一致');
 expect(host.querySelector('.stack-evidence [aria-hidden]')?.textContent).toBe('NAME');
});
it('clamps both grids to content width without writing the shared preference and restores it on widening', async () => {
 let resize!: ResizeObserverCallback;
 vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) {resize=callback;} observe() {} disconnect() {} });
 await mount('/stack', {selectedAssets:photos});
 const page=host.querySelector<HTMLElement>('.stack-management-page')!;
 const change = async (width:number) => act(async () => resize([{contentRect:{width}} as ResizeObserverEntry], {} as ResizeObserver));
 await change(358); expect(page.style.getPropertyValue('--stack-effective-columns')).toBe('2');
 expect(page.style.getPropertyValue('--stack-columns')).toBe('6'); expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('6');
 await change(1200); expect(page.style.getPropertyValue('--stack-effective-columns')).toBe('6');
});

it('provides explicit error text for failed detail in addition to color', async () => {
 api.detail.mockRejectedValue(new Error('offline'));
 await mount('/stack',{selectedAssets:photos});
 for (const chip of host.querySelectorAll('.stack-evidence.error')) {
 expect(chip.querySelector('.visually-hidden')?.textContent).toContain('Failed to retrieve or parse photo information');
 expect(chip.getAttribute('title')).toBe(chip.querySelector('.visually-hidden')?.textContent);
 }
 expect(host.querySelectorAll('.stack-evidence.error')).toHaveLength(3);
});
