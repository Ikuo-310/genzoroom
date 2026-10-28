// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AnshitsuPage } from './AnshitsuPage';
import { commitAdjustmentEdits, isRegisteredAdjustment, keyboardAdjustment } from './adjustmentFocus';
import { SettingsProvider } from './SettingsDialog';
import i18n from './i18n';
import type { AssetDetail } from './assets';
import * as rawApi from './rawApi';
import { rawSettings } from './test/rawSettings';
import { rawHistoryResult, rawHistoryData, fakeRawHistory } from './test/rawHistory';
import { DesktopLifecycleProvider } from './DesktopLifecycle';

const base: AssetDetail = { id: '12345678-1234-4234-9234-123456789abc', filename: 'a.DNG',
  date: '2026-10-22', thumbnail_url: '/thumb', preview_url: '/immich-viewing', format: 'DNG', is_raw: true, exif: {} };
const jpeg = { ...base, id: '87654321-4321-4321-8321-cba987654321', filename: 'b.jpg', format: 'JPEG', is_raw: false };
const rawB = { ...base, id: '22222222-2222-4222-8222-222222222222', filename: 'c.DNG' };
const adjusted = vi.hoisted(() => vi.fn());
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(),
  fetchAssetDetail: vi.fn(async id => [base, jpeg, rawB].find(asset => asset.id === id)) }));
vi.mock('./editStateApi', async original => ({ ...await original<typeof import('./editStateApi')>(),
  getAssetEditState: vi.fn(async () => ({ state: null })), getAssetEditStatuses: vi.fn(async () => ({})) }));
vi.mock('./exportQueueApi', async original => ({ ...await original<typeof import('./exportQueueApi')>(), listExportQueue: vi.fn(async () => []) }));
vi.mock('./AdjustedImage', () => ({ AdjustedImage: (props: unknown) => { adjusted(props); return <div data-jpeg-renderer />; } }));
vi.mock('./rawApi', async original => ({ ...await original<typeof import('./rawApi')>(),
  rawCapability: vi.fn(), createRawWorkspace: vi.fn(async () => 'workspace'), openRawDocument: vi.fn(async (workspaceId, assetId) => ({
    workspaceId, assetId, handle: 'handle', generation: 1, documentToken: 'token', revision: 1 })),
  rawPreview: vi.fn(), readRawDocument: vi.fn(async doc => doc), readRawSettings: vi.fn(async doc => rawSettings(doc)),
  setRawControls: vi.fn(async (doc, patch) => ({ ...rawSettings(doc), revision: doc.revision + 1,
    settingsFingerprint: String(doc.revision + 1).padStart(64, '0'),
    values: { ...rawSettings(doc).values, ...patch } })), releaseRawWorkspace: vi.fn(async () => {}),
  readRawHistory: vi.fn(), saveRawHistory: vi.fn(), saveRawRecipe: vi.fn(), readRawRecipe: vi.fn() }));
const commitHistory = vi.fn(async (request: rawApi.RawHistoryRequest): Promise<rawApi.RawHistoryResult> => rawHistoryResult(request));
let root: Root, host: HTMLDivElement;
async function flush() { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); }
async function mount() {
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: `/anshitsu/${base.id}`,
    state: { selectedAssets: [base, jpeg, rawB], activeAssetId: base.id } }]}><DesktopLifecycleProvider><SettingsProvider><Routes>
    <Route path="/anshitsu/:assetId" element={<AnshitsuPage />} />
    <Route path="/" element={<div data-gallery />} />
  </Routes></SettingsProvider></DesktopLifecycleProvider></MemoryRouter>));
  await flush();
}
beforeEach(async () => {
  vi.mocked(rawApi.readRawHistory).mockReset().mockImplementation(async doc => rawHistoryData(doc));
  vi.clearAllMocks(); await i18n.changeLanguage('en');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 16; naturalHeight = 12; decode() { return Promise.resolve(); } removeAttribute() {} });
  vi.stubGlobal('URL', class extends URL { static createObjectURL = () => 'blob:lightcraft'; static revokeObjectURL = vi.fn(); });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
  vi.mocked(rawApi.rawCapability).mockResolvedValue(true);
  vi.mocked(rawApi.openRawDocument).mockReset().mockImplementation(async (workspaceId, assetId) => ({ workspaceId, assetId,
    handle: 'handle', generation: 1, documentToken: 'token', revision: 1 }));
  vi.mocked(rawApi.readRawSettings).mockReset().mockImplementation(async doc => rawSettings(doc));
  vi.mocked(rawApi.setRawControls).mockReset().mockImplementation(async (doc, patch) => ({ ...rawSettings(doc),
    revision: doc.revision + 1, settingsFingerprint: String(doc.revision + 1).padStart(64, '0'),
    values: { ...((doc as rawApi.RawSettings).values ?? rawSettings(doc).values), ...patch } }));
  vi.mocked(rawApi.rawPreview).mockResolvedValue({ blob: new Blob(['png']), width: 16, height: 12, epoch: 1, sequence: 1 });
  commitHistory.mockReset().mockImplementation(async request => rawHistoryResult(request));
  vi.mocked(rawApi.saveRawHistory).mockReset().mockImplementation(async request => request.action === 'initialize'
    ? rawHistoryResult(request) : commitHistory(request));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); await flush(); host.remove(); delete window.__GENZOROOM_DESKTOP__; vi.useRealTimers(); vi.unstubAllGlobals(); });

