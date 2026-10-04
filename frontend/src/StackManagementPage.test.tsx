// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { PhotoSelectionBar } from './PhotoSelectionBar';
import i18n from './i18n';
import { frontendLogger } from './frontendLogging';
import { HOME_THUMBNAIL_COLUMNS_KEY, updateSetting } from './appSettings';
const api = vi.hoisted(() => ({ recent: vi.fn(), favorites: vi.fn(), statuses: vi.fn(), detail: vi.fn(), resolve: vi.fn(), refresh: vi.fn() }));
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), fetchRecentAssets: api.recent, fetchFavoriteAssets: api.favorites, fetchAssetDetail: api.detail, fetchSelectedImmichStacks: api.resolve, refreshSelectedImmichStacks: api.refresh }));
vi.mock('./editStateApi', async original => ({ ...(await original<typeof import('./editStateApi')>()), getAssetEditStatuses: api.statuses }));
const photos = [
  { id: 'raw', filename: 'selected.dng', format: 'DNG', is_raw: true, date: '2026-09-01', thumbnail_url: '/raw' },
  { id: 'jpeg', filename: 'selected.jpg', format: 'JPEG', is_raw: false, date: '2026-09-01', thumbnail_url: '/jpeg' },
];
let host: HTMLDivElement, root: Root;
let navigateTest: (path: string, state?: unknown) => void = () => {};
function NavigationProbe() { const navigate = useNavigate(); navigateTest = (path, state) => navigate(path, { state }); return null; }
async function mount(path = '/', state?: unknown) { await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: path, state }]}><App /><NavigationProbe /></MemoryRouter>)); }
async function click(selector: string) { await act(async () => host.querySelector<HTMLElement>(selector)!.click()); }
async function press(key: string, options: KeyboardEventInit = {}, target: EventTarget = window) {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })); });
}
beforeEach(async () => {
  frontendLogger.setLevel('off'); frontendLogger.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false; } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  await i18n.changeLanguage('en'); sessionStorage.clear(); localStorage.clear(); updateSetting('showKeyboardShortcuts', true); updateSetting('homeThumbnailColumns', 6);
  api.detail.mockReset().mockImplementation(async (id: string) => ({ ...photos.find(a => a.id === id), exif: {}, preview_url: '/preview' }));
  api.resolve.mockReset().mockRejectedValue(new Error('No Stack fixture'));
  api.refresh.mockReset().mockImplementation(async (ids: string[], signal: AbortSignal) => ids.some(id => /^[0-9a-f]{8}-/i.test(id)) ? api.resolve([], signal) : []);
  api.recent.mockResolvedValue(photos); api.favorites.mockResolvedValue(photos); api.statuses.mockResolvedValue({});
  document.title = 'GenzoRoom'; host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); frontendLogger.setLevel('off'); frontendLogger.clear(); vi.unstubAllGlobals(); await i18n.changeLanguage('en'); });
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
it('renders compact header, isolated scroll sections and enables sending completed candidates', async () => {
  await mount('/stack', { selectedAssets: photos });
  const content = host.querySelector('.stack-content')!;
  expect(content.contains(host.querySelector('.stack-management-header'))).toBe(false); expect(content.contains(host.querySelector('.stack-control-bar'))).toBe(false);
  expect(host.querySelector('.stack-home-title')?.textContent).toBe('GenzoRoom'); expect(host.querySelector('h1')?.textContent).toBe('Stack Management');
  expect(host.querySelector('[aria-label="Settings"]')).not.toBeNull(); expect(host.querySelector('#stack-candidates-heading')).not.toBeNull();
  expect(host.querySelector('#stack-unmatched-heading')?.parentElement?.querySelectorAll('.stack-photo')).toHaveLength(0);
  expect(host.querySelector('#stack-unmatched-heading')?.parentElement?.classList.contains('stack-unmatched-empty')).toBe(true);
  expect(host.querySelector('.stack-candidate-grid')?.querySelectorAll('.stack-photo')).toHaveLength(2);
  expect(host.querySelectorAll('.stack-control-bar button:disabled')).toHaveLength(3);
  await click('.stack-photo'); expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('0 selected');
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
it('uses Primary+Z for one local Undo, preserves native/dialog/sending guards, and adds no Redo', async () => {
 await mount('/stack',{selectedAssets:photos});
 const coverName=()=>host.querySelector('.stack-cover .stack-filename')?.textContent;
 expect(coverName()).toBe('selected.jpg');
 await press('z',{ctrlKey:true}); expect(coverName()).toBe('selected.jpg');
 await click('[aria-label="Set selected.dng as COVER"]'); expect(coverName()).toBe('selected.dng');
 await press('z',{ctrlKey:true,shiftKey:true}); await press('y',{ctrlKey:true}); expect(coverName()).toBe('selected.dng');
 const input=document.createElement('input');host.append(input);await press('z',{ctrlKey:true},input);input.remove();expect(coverName()).toBe('selected.dng');
 await press('z',{ctrlKey:true});expect(coverName()).toBe('selected.jpg');
 await press('z',{ctrlKey:true});expect(coverName()).toBe('selected.jpg');
 await click('[aria-label="Set selected.dng as COVER"]');
 await click('.settings-button'); expect(host.querySelector('dialog[open]')).not.toBeNull();
 await press('z',{ctrlKey:true}); expect(coverName()).toBe('selected.dng');
 await click('.settings-button');
 let finish!:(value:Response)=>void;
 vi.stubGlobal('fetch',vi.fn((_url:string,_init:RequestInit)=>new Promise<Response>(resolve=>{finish=resolve;})));
 await act(async()=>button('Send to Immich').click());
 await press('z',{ctrlKey:true}); expect(coverName()).toBe('selected.dng');
 await act(async()=>button('Continue').click());
 expect(button('Send to Immich').getAttribute('aria-busy')).toBe('true');
 await press('z',{ctrlKey:true}); expect(coverName()).toBe('selected.dng');
 await act(async()=>finish(new Response(JSON.stringify({results:[]}))));
});
it('discards the one-step Undo snapshot when /stack navigation gets a new source generation', async () => {
 await mount('/stack',{selectedAssets:photos});
 await click('[aria-label="Set selected.dng as COVER"]');
 expect(host.querySelector('.stack-cover .stack-filename')?.textContent).toBe('selected.dng');
 await act(async()=>navigateTest('/stack',{selectedAssets:photos}));
 await press('z',{ctrlKey:true});
 expect(host.querySelector('.stack-cover .stack-filename')?.textContent).toBe('selected.jpg');
});
it('clears active drag state and ref when the source generation changes',async()=>{
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 const source=host.querySelector<HTMLButtonElement>('.stack-unmatched-grid .stack-photo')!;
 const transfer=dragTransfer({assetId:'x',sourceGroupId:null},[],[],undefined,true);
 await act(async()=>source.dispatchEvent(dragEvent('dragstart',transfer)));
 expect(host.querySelector('.stack-photo-dragging')).not.toBeNull();
 await act(async()=>navigateTest('/stack',{selectedAssets:[...photos,...singles]}));
 expect(host.querySelector('.stack-photo-dragging')).toBeNull();
 const group=host.querySelector<HTMLElement>('.stack-candidate-group')!;
 const afterGeneration=dragTransfer(undefined,['application/x-genzoroom-stack-photo+json'],[],undefined,true);
 const over=dragEvent('dragover',afterGeneration);await act(async()=>group.dispatchEvent(over));
 expect(over.defaultPrevented).toBe(false);
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
it('shows NAME/TIME/CAM/GPS and COVER and partitions NAME candidates without duplicates', async () => {
  api.detail.mockImplementation(async (id: string) => ({ ...photos[0], id, exif: { date_time_original: '2026:10:01 08:25:49', make: 'Camera', model: 'Model', latitude: 35, longitude: 139 } }));
  await mount('/stack', { selectedAssets: [...photos, photos[0]] });
  expect(host.querySelectorAll('.stack-photo')).toHaveLength(2);
  expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
  expect(host.querySelector<HTMLElement>('.stack-candidate-group')!.style.getPropertyValue('--stack-member-count')).toBe('2');
  expect(host.querySelector('.stack-unmatched-grid .stack-filename')).toBeNull();
  expect(Array.from(host.querySelectorAll('.stack-evidence')).map(e => e.querySelector('[aria-hidden]')?.textContent)).toEqual(['NAME', 'TIME', 'CAM', 'GPS']);
  expect(host.querySelectorAll('.stack-evidence.matched')).toHaveLength(4);
  expect(host.querySelector('.stack-cover .stack-filename')?.textContent).toBe('selected.jpg');
  expect(host.querySelector('.stack-cover-badge')?.textContent).toBe('COVER');
  expect(host.querySelector('.stack-cover')?.getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('.stack-cover')?.classList.contains('stack-selection-active')).toBe(false);
  expect(host.querySelectorAll('.stack-unmatched-grid .stack-selection-active')).toHaveLength(0);
  await click('.stack-cover'); expect(host.querySelector('.stack-cover')?.getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('.stack-cover-badge')?.textContent).toBe('COVER');
  expect(host.querySelector('.stack-cover')?.classList.contains('stack-selection-active')).toBe(false);
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
  expect(host.textContent).toContain('Photo details could not be loaded. Existing candidates are preserved; EXIF fallback candidates are hidden');
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
  expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('0 selected');
});
it('reuses the saved thumbnail controller outside content and updates shared column count immediately', async () => {
  await mount('/stack', { selectedAssets: [...photos, { ...photos[1], id: 'single', filename: 'single.jpg' }] });
  expect(host.querySelector('#stack-unmatched-heading')?.parentElement?.classList.contains('stack-unmatched-empty')).toBe(false);
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

it('renders EXIF fallback with a mismatch NAME label and three matched evidence indicators', async () => {
 const fallback = [
  { ...photos[0], id:'fallback-raw', filename:'capture.dng' },
  { ...photos[1], id:'fallback-jpeg', filename:'exported.jpg' },
 ];
 api.detail.mockImplementation(async (id:string) => ({...photos[0], id, exif:{date_time_original:'2026:10:01 08:25:49', make:'Camera', model:'Model', latitude:35, longitude:139}, preview_url:'/preview'}));
 await mount('/stack', {selectedAssets:fallback});
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
 expect(host.querySelector('.stack-evidence.mismatch .visually-hidden')?.textContent).toBe('NAME: Mismatch');
 expect(host.querySelector('.stack-evidence.mismatch')?.getAttribute('title')).toContain('Filename family mismatch');
 expect(host.querySelectorAll('.stack-evidence.matched')).toHaveLength(3);
});
it('keeps EXIF fallback groups editable, addable, purgeable and redetectable', async () => {
 const fallback = [
  { ...photos[0], id:'fallback-raw', filename:'capture.dng' },
  { ...photos[1], id:'fallback-jpeg', filename:'exported.jpg' },
  ...singles,
 ];
 api.detail.mockImplementation(async (id:string) => ({...photos[0], id, exif:{date_time_original:'2026:10:01 08:25:49', make:'Camera', model:id.startsWith('fallback-') ? 'Model' : 'Other', latitude:35, longitude:139}, preview_url:'/preview'}));
 await mount('/stack', {selectedAssets:fallback});
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
 await click('[aria-label="Set capture.dng as COVER"]');
 await click('.stack-unmatched-grid .stack-photo');
 await click('.stack-unmatched-grid .stack-photo-wrapper:last-child .stack-photo');
 await click('.stack-set-target');
 const group = host.querySelector('.stack-candidate-group')!;
 expect(Array.from(group.querySelectorAll('.stack-filename')).map(node => node.textContent)).toEqual(['capture.dng','exported.jpg','x.jpg','y.jpg']);
 expect(group.querySelector('.stack-cover .stack-filename')?.textContent).toBe('capture.dng');
 expect(group.querySelector('.stack-group-indicators')?.textContent).toBe('MANUAL');
 expect(group.querySelector('.stack-evidence.mismatch')?.getAttribute('title')).toBe('Manually assembled Stack');
 expect(group.querySelector('.stack-evidence.unavailable')).toBeNull();
 expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('0 selected');
 expect(unmatched()).toEqual([]);
 await act(async()=>button('Detect again').click());
 expect(host.querySelector('dialog')).not.toBeNull();
 await act(async()=>button('Continue').click());
 expect(host.querySelector('.stack-cover .stack-filename')?.textContent).toBe('exported.jpg');
 expect(host.querySelector('.stack-group-indicators')?.textContent).not.toBe('MANUAL');
 await click('[aria-label="Remove exported.jpg from draft Stack"]');
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(0);
 expect(unmatched()).toEqual(['capture.dng','exported.jpg','x.jpg','y.jpg']);
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

const singles = [{ ...photos[1], id: 'x', filename: 'x.jpg' }, { ...photos[1], id: 'y', filename: 'y.jpg' }];
const existingStackId='52345678-1234-4234-9234-123456789abc';
const existingPrimary='62345678-1234-4234-9234-123456789abc';
const existingMembers=[
 {...photos[1],id:'72345678-1234-4234-9234-123456789abc',filename:'hidden.jpg'},
 {...photos[0],id:existingPrimary,filename:'primary.dng'},
 {...photos[1],id:'82345678-1234-4234-9234-123456789abc',filename:'hidden.png',format:'PNG'},
].map(asset=>({...asset,stackId:existingStackId,primaryAssetId:existingPrimary,stackAssetCount:3}));
const existingStack={id:existingStackId,primaryAssetId:existingPrimary,assets:existingMembers};
const singletonMember={...existingMembers[1],stackAssetCount:1};
const singletonStack={...existingStack,assets:[singletonMember]};
it.each(['en','ja'])('keeps the singleton warning and its localized description after an empty send: %s',async(language)=>{
 await i18n.changeLanguage(language);api.resolve.mockResolvedValue([singletonStack]);
 await mount('/stack',{selectedAssets:[singletonMember]});
 const label=language==='ja'?'Immich側の異常STACK: 1枚':'Invalid Immich Stack: 1 asset';
 expect(host.querySelector('.stack-singleton-warning')).not.toBeNull();
 expect(host.querySelector('.stack-evidence.singleton-warning')?.getAttribute('title')).toBe(label);
 expect(host.querySelector('.stack-evidence.singleton-warning')?.textContent).toContain(label);
 expect(host.querySelectorAll('.stack-cover-badge')).toHaveLength(1);
 await act(async()=>button(i18n.t('stackManagement.send')).click());
 await act(async()=>button(i18n.t('workspace.historyContinue')).click());
 expect(fetch).not.toHaveBeenCalled();expect(host.querySelector('.stack-singleton-warning')).not.toBeNull();
 expect(host.querySelector('.stack-section-heading .stack-send-status')?.textContent).toBe(language==='ja'?'変更はありません。':'No changes to apply.');
 expect(host.querySelector('.stack-control-bar .stack-send-status')).toBeNull();
 expect(host.querySelector('.stack-candidate-grid .stack-send-status')).toBeNull();
 expect(host.querySelector('.stack-section-heading')?.contains(host.querySelector('#stack-candidates-heading'))).toBe(true);
 expect(host.querySelector('.stack-content > [role="status"]')).toBeNull();
});
it('disables singleton Add and COVER, rejects drops, and permits Purge followed by DELETE',async()=>{
 frontendLogger.setLevel('debug');
 api.resolve.mockResolvedValue([singletonStack]);
 await mount('/stack',{selectedAssets:[singletonMember,singles[0]]});
 const group=host.querySelector<HTMLElement>('.stack-singleton-warning')!;
 expect(group.querySelector('.stack-set-target')).toBeNull();
 expect(group.querySelector<HTMLButtonElement>('.stack-photo')!.disabled).toBe(true);
 expect(group.querySelector<HTMLButtonElement>('.stack-photo')!.draggable).toBe(false);
 expect(group.querySelector<HTMLImageElement>('.stack-photo img')!.draggable).toBe(false);
 expect(group.querySelector('.stack-purge-member')).toBeNull();
 await click('.stack-unmatched-grid .stack-photo');
 expect(button(i18n.t('stackManagement.add')).disabled).toBe(true);expect(group.classList.contains('stack-add-target')).toBe(false);
 const transfer={types:['application/x-genzoroom-stack-photo+json'],files:[],getData:()=>JSON.stringify({assetId:'x',sourceGroupId:null})};
 const over=new Event('dragover',{bubbles:true,cancelable:true});Object.defineProperty(over,'dataTransfer',{value:transfer});
 await act(async()=>group.dispatchEvent(over));expect(over.defaultPrevented).toBe(false);expect(group.classList.contains('stack-drop-target')).toBe(false);
 expect(frontendLogger.getEntries().some(entry=>entry.component==='stack.dnd'&&entry.event==='dragover.rejected'
  &&entry.context?.rejectionReason==='singleton-target')).toBe(true);
 const drop=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:transfer});
 await act(async()=>group.dispatchEvent(drop));
 expect(host.querySelectorAll('.stack-singleton-warning .stack-photo')).toHaveLength(1);
 expect(host.querySelector('.stack-evidence.singleton-warning')).not.toBeNull();
 await click('.stack-purge-group');expect(host.querySelector('.stack-singleton-warning')).toBeNull();
 expect(host.querySelector('.stack-pending-summary')?.textContent).toBe('Pending: New 0 / Update 0 / Dissolve 1');
 vi.mocked(fetch).mockImplementation(async(_url,init)=>{
  const op=JSON.parse(init!.body as string).operations[0];
  expect(op).toEqual({operationId:`delete:${existingStackId}`,type:'delete',stackId:existingStackId});
  return new Response(JSON.stringify({results:[{operationId:op.operationId,status:'success',stackId:existingStackId}]}));
 });
 await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());
 expect(host.querySelector('.stack-singleton-warning')).toBeNull();expect(fetch).toHaveBeenCalledOnce();
 expect(host.querySelector('.stack-section-heading .stack-send-status')?.textContent).toBe('Applied to Immich.');
 expect(host.querySelector('.stack-section-heading .stack-send-status')?.classList.contains('stack-send-status-error')).toBe(false);
 expect(host.querySelector('.stack-control-bar .stack-send-status')).toBeNull();
 expect(host.querySelector('.stack-candidate-grid .stack-send-status')).toBeNull();
});
it('shows a failed singleton DELETE result in the toolbar',async()=>{
 api.resolve.mockResolvedValue([singletonStack]);
 await mount('/stack',{selectedAssets:[singletonMember,singles[0]]});
 await click('.stack-purge-group');
 vi.mocked(fetch).mockImplementation(async(_url,init)=>{
  const op=JSON.parse(init!.body as string).operations[0];
  return new Response(JSON.stringify({results:[{operationId:op.operationId,status:'failed'}]}));
 });
 await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());
 expect(host.querySelector('.stack-section-heading .stack-send-status')?.textContent).toBe(i18n.t('stackManagement.sendFailure'));
 expect(host.querySelector('.stack-section-heading .stack-send-status')?.classList.contains('stack-send-status-error')).toBe(true);
 expect(host.querySelector('.stack-candidate-grid .stack-send-status')).toBeNull();
});
const secondStackId='92345678-1234-4234-9234-123456789abc';
const secondPrimary='a2345678-1234-4234-9234-123456789abc';
const secondMembers=[
 {...photos[0],id:'b2345678-1234-4234-9234-123456789abc',filename:'second.dng'},
 {...photos[1],id:secondPrimary,filename:'second.jpg'},
].map(asset=>({...asset,stackId:secondStackId,primaryAssetId:secondPrimary,stackAssetCount:2}));
const secondStack={id:secondStackId,primaryAssetId:secondPrimary,assets:secondMembers};
const button = (text: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === text)!;
const unmatched = () => Array.from(host.querySelectorAll('.stack-unmatched-grid .stack-filename')).map(e => e.textContent);
it('uses the concise Japanese wording for unknown Stack outcomes',async()=>{
 await i18n.changeLanguage('ja');
 expect(i18n.t('stackManagement.sendUnknown')).toBe('一部STACKの反映結果を確認できませんでした。再検出して確認してください。');
});

it('shows full Immich membership beside auto candidates and keeps the Immich primary Cover',async()=>{
 api.resolve.mockResolvedValue([existingStack]);
 await mount('/stack',{selectedAssets:[...photos,existingMembers[1],existingMembers[0],singles[0]]});
 expect(api.resolve).toHaveBeenCalledOnce();expect(api.resolve.mock.calls[0][0]).toEqual([existingStackId]);
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(2);expect(host.querySelectorAll('.stack-photo')).toHaveLength(6);
 expect(unmatched()).toEqual(['x.jpg']);
 const immich=host.querySelector('.stack-candidate-group')!;
 expect(immich.querySelector('.stack-set-target')).not.toBeNull();
 expect(Array.from(immich.querySelectorAll('.stack-filename')).map(e=>e.textContent)).toEqual(['hidden.jpg','primary.dng','hidden.png']);
 expect(immich.querySelector('.stack-cover .stack-filename')?.textContent).toBe('primary.dng');
 expect(immich.querySelector('.stack-evidence.matched [aria-hidden]')?.textContent).toBe('IMMICH');
 expect(immich.querySelector('.visually-hidden')?.textContent).toBe('Immich Stack');
 expect(immich.querySelectorAll('.stack-evidence')).toHaveLength(1);
 expect(api.detail.mock.calls.map(call=>call[0]).sort()).toEqual(['jpeg','raw']);
 await click('[aria-label="Set hidden.jpg as COVER"]');
 expect(immich.querySelector('.stack-evidence.mismatch')?.getAttribute('title')).toBe('Immich Stack with unsaved changes');
 expect(immich.querySelector('.stack-group-indicators')?.textContent).toContain('IMMICH');
 expect(immich.querySelector('.stack-group-indicators')?.textContent).not.toContain('MANUAL');
 await click('.stack-unmatched-grid .stack-photo');await click('.stack-set-target');
 expect(immich.querySelectorAll('.stack-filename')).toHaveLength(4);
 expect(immich.querySelector('.stack-cover .stack-filename')?.textContent).toBe('hidden.jpg');
});
it('blocks editing during Immich resolution and provides a safe retry after failure',async()=>{
 let fail!:(error:Error)=>void;api.resolve.mockImplementation(()=>new Promise((_resolve,reject)=>{fail=reject;}));
 await mount('/stack',{selectedAssets:[existingMembers[1]]});
 expect(host.textContent).toContain('Loading Immich Stacks');expect(host.querySelectorAll('.stack-photo')).toHaveLength(0);
 expect(button('Detect again').disabled).toBe(true);expect(button('New Stack').disabled).toBe(true);
 await act(async()=>fail(new Error('offline')));
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('Immich Stack information could not be loaded');
 expect(host.querySelectorAll('.stack-photo')).toHaveLength(0);expect(button('New Stack').disabled).toBe(true);
 expect(button('Detect again').disabled).toBe(false);
 api.resolve.mockResolvedValue([existingStack]);await act(async()=>button('Detect again').click());
 expect(host.querySelectorAll('.stack-photo')).toHaveLength(3);expect(host.querySelector<HTMLButtonElement>('.stack-photo')?.disabled).toBe(false);
 expect(host.querySelector('button[disabled]')?.textContent).not.toBe('Detect again');
});
it('waits for both full Stack resolution and auto detail completion before enabling editing',async()=>{
 let finishStacks!:(value:typeof existingStack[])=>void;
 const details:Array<()=>void>=[];
 api.resolve.mockImplementation(()=>new Promise(resolve=>{finishStacks=resolve;}));
 api.detail.mockImplementation((id:string)=>new Promise(resolve=>details.push(()=>resolve({id,exif:{}}))));
 await mount('/stack',{selectedAssets:[...photos,existingMembers[1]]});
 expect(button('Detect again').disabled).toBe(true);
 await act(async()=>finishStacks([existingStack]));
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(2);
 for(const control of host.querySelectorAll<HTMLButtonElement>('.stack-photo,.stack-set-target,.stack-purge-member,.stack-purge-group')) expect(control.disabled).toBe(true);
 expect(details).toHaveLength(2);
 await act(async()=>details.forEach(resolve=>resolve()));
 for(const control of host.querySelectorAll<HTMLButtonElement>('.stack-photo,.stack-set-target,.stack-purge-member,.stack-purge-group')) expect(control.disabled).toBe(false);
 expect(button('Detect again').disabled).toBe(false);
});
it('restores the green indicator and redetects without confirmation after Cover restoration',async()=>{
 api.resolve.mockResolvedValue([existingStack]);await mount('/stack',{selectedAssets:[existingMembers[1]]});
 await click('[aria-label="Set hidden.jpg as COVER"]');
 expect(host.querySelector('.stack-evidence.mismatch [aria-hidden]')?.textContent).toBe('IMMICH');
 await click('[aria-label="Set primary.dng as COVER"]');
 expect(host.querySelector('.stack-evidence.matched [aria-hidden]')?.textContent).toBe('IMMICH');
 await act(async()=>button('Detect again').click());
 expect(api.resolve).toHaveBeenCalledTimes(2);expect(button('Continue')).toBeUndefined();
});
it('restores green IMMICH after member Add and exact group recreation without a redetect confirmation',async()=>{
 api.resolve.mockResolvedValue([existingStack]);await mount('/stack',{selectedAssets:[existingMembers[1]]});
 await click('[aria-label="Remove hidden.png from draft Stack"]');
 expect(host.querySelector('.stack-evidence.mismatch [aria-hidden]')?.textContent).toBe('IMMICH');
 await click('.stack-unmatched-grid .stack-photo');await click('.stack-set-target');
 expect(host.querySelector('.stack-evidence.matched [aria-hidden]')?.textContent).toBe('IMMICH');
 await click('.stack-purge-group');
 for(const photo of Array.from(host.querySelectorAll<HTMLButtonElement>('.stack-unmatched-grid .stack-photo'))) await act(async()=>photo.click());
 await act(async()=>button('New Stack').click());
 expect(host.querySelector('.stack-group-indicators')?.textContent).not.toContain('MANUAL');
 await click('[aria-label="Set primary.dng as COVER"]');
 expect(host.querySelector('.stack-evidence.matched [aria-hidden]')?.textContent).toBe('IMMICH');
 await act(async()=>button('Detect again').click());
 expect(api.resolve).toHaveBeenCalledTimes(2);expect(button('Continue')).toBeUndefined();
});
it('confirms before redetection and restores the latest Immich primary on Continue',async()=>{
 api.resolve.mockResolvedValue([existingStack]);await mount('/stack',{selectedAssets:[existingMembers[1]]});
 await click('[aria-label="Set hidden.jpg as COVER"]');await click('.stack-set-target');
 await act(async()=>button('Detect again').click());await act(async()=>button('Cancel').click());
 expect(api.resolve).toHaveBeenCalledOnce();expect(host.querySelector('.stack-cover .stack-filename')?.textContent).toBe('hidden.jpg');
 expect(host.querySelector('.stack-add-target')).not.toBeNull();
 const latestPrimary=existingMembers[2].id;
 api.resolve.mockResolvedValue([{...existingStack,primaryAssetId:latestPrimary,assets:existingMembers.map(a=>({...a,primaryAssetId:latestPrimary}))}]);
 await act(async()=>button('Detect again').click());await act(async()=>button('Continue').click());
 expect(api.resolve).toHaveBeenCalledTimes(2);expect(host.querySelector('.stack-cover .stack-filename')?.textContent).toBe('hidden.png');
 expect(host.querySelector('.stack-add-target')).toBeNull();expect(host.querySelector('.stack-evidence.matched [aria-hidden]')?.textContent).toBe('IMMICH');
});

it('changes Cover only on member click and keeps evidence; member Purge does not toggle selection', async () => {
 await mount('/stack', {selectedAssets: [...photos, ...singles]});
 expect(host.querySelector('[aria-label="Current COVER: selected.jpg"]')).not.toBeNull();
 await click('[aria-label="Set selected.dng as COVER"]');
 expect(host.querySelector('.stack-cover .stack-filename')?.textContent).toBe('selected.dng');
 expect(host.querySelectorAll('.stack-group-indicators .stack-evidence')).toHaveLength(4);
 expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('0 selected');
 await click('.stack-purge-member');
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(0);
 expect(unmatched()).toEqual(['selected.dng','selected.jpg','x.jpg','y.jpg']);
 expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('0 selected');
});
it('uses plus to toggle or switch Add target when no unmatched photos are selected', async () => {
 const other = photos.map(a=>({...a,id:'other-'+a.id,filename:'other.'+(a.is_raw?'dng':'jpg')}));
 api.detail.mockImplementation(async (id:string)=>({id,exif:{}}));
 await mount('/stack',{selectedAssets:[...photos,...other]});
 const targets=host.querySelectorAll<HTMLButtonElement>('.stack-set-target');
 await act(async()=>targets[0].click()); expect(targets[0].getAttribute('aria-pressed')).toBe('true');
 await act(async()=>targets[1].click()); expect(targets[0].getAttribute('aria-pressed')).toBe('false'); expect(targets[1].getAttribute('aria-pressed')).toBe('true');
 await act(async()=>targets[1].click()); expect(host.querySelector('.stack-add-target')).toBeNull();
 expect(host.querySelectorAll('.stack-unmatched-grid .stack-photo')).toHaveLength(0);
});
it('keeps the existing A and control-bar Add action paths', async () => {
 const more = [{ ...photos[1], id:'z', filename:'z.jpg' }, { ...photos[1], id:'w', filename:'w.jpg' }];
 const other = photos.map(a=>({...a,id:'other-'+a.id,filename:'other.'+(a.is_raw?'dng':'jpg')}));
 api.detail.mockImplementation(async (id:string)=>({id,exif:{}}));
 await mount('/stack',{selectedAssets:[...photos,...singles,...more,...other]});
 const targets=host.querySelectorAll<HTMLButtonElement>('.stack-set-target');
 await act(async()=>targets[0].click());
 await click('.stack-unmatched-grid .stack-photo-wrapper:last-child .stack-photo');
 await click('.stack-unmatched-grid .stack-photo');
 expect(button('Add to selected stack').title).toContain('(A)');
 await press('A');
 expect(unmatched()).toEqual(['y.jpg','z.jpg']); expect(host.querySelector('.stack-add-target')).toBeNull();
 expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('0 selected');
 expect(host.querySelector('.stack-candidate-group .stack-group-indicators')?.textContent).toBe('MANUAL');

 await act(async()=>targets[1].click());
 await click('.stack-unmatched-grid .stack-photo-wrapper:last-child .stack-photo');
 await click('.stack-unmatched-grid .stack-photo');
 await act(async()=>button('Add to selected stack').click());
 expect(unmatched()).toEqual([]); expect(host.querySelector('.stack-add-target')).toBeNull();
 expect(host.querySelectorAll('.stack-candidate-group')[1].querySelector('.stack-group-indicators')?.textContent).toBe('MANUAL');
});
it('lets selected unmatched photos be added directly with plus without using the bar or A', async () => {
 const other = photos.map(a=>({...a,id:'other-'+a.id,filename:'other.'+(a.is_raw?'dng':'jpg')}));
 api.detail.mockImplementation(async (id:string)=>({id,exif:{}}));
 await mount('/stack',{selectedAssets:[...photos,...singles,...other]});
 await click('.stack-unmatched-grid .stack-photo-wrapper:last-child .stack-photo');
 await click('.stack-unmatched-grid .stack-photo');
 expect(host.querySelectorAll('.stack-unmatched-grid .stack-photo.stack-selection-active')).toHaveLength(2);
 const beforeCount=host.querySelectorAll('.stack-candidate-group')[1].querySelectorAll('.stack-filename').length;
 await act(async()=>host.querySelectorAll<HTMLButtonElement>('.stack-set-target')[1].click());
 expect(unmatched()).toEqual([]); expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('0 selected');
 expect(host.querySelector('.stack-add-target')).toBeNull();
 const after=host.querySelectorAll('.stack-candidate-group')[1];
 expect(Array.from(after.querySelectorAll('.stack-filename')).map(e=>e.textContent)).toEqual(['other.dng','other.jpg','x.jpg','y.jpg']);
 expect(after.querySelector('.stack-cover .stack-filename')?.textContent).toBe('other.jpg');
 expect(after.querySelectorAll('.stack-cover-badge')).toHaveLength(1);
 expect(after.querySelector('.stack-cover')?.classList.contains('stack-selection-active')).toBe(false);
 expect(after.querySelector('.stack-cover')?.getAttribute('aria-label')).toBe('Current COVER: other.jpg');
 expect(after.querySelector('.stack-group-indicators')?.textContent).toBe('MANUAL');
 expect(after.querySelectorAll('.stack-filename')).toHaveLength(beforeCount+2);
});
it('creates a manual Stack from two selected unmatched photos and dissolves it in original order', async () => {
 await mount('/stack',{selectedAssets:singles});
 expect(button('New Stack').disabled).toBe(true);
 await click('.stack-unmatched-grid .stack-photo'); expect(button('New Stack').disabled).toBe(true);
 await click('.stack-unmatched-grid .stack-photo-wrapper:last-child .stack-photo'); await act(async()=>button('New Stack').click());
 expect(unmatched()).toEqual([]); expect(host.querySelector('.stack-group-indicators')?.textContent).toBe('MANUAL');
 expect(host.querySelector('.stack-cover .stack-filename')?.textContent).toBe('x.jpg');
 await click('.stack-set-target'); await click('.stack-purge-group');
 expect(host.querySelector('.stack-add-target')).toBeNull(); expect(unmatched()).toEqual(['x.jpg','y.jpg']);
});
it('blocks all manual editing until detail completion and cannot roll back subsequent edits', async () => {
 const pending: Array<()=>void> = [];
 api.detail.mockImplementation((id:string)=>new Promise(resolve=>pending.push(()=>resolve({id,exif:{}}))));
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 for(const control of host.querySelectorAll<HTMLButtonElement>('.stack-purge-group,.stack-purge-member,.stack-set-target,.stack-photo')) expect(control.disabled).toBe(true);
 await click('.stack-purge-group'); await click('.stack-photo'); expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
 await act(async()=>pending.splice(0).forEach(resolve=>resolve()));
 expect(host.querySelector<HTMLButtonElement>('.stack-purge-group')?.disabled).toBe(false);
 await click('.stack-purge-group');
 await act(async()=>{ updateSetting('homeThumbnailColumns',5); });
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(0); expect(unmatched()).toHaveLength(4);
});
it('asks before discarding edits, focuses Cancel, retains state on Cancel and resets on Continue', async () => {
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 await click('[aria-label="Set selected.dng as COVER"]');
 await click('.stack-set-target'); await click('.stack-unmatched-grid .stack-photo');
 const requests=api.detail.mock.calls.length;
 await act(async()=>button('Detect again').click());
 expect(document.activeElement?.textContent).toBe('Cancel'); expect(api.detail).toHaveBeenCalledTimes(requests);
 await press('h'); await press('a'); expect(host.querySelector('.stack-management-page')).not.toBeNull();
 await act(async()=>button('Cancel').click());
 expect(host.querySelector('.stack-add-target')).not.toBeNull(); expect(host.querySelector('.stack-cover .stack-filename')?.textContent).toBe('selected.dng');
 expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('1 selected');
 await act(async()=>button('Detect again').click()); await act(async()=>button('Continue').click());
 expect(api.detail).toHaveBeenCalledTimes(requests+2); expect(host.querySelector('.stack-cover .stack-filename')?.textContent).toBe('selected.jpg');
 expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('0 selected'); expect(host.querySelector('.stack-add-target')).toBeNull();
 await act(async()=>button('Detect again').click()); expect(host.querySelector('dialog')).toBeNull();
});
it('guards A and Escape against modifiers, IME, repeats, menus, native editing and prevented events', async () => {
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 await press('a'); await click('.stack-set-target'); await press('a'); expect(unmatched()).toHaveLength(2);
 await click('.stack-unmatched-grid .stack-photo');
 for(const key of ['a','Escape']) {
  for(const options of [{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{isComposing:true},{repeat:true}]) await press(key,options);
  const input=document.createElement('textarea');host.append(input);await press(key,{},input);input.remove();
  const menu=document.createElement('div');menu.setAttribute('role','menu');host.append(menu);await press(key);menu.remove();
  await act(async()=>{const event=new KeyboardEvent('keydown',{key,cancelable:true});event.preventDefault();window.dispatchEvent(event);});
 }
 expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('1 selected');expect(host.querySelector('.stack-add-target')).not.toBeNull();
 await press('Escape');expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('0 selected');expect(host.querySelector('.stack-add-target')).toBeNull();
});
it('keeps selection and target while Settings blocks A and Escape', async () => {
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 await click('.stack-set-target');await click('.stack-unmatched-grid .stack-photo');await click('.settings-button');
 await press('a');await press('Escape');
 expect(host.querySelector('.stack-add-target')).not.toBeNull();expect(host.querySelector('.stack-control-bar strong')?.textContent).toBe('1 selected');
});
it('shows MANUAL after member Purge that leaves two members and retains a non-purged Cover', async () => {
 const third={...photos[1],id:'png',filename:'selected.png',format:'PNG'};
 api.detail.mockImplementation(async(id:string)=>({id,exif:{}}));
 await mount('/stack',{selectedAssets:[...photos,third]});
 await click('[aria-label="Remove selected.dng from draft Stack"]');
 expect(host.querySelector('.stack-group-indicators')?.textContent).toBe('MANUAL');
 expect(host.querySelector('.stack-cover .stack-filename')?.textContent).toBe('selected.jpg');
 expect(unmatched()).toEqual(['selected.dng']);
});

it('hides the pending summary when the write plan has no operations',async()=>{
 api.resolve.mockResolvedValue([existingStack]);
 await mount('/stack',{selectedAssets:[existingMembers[1]]});
 expect(host.querySelector('.stack-pending-summary')).toBeNull();
});
it('summarizes one pending create in the toolbar',async()=>{
 await mount('/stack',{selectedAssets:photos});
 expect(host.querySelector('.stack-pending-summary')?.textContent).toBe('Pending: New 1 / Update 0 / Dissolve 0');
 await act(async()=>i18n.changeLanguage('ja'));
 expect(host.querySelector('.stack-pending-summary')?.textContent).toBe('未送信: 新規 1 / 更新 0 / 解除 0');
});
it('summarizes one pending update in the toolbar',async()=>{
 api.resolve.mockResolvedValue([existingStack]);
 await mount('/stack',{selectedAssets:[existingMembers[1]]});
 await click('[aria-label="Set hidden.jpg as COVER"]');
 expect(host.querySelector('.stack-pending-summary')?.textContent).toBe('Pending: New 0 / Update 1 / Dissolve 0');
});
it('summarizes one pending delete in the toolbar without a candidate status row',async()=>{
 api.resolve.mockResolvedValue([existingStack]);
 await mount('/stack',{selectedAssets:[existingMembers[1]]});
 await click('.stack-purge-group');
 expect(host.querySelector('.stack-pending-summary')?.textContent).toBe('Pending: New 0 / Update 0 / Dissolve 1');
 expect(host.querySelectorAll('.stack-candidate-grid .stack-status')).toHaveLength(0);
});
it('shares create, update and delete counts between the toolbar and send confirmation',async()=>{
 api.resolve.mockResolvedValue([existingStack,secondStack]);
 await mount('/stack',{selectedAssets:[...photos,existingMembers[1],secondMembers[1]]});
 await click('[aria-label="Set hidden.jpg as COVER"]');
 await click(`[data-stack-id="draft:immich:${secondStackId}"] .stack-purge-group`);
 const summary='Pending: New 1 / Update 1 / Dissolve 1';
 expect(host.querySelector('.stack-pending-summary')?.textContent).toBe(summary);
 await act(async()=>button('Send to Immich').click());
 expect(host.querySelector('dialog')?.textContent).toContain('New 1, update 1, dissolve 1');
});
it('summarizes multiple pending deletes without listing individual stacks',async()=>{
 api.resolve.mockResolvedValue([existingStack,secondStack]);
 await mount('/stack',{selectedAssets:[existingMembers[1],secondMembers[1]]});
 await click(`[data-stack-id="draft:immich:${existingStackId}"] .stack-purge-group`);
 await click(`[data-stack-id="draft:immich:${secondStackId}"] .stack-purge-group`);
 expect(host.querySelector('.stack-pending-summary')?.textContent).toBe('Pending: New 0 / Update 0 / Dissolve 2');
 expect(host.querySelectorAll('.stack-candidate-grid .stack-status')).toHaveLength(0);
 expect(host.querySelector('.stack-candidate-grid')?.textContent).not.toContain('pending dissolution');
 expect(host.querySelector('.stack-candidate-grid')?.textContent).not.toContain('hidden.jpg');
 expect(host.querySelector('.stack-candidate-grid')?.textContent).not.toContain('second.jpg');
});
it('confirms sending with counts, Cancel focus and Escape dismissal',async()=>{
 await mount('/stack',{selectedAssets:photos});
 expect(button('Send to Immich').disabled).toBe(false);
 await act(async()=>button('Send to Immich').click());
 expect(host.querySelector('dialog')?.textContent).toContain('New 1, update 0, dissolve 0');
 expect(document.activeElement?.textContent).toBe('Cancel');
 await press('Escape',{},document.activeElement!);expect(host.querySelector('dialog')).toBeNull();
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
});
it('sends only once, disables editing, cleans candidates and preserves unmatched for further work',async()=>{
 let finish!:(value:Response)=>void;
 const fetch=vi.fn((_url: string, _init: RequestInit)=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetch);
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 await act(async()=>button('Send to Immich').click());
 await act(async()=>{button('Continue').click();button('Continue')?.click();});
 expect(fetch).toHaveBeenCalledOnce();expect(button('Send to Immich').getAttribute('aria-busy')).toBe('true');
 for(const control of host.querySelectorAll<HTMLButtonElement>('.stack-photo,.stack-purge-group,.stack-purge-member,.stack-set-target')) expect(control.disabled).toBe(true);
 expect(button('Detect again').disabled).toBe(true);
 const payload=JSON.parse(fetch.mock.calls[0][1].body as string);
 await act(async()=>finish(new Response(JSON.stringify({results:[{operationId:payload.operations[0].operationId,status:'success',stackId:existingStackId}]}))));
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(0);expect(unmatched()).toEqual(['x.jpg','y.jpg']);
 for(const photo of Array.from(host.querySelectorAll<HTMLButtonElement>('.stack-unmatched-grid .stack-photo'))) await act(async()=>photo.click());
 await act(async()=>button('New Stack').click());expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
});
it('removes unchanged without writes and exposes delete failure with a safe manual retry',async()=>{
 api.resolve.mockResolvedValue([existingStack]);await mount('/stack',{selectedAssets:[existingMembers[1]]});
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());
 expect(fetch).not.toHaveBeenCalled();expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(0);
 expect(button('Send to Immich').disabled).toBe(true);
 await act(async()=>button('Detect again').click());await click('.stack-purge-group');
 fetch.mockImplementation(async(_url:string,init:RequestInit)=>new Response(JSON.stringify({results:JSON.parse(init.body as string).operations.map((op:{operationId:string})=>({operationId:op.operationId,status:'failed',errorCode:'authentication_failed'}))})));
 await act(async()=>button('Send to Immich').click());expect(host.querySelector('dialog')?.textContent).toContain('dissolve 1');
 await act(async()=>button('Continue').click());
 expect(host.textContent).toContain('could not be applied');expect(host.querySelector('.stack-pending-summary')?.textContent).toBe('Pending: New 0 / Update 0 / Dissolve 1');
 expect(host.querySelectorAll('.stack-candidate-grid .stack-status')).toHaveLength(0);expect(unmatched()).toHaveLength(3);expect(button('Send to Immich').disabled).toBe(false);
 fetch.mockImplementation(async(_url:string,init:RequestInit)=>new Response(JSON.stringify({results:JSON.parse(init.body as string).operations.map((op:{operationId:string})=>({operationId:op.operationId,status:'success'}))})));
 await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());
 expect(host.querySelector('.stack-pending-summary')).toBeNull();expect(unmatched()).toHaveLength(3);
});
it('retains unknown work, labels outcome uncertainty and requires redetection before resend',async()=>{
 await mount('/stack',{selectedAssets:photos});
 const fetch=vi.fn().mockRejectedValue(new Error('lost'));vi.stubGlobal('fetch',fetch);
 await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
 expect(host.querySelector('.stack-evidence.error')?.getAttribute('title')).toContain('outcomes could not be confirmed');
 expect(host.querySelector('.stack-section-heading .stack-send-status')?.textContent).toBe(i18n.t('stackManagement.sendUnknown'));
 expect(host.querySelector('.stack-section-heading .stack-send-status')?.classList.contains('stack-send-status-error')).toBe(true);
 expect(host.querySelector('.stack-candidate-grid .stack-send-status')).toBeNull();
 expect(button('Send to Immich').disabled).toBe(true);expect(fetch).toHaveBeenCalledOnce();
 await act(async()=>button('Detect again').click());
 if(button('Continue')) await act(async()=>button('Continue').click());
 expect(api.refresh).toHaveBeenCalledOnce();expect(button('Send to Immich').disabled).toBe(false);
});
it('retains failed candidate with accessible red status and retries only on explicit confirmation',async()=>{
 await mount('/stack',{selectedAssets:photos});
 const fetch=vi.fn().mockImplementation(async(_url:string,init:RequestInit)=>new Response(JSON.stringify({results:JSON.parse(init.body as string).operations.map((op:{operationId:string})=>({operationId:op.operationId,status:'failed'}))})));vi.stubGlobal('fetch',fetch);
 await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());
 expect(host.querySelector('.stack-evidence.error .visually-hidden')?.textContent).toContain('could not be applied');
 expect(button('Send to Immich').disabled).toBe(false);expect(fetch).toHaveBeenCalledOnce();
 await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());expect(fetch).toHaveBeenCalledTimes(2);
});

it('applies a partial batch by removing only successes and marking failed work',async()=>{
 const more=photos.map(asset=>({...asset,id:'second-'+asset.id,filename:'second.'+(asset.is_raw?'dng':'jpg')}));
 api.detail.mockImplementation(async(id:string)=>({id,exif:{}}));
 await mount('/stack',{selectedAssets:[...photos,...more,...singles]});
 const fetch=vi.fn(async(_url:string,init:RequestInit)=>{
  const operations=JSON.parse(init.body as string).operations;
  return new Response(JSON.stringify({results:operations.map((op:{operationId:string},index:number)=>({operationId:op.operationId,status:index?'failed':'success',...(index?{}:{stackId:existingStackId})}))}));
 });vi.stubGlobal('fetch',fetch);
 await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);expect(unmatched()).toEqual(['x.jpg','y.jpg']);
 expect(host.querySelector('.stack-evidence.error')).not.toBeNull();expect(host.querySelector('.stack-section-heading .stack-send-status')?.textContent).toContain('could not be applied');
});
it('aborts the frontend wait on Home navigation without resending the write',async()=>{
 let signal:AbortSignal|undefined;
 const fetch=vi.fn((url:string,init:RequestInit)=>{if(url!=='/api/stacks/apply') return Promise.resolve(new Response('{}'));signal=init.signal as AbortSignal;return new Promise<Response>(()=>{});});vi.stubGlobal('fetch',fetch);
 await mount('/stack',{selectedAssets:photos});
 await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());
 expect(signal?.aborted).toBe(false);await press('H');expect(signal?.aborted).toBe(true);expect(fetch.mock.calls.filter(call=>call[0]==='/api/stacks/apply')).toHaveLength(1);
});
it('aborts and ignores a successful send result after same-route navigation changes the selection',async()=>{
 api.resolve.mockResolvedValue([existingStack]);
 const next=[
  {...photos[0],id:'next-raw',filename:'next.dng'},
  {...photos[1],id:'next-jpeg',filename:'next.jpg'},
 ];
 api.detail.mockImplementation(async(id:string)=>({id,filename:id==='next-raw'?'next.dng':'next.jpg',format:id.endsWith('raw')?'DNG':'JPEG',is_raw:id.endsWith('raw'),date:'2026-09-01',thumbnail_url:'/next',exif:{},preview_url:'/preview'}));
 const finishes:Array<(response:Response)=>void>=[],signals:AbortSignal[]=[];
 const fetch=vi.fn((_url:string,init:RequestInit)=>{signals.push(init.signal as AbortSignal);return new Promise<Response>(resolve=>{finishes.push(resolve);});});vi.stubGlobal('fetch',fetch);
 await mount('/stack',{selectedAssets:[...photos,existingMembers[1]]});await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());
 expect(signals[0].aborted).toBe(false);
 await act(async()=>navigateTest('/stack',{selectedAssets:[...next,existingMembers[1]]}));
 expect(signals[0].aborted).toBe(true);
 await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());
 expect(signals[1].aborted).toBe(false);expect(button('Send to Immich').getAttribute('aria-busy')).toBe('true');
 await act(async()=>finishes[0](new Response(JSON.stringify({results:[{operationId:'draft:auto:selected',status:'success',stackId:existingStackId}]}))));
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(2);
 expect(host.textContent).toContain('next.dng');
 expect(button('Send to Immich').getAttribute('aria-busy')).toBe('true');expect(signals[1].aborted).toBe(false);
 expect(host.textContent).not.toContain('Applied to Immich.');
 await act(async()=>finishes[1](new Response(JSON.stringify({results:[{operationId:'draft:auto:next',status:'success',stackId:existingStackId}]}))));
 expect(button('Send to Immich').getAttribute('aria-busy')).not.toBe('true');
});
it('refreshes latest membership after unknown create without relying on old Stack IDs',async()=>{
 await mount('/stack',{selectedAssets:photos});
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('lost')));
 await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());
 const created={id:existingStackId,primaryAssetId:'jpeg',assets:photos.map(asset=>({...asset,stackId:existingStackId,primaryAssetId:'jpeg',stackAssetCount:2}))};
 api.refresh.mockResolvedValue([created]);
 await act(async()=>button('Detect again').click());
 expect(api.refresh.mock.calls[0][0]).toEqual(['raw','jpeg']);
 expect(host.querySelector('.stack-evidence.matched [aria-hidden]')?.textContent).toBe('IMMICH');
 expect(button('Send to Immich').disabled).toBe(false);expect(api.detail).toHaveBeenCalledTimes(2);
});
it('retains the current draft when a chunked re-detection refresh fails and allows retry',async()=>{
 api.refresh.mockRejectedValueOnce(new Error('chunk failed')).mockResolvedValueOnce([]);
 await mount('/stack',{selectedAssets:photos});expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
 await act(async()=>button('Detect again').click());
 expect(api.refresh).toHaveBeenCalledTimes(1);expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
 await act(async()=>button('Detect again').click());
 expect(api.refresh).toHaveBeenCalledTimes(2);expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
});
function dragTransfer(payload?: {assetId:string;sourceGroupId:string|null}, extraTypes:string[]=[], files:File[]=[], rawData?:string, hideCustomData=false): DataTransfer {
 const store=new Map<string,string>(), types:string[]=[...extraTypes], transfer={
  files:files as unknown as FileList,types,
  setData:(type:string,value:string)=>{store.set(type,value);if(!types.includes(type))types.push(type);},
  getData:(type:string)=>hideCustomData&&type==='application/x-genzoroom-stack-photo+json'?'':store.get(type)??'',clearData:()=>{store.clear();types.splice(0);},
  effectAllowed:'all',dropEffect:'none',
 };
 if(payload)transfer.setData('application/x-genzoroom-stack-photo+json',JSON.stringify(payload));
 else if(rawData!==undefined)transfer.setData('application/x-genzoroom-stack-photo+json',rawData);
 return transfer as unknown as DataTransfer;
}
function dragEvent(type:string,transfer:DataTransfer,relatedTarget?:EventTarget|null):DragEvent {
 const event=new Event(type,{bubbles:true,cancelable:true}) as DragEvent;
 Object.defineProperty(event,'dataTransfer',{value:transfer});
 if(type==='dragleave')Object.defineProperty(event,'relatedTarget',{value:relatedTarget??null});
 return event;
}
it('records safe D&D diagnostics with Chrome dragover deduplication and preserves the drop result',async()=>{
 frontendLogger.setLevel('debug');
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 const source=host.querySelector<HTMLButtonElement>('.stack-unmatched-grid .stack-photo')!;
 const target=host.querySelector<HTMLElement>('.stack-candidate-group')!;
 const transfer=dragTransfer({assetId:'x',sourceGroupId:null});
 await act(async()=>source.dispatchEvent(dragEvent('dragstart',transfer)));
 let over!:DragEvent;
 await act(async()=>{over=dragEvent('dragover',transfer);target.dispatchEvent(over);target.dispatchEvent(dragEvent('dragover',transfer));});
 expect(over.defaultPrevented).toBe(true);
 let entries=frontendLogger.getEntries().filter(entry=>entry.component==='stack.dnd');
 expect(entries.find(entry=>entry.event==='dragstart')?.context).toMatchObject({assetId:'x',sourceGroupId:null,hasCustomMime:true,refPayloadPresent:true,statePayloadPresent:false});
 expect(entries.filter(entry=>entry.event==='dragover.accepted')).toHaveLength(1);
 expect(entries.find(entry=>entry.event==='dragover.accepted')?.context).toMatchObject({targetKind:'stack',targetGroupId:expect.any(String),payloadSource:'data-transfer',accepted:true});
 const drop=dragEvent('drop',transfer);await act(async()=>target.dispatchEvent(drop));
 expect(drop.defaultPrevented).toBe(true);expect(target.querySelectorAll('.stack-photo')).toHaveLength(3);
 const moved=target.querySelector<HTMLButtonElement>('.stack-photo[aria-label*="x.jpg"]') ?? target.querySelector<HTMLButtonElement>('.stack-photo')!;
 await act(async()=>moved.dispatchEvent(dragEvent('dragend',transfer)));
 entries=frontendLogger.getEntries().filter(entry=>entry.component==='stack.dnd');
 expect(entries.find(entry=>entry.event==='drop.accepted')?.context).toMatchObject({operationKind:'unmatched-to-stack',assetId:'x',accepted:true});
 expect(entries.some(entry=>entry.event==='dragend')).toBe(true);
 expect(JSON.stringify(entries)).not.toContain('selected.jpg');
});
it('logs ref fallback and refuses malformed, missing-MIME and external-file drags',async()=>{
 frontendLogger.setLevel('debug');
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 const source=host.querySelector<HTMLButtonElement>('.stack-unmatched-grid .stack-photo')!;
 const target=host.querySelector<HTMLElement>('.stack-candidate-group')!;
 const active=dragTransfer({assetId:'x',sourceGroupId:null},[],[],undefined,true);
 await act(async()=>source.dispatchEvent(dragEvent('dragstart',active)));
 const hidden=dragEvent('dragover',active);await act(async()=>target.dispatchEvent(hidden));
 expect(hidden.defaultPrevented).toBe(true);
 expect(frontendLogger.getEntries().find(entry=>entry.event==='dragover.accepted')?.context).toMatchObject({payloadSource:'active-ref',customDataState:'empty'});
 const malformed=dragTransfer(undefined,['application/x-genzoroom-stack-photo+json'],[],'{bad');
 const malformedOver=dragEvent('dragover',malformed);await act(async()=>target.dispatchEvent(malformedOver));expect(malformedOver.defaultPrevented).toBe(false);
 const malformedDrop=dragEvent('drop',malformed);await act(async()=>target.dispatchEvent(malformedDrop));
 const noMime=dragTransfer(undefined,[],[],undefined,true);
 const noMimeOver=dragEvent('dragover',noMime);await act(async()=>target.dispatchEvent(noMimeOver));expect(noMimeOver.defaultPrevented).toBe(false);
 const file=dragTransfer({assetId:'x',sourceGroupId:null},[],[new File(['x'],'private-name.jpg')]);
 const fileOver=dragEvent('dragover',file);await act(async()=>target.dispatchEvent(fileOver));expect(fileOver.defaultPrevented).toBe(false);
 const entries=frontendLogger.getEntries().filter(entry=>entry.component==='stack.dnd'&&entry.event==='dragover.rejected');
 expect(entries.some(entry=>entry.context?.rejectionReason==='malformed-payload'&&entry.context.payloadSource==='none')).toBe(true);
 expect(entries.some(entry=>entry.context?.rejectionReason==='not-stack-drag'&&entry.context.refPayloadPresent===true)).toBe(true);
 expect(entries.some(entry=>entry.context?.rejectionReason==='external-file')).toBe(true);
 expect(frontendLogger.getEntries().some(entry=>entry.component==='stack.dnd'&&entry.event==='drop.rejected'
  &&entry.context?.rejectionReason==='malformed-payload')).toBe(true);
 expect(JSON.stringify(entries)).not.toContain('private-name.jpg');
});
it('logs rejected drag starts without recording external filenames',async()=>{
 frontendLogger.setLevel('debug');
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 const source=host.querySelector<HTMLButtonElement>('.stack-unmatched-grid .stack-photo')!;
 const external=dragTransfer(undefined,[],[new File(['x'],'must-not-log.jpg')]);
 await act(async()=>source.dispatchEvent(dragEvent('dragstart',external)));
 const entry=frontendLogger.getEntries().find(item=>item.component==='stack.dnd'&&item.event==='dragstart.rejected');
 expect(entry?.context).toMatchObject({assetId:'x',canEdit:true,filesLength:1,accepted:false,rejectionReason:'external-file'});
 expect(JSON.stringify(entry)).not.toContain('must-not-log.jpg');
});
it('uses the synchronous active payload when Chrome exposes the MIME type but hides its data',async()=>{
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 const group=host.querySelector<HTMLElement>('.stack-candidate-group')!;
 const sources=Array.from(host.querySelectorAll<HTMLButtonElement>('.stack-unmatched-grid .stack-photo'));
 const source=sources[0],transfer=dragTransfer({assetId:'x',sourceGroupId:null},[],[],undefined,true);
 let over!:DragEvent;
 await act(async()=>{
  source.dispatchEvent(dragEvent('dragstart',transfer));
  over=dragEvent('dragover',transfer);group.dispatchEvent(over);
 });
 expect(over.defaultPrevented).toBe(true);
 expect(group.classList.contains('stack-drop-target')).toBe(true);
 const drop=dragEvent('drop',transfer);await act(async()=>group.dispatchEvent(drop));
 expect(drop.defaultPrevented).toBe(true);expect(group.querySelectorAll('.stack-photo')).toHaveLength(3);
 expect(host.querySelector('.stack-photo-dragging')).toBeNull();

 const next=host.querySelector<HTMLButtonElement>('.stack-unmatched-grid .stack-photo')!;
 const nextTransfer=dragTransfer({assetId:'y',sourceGroupId:null},[],[],undefined,true);
 await act(async()=>next.dispatchEvent(dragEvent('dragstart',nextTransfer)));
 expect(next.classList.contains('stack-photo-dragging')).toBe(true);
 await act(async()=>next.dispatchEvent(dragEvent('dragend',nextTransfer)));
 expect(host.querySelector('.stack-photo-dragging')).toBeNull();
 const afterEnd=dragEvent('dragover',nextTransfer);await act(async()=>group.dispatchEvent(afterEnd));
 expect(afterEnd.defaultPrevented).toBe(false);
});
it('moves unmatched by internal native drop, highlights valid targets and preserves Cover and selection',async()=>{
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 await click('.stack-unmatched-grid .stack-photo-wrapper:last-child .stack-photo');
 const group=host.querySelector<HTMLElement>('.stack-candidate-group')!;
 const source=host.querySelector<HTMLButtonElement>('.stack-unmatched-grid .stack-photo-wrapper:first-child .stack-photo')!;
 const transfer=dragTransfer({assetId:'x',sourceGroupId:null});
 expect(source.draggable).toBe(true);expect(source.querySelector('img')?.draggable).toBe(false);
 await act(async()=>source.dispatchEvent(dragEvent('dragstart',transfer)));
 expect(source.draggable).toBe(true);expect(source.classList.contains('stack-photo-dragging')).toBe(true);
 await act(async()=>group.dispatchEvent(dragEvent('dragover',transfer)));
 expect(group.classList.contains('stack-drop-target')).toBe(true);
 const drop=dragEvent('drop',transfer);await act(async()=>group.dispatchEvent(drop));
 expect(drop.defaultPrevented).toBe(true);expect(group.querySelectorAll('.stack-photo')).toHaveLength(3);
 expect(group.querySelector<HTMLButtonElement>('.stack-photo')?.draggable).toBe(true);
 expect(Array.from(group.querySelectorAll<HTMLImageElement>('.stack-photo img')).every(image=>image.draggable===false)).toBe(true);
 expect(group.querySelector('.stack-cover .stack-filename')?.textContent).toBe('selected.jpg');
 expect(unmatched()).toEqual(['y.jpg']);expect(host.querySelectorAll('.stack-unmatched-grid .stack-selection-active')).toHaveLength(1);
 await act(async()=>source.dispatchEvent(dragEvent('dragend',transfer)));
 expect(host.querySelector('.stack-drop-target')).toBeNull();expect(host.querySelector('.stack-photo-dragging')).toBeNull();
});
it('creates one manual Stack by dropping an unmatched photo onto another and undoes the whole drop',async()=>{
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 const wrappers=Array.from(host.querySelectorAll<HTMLElement>('.stack-unmatched-grid .stack-photo-wrapper'));
 const source=wrappers[0].querySelector<HTMLButtonElement>('.stack-photo')!,target=wrappers[1];
 const transfer=dragTransfer({assetId:'x',sourceGroupId:null});
 await act(async()=>source.dispatchEvent(dragEvent('dragstart',transfer)));
 const over=dragEvent('dragover',transfer);await act(async()=>target.dispatchEvent(over));
 expect(over.defaultPrevented).toBe(true);expect(target.querySelector('.stack-photo')?.classList.contains('stack-drop-target')).toBe(true);
 expect(host.querySelector('#stack-unmatched-heading')?.parentElement?.classList.contains('stack-unmatched-drop-target')).toBe(false);
 await act(async()=>target.dispatchEvent(dragEvent('dragleave',transfer,host.querySelector('.stack-control-bar'))));
 expect(target.querySelector('.stack-photo')?.classList.contains('stack-drop-target')).toBe(false);
 await act(async()=>target.dispatchEvent(dragEvent('dragover',transfer)));
 const drop=dragEvent('drop',transfer);await act(async()=>target.dispatchEvent(drop));
 expect(drop.defaultPrevented).toBe(true);
 const created=Array.from(host.querySelectorAll<HTMLElement>('.stack-candidate-group')).at(-1)!;
 expect(created.querySelector('.stack-group-indicators')?.textContent).toBe('MANUAL');
 expect(Array.from(created.querySelectorAll('.stack-filename')).map(node=>node.textContent)).toEqual(['x.jpg','y.jpg']);
 expect(created.querySelector('.stack-cover .stack-filename')?.textContent).toBe('x.jpg');
 expect(host.querySelectorAll('.stack-unmatched-grid .stack-photo')).toHaveLength(0);
 await press('z',{ctrlKey:true});
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
 expect(unmatched()).toEqual(['x.jpg','y.jpg']);
 await act(async()=>source.dispatchEvent(dragEvent('dragend',transfer)));
 expect(host.querySelector('.stack-drop-target')).toBeNull();
});
it('does not consume invalid, external or malformed unmatched-photo drops',async()=>{
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 const wrappers=Array.from(host.querySelectorAll<HTMLElement>('.stack-unmatched-grid .stack-photo-wrapper'));
 const source=wrappers[0].querySelector<HTMLButtonElement>('.stack-photo')!,self=wrappers[0],other=wrappers[1];
 const transfer=dragTransfer({assetId:'x',sourceGroupId:null});await act(async()=>source.dispatchEvent(dragEvent('dragstart',transfer)));
 const selfOver=dragEvent('dragover',transfer);await act(async()=>self.dispatchEvent(selfOver));
 expect(selfOver.defaultPrevented).toBe(false);expect(self.querySelector('.stack-drop-target')).toBeNull();
 const selfDrop=dragEvent('drop',transfer);await act(async()=>self.dispatchEvent(selfDrop));expect(selfDrop.defaultPrevented).toBe(false);
 const malformed=dragTransfer(undefined,['application/x-genzoroom-stack-photo+json'],[],'{');
 const malformedDrop=dragEvent('drop',malformed);await act(async()=>other.dispatchEvent(malformedDrop));expect(malformedDrop.defaultPrevented).toBe(false);
 const noMime=dragTransfer();
 const noMimeOver=dragEvent('dragover',noMime);await act(async()=>other.dispatchEvent(noMimeOver));expect(noMimeOver.defaultPrevented).toBe(false);
 const external=dragTransfer(undefined,['Files'],[new File(['image'],'photo.jpg')]);
 const externalDrop=dragEvent('drop',external);await act(async()=>other.dispatchEvent(externalDrop));expect(externalDrop.defaultPrevented).toBe(false);
 const fileWithMime=dragTransfer(undefined,['application/x-genzoroom-stack-photo+json','Files'],[new File(['image'],'photo.jpg')],'');
 const fileOver=dragEvent('dragover',fileWithMime);await act(async()=>other.dispatchEvent(fileOver));expect(fileOver.defaultPrevented).toBe(false);
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);expect(unmatched()).toEqual(['x.jpg','y.jpg']);
 await act(async()=>source.dispatchEvent(dragEvent('dragend',transfer)));
});
it('moves an Immich member to another group and back without changing Cover or send classification',async()=>{
 api.resolve.mockResolvedValue([existingStack]);await mount('/stack',{selectedAssets:[...photos,existingMembers[1]]});
 const [immich,auto]=Array.from(host.querySelectorAll<HTMLElement>('.stack-candidate-group'));
 const cover=immich.querySelector('.stack-cover .stack-filename')?.textContent;
 const source=immich.querySelector<HTMLButtonElement>('.stack-photo')!;const transfer=dragTransfer({assetId:'hidden-first',sourceGroupId:'draft:immich:'+existingStackId});
 await act(async()=>source.dispatchEvent(dragEvent('dragstart',transfer)));
 await act(async()=>auto.dispatchEvent(dragEvent('dragover',transfer)));
 expect(auto.classList.contains('stack-drop-target')).toBe(true);
 await act(async()=>auto.dispatchEvent(dragEvent('drop',transfer)));
 expect(immich.querySelectorAll('.stack-photo')).toHaveLength(2);expect(auto.querySelectorAll('.stack-photo')).toHaveLength(3);
 expect(immich.querySelector('.stack-evidence.mismatch [aria-hidden]')?.textContent).toBe('IMMICH');
 expect(auto.querySelector('.stack-group-indicators')?.textContent).toBe('MANUAL');
 expect(immich.querySelector('.stack-cover .stack-filename')?.textContent).toBe(cover);
 const autoId=auto.dataset.stackId!;
 const moved=auto.querySelector<HTMLButtonElement>('[aria-label="Set hidden.jpg as COVER"]')!;
 const back=dragTransfer({assetId:'hidden-first',sourceGroupId:autoId});
 await act(async()=>moved.dispatchEvent(dragEvent('dragstart',back)));
 await act(async()=>immich.dispatchEvent(dragEvent('drop',back)));
 expect(immich.querySelectorAll('.stack-photo')).toHaveLength(3);
 expect(immich.querySelector('.stack-evidence.matched [aria-hidden]')?.textContent).toBe('IMMICH');
 expect(immich.querySelector('.stack-cover .stack-filename')?.textContent).toBe(cover);
});
it('purgess a member dropped into unmatched, ignores external/malformed/same-group drops, and keeps indicators out of hit targets',async()=>{
 api.resolve.mockResolvedValue([existingStack]);await mount('/stack',{selectedAssets:[existingMembers[1],singles[0]]});
 const group=host.querySelector<HTMLElement>('.stack-candidate-group')!,target=host.querySelector<HTMLElement>('#stack-unmatched-heading')!.parentElement!;
 const source=group.querySelector<HTMLButtonElement>('.stack-photo')!;
 const payload={assetId:'hidden-first',sourceGroupId:`draft:immich:${existingStackId}`};
 await act(async()=>source.dispatchEvent(dragEvent('dragstart',dragTransfer(payload))));
 const malformed=dragEvent('dragover',dragTransfer(undefined,['application/x-genzoroom-stack-photo+json']));
 await act(async()=>group.dispatchEvent(malformed));expect(malformed.defaultPrevented).toBe(false);expect(group.classList.contains('stack-drop-target')).toBe(false);
 const external=dragEvent('drop',dragTransfer(undefined,['Files']));await act(async()=>target.dispatchEvent(external));
 expect(external.defaultPrevented).toBe(false);expect(unmatched()).toEqual(['x.jpg']);
 const indicator=group.querySelector('.stack-group-indicators')!;
 const overIndicator=dragEvent('dragover',dragTransfer(payload));await act(async()=>indicator.dispatchEvent(overIndicator));
 expect(overIndicator.defaultPrevented).toBe(false);expect(group.classList.contains('stack-drop-target')).toBe(false);
 const same=dragEvent('dragover',dragTransfer(payload));await act(async()=>group.dispatchEvent(same));expect(same.defaultPrevented).toBe(false);
 await act(async()=>source.dispatchEvent(dragEvent('dragend',dragTransfer(payload))));
});
it('purges a Stack member dropped onto an unmatched photo instead of creating a manual Stack',async()=>{
 api.resolve.mockResolvedValue([existingStack]);await mount('/stack',{selectedAssets:[existingMembers[1],...singles]});
 const group=host.querySelector<HTMLElement>('.stack-candidate-group')!;
 const source=group.querySelector<HTMLButtonElement>('.stack-photo')!;
 const target=host.querySelector<HTMLElement>('.stack-unmatched-grid .stack-photo-wrapper')!;
 const payload={assetId:'hidden-first',sourceGroupId:`draft:immich:${existingStackId}`};
 const transfer=dragTransfer(payload);await act(async()=>source.dispatchEvent(dragEvent('dragstart',transfer)));
 const drop=dragEvent('drop',transfer);await act(async()=>target.dispatchEvent(drop));
 expect(drop.defaultPrevented).toBe(true);expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);
 expect(Array.from(host.querySelectorAll('.stack-candidate-group .stack-filename')).map(node=>node.textContent)).toEqual(['primary.dng','hidden.png']);
 expect(unmatched()).toEqual(['x.jpg','y.jpg','hidden.jpg']);
 await act(async()=>source.dispatchEvent(dragEvent('dragend',transfer)));
});
it('disables native dragging while unavailable or sending and suppresses the post-drag click',async()=>{
 await mount('/stack',{selectedAssets:[...photos,...singles]});
 const group=host.querySelector<HTMLElement>('.stack-candidate-group')!,cover=group.querySelector<HTMLButtonElement>('.stack-cover')!;
 expect(cover.draggable).toBe(true);const original=cover.querySelector('.stack-filename')?.textContent;
 const transfer=dragTransfer({assetId:'jpeg',sourceGroupId:group.getAttribute('aria-label')});
 await act(async()=>{cover.dispatchEvent(dragEvent('dragstart',transfer));cover.dispatchEvent(dragEvent('dragend',transfer));cover.click();});
 expect(group.querySelector('.stack-cover .stack-filename')?.textContent).toBe(original);
 const fetch=vi.fn((_url:string,init:RequestInit)=>new Promise<Response>(()=>{void init;}));vi.stubGlobal('fetch',fetch);
 await act(async()=>button('Send to Immich').click());await act(async()=>button('Continue').click());
 expect(host.querySelector('.stack-unmatched-grid .stack-photo')?.getAttribute('draggable')).toBe('false');
 const wrappers=Array.from(host.querySelectorAll<HTMLElement>('.stack-unmatched-grid .stack-photo-wrapper'));
 const disabledTransfer=dragTransfer({assetId:'x',sourceGroupId:null});
 const disabledOver=dragEvent('dragover',disabledTransfer);await act(async()=>wrappers[1].dispatchEvent(disabledOver));
 const disabledDrop=dragEvent('drop',disabledTransfer);await act(async()=>wrappers[1].dispatchEvent(disabledDrop));
 expect(disabledOver.defaultPrevented).toBe(false);expect(disabledDrop.defaultPrevented).toBe(false);
 expect(host.querySelectorAll('.stack-candidate-group')).toHaveLength(1);expect(unmatched()).toEqual(['x.jpg','y.jpg']);
});
it('keeps semantic status indicators accessible and outside drag sources',async()=>{
 api.resolve.mockResolvedValue([existingStack]);await mount('/stack',{selectedAssets:[...photos,existingMembers[1],...singles]});
 await click('.stack-unmatched-grid .stack-photo-wrapper:first-child .stack-photo');await click('.stack-unmatched-grid .stack-photo-wrapper:last-child .stack-photo');await act(async()=>button('New Stack').click());
 const indicators=Array.from(host.querySelectorAll<HTMLElement>('.stack-evidence'));
 const labels=new Set(indicators.map(node=>node.querySelector('[aria-hidden="true"]')?.textContent?.trim() ?? node.textContent?.trim()));
 for(const label of ['NAME','TIME','CAM','GPS','IMMICH','MANUAL'])expect(labels.has(label),`missing ${label}: ${[...labels].join(', ')}`).toBe(true);
 for(const indicator of indicators)expect(indicator.closest('[draggable="true"]')).toBeNull();
 expect(host.querySelector('.stack-photo')?.getAttribute('draggable')).toBe('true');
 expect(host.querySelector('.stack-cover')?.getAttribute('aria-label')).toContain('COVER');
});