async function editRaw() {
  const number = host.querySelector<HTMLInputElement>('[data-adjustment-id="exposure"]')!.closest('.adjustment-control')!
    .querySelector<HTMLInputElement>('input[type="number"]')!;
  act(() => {
    number.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(number, '1.25');
    number.dispatchEvent(new Event('input', { bubbles: true }));
    number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await flush();
}
async function clickText(text: string, scope: ParentNode = host) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!;
  expect(button).toBeDefined(); act(() => button.click()); await flush();
}
function desktop() {
  const respond = vi.fn(async () => {});
  window.__GENZOROOM_DESKTOP__ = { respond };
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  return respond;
}

it('keeps mixed Filmstrip order and separates native RAW Preview from the JPEG renderer', async () => {
  await mount();
  expect([...host.querySelectorAll('.filmstrip-item')].map(item => item.getAttribute('aria-label'))).toEqual(['a.DNG', 'b.jpg', 'c.DNG']);
  expect(host.querySelector('.viewer-panel img')?.getAttribute('src')).toBe('blob:lightcraft');
  expect(host.querySelector('.raw-preview-note')).toBeNull();
  expect(adjusted).not.toHaveBeenCalled();
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[1].click()); await flush();
  expect(host.querySelector('[data-jpeg-renderer]')).not.toBeNull();
  expect(adjusted).toHaveBeenCalled();
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[2].click()); await flush();
  expect(host.querySelector('.viewer-panel img')?.getAttribute('src')).toBe('blob:lightcraft');
  expect(adjusted.mock.calls.every(([props]) => props.alt === 'b.jpg')).toBe(true);
});
it('shows the viewing Preview only with an explicit unavailable label', async () => {
  vi.mocked(rawApi.rawCapability).mockResolvedValue(false);
  await mount();
  expect(host.querySelector('.viewer-panel img')?.getAttribute('src')).toBe('/immich-viewing');
  expect(host.textContent).toContain('showing Immich viewing preview');
  expect(rawApi.openRawDocument).not.toHaveBeenCalled();
});
it('wires native Before into the shared Viewer lazily without changing RAW edits or History', async () => {
  vi.mocked(rawApi.readRawSettings).mockImplementation(async doc => ({ ...rawSettings(doc), beforeKey: 'b'.repeat(64) }));
  const urls = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:after').mockReturnValueOnce('blob:before');
  let resolveBefore!: (frame: rawApi.RawFrame) => void;
  vi.mocked(rawApi.rawPreview).mockImplementation(async (_doc, _serial, _signal, kind = 'after') => kind === 'before'
    ? new Promise(resolve => { resolveBefore = resolve; })
    : { blob: new Blob(), width: 16, height: 12, epoch: 1, sequence: 1 });
  await mount();
  expect(rawApi.rawPreview).toHaveBeenCalledTimes(1);
  const saves = vi.mocked(rawApi.saveRawHistory).mock.calls.length;
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Before and after adjustments"]')!;
  expect(toggle.disabled).toBe(false);
  act(() => toggle.click()); await flush();
  expect(host.querySelector('.viewer-panel img')!.getAttribute('src')).toBe('blob:after');
  expect(host.textContent).toContain('Preparing RAW Before');
  await act(async () => resolveBefore({ blob: new Blob(), width: 16, height: 12, epoch: 1, sequence: 1,
    kind: 'before', key: 'b'.repeat(64) })); await flush();
  expect(host.querySelector('.viewer-panel img')!.getAttribute('src')).toBe('blob:before');
  act(() => toggle.click()); act(() => toggle.click()); await flush();
  expect(rawApi.rawPreview).toHaveBeenCalledTimes(2);
  expect(rawApi.saveRawHistory).toHaveBeenCalledTimes(saves);
  expect(rawApi.setRawControls).not.toHaveBeenCalled();
  expect(adjusted).not.toHaveBeenCalled();
  urls.mockRestore();
});
it('binds engine control specs to shared sliders and commits RAW values without JPEG rendering', async () => {
  await mount();
  const sliders = [...host.querySelectorAll<HTMLInputElement>('.adjustment-range')];
  expect(sliders).toHaveLength(25);
  expect(sliders.map(slider => slider.dataset.adjustmentId)).toEqual([
    'temperature', 'tint', 'vibrance', 'saturation', 'exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks',
    'effects.texture', 'effects.clarity', 'effects.dehaze',
    'vignette.amount', 'vignette.midpoint', 'vignette.feather', 'vignette.roundness', 'vignette.highlights',
    'detail.sharpenAmount', 'detail.sharpenMasking',
    'detail.nrLuminance', 'detail.nrDetail', 'detail.nrColor', 'detail.nrColorDetail', 'detail.nrColorSmoothness',
  ]);
  expect(sliders[0].min).toBe('2000'); expect(sliders[0].max).toBe('50000'); expect(sliders[0].step).toBe('50');
  expect(sliders[1].min).toBe('-150'); expect(sliders[4].step).toBe('0.01');
  expect(sliders[0].classList.contains('has-gradient')).toBe(true);
  expect(sliders[0].style.getPropertyValue('--adjustment-track-gradient')).toContain('#4e8ed9');
  expect(sliders[0].style.getPropertyValue('--adjustment-track-gradient')).toContain('#d86943');
  expect(sliders[1].style.getPropertyValue('--adjustment-track-gradient')).toContain('#4f9b62');
  expect(sliders[1].style.getPropertyValue('--adjustment-track-gradient')).toContain('#b05aa0');
  const actions = [...host.querySelectorAll<HTMLButtonElement>('.adjustment-power, .adjustment-reset, .adjustment-category-actions button, .develop-panel .workspace-section-action')];
  expect(actions).toHaveLength(35);
  expect(host.querySelectorAll('.adjustment-power')).toHaveLength(0);
  expect(actions.filter(button => button.disabled)).toHaveLength(5);
  const number = sliders[4].closest('.adjustment-control')!.querySelector<HTMLInputElement>('input[type="number"]')!;
  act(() => {
    number.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(number, '1.25');
    number.dispatchEvent(new Event('input', { bubbles: true }));
    number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }); await flush();
  expect(rawApi.setRawControls).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }), { 'light.exposure': 1.25 });
  expect(rawApi.rawPreview).toHaveBeenCalledTimes(2); expect(adjusted).not.toHaveBeenCalled();
  expect(number.value).toBe('1.25'); expect(host.textContent).toContain('RAW recipes are autosaved');
});
it('enters RAW slider focus from the Viewer and follows the displayed row order', async () => {
  await mount();
  const viewer = host.querySelector<HTMLElement>('.viewer-panel')!;
  const sliders = [...host.querySelectorAll<HTMLInputElement>('.adjustment-range')];
  expect(document.activeElement).not.toBe(sliders[0]);
  act(() => viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(sliders[0]);
  const moveDown = (target: HTMLElement) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true,
  })));
  moveDown(sliders[0]); expect(document.activeElement).toBe(sliders[1]);
  moveDown(sliders[1]); expect(document.activeElement).toBe(sliders[2]);
  moveDown(sliders[2]); expect(document.activeElement).toBe(sliders[3]);
  const basicTitle = host.querySelector<HTMLElement>('.raw-adjustment-category:nth-of-type(2) .adjustment-category-title')!;
  moveDown(sliders[3]); expect(document.activeElement).toBe(basicTitle);
  moveDown(basicTitle); expect(document.activeElement).toBe(sliders[4]);
  for (let index = 5; index < 10; index++) {
    moveDown(sliders[index - 1]); expect(document.activeElement).toBe(sliders[index]);
  }
  expect(sliders.slice(4, 10).map(slider => slider.dataset.adjustmentId)).toEqual(['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks']);
  const effectsTitle = host.querySelector<HTMLElement>('.raw-adjustment-category:nth-of-type(3) .adjustment-category-title')!;
  const effectsSubtitle = host.querySelector<HTMLElement>('.raw-adjustment-subsection-title')!;
  moveDown(sliders[9]); expect(document.activeElement).toBe(effectsTitle);
  moveDown(effectsTitle); expect(document.activeElement).toBe(effectsSubtitle);
  moveDown(effectsSubtitle); expect(document.activeElement).toBe(sliders[10]);
  for (let index = 11; index < 13; index++) { moveDown(sliders[index - 1]); expect(document.activeElement).toBe(sliders[index]); }
  const detailTitle = host.querySelector<HTMLElement>('.raw-adjustment-category:nth-of-type(4) .adjustment-category-title')!;
  const vignetteTitle = host.querySelectorAll<HTMLElement>('.raw-adjustment-subsection-title')[1];
  const mode = host.querySelector<HTMLInputElement>('.raw-vignette-mode input:checked')!;
  moveDown(sliders[12]); expect(document.activeElement).toBe(vignetteTitle);
  moveDown(vignetteTitle); expect(document.activeElement).toBe(mode);
  moveDown(mode); expect(document.activeElement).toBe(sliders[13]);
  moveDown(sliders[13]); expect(document.activeElement).toBe(detailTitle);
  moveDown(detailTitle); expect(document.activeElement).toBe(sliders[18]);
  for (let index = 19; index < 25; index++) { moveDown(sliders[index - 1]); expect(document.activeElement).toBe(sliders[index]); }
  act(() => viewer.focus());
  act(() => viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(sliders[24]);
});
it.each(['vignette.amount', 'vignette.midpoint', 'vignette.feather', 'vignette.roundness', 'vignette.highlights', 'effects.texture', 'effects.clarity', 'effects.dehaze', 'detail.sharpenAmount', 'detail.sharpenMasking', 'detail.nrLuminance', 'detail.nrDetail', 'detail.nrColor',
  'detail.nrColorDetail', 'detail.nrColorSmoothness'] as const)('uses existing pointer, wheel, keyboard, number and Reset gestures for %s', async control => {
  if (control.startsWith('vignette.') && control !== 'vignette.amount') vi.mocked(rawApi.readRawSettings).mockImplementation(async doc => ({ ...rawSettings(doc), values: { ...rawSettings(doc).values, 'vignette.amount': -50 } }));
  await mount();
  const range = host.querySelector<HTMLInputElement>(`[data-adjustment-id="${control}"]`)!;
  const row = range.closest('.adjustment-control')!;
  const number = row.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(range.min).toBe(control.startsWith('effects.') || control === 'vignette.amount' || control === 'vignette.roundness' ? '-100' : '0'); expect(range.max).toBe(control.endsWith('Amount') ? '150' : '100'); expect(range.step).toBe('1');
  expect(range.value).toBe(control.endsWith('Amount') ? '40' : control === 'detail.nrColor' ? '25'
    : ['detail.nrDetail', 'detail.nrColorDetail', 'detail.nrColorSmoothness', 'vignette.midpoint', 'vignette.feather'].includes(control) ? '50' : '0');
  const set = (element: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  };
  act(() => { range.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true })); set(range, '60'); });
  expect(commitHistory).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new MouseEvent('pointerup', { button: 0, bubbles: true }))); await flush();
  expect(rawApi.setRawControls).toHaveBeenLastCalledWith(expect.anything(), { [control]: 60 });
  expect(commitHistory).toHaveBeenLastCalledWith(expect.objectContaining({ control, action: 'commit' }));
  const commits = commitHistory.mock.calls.length;
  act(() => { range.focus(); range.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
  expect(range.value).toBe('70');
  act(() => { range.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, shiftKey: true, bubbles: true, cancelable: true })); });
  expect(range.value).toBe('71');
  // The next input is a boundary on the same shared slider, not a separate save owner.
  act(() => { number.focus(); set(number, '73'); number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await flush();
  expect(rawApi.setRawControls).toHaveBeenLastCalledWith(expect.anything(), { [control]: 73 });
  expect(commitHistory.mock.calls.length).toBe(commits + 1);
  act(() => row.querySelector<HTMLButtonElement>('.adjustment-reset')!.click()); await flush();
  expect(commitHistory).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'operate',
    operation: { kind: 'controlReset', metadata: { control } } }));
  expect(adjusted).not.toHaveBeenCalled();
});

it('reuses Detail category collapse, action navigation, toggle and Reset', async () => {
  commitHistory.mockImplementation(async request => {
    const next = structuredClone(request.doc);
    next.revision++; next.settingsFingerprint = String(next.revision).padStart(64, '0');
    if (request.operation?.kind === 'sectionToggle') next.sections.detail = request.operation.metadata.enabled;
    if (request.operation?.kind === 'sectionReset') Object.assign(next.values,
      Object.fromEntries(next.controls.filter(spec => spec.id.startsWith('detail.')).map(spec => [spec.id, spec.default])));
    return rawHistoryResult({ ...request, doc: next });
  });
  await mount();
  expect([...host.querySelectorAll('.raw-adjustment-category .adjustment-category-label')].map(item => item.textContent))
    .toEqual(['Color', 'Basic', 'Effects', 'Detail']);
  const category = host.querySelectorAll('.raw-adjustment-category')[3];
  expect(category.textContent).toContain('Sharpening');
  const title = category.querySelector<HTMLButtonElement>('.adjustment-category-title')!;
  const toggle = category.querySelector<HTMLButtonElement>('[data-category-switch]')!;
  const reset = category.querySelector<HTMLButtonElement>('.adjustment-category-reset')!;
  act(() => title.focus()); historyKey('ArrowRight', { ctrlKey: false, shiftKey: true }, title);
  expect(document.activeElement).toBe(toggle);
  historyKey('ArrowRight', { ctrlKey: false, shiftKey: true }, toggle); expect(document.activeElement).toBe(reset);
  act(() => title.click()); expect(category.querySelector('.adjustment-range')).toBeNull();
  act(() => title.click()); expect(category.querySelectorAll('.adjustment-range')).toHaveLength(7);
  act(() => toggle.click()); await flush();
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(category.querySelector<HTMLInputElement>('.adjustment-range')!.value).toBe('40');
  expect(category.querySelector<HTMLInputElement>('.adjustment-range')!.disabled).toBe(true);
  act(() => reset.click()); await flush();
  expect(commitHistory).toHaveBeenLastCalledWith(expect.objectContaining({ operation: { kind: 'sectionReset', metadata: { section: 'detail' } } }));
  expect(category.querySelector<HTMLInputElement>('.adjustment-range')!.value).toBe('0');
  expect(category.querySelector<HTMLInputElement>('[data-adjustment-id="detail.nrDetail"]')!.value).toBe('50');
  expect(category.querySelector<HTMLInputElement>('[data-adjustment-id="detail.nrColor"]')!.value).toBe('0');
  act(() => toggle.click()); await flush(); expect(category.querySelector<HTMLInputElement>('.adjustment-range')!.disabled).toBe(false);
});

it('commits a number gesture before mode selection, updates Preview and makes reselect a no-op', async () => {
  commitHistory.mockImplementation(async request => {
    if (request.operation?.kind !== 'vignetteStyle') return rawHistoryResult(request);
    return rawHistoryResult({ ...request, doc: { ...request.doc, revision: request.doc.revision + 1,
      settingsFingerprint: 'e'.repeat(64), vignetteStyle: request.operation.metadata.style } });
  });
  await mount();
  const number = host.querySelector<HTMLInputElement>('[data-adjustment-id="vignette.amount"]')!.closest('.adjustment-control')!.querySelector<HTMLInputElement>('input[type="number"]')!;
  const paint = host.querySelector<HTMLInputElement>('.raw-vignette-mode input[value="paintOverlay"]')!;
  act(() => {
    number.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(number, '-73');
    number.dispatchEvent(new Event('input', { bubbles: true }));
    paint.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    paint.click();
  }); await flush();
  expect(commitHistory.mock.calls.map(([request]) => request.action)).toEqual(['commit', 'operate']);
  expect(commitHistory.mock.calls[0][0].control).toBe('vignette.amount');
  expect(commitHistory.mock.calls[1][0].operation).toEqual({ kind: 'vignetteStyle', metadata: { style: 'paintOverlay' } });
  expect(paint.checked).toBe(true); expect(number.value).toBe('-73');
  expect(rawApi.rawPreview).toHaveBeenCalledTimes(2);
  expect(vi.mocked(rawApi.rawPreview).mock.calls.at(-1)![0]).toMatchObject({ vignetteStyle: 'paintOverlay', revision: 3 });
  act(() => paint.click()); await flush(); expect(commitHistory).toHaveBeenCalledTimes(2);
});

it.each(['ja', 'en'])('keeps Effects eye in the category and Reset in Basic Effects in %s', async language => {
  await i18n.changeLanguage(language);
  vi.mocked(rawApi.readRawSettings).mockImplementation(async doc => ({ ...rawSettings(doc),
    values: { ...rawSettings(doc).values, 'effects.texture': -31, 'effects.clarity': 62, 'effects.dehaze': 93 } }));
  commitHistory.mockImplementation(async request => {
    if (request.action !== 'operate') return rawHistoryResult(request);
    const next = structuredClone(request.doc);
    next.revision++; next.settingsFingerprint = String(next.revision).padStart(64, '0');
    if (request.operation?.kind === 'sectionToggle') next.sections.effects = request.operation.metadata.enabled;
    if (request.operation?.kind === 'sectionReset') Object.assign(next.values,
      { 'effects.texture': 0, 'effects.clarity': 0, 'effects.dehaze': 0 });
    return rawHistoryResult({ ...request, doc: next });
  });
  await mount();
  const categories = host.querySelectorAll('.raw-adjustment-category');
  expect([...categories].map(category => category.querySelector('.adjustment-category-label')!.textContent)).toEqual(language === 'ja'
    ? ['カラー', '基本補正', 'エフェクト', 'ディテール'] : ['Color', 'Basic', 'Effects', 'Detail']);
  const category = categories[2];
  const title = category.querySelector<HTMLButtonElement>('.adjustment-category-title')!;
  const subtitle = category.querySelector<HTMLElement>('.raw-adjustment-subsection-title')!;
  const reset = category.querySelector<HTMLButtonElement>('.raw-adjustment-subsection-header button')!;
  const toggle = category.querySelector<HTMLButtonElement>('[data-category-switch]')!;
  expect(category.querySelector('.adjustment-category-header .adjustment-category-reset')).toBeNull();
  expect(subtitle.textContent).toBe(language === 'ja' ? '基本エフェクト' : 'Basic Effects');
  expect(reset.getAttribute('aria-label')).toBe(language === 'ja' ? '基本エフェクトをリセット' : 'Reset Basic Effects');
  act(() => subtitle.focus()); historyKey('ArrowRight', { ctrlKey: false, shiftKey: true }, subtitle);
  expect(document.activeElement).toBe(reset);
  historyKey('ArrowLeft', { ctrlKey: false, shiftKey: true }, reset); expect(document.activeElement).toBe(subtitle);
  const ranges = () => [...category.querySelectorAll<HTMLInputElement>('.adjustment-range[data-adjustment-id^="effects."]')];
  expect(ranges().map(range => range.value)).toEqual(['-31', '62', '93']);
  act(() => toggle.click()); await flush();
  expect(ranges().every(range => range.disabled)).toBe(true);
  expect(ranges().map(range => range.value)).toEqual(['-31', '62', '93']);
  expect(reset.disabled).toBe(false);
  act(() => toggle.click()); await flush(); expect(ranges().every(range => !range.disabled)).toBe(true);
  // The subsection action must close the number gesture before its save lock can disable Reset.
  const number = ranges()[0].closest('.adjustment-control')!.querySelector<HTMLInputElement>('input[type="number"]')!;
  const pointer = new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true });
  act(() => {
    number.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(number, '-52');
    number.dispatchEvent(new Event('input', { bubbles: true })); reset.dispatchEvent(pointer);
  });
  expect(pointer.defaultPrevented).toBe(true);
  act(() => reset.click()); await flush();
  expect(commitHistory.mock.calls.slice(-2).map(([request]) => request.action)).toEqual(['commit', 'operate']);
  expect(commitHistory).toHaveBeenLastCalledWith(expect.objectContaining({ operation: { kind: 'sectionReset', metadata: { section: 'effects' } } }));
  expect(ranges().map(range => range.value)).toEqual(['0', '0', '0']);
  expect(category.querySelectorAll('h4')).toHaveLength(2);
  expect(category.textContent).not.toMatch(/Grain|粒子|workspace\./);
  await act(async () => title.click()); await flush(); expect(ranges()).toHaveLength(0);
  await act(async () => title.click()); await flush(); expect(ranges()).toHaveLength(3);
});

it.each(['ja', 'en'])('separates NR subheadings, accessible Detail names and zero-amount dependents in %s', async language => {
  await i18n.changeLanguage(language);
  vi.mocked(rawApi.readRawSettings).mockImplementation(async doc => {
    const settings = rawSettings(doc);
    settings.values['detail.nrColor'] = 0;
    return settings;
  });
  await mount();
  const category = host.querySelectorAll('.raw-adjustment-category')[3];
  expect([...category.querySelectorAll('h4')].map(item => item.textContent)).toEqual(language === 'ja'
    ? ['シャープネス', 'ノイズリダクション', 'カラーノイズリダクション'] : ['Sharpening', 'Noise Reduction', 'Color Noise Reduction']);
  const lum = category.querySelector<HTMLInputElement>('[data-adjustment-id="detail.nrDetail"]')!;
  const color = category.querySelector<HTMLInputElement>('[data-adjustment-id="detail.nrColorDetail"]')!;
  expect(lum.getAttribute('aria-label')).toBe(language === 'ja' ? '輝度ノイズ軽減のディテール' : 'Luminance Noise Reduction Detail');
  expect(color.getAttribute('aria-label')).toBe(language === 'ja' ? 'カラーノイズ軽減のディテール' : 'Color Noise Reduction Detail');
  expect(lum.closest('.adjustment-control')!.querySelector('label')!.textContent).toBe(language === 'ja' ? 'ディテール' : 'Detail');
  expect(color.closest('.adjustment-control')!.querySelector('label')!.textContent).toBe(language === 'ja' ? 'ディテール' : 'Detail');
  for (const id of ['detail.nrDetail', 'detail.nrColorDetail', 'detail.nrColorSmoothness']) {
    const range = category.querySelector<HTMLInputElement>(`[data-adjustment-id="${id}"]`)!;
    expect(range.disabled).toBe(false);
    expect(range.closest('.adjustment-control')!.querySelector<HTMLInputElement>('input[type="number"]')!.disabled).toBe(false);
  }
});

it('skips unavailable WB sliders when acquiring initial RAW focus', async () => {
  vi.mocked(rawApi.readRawSettings).mockImplementationOnce(async doc => ({ ...rawSettings(doc), wb: { available: false, mode: 'asShot', scale: 'legacy' } }));
  await mount();
  const viewer = host.querySelector<HTMLElement>('.viewer-panel')!;
  const sliders = [...host.querySelectorAll<HTMLInputElement>('.adjustment-range')];
  act(() => viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true })));
  expect(sliders[0].disabled).toBe(true); expect(sliders[1].disabled).toBe(true);
  expect(document.activeElement).toBe(sliders[2]);
});
it('disables only WB when Kelvin capability is unknown', async () => {
  vi.mocked(rawApi.readRawSettings).mockImplementationOnce(async doc => ({ ...rawSettings(doc), wb: { available: false, mode: 'asShot', scale: 'legacy' } }));
  await mount();
  const sliders = [...host.querySelectorAll<HTMLInputElement>('.adjustment-range')];
  expect(sliders.slice(0, 2).every(slider => slider.disabled)).toBe(true);
  expect(sliders.slice(2).filter(slider => slider.disabled).map(slider => slider.dataset.adjustmentId)).toEqual(['vignette.midpoint', 'vignette.feather', 'vignette.roundness', 'vignette.highlights']);
});

it('shows a five-digit temperature with an overlaid K suffix while WB Reset updates both fields', async () => {
  vi.mocked(rawApi.readRawSettings).mockImplementationOnce(async doc => ({ ...rawSettings(doc),
    values: { ...rawSettings(doc).values, 'wb.temp': 11000, 'wb.tint': 26 } }));
  commitHistory.mockImplementation(async request => {
    if (request.action !== 'operate') return rawHistoryResult(request);
    const settings = { ...request.doc, revision: request.doc.revision + 1, settingsFingerprint: '8'.repeat(64),
      recipeFingerprint: '8'.repeat(64), values: { ...request.doc.values, 'wb.temp': 4875, 'wb.tint': 13 } };
    return rawHistoryResult({ ...request, doc: settings });
  });
  await mount();
  const temp = host.querySelector('[data-adjustment-id="temperature"]')!.closest('.adjustment-control')!;
  const input = temp.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.value).toBe('11000');
  expect(host.querySelectorAll('.adjustment-number-suffix')).toHaveLength(1);
  expect(temp.querySelector('.adjustment-number-suffix')?.textContent).toBe('K');
  expect(input.parentElement?.classList.contains('adjustment-number-wrap')).toBe(true);
  expect(input.parentElement?.querySelector('.adjustment-number-suffix')).not.toBeNull();
  const rows = [...host.querySelectorAll<HTMLElement>('.raw-adjustment-controls .adjustment-control')];
  expect(rows).toHaveLength(25);
  expect(rows.every(row => row.querySelector('.adjustment-number-wrap input[type="number"]')
    && row.querySelectorAll('.adjustment-value-controls .adjustment-reset').length === 1)).toBe(true);
  const reset = temp.querySelector<HTMLButtonElement>('.adjustment-reset')!;
  expect(reset.title).toBe(i18n.t('workspace.rawPreview.wbResetAsShot'));
  const pointer = new MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true });
  act(() => {
    input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '12000');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    reset.dispatchEvent(pointer);
  });
  expect(pointer.defaultPrevented).toBe(true);
  act(() => reset.click()); await flush();
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request.action)).toEqual(['initialize', 'commit', 'operate']);
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.at(-1)![0]).toMatchObject({ action: 'operate',
    operation: { kind: 'controlReset', metadata: { control: 'wb.temp' } } });
  expect(input.value).toBe('4875');
  expect(host.querySelector('[data-adjustment-id="tint"]')!.closest('.adjustment-control')!.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('13');
});

it('retains values across category OFF/ON and permits Reset while OFF on the same History owner', async () => {
  vi.mocked(rawApi.readRawSettings).mockImplementationOnce(async doc => ({ ...rawSettings(doc),
    values: { ...rawSettings(doc).values, 'light.exposure': 1 } }));
  commitHistory.mockImplementation(async request => {
    const next = structuredClone(request.doc);
    next.revision++; next.settingsFingerprint = String(next.revision).padStart(64, '0'); next.recipeFingerprint = next.settingsFingerprint;
    const operation = request.operation!;
    if (operation.kind === 'sectionToggle') next.sections[operation.metadata.section] = operation.metadata.enabled;
    else if (operation.kind === 'sectionReset') next.values['light.exposure'] = 0;
    return rawHistoryResult({ ...request, doc: next });
  });
  await mount();
  const categories = host.querySelectorAll('.raw-adjustment-category');
  expect(categories).toHaveLength(4);
  expect(categories[0].querySelector('.adjustment-category-label')!.textContent).toBe('Color');
  const toggle = categories[1].querySelector<HTMLButtonElement>('.adjustment-category-icon')!;
  const reset = categories[1].querySelector<HTMLButtonElement>('.adjustment-category-reset')!;
  act(() => toggle.click()); await flush();
  expect(exposure().disabled).toBe(true); expect(exposure().value).toBe('1'); expect(reset.disabled).toBe(false);
  act(() => toggle.click()); await flush();
  expect(exposure().disabled).toBe(false); expect(exposure().value).toBe('1');
  act(() => toggle.click()); await flush();
  act(() => reset.click()); await flush();
  expect(exposure().disabled).toBe(true); expect(exposure().value).toBe('0');
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.at(-1)![0].operation).toEqual({ kind: 'sectionReset', metadata: { section: 'light' } });
});

it('keeps the overlaid suffix outside the numeric temperature value during Enter and Escape editing', async () => {
  await mount();
  const row = host.querySelector('[data-adjustment-id="temperature"]')!.closest('.adjustment-control')!;
  const input = row.querySelector<HTMLInputElement>('input[type="number"]')!;
  const enterValue = (value: string, key: string) => act(() => {
    input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  enterValue('11000', 'Enter'); await flush();
  expect(input.value).toBe('11000');
  expect(vi.mocked(rawApi.setRawControls).mock.calls.at(-1)![1]).toEqual({ 'wb.temp': 11000 });
  enterValue('12000', 'Escape'); await flush();
  expect(input.value).toBe('11000');
  expect(input.parentElement?.querySelector('.adjustment-number-suffix')?.textContent).toBe('K');
});

it('navigates RAW category controls in title, AW, toggle, Reset order without activating them', async () => {
  await mount();
  const header = host.querySelector<HTMLElement>('.raw-adjustment-category .adjustment-category-header')!;
  const title = header.querySelector<HTMLButtonElement>('.adjustment-category-title')!;
  const aw = header.querySelector<HTMLButtonElement>('[data-category-command]')!;
  const toggle = header.querySelector<HTMLButtonElement>('[data-category-switch]')!;
  const reset = header.querySelector<HTMLButtonElement>('.adjustment-category-reset')!;
  const enabled = toggle.getAttribute('aria-pressed');
  const historyCount = vi.mocked(rawApi.saveRawHistory).mock.calls.length;
  const move = (element: HTMLElement, key: string) => historyKey(key, { ctrlKey: false, shiftKey: true }, element);
  act(() => title.focus()); move(title, 'ArrowRight'); expect(document.activeElement).toBe(aw);
  move(aw, 'ArrowRight'); expect(document.activeElement).toBe(toggle);
  move(toggle, 'ArrowRight'); expect(document.activeElement).toBe(reset);
  move(reset, 'ArrowLeft'); expect(document.activeElement).toBe(toggle);
  move(toggle, 'ArrowLeft'); expect(document.activeElement).toBe(aw);
  move(aw, 'ArrowLeft'); expect(document.activeElement).toBe(title);
  expect(toggle.getAttribute('aria-pressed')).toBe(enabled);
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls).toHaveLength(historyCount);
});

it('moves through an unchanged RAW number input without starting a save or History commit', async () => {
  await mount();
  const range = exposure();
  const row = range.closest('.adjustment-control')!;
  const input = row.querySelector<HTMLInputElement>('input[type="number"]')!;
  const reset = row.querySelector<HTMLButtonElement>('.adjustment-reset')!;
  const historyCalls = vi.mocked(rawApi.saveRawHistory).mock.calls.length;
  const historyReads = vi.mocked(rawApi.readRawHistory).mock.calls.length;

  act(() => range.focus());
  historyKey('ArrowRight', { ctrlKey: false, shiftKey: true }, range);
  expect(document.activeElement).toBe(input);
  historyKey('ArrowRight', { ctrlKey: false, shiftKey: true }, input);

  expect(document.activeElement).toBe(reset);
  expect(reset.disabled).toBe(false);
  expect(vi.mocked(rawApi.setRawControls)).not.toHaveBeenCalled();
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls).toHaveLength(historyCalls);
  expect(vi.mocked(rawApi.readRawHistory).mock.calls).toHaveLength(historyReads);
});

it.each(['Enter', ' '])('leaves RAW Reset activation to the native %s button action', async key => {
  const model = historyBackend(0);
  await mount();
  const header = host.querySelector<HTMLElement>('.raw-adjustment-category .adjustment-category-header')!;
  const title = header.querySelector<HTMLButtonElement>('.adjustment-category-title')!;
  const reset = header.querySelector<HTMLButtonElement>('.adjustment-category-reset')!;
  act(() => title.focus());
  historyKey('ArrowRight', { ctrlKey: false, shiftKey: true }, title);
  historyKey('ArrowRight', { ctrlKey: false, shiftKey: true }, document.activeElement as HTMLElement);
  historyKey('ArrowRight', { ctrlKey: false, shiftKey: true }, document.activeElement as HTMLElement);
  expect(document.activeElement).toBe(reset);
  const before = vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request.action);
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => reset.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request.action)).toEqual(before);
  act(() => reset.click()); await flush();
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.at(-1)?.[0].operation).toEqual({
    kind: 'sectionReset', metadata: { section: 'color' },
  });
  expect(model.cursor()).toBe(0);
});

it('keeps focus on a RAW individual Reset after Shift navigation settles a numeric edit', async () => {
  vi.useFakeTimers();
  const model = historyBackend(0);
  await mount();
  let resolveCommit!: () => void;
  let pendingRequest: rawApi.RawHistoryRequest | undefined;
  const trace: string[] = [];
  vi.mocked(rawApi.saveRawHistory).mockImplementation(request => request.action === 'initialize' ? Promise.resolve(model.save(request))
    : new Promise(resolve => { pendingRequest = request; trace.push(`history.${request.action}`); resolveCommit = () => resolve(model.save(request)); }));
  const row = exposure().closest('.adjustment-control')!;
  const input = row.querySelector<HTMLInputElement>('input[type="number"]')!;
  const reset = row.querySelector<HTMLButtonElement>('.adjustment-reset')!;
  input.addEventListener('blur', () => trace.push('number.blur'));
  reset.addEventListener('focus', () => trace.push('reset.focus'));
  reset.addEventListener('blur', () => trace.push('reset.blur'));
  act(() => input.focus()); inputValue(input, '1.25');
  historyKey('ArrowRight', { ctrlKey: false, shiftKey: true }, input);
  await flush();
  expect(pendingRequest?.action).toBe('commit');
  expect(trace.indexOf('reset.focus')).toBeGreaterThanOrEqual(0);
  expect(trace.indexOf('number.blur')).toBeGreaterThanOrEqual(0);
  expect(trace.indexOf('number.blur')).toBeLessThan(trace.indexOf('reset.focus'));
  expect(trace.indexOf('number.blur')).toBeLessThan(trace.indexOf('history.commit'));
  expect(reset.disabled).toBe(true);
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request.action)).toEqual(['initialize', 'commit']);

  // Chromium drops focus when a focused native button becomes disabled; jsdom does not.
  if (document.activeElement === reset) {
    reset.disabled = false; act(() => reset.blur()); reset.disabled = true;
  }
  expect(trace.indexOf('reset.blur')).toBeGreaterThan(trace.indexOf('reset.focus'));
  expect(document.activeElement).toBe(document.body);
  await act(async () => resolveCommit()); await flush();
  expect(reset.disabled).toBe(false);
  expect(document.activeElement).toBe(reset);
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request.action)).toEqual(['initialize', 'commit']);

  const activation = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  act(() => reset.dispatchEvent(activation));
  expect(activation.defaultPrevented).toBe(false);
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request.action)).toEqual(['initialize', 'commit']);
  vi.mocked(rawApi.saveRawHistory).mockImplementation(request => Promise.resolve(model.save(request)));
  act(() => reset.click()); await flush();
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request.action)).toEqual(['initialize', 'commit', 'operate']);
});

it('does not restore a RAW Reset focus after the user moves elsewhere during the save lock', async () => {
  const model = historyBackend(0);
  await mount();
  let resolveCommit!: () => void;
  vi.mocked(rawApi.saveRawHistory).mockImplementation(request => request.action === 'initialize' ? Promise.resolve(model.save(request))
    : new Promise(resolve => { resolveCommit = () => resolve(model.save(request)); }));
  const row = exposure().closest('.adjustment-control')!;
  const input = row.querySelector<HTMLInputElement>('input[type="number"]')!;
  const reset = row.querySelector<HTMLButtonElement>('.adjustment-reset')!;
  act(() => input.focus()); inputValue(input, '1.25');
  historyKey('ArrowRight', { ctrlKey: false, shiftKey: true }, input);
  await flush();
  expect(reset.disabled).toBe(true);
  if (document.activeElement === reset) {
    reset.disabled = false; act(() => reset.blur()); reset.disabled = true;
  }
  const external = document.createElement('button'); document.body.append(external);
  act(() => external.focus());
  await act(async () => resolveCommit()); await flush();
  expect(document.activeElement).toBe(external);
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request.action)).toEqual(['initialize', 'commit']);
  external.remove();
});

it('does not show an Immich image as the result of failed native rendering', async () => {
  vi.mocked(rawApi.rawPreview).mockRejectedValue(new rawApi.RawApiError('raw_render_failed'));
  await mount();
  expect(host.querySelector('.viewer-panel img')).toBeNull();
  expect(host.textContent).toContain('LightCraft RAW Preview failed');
  expect(adjusted).not.toHaveBeenCalled();
});

it('shows the ordinary RAW open error instead of blocking by engine version', async () => {
  desktop();
  vi.mocked(rawApi.openRawDocument).mockRejectedValue(new rawApi.RawApiError('raw_recipe_engine_incompatible', 409));
  await mount();
  expect(host.textContent).toContain('LightCraft RAW Preview failed');
  expect(host.textContent).not.toContain('They are preserved');
  await clickText('Reset RAW edits');
  expect(host.textContent).toContain('RAW Recipe and RAW History');
  expect(host.textContent).toContain('original RAW file and Immich photo will not be deleted');
  expect(vi.mocked(rawApi.rawPreview)).not.toHaveBeenCalled();
  expect(vi.mocked(rawApi.saveRawHistory)).not.toHaveBeenCalled();
});

it('keeps the RAW loading status until the preview is ready', async () => {
  vi.mocked(rawApi.rawPreview).mockImplementation(() => new Promise(() => {}));
  await mount();
  expect(host.querySelector('.viewer-image-status')?.textContent).toContain('Loading photo');
});

it('keeps the RAW edit failure status over the last ready preview', async () => {
  await mount();
  vi.mocked(rawApi.setRawControls).mockRejectedValue(new rawApi.RawApiError('raw_connection_failed'));
  await editRaw();
  expect(host.querySelector('.raw-preview-note')?.textContent).toContain('RAW settings or Preview could not be confirmed');
  expect(host.querySelector('.viewer-panel img')?.getAttribute('src')).toBe('blob:lightcraft');
});

it('blocks RAW to JPEG on a lost save response and retries the exact saveId before navigation', async () => {
  await mount();
  commitHistory.mockRejectedValueOnce(new rawApi.RawSaveError('raw_connection_failed', 'unknown'));
  await editRaw();
  act(() => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[1].click()); await flush();
  expect(host.querySelector('[role="alertdialog"]')).not.toBeNull(); expect(host.querySelector('[data-jpeg-renderer]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('[data-adjustment-id="exposure"]')!.disabled).toBe(true);
  const first = commitHistory.mock.calls[0][0];
  await clickText('Retry RAW save', host.querySelector('[role="alertdialog"]')!);
  expect(commitHistory.mock.calls[1][0]).toEqual(first);
  expect(host.querySelector('[data-jpeg-renderer]')).not.toBeNull();
});

it('blocks Gallery return on a failed RAW save, preserves editing on cancel, and exits only after retry', async () => {
  await mount();
  commitHistory.mockRejectedValueOnce(new rawApi.RawSaveError('raw_recipe_save_failed', 'unknown', 503));
  await editRaw();
  await clickText('Back to Gallery');
  expect(host.querySelector('[data-gallery]')).toBeNull(); expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
  await clickText(i18n.t('workspace.stayInAnshitsu'));
  expect(host.querySelector<HTMLInputElement>('[data-adjustment-id="exposure"]')!.disabled).toBe(true);
  await clickText('Retry RAW save');
  await clickText('Back to Gallery'); expect(host.querySelector('[data-gallery]')).not.toBeNull();
});

it('restores the saved RAW readback when returning through JPEG', async () => {
  const saved = new Map<string, rawApi.RawSettings>();
  commitHistory.mockImplementation(async request => {
    saved.set(request.doc.assetId, request.doc);
    return rawHistoryResult(request);
  });
  vi.mocked(rawApi.readRawSettings).mockImplementation(async doc => saved.has(doc.assetId)
    ? { ...saved.get(doc.assetId)!, ...doc, settingsFingerprint: saved.get(doc.assetId)!.settingsFingerprint,
      recipeFingerprint: saved.get(doc.assetId)!.settingsFingerprint, recipeRevision: 1 } : rawSettings(doc));
  await mount(); await editRaw();
  act(() => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[1].click()); await flush();
  expect(host.querySelector('[data-jpeg-renderer]')).not.toBeNull(); expect(saved.get(base.id)!.values['light.exposure']).toBe(1.25);
  act(() => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[0].click()); await flush();
  const exposure = host.querySelector<HTMLElement>('[data-adjustment-id="exposure"]')!.closest('.adjustment-control')!
    .querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(exposure.value).toBe('1.25'); expect(adjusted.mock.calls.every(([props]) => props.alt === 'b.jpg')).toBe(true);
});

it('waits for the RAW save acknowledgement before approving normal Windows close', async () => {
  const respond = desktop(); await mount();
  let resolve!: (ack: rawApi.RawHistoryResult) => void;
  commitHistory.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
  await editRaw();
  act(() => window.dispatchEvent(new CustomEvent('genzoroom:close-request', { detail: { requestId: 'a'.repeat(64) } }))); await flush();
  expect(respond).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'closeResult', saved: true }));
  const request = commitHistory.mock.calls[0][0];
  await act(async () => resolve(rawHistoryResult(request))); await flush();
  expect(respond).toHaveBeenCalledWith({ kind: 'closeResult', saved: true, requestId: 'a'.repeat(64) });
});

it('waits for saving RAW A before opening RAW B and restores A on Gallery reentry', async () => {
  let saved: rawApi.RawSettings | undefined;
  let resolve!: (ack: rawApi.RawHistoryResult) => void;
  commitHistory.mockImplementation(async request => {
    saved = request.doc;
    return new Promise<rawApi.RawHistoryResult>(yes => { resolve = yes; });
  });
  vi.mocked(rawApi.readRawSettings).mockImplementation(async doc => saved?.assetId === doc.assetId
    ? { ...saved, ...doc, settingsFingerprint: saved.settingsFingerprint, recipeFingerprint: saved.settingsFingerprint, recipeRevision: 1 }
    : rawSettings(doc));
  await mount(); await editRaw();
  act(() => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[2].click()); await flush();
  expect(rawApi.openRawDocument).toHaveBeenCalledTimes(1);
  const request = commitHistory.mock.calls[0][0];
  await act(async () => resolve(rawHistoryResult(request))); await flush();
  expect(rawApi.openRawDocument).toHaveBeenLastCalledWith('workspace', rawB.id);
  await clickText('Back to Gallery'); expect(host.querySelector('[data-gallery]')).not.toBeNull();
  // Reenter through a fresh route owner; persistence, not a visited-photo snapshot, supplies A.
  act(() => root.unmount()); await flush(); root = createRoot(host); await mount();
  const exposure = host.querySelector<HTMLElement>('[data-adjustment-id="exposure"]')!.closest('.adjustment-control')!
    .querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(exposure.value).toBe('1.25');
});

it('refuses Windows close after RAW save failure and allows explicit retry', async () => {
  const respond = desktop(); await mount();
  commitHistory.mockRejectedValueOnce(new rawApi.RawSaveError('raw_connection_failed', 'unknown'));
  await editRaw();
  act(() => window.dispatchEvent(new CustomEvent('genzoroom:close-request', { detail: { requestId: 'b'.repeat(64) } }))); await flush();
  expect(respond).toHaveBeenCalledWith({ kind: 'closeResult', saved: false, requestId: 'b'.repeat(64) });
  act(() => document.querySelector<HTMLButtonElement>('dialog button')!.click()); await flush();
  await clickText('Retry RAW save');
  act(() => window.dispatchEvent(new CustomEvent('genzoroom:close-request', { detail: { requestId: 'c'.repeat(64) } }))); await flush();
  expect(respond).toHaveBeenCalledWith({ kind: 'closeResult', saved: true, requestId: 'c'.repeat(64) });
});


it('offers save retry before renewal while retaining a RAW edit after its boundary save fails', async () => {
  vi.mocked(rawApi.readRawSettings).mockImplementation(async doc => ({ ...rawSettings(doc), mutationAttempts: 199 }));
  vi.mocked(rawApi.setRawControls).mockImplementation(async (doc, patch) => ({ ...rawSettings(doc), mutationAttempts: 200,
    revision: doc.revision + 1, settingsFingerprint: '2'.repeat(64), values: { ...rawSettings(doc).values, ...patch } }));
  commitHistory.mockRejectedValueOnce(new rawApi.RawSaveError('raw_connection_failed', 'unknown'));
  await mount(); await editRaw();
  expect(host.textContent).toContain(i18n.t('workspace.rawPreview.saveFailed'));
  expect(!!(host.querySelector('.raw-adjustment-controls > [role="alert"]')!.compareDocumentPosition(
    host.querySelector('.raw-adjustment-controls > .adjustment-category')!,
  ) & Node.DOCUMENT_POSITION_PRECEDING)).toBe(true);
  const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === i18n.t('workspace.rawPreview.retrySave'))!;
  expect(retry.disabled).toBe(false);
  expect(host.querySelector<HTMLInputElement>('[data-adjustment-id="exposure"]')!.disabled).toBe(true);
  expect(rawApi.releaseRawWorkspace).not.toHaveBeenCalled();
});

it('does not render normal save-state text while a RAW save is pending or after it succeeds', async () => {
  let resolve!: () => void;
  commitHistory.mockImplementation(request => new Promise(yes => { resolve = () => yes(rawHistoryResult(request)); }));
  await mount(); await editRaw();
  expect(host.textContent).not.toContain(i18n.t('workspace.rawPreview.saving'));
  expect(host.textContent).not.toContain(i18n.t('workspace.rawPreview.unsaved'));
  expect(host.textContent).not.toContain(i18n.t('workspace.rawPreview.updating'));
  const firstSlider = host.querySelector('[data-adjustment-id="temperature"]');
  expect(firstSlider).not.toBeNull();
  await act(async () => resolve()); await flush();
  expect(host.querySelector('[data-adjustment-id="temperature"]')).toBe(firstSlider);
  expect(host.textContent).not.toContain(i18n.t('workspace.rawPreview.saving'));
  expect(host.textContent).not.toContain(i18n.t('workspace.rawPreview.unsaved'));
  expect(host.textContent).not.toContain(i18n.t('workspace.rawPreview.updating'));
});

it('keeps the adjustment controls in place while a RAW native edit is pending', async () => {
  let resolve!: (settings: rawApi.RawSettings) => void;
  vi.mocked(rawApi.setRawControls).mockImplementation(() => new Promise(yes => { resolve = yes; }));
  await mount();
  const number = host.querySelector<HTMLInputElement>('[data-adjustment-id="exposure"]')!.closest('.adjustment-control')!
    .querySelector<HTMLInputElement>('input[type="number"]')!;
  const firstSlider = host.querySelector('[data-adjustment-id="temperature"]');
  act(() => {
    number.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(number, '1.25');
    number.dispatchEvent(new Event('input', { bubbles: true }));
    number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await flush();
  expect(rawApi.setRawControls).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain(i18n.t('workspace.rawPreview.updating'));
  expect(host.querySelector('[data-adjustment-id="temperature"]')).toBe(firstSlider);
  await act(async () => resolve({ ...rawSettings({ workspaceId: 'workspace', assetId: base.id, handle: 'handle', generation: 1,
    documentToken: 'token', revision: 1 }), revision: 2, settingsFingerprint: '2'.repeat(64),
    values: { ...rawSettings({ workspaceId: 'workspace', assetId: base.id, handle: 'handle', generation: 1,
      documentToken: 'token', revision: 1 }).values, 'light.exposure': 1.25 } }));
  await flush();
});

const exposure = () => host.querySelector<HTMLInputElement>('[data-adjustment-id="exposure"]')!;
function inputValue(element: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
it.each(['pointerup', 'pointercancel'])('commits one History operation for a long drag ending with %s', async ending => {
  vi.useFakeTimers(); await mount();
  const range = exposure();
  act(() => range.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
  for (let i = 1; i <= 8; i++) {
    inputValue(range, String(i / 10));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); }); await flush();
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); await flush();
  expect(commitHistory).not.toHaveBeenCalled(); expect(rawApi.saveRawRecipe).not.toHaveBeenCalled();
  expect(rawApi.setRawControls).toHaveBeenCalledTimes(8);
  act(() => window.dispatchEvent(new MouseEvent(ending, { bubbles: true }))); await flush();
  expect(commitHistory).toHaveBeenCalledOnce();
  expect(commitHistory.mock.calls[0][0].doc.values['light.exposure']).toBe(.8);
});

it.each(['Enter', 'blur'])('commits a numeric edit on %s only once', async ending => {
  await mount();
  const number = exposure().closest('.adjustment-control')!.querySelector<HTMLInputElement>('input[type="number"]')!;
  act(() => number.focus()); inputValue(number, '1.25');
  if (ending === 'blur') act(() => number.blur());
  else act(() => number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await flush(); act(() => number.blur()); await flush();
  expect(commitHistory).toHaveBeenCalledOnce(); expect(commitHistory.mock.calls[0][0].doc.values['light.exposure']).toBe(1.25);
});

it('keeps the RAW History no-op when a numeric edit returns to its starting value', async () => {
  const model = historyBackend(0);
  await mount();
  const number = exposure().closest('.adjustment-control')!.querySelector<HTMLInputElement>('input[type="number"]')!;
  act(() => number.focus());
  inputValue(number, '1.25');
  inputValue(number, '0.00');
  act(() => number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await flush();

  expect(vi.mocked(rawApi.setRawControls)).toHaveBeenCalledOnce();
  expect(vi.mocked(rawApi.setRawControls).mock.calls[0][1]).toEqual({ 'light.exposure': 0 });
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request.action)).toEqual(['initialize', 'commit']);
  expect(model.cursor()).toBe(0);
  expect(model.entries).toHaveLength(0);
});

it.each(['keyboard', 'wheel'])('keeps RAW %s changes in one gesture across inactivity until another control starts', async kind => {
  vi.useFakeTimers(); const model = historyBackend(0); await mount(); const range = exposure();
  act(() => range.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
  for (let i = 0; i < 3; i++) {
    act(() => range.dispatchEvent(kind === 'keyboard'
      ? new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
      : new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true })));
    await act(async () => { await vi.advanceTimersByTimeAsync(750); }); await flush();
  }
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request.action)).toEqual(['initialize']);
  expect(model.entries).toHaveLength(0);
  const contrast = host.querySelector<HTMLInputElement>('[data-adjustment-id="contrast"]')!;
  act(() => contrast.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
  act(() => contrast.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
  await flush();
  const commits = vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request).filter(request => request.action === 'commit');
  expect(commits).toHaveLength(1);
  expect(commits[0].control).toBe('light.exposure');
  expect(commits[0].doc.values['light.exposure']).toBe(Number(range.value));
  expect(model.entries).toHaveLength(1);
  expect(model.entries[0].exposure).toBe(Number(range.value));
});

it('commits an open RAW keyboard gesture before a control Reset operation', async () => {
  vi.useFakeTimers(); historyBackend(0); await mount(); const range = exposure();
  act(() => range.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
  act(() => range.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); await flush();
  const reset = range.closest('.adjustment-control')!.querySelector<HTMLButtonElement>('.adjustment-reset')!;
  act(() => reset.click()); await flush();
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request.action))
    .toEqual(['initialize', 'commit', 'operate']);
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls[1][0].doc.values['light.exposure']).toBe(Number(range.value));
});

it('commits a RAW numeric draft before a section Reset operation', async () => {
  vi.useFakeTimers(); historyBackend(0); await mount();
  const input = exposure().closest('.adjustment-control')!.querySelector<HTMLInputElement>('input[type="number"]')!;
  act(() => {
    input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '1.25');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const reset = host.querySelector<HTMLButtonElement>('.raw-adjustment-category:nth-of-type(2) .adjustment-category-reset')!;
  act(() => reset.click()); await flush();
  const requests = vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request);
  expect(requests.map(request => request.action)).toEqual(['initialize', 'commit', 'operate']);
  expect(requests[1].control).toBe('light.exposure');
  expect(requests[1].doc.values['light.exposure']).toBe(1.25);
  expect(requests[2].operation?.kind).toBe('sectionReset');
});

it.each([
  ['Auto WB', 'button.raw-auto-wb', 'wbAuto'],
  ['section Reset', 'button.adjustment-category-reset', 'sectionReset'],
  ['section Toggle', 'button[data-category-switch]', 'sectionToggle'],
] as const)('commits an open RAW keyboard gesture before %s', async (_name, selector, kind) => {
  vi.useFakeTimers(); historyBackend(0); await mount(); const range = exposure();
  act(() => range.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
  act(() => range.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); await flush();
  const operation = host.querySelector<HTMLButtonElement>(selector)!;
  act(() => operation.click()); await flush();
  const requests = vi.mocked(rawApi.saveRawHistory).mock.calls.map(([request]) => request);
  expect(requests.map(request => request.action)).toEqual(['initialize', 'commit', 'operate']);
  expect(requests[1].doc.values['light.exposure']).toBe(Number(range.value));
  expect(requests[2].operation?.kind).toBe(kind);
});

it('finishes a gesture when its category unmounts its sliders', async () => {
  await mount(); const range = exposure();
  act(() => range.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
  inputValue(range, '.7');
  const title = range.closest('.raw-adjustment-category')!.querySelector<HTMLButtonElement>('.adjustment-category-title')!;
  act(() => title.click()); await flush();
  expect(commitHistory).toHaveBeenCalledOnce(); expect(commitHistory.mock.calls[0][0].doc.values['light.exposure']).toBe(.7);
});

it('keeps sliders disabled after initialization fails and retries without changing native', async () => {
  vi.mocked(rawApi.saveRawHistory).mockRejectedValueOnce(new rawApi.RawSaveError('raw_history_save_failed', 'unknown'));
  await mount();
  expect(exposure().disabled).toBe(true); expect(rawApi.setRawControls).not.toHaveBeenCalled();
  const first = vi.mocked(rawApi.saveRawHistory).mock.calls[0][0];
  await clickText('Retry RAW save');
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls[1][0]).toEqual(first); expect(exposure().disabled).toBe(false);
});

function historyBackend(count = 2) {
  const model = fakeRawHistory(count);
  vi.mocked(rawApi.readRawSettings).mockImplementation(async doc => model.settings(doc));
  vi.mocked(rawApi.saveRawHistory).mockImplementation(async request => model.save(request));
  vi.mocked(rawApi.readRawHistory).mockImplementation(async doc => model.history(doc));
  return model;
}
function historyKey(key = 'z', init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event)); return event;
}
const history = () => host.querySelector<HTMLOListElement>('.edit-history')!;
const historyButton = (position: number) => position === 0 ? history().querySelector<HTMLButtonElement>('.initial-state button')!
  : history().querySelector<HTMLButtonElement>(`li[value="${position}"] button`)!;

it('displays baseline and numeric RAW History rows without operation timestamps', async () => {
  await mount(); expect(historyButton(0).getAttribute('aria-current')).toBe('step');
  expect([...host.querySelectorAll<HTMLButtonElement>('.edit-actions button')].every(button => button.disabled)).toBe(true);
  act(() => root.unmount()); await flush(); root = createRoot(host);
  historyBackend(); await mount();
  expect(history().querySelectorAll('li')).toHaveLength(3); expect(historyButton(2).getAttribute('aria-current')).toBe('step');
  expect(history().querySelector('time')).toBeNull();
  expect(history().textContent).toContain('Exposure'); expect(history().textContent).toContain('→');
  expect(historyButton(0).textContent).toBe('Initial State');
});

it('shares the History presentation while mapping rows to stable RAW UUIDs and baseline null', async () => {
  const model = historyBackend(); await mount();
  act(() => historyButton(1).click()); await flush();
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls[1][0]).toMatchObject({ action: 'jump', targetStepId: model.entries[0].id });
  expect(historyButton(1).getAttribute('aria-current')).toBe('step'); expect(exposure().value).toBe('1');
  const undo = host.querySelectorAll<HTMLButtonElement>('.edit-actions button')[0], redo = host.querySelectorAll<HTMLButtonElement>('.edit-actions button')[1];
  expect(redo.disabled).toBe(false); act(() => historyButton(0).click()); await flush();
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls[2][0].targetStepId).toBeNull(); expect(undo.disabled).toBe(true);
  expect(history().querySelectorAll('.undone')).toHaveLength(2); expect(exposure().value).toBe('0');
  act(() => redo.click()); await flush(); expect(historyButton(1).getAttribute('aria-current')).toBe('step');
});

it('dispatches each RAW shortcut once and leaves native input, IME, repeat and modal events untouched', async () => {
  historyBackend(); await mount();
  expect(historyKey().defaultPrevented).toBe(true); await flush();
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.map(([r]) => r.action)).toEqual(['initialize', 'undo']);
  historyKey('z', { shiftKey: true }); await flush(); expect(historyButton(2).getAttribute('aria-current')).toBe('step');
  const count = vi.mocked(rawApi.saveRawHistory).mock.calls.length;
  const input = exposure().closest('.adjustment-control')!.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(historyKey('z', {}, input).defaultPrevented).toBe(false);
  historyKey('z', { isComposing: true }); historyKey('z', { repeat: true });
  const modal = document.createElement('div'); modal.setAttribute('role', 'dialog'); document.body.append(modal);
  expect(historyKey().defaultPrevented).toBe(false); modal.remove(); await flush();
  expect(rawApi.saveRawHistory).toHaveBeenCalledTimes(count);
  act(() => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[1].click()); await flush();
  historyKey(); await flush(); expect(rawApi.saveRawHistory).toHaveBeenCalledTimes(count);
});

it('prioritizes Filmstrip exclusion Undo before RAW History Undo', async () => {
  historyBackend(); await mount();
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Exclude b.jpg from Filmstrip"]')!.click()); await flush();
  expect(host.querySelectorAll('.filmstrip-item')).toHaveLength(2);
  historyKey(); await flush(); expect(host.querySelectorAll('.filmstrip-item')).toHaveLength(3);
  expect(rawApi.saveRawHistory).toHaveBeenCalledOnce();
  historyKey(); await flush(); expect(vi.mocked(rawApi.saveRawHistory).mock.calls[1][0].action).toBe('undo');
});

it('commits an open RAW gesture before shortcut Undo without recording the move as a new step', async () => {
  historyBackend(); await mount();
  act(() => exposure().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
  inputValue(exposure(), '3'); historyKey(); await flush();
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.map(([r]) => r.action)).toEqual(['initialize', 'commit', 'undo']);
  expect(historyButton(2).getAttribute('aria-current')).toBe('step'); expect(history().querySelectorAll('li')).toHaveLength(4);
});

it('displays all 200 saved operations on first load with no paging controls', async () => {
  historyBackend(200); await mount(); expect(history().querySelectorAll('li')).toHaveLength(201);
  expect(rawApi.readRawHistory).toHaveBeenCalledOnce();
  expect(historyButton(1).textContent).toContain('Exposure');
  expect(historyButton(200).getAttribute('aria-current')).toBe('step');
  expect(host.textContent).not.toContain('20 earlier operations');
  expect(host.textContent).not.toContain('20 later operations');
});

it('retains the old cursor on save failure, locks history/editing, and retries exactly the same move', async () => {
  const model = historyBackend(); await mount();
  vi.mocked(rawApi.saveRawHistory).mockImplementationOnce(async request => {
    model.save(request); throw new rawApi.RawSaveError('raw_history_save_failed', 'unknown');
  });
  historyKey(); await flush(); const request = vi.mocked(rawApi.saveRawHistory).mock.calls[1][0];
  expect(historyButton(2).getAttribute('aria-current')).toBe('step'); expect(exposure().disabled).toBe(true);
  expect([...history().querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true);
  await clickText('Retry RAW save');
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls[2][0]).toEqual(request);
  expect(historyButton(1).getAttribute('aria-current')).toBe('step'); expect(exposure().disabled).toBe(false);
});

it('waits for an in-flight History move before approving Windows close', async () => {
  const respond = desktop(), model = historyBackend(); await mount();
  let resolve!: (result: rawApi.RawHistoryResult) => void;
  vi.mocked(rawApi.saveRawHistory).mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
  historyKey(); await flush(); const request = vi.mocked(rawApi.saveRawHistory).mock.calls[1][0];
  historyKey(); act(() => historyButton(0).click()); await flush();
  expect(rawApi.saveRawHistory).toHaveBeenCalledTimes(2);
  act(() => window.dispatchEvent(new CustomEvent('genzoroom:close-request', { detail: { requestId: 'd'.repeat(64) } }))); await flush();
  expect(respond).not.toHaveBeenCalledWith(expect.objectContaining({ saved: true }));
  await act(async () => resolve(model.save(request))); await flush();
  expect(respond).toHaveBeenCalledWith({ kind: 'closeResult', saved: true, requestId: 'd'.repeat(64) });
});

it('reloads the persisted cursor and Redo range after switching through JPEG', async () => {
  historyBackend(); await mount(); historyKey(); await flush();
  act(() => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[1].click()); await flush();
  expect(host.querySelector('[data-jpeg-renderer]')).not.toBeNull();
  act(() => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[0].click()); await flush();
  expect(historyButton(1).getAttribute('aria-current')).toBe('step');
  expect(host.querySelectorAll<HTMLButtonElement>('.edit-actions button')[1].disabled).toBe(false);
  expect(rawApi.readRawHistory).toHaveBeenCalledTimes(2);
});

it('labels RAW temperature in Kelvin without inventing unavailable before/after values', async () => {
  const model = historyBackend();
  vi.mocked(rawApi.readRawHistory).mockImplementation(async doc => {
    const data = model.history(doc);
    data.steps[0].metadata.control = 'wb.temp'; data.steps[0].changes = [{ control: 'wb.temp', before: 4500, after: 5000 }];
    data.steps[1].metadata.control = 'wb.tint'; data.steps[1].changes = [{ control: 'wb.tint', before: 0, after: -10 }]; return data;
  });
  await mount();
  expect(history().textContent).toContain(`${i18n.t('workspace.temperature')} 4500 K → 5000 K`);
  expect(history().textContent).toContain(`${i18n.t('workspace.tint')} 0 → -10`);
});

function simulateChromiumRangeDisableBlur(range: HTMLInputElement) {
  // jsdom won't blur a disabled input, so temporarily enable only the DOM node to emit native blur.
  range.disabled = false;
  act(() => range.blur());
  range.disabled = true;
}

it.each(['Shift navigation', 'Shift navigation under stationary pointer', 'mouse focus'] as const)('records RAW slider focus during an explicit boundary commit after %s', async method => {
  vi.useFakeTimers();
  let resolve!: () => void;
  let pendingRequest!: rawApi.RawHistoryRequest;
  const model = historyBackend(0);
  vi.mocked(rawApi.saveRawHistory).mockImplementation(request => request.action === 'initialize' ? Promise.resolve(model.save(request))
    : new Promise(yes => { pendingRequest = request; resolve = () => yes(model.save(request)); }));
  await mount();
  const range = host.querySelector<HTMLInputElement>('[data-adjustment-id="temperature"]')!;
  const before: Array<{ phase: string; activeElement: Element | null; logicalTarget: Element | null; registered: boolean; disabled: boolean }> = [];
  const record = (phase: string) => before.push({ phase, activeElement: document.activeElement,
    logicalTarget: keyboardAdjustment(), registered: isRegisteredAdjustment(range), disabled: range.disabled });
  if (method.startsWith('Shift navigation')) {
    const category = host.querySelector<HTMLButtonElement>('.raw-adjustment-category .adjustment-category-title')!;
    act(() => category.focus()); historyKey('ArrowDown', { ctrlKey: false, shiftKey: true }, category);
    if (method === 'Shift navigation under stationary pointer')
      act(() => range.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
  } else {
    act(() => range.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    act(() => range.focus());
  }
  record('before input');
  expect(document.activeElement).toBe(range); expect(keyboardAdjustment()).toBe(range);
  historyKey('ArrowRight', { ctrlKey: false }, range);
  act(() => commitAdjustmentEdits(host.querySelector('.raw-adjustment-controls')!)); await flush();
  expect(vi.mocked(rawApi.saveRawHistory).mock.calls.filter(([request]) => request.action === 'commit')).toHaveLength(1);
  // Chromium moves focus off a native range when React applies the RAW save lock.
  if (range.disabled) simulateChromiumRangeDisableBlur(range);
  record('commit pending');
  expect(pendingRequest.action).toBe('commit');
  expect(range.disabled).toBe(true); expect(isRegisteredAdjustment(range)).toBe(true);
  await act(async () => resolve()); await flush();
  record('commit acknowledged');
  expect(range.isConnected).toBe(true); expect(range.disabled).toBe(false);
  expect(host.querySelector('[data-adjustment-id="temperature"]')).toBe(range);
  expect(keyboardAdjustment()).toBe(range);
  if (method.startsWith('Shift navigation')) expect(document.activeElement).toBe(range);
  else expect(document.activeElement).toBe(document.body);
  expect(before.map(({ phase, activeElement, logicalTarget, registered, disabled }) => ({
    phase, activeElement: activeElement === range ? 'range' : activeElement?.tagName ?? null,
    logicalTarget: logicalTarget === range ? 'range' : logicalTarget?.tagName ?? null, registered, disabled,
  }))).toEqual([
    { phase: 'before input', activeElement: 'range', logicalTarget: 'range', registered: true, disabled: false },
    { phase: 'commit pending', activeElement: 'BODY', logicalTarget: null, registered: true, disabled: true },
    { phase: 'commit acknowledged', activeElement: method.startsWith('Shift navigation') ? 'range' : 'BODY',
      logicalTarget: 'range', registered: true, disabled: false },
  ]);
  const value = range.getAttribute('aria-valuetext');
  historyKey('ArrowRight', { ctrlKey: false }, method.startsWith('Shift navigation') ? range : document.activeElement!);
  expect(range.getAttribute('aria-valuetext')).not.toBe(value);
  act(() => commitAdjustmentEdits(host.querySelector('.raw-adjustment-controls')!)); await flush();
  expect(pendingRequest.action).toBe('commit');
  await act(async () => resolve()); await flush();
});

it.each(['another element', 'another window'])('does not reclaim a RAW slider after focus moves to %s during a boundary save lock', async destination => {
  vi.useFakeTimers();
  let resolve!: () => void;
  let pendingRequest!: rawApi.RawHistoryRequest;
  const model = historyBackend(0);
  vi.mocked(rawApi.saveRawHistory).mockImplementation(request => request.action === 'initialize' ? Promise.resolve(model.save(request))
    : new Promise(yes => { pendingRequest = request; resolve = () => yes(model.save(request)); }));
  await mount();
  const category = host.querySelector<HTMLButtonElement>('.raw-adjustment-category .adjustment-category-title')!;
  const range = host.querySelector<HTMLInputElement>('[data-adjustment-id="temperature"]')!;
  act(() => category.focus()); historyKey('ArrowDown', { ctrlKey: false, shiftKey: true }, category);
  historyKey('ArrowRight', { ctrlKey: false }, range);
  act(() => commitAdjustmentEdits(host.querySelector('.raw-adjustment-controls')!)); await flush();
  expect(pendingRequest.action).toBe('commit'); expect(range.disabled).toBe(true);
  simulateChromiumRangeDisableBlur(range);
  const external = document.createElement('button'); document.body.append(external);
  act(() => destination === 'another element' ? external.focus() : window.dispatchEvent(new Event('blur')));
  await act(async () => resolve()); await flush();
  expect(document.activeElement).toBe(destination === 'another element' ? external : document.body);
  expect(keyboardAdjustment()).toBeNull();
  external.remove();
});


it('runs AW once through History, updates both WB values and Preview, and releases its momentary button', async () => {
  await mount();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  commitHistory.mockImplementation(async request => {
    await pending;
    const settings = { ...request.doc, revision: request.doc.revision + 1, settingsFingerprint: 'f'.repeat(64),
      wb: { available: true, mode: 'auto', scale: 'kelvin' },
      values: { ...request.doc.values, 'wb.temp': 5200, 'wb.tint': 11 } };
    return rawHistoryResult({ ...request, doc: settings }, { history: {
      initialized: true, cursor: 1, length: 1, selectedStepId: request.saveId } });
  });
  vi.mocked(rawApi.readRawHistory).mockImplementation(async doc => {
    const result = rawHistoryData(doc);
    return { ...result, steps: result.steps.map(step => ({ ...step, kind: 'wbAuto', metadata: {}, changes: [
      { control: 'wb.temp', before: 6500, after: 5200 }, { control: 'wb.tint', before: 0, after: 11 } ] })) };
  });
  const aw = host.querySelector<HTMLButtonElement>('.raw-auto-wb')!;
  expect(aw.textContent).toBe('AW'); expect(aw.disabled).toBe(false);
  expect(aw.getAttribute('aria-pressed')).toBeNull();
  expect(aw.parentElement?.firstElementChild).toBe(aw);
  act(() => { aw.click(); aw.click(); }); await flush();
  expect(aw.disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>('.adjustment-range')!.disabled).toBe(true);
  historyKey(); await flush();
  expect(commitHistory).toHaveBeenCalledOnce();
  expect(commitHistory.mock.calls[0][0].operation).toEqual({ kind: 'wbAuto', metadata: {} });
  await act(async () => finish()); await flush();
  expect(aw.disabled).toBe(false); expect(aw.getAttribute('aria-pressed')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('[data-adjustment-id="temperature"]')!.value).toBe('5200');
  expect(host.querySelector<HTMLInputElement>('[data-adjustment-id="tint"]')!.value).toBe('11');
  expect(history().textContent).toContain('Auto white balance');
  expect(history().textContent).toContain('6500 K → 5200 K');
  expect(vi.mocked(rawApi.rawPreview).mock.calls.at(-1)?.[0].revision).toBe(2);
});

it('toggles Picker, cancels with Escape/other edits/Asset change, and submits one frozen displayed Whole point', async () => {
  vi.mocked(rawApi.rawPreview).mockImplementation(async (_doc, sequence, _signal, kind = 'after', target) => ({
    blob: new Blob(['png']), width: 16, height: 12, epoch: 1, sequence, kind,
    quality: target?.quality ?? 'full', frame: { geometryId: 'a'.repeat(64), nativeWidth: 4000, nativeHeight: 3000,
      fullWidth: 16, fullHeight: 12, aspect: 4/3, window: null } }));
  await mount();
  const picker = () => host.querySelector<HTMLButtonElement>('.raw-wb-pick')!;
  expect(picker().disabled).toBe(false);
  expect(picker().previousElementSibling?.textContent).toBe('AW');
  const aw = picker().previousElementSibling as HTMLButtonElement;
  act(() => aw.focus()); historyKey('ArrowRight', { ctrlKey: false, shiftKey: true }, aw);
  expect(document.activeElement).toBe(picker());
  act(() => picker().click()); await flush(); expect(picker().getAttribute('aria-pressed')).toBe('true');
  act(() => picker().click()); await flush(); expect(picker().getAttribute('aria-pressed')).toBe('false');
  act(() => picker().click()); await flush();
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await flush(); expect(picker().getAttribute('aria-pressed')).toBe('false');
  act(() => picker().click()); await flush();
  const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
  Object.defineProperty(viewport, 'setPointerCapture', { value: vi.fn() });
  const position = host.querySelector<HTMLElement>('.viewer-image-position')!;
  vi.spyOn(position, 'getBoundingClientRect').mockReturnValue({ left: 50, top: 20, width: 800, height: 600 } as DOMRect);
  const base = host.querySelector<HTMLImageElement>('.raw-whole-base')!;
  Object.defineProperty(base, 'naturalWidth', { value: 16 }); Object.defineProperty(base, 'naturalHeight', { value: 12 });
  act(() => base.dispatchEvent(new Event('load')));
  commitHistory.mockImplementation(async request => rawHistoryResult({ ...request,
    doc: { ...request.doc, revision: request.doc.revision + 1, settingsFingerprint: 'e'.repeat(64),
      wb: { available: true, mode: 'custom', scale: 'kelvin' }, values: { ...request.doc.values, 'wb.temp': 5300, 'wb.tint': 12 } } },
    { history: { initialized: true, cursor: 1, length: 1, selectedStepId: request.saveId } }));
  act(() => {
    for (const type of ['pointerdown', 'pointerup']) viewport.dispatchEvent(new MouseEvent(type,
      { bubbles: true, button: 0, clientX: 250, clientY: 470 }));
  }); await flush();
  expect(commitHistory).toHaveBeenCalledOnce();
  expect(commitHistory.mock.calls[0][0].operation).toEqual({ kind: 'wbPick', metadata: {}, frame: {
    kind: 'after', geometryId: 'a'.repeat(64), maxSide: 1024, quality: 'full', x: .25, y: .75 } });
  expect(picker().getAttribute('aria-pressed')).toBe('false');
  expect(host.querySelector<HTMLInputElement>('[data-adjustment-id="temperature"]')!.value).toBe('5300');
  act(() => picker().click()); await flush();
  await editRaw(); expect(picker().getAttribute('aria-pressed')).toBe('false');
  act(() => picker().click()); await flush();
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[2].click()); await flush();
  expect(picker().getAttribute('aria-pressed')).toBe('false');
});

it.each(['off', 'wbUnavailable', 'helperUnavailable'])('disables AW when %s while retaining the category actions', async reason => {
  vi.mocked(rawApi.readRawSettings).mockImplementationOnce(async doc => {
    const settings = rawSettings(doc);
    return { ...settings, sections: { ...settings.sections, color: reason !== 'off' },
      wbAutoAvailable: reason !== 'helperUnavailable', wb: { ...settings.wb, available: reason !== 'wbUnavailable' } };
  });
  await mount();
  expect(host.querySelector<HTMLButtonElement>('.raw-auto-wb')!.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('.raw-wb-pick')!.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[data-category-switch]')!.disabled).toBe(false);
});

it('shows a rejected AW estimate without locking saved edits or retrying it as an unknown save', async () => {
  await mount();
  commitHistory.mockRejectedValueOnce(new rawApi.RawSaveError('raw_wb_no_valid_samples', 'rejected', 422));
  const aw = host.querySelector<HTMLButtonElement>('.raw-auto-wb')!;
  act(() => aw.click()); await flush();
  expect(host.textContent).toContain('could not find suitable samples');
  expect(aw.disabled).toBe(false);
  expect(host.textContent).not.toContain('The RAW recipe could not be saved');
  expect(history().querySelectorAll('li')).toHaveLength(1);
});
