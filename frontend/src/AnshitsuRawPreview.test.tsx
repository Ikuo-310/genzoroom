// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AnshitsuPage } from './AnshitsuPage';
import { isRegisteredAdjustment, keyboardAdjustment } from './adjustmentFocus';
import { SettingsProvider } from './SettingsDialog';
import i18n from './i18n';
import type { AssetDetail } from './assets';
import * as rawApi from './rawApi';
import { rawSettings } from './test/rawSettings';
import { rawHistoryResult, rawHistoryPage, fakeRawHistory } from './test/rawHistory';
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
  vi.mocked(rawApi.readRawHistory).mockReset().mockImplementation(async (doc, offset) => rawHistoryPage(doc, offset));
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
  expect(host.textContent).toContain('LightCraft RAW Preview · up to 1024 px');
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
it('binds engine control specs to shared sliders and commits RAW values without JPEG rendering', async () => {
  await mount();
  const sliders = [...host.querySelectorAll<HTMLInputElement>('.adjustment-range')];
  expect(sliders).toHaveLength(10);
  expect(sliders.map(slider => slider.dataset.adjustmentId)).toEqual([
    'temperature', 'tint', 'exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks', 'vibrance', 'saturation',
  ]);
  expect(sliders[0].min).toBe('2000'); expect(sliders[0].max).toBe('50000'); expect(sliders[0].step).toBe('50');
  expect(sliders[1].min).toBe('-150'); expect(sliders[2].step).toBe('0.01');
  expect(sliders[0].classList.contains('has-gradient')).toBe(true);
  expect(sliders[0].style.getPropertyValue('--adjustment-track-gradient')).toContain('#4e8ed9');
  expect(sliders[0].style.getPropertyValue('--adjustment-track-gradient')).toContain('#d86943');
  expect(sliders[1].style.getPropertyValue('--adjustment-track-gradient')).toContain('#4f9b62');
  expect(sliders[1].style.getPropertyValue('--adjustment-track-gradient')).toContain('#b05aa0');
  const actions = [...host.querySelectorAll<HTMLButtonElement>('.adjustment-power, .adjustment-reset, .adjustment-category-actions button, .develop-panel .workspace-section-action')];
  expect(actions).toHaveLength(27);
  expect(actions.every(button => button.disabled && button.title === i18n.t('workspace.rawPreview.actionsUnavailable'))).toBe(true);
  const number = sliders[2].closest('.adjustment-control')!.querySelector<HTMLInputElement>('input[type="number"]')!;
  act(() => {
    number.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(number, '1.25');
    number.dispatchEvent(new Event('input', { bubbles: true }));
    number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }); await flush();
  expect(rawApi.setRawControls).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }), { 'light.exposure': 1.25 });
  const mutationCount = vi.mocked(rawApi.setRawControls).mock.calls.length;
  act(() => actions.forEach(button => button.click())); await flush();
  expect(rawApi.setRawControls).toHaveBeenCalledTimes(mutationCount);
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
  const basicTitle = host.querySelector<HTMLElement>('.raw-adjustment-category:nth-of-type(2) .adjustment-category-title')!;
  moveDown(sliders[1]); expect(document.activeElement).toBe(basicTitle);
  moveDown(basicTitle); expect(document.activeElement).toBe(sliders[2]);
  for (let index = 3; index < 8; index++) {
    moveDown(sliders[index - 1]); expect(document.activeElement).toBe(sliders[index]);
  }
  expect(sliders.slice(2, 8).map(slider => slider.dataset.adjustmentId)).toEqual(['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks']);
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
  expect(sliders.slice(2).every(slider => !slider.disabled)).toBe(true);
});
it('does not show an Immich image as the result of failed native rendering', async () => {
  vi.mocked(rawApi.rawPreview).mockRejectedValue(new rawApi.RawApiError('raw_render_failed'));
  await mount();
  expect(host.querySelector('.viewer-panel img')).toBeNull();
  expect(host.textContent).toContain('LightCraft RAW Preview failed');
  expect(adjusted).not.toHaveBeenCalled();
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

it.each(['keyboard', 'wheel'])('uses the existing 500ms %s commit boundary', async kind => {
  vi.useFakeTimers(); await mount(); const range = exposure();
  act(() => range.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
  for (let i = 0; i < 3; i++) {
    act(() => range.dispatchEvent(kind === 'keyboard'
      ? new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
      : new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true })));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); }); await flush();
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(349); }); await flush();
  expect(commitHistory).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); await flush();
  expect(commitHistory).toHaveBeenCalledOnce();
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
  vi.mocked(rawApi.readRawHistory).mockImplementation(async (doc, offset) => model.page(doc, offset));
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

it('pages through 200 saved operations in batches of 20', async () => {
  historyBackend(200); await mount(); expect(history().querySelectorAll('li')).toHaveLength(21);
  expect(rawApi.readRawHistory).toHaveBeenCalledOnce();
  for (let i = 0; i < 9; i++) await clickText('Load 20 earlier operations');
  expect(history().querySelectorAll('li')).toHaveLength(201); expect(rawApi.readRawHistory).toHaveBeenCalledTimes(10);
  expect(historyButton(200).getAttribute('aria-current')).toBe('step');
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
  vi.mocked(rawApi.readRawHistory).mockImplementation(async (doc, offset) => {
    const page = model.page(doc, offset);
    page.steps[0].metadata.control = 'wb.temp'; page.steps[0].changes = [{ control: 'wb.temp', before: 4500, after: 5000 }];
    page.steps[1].metadata.control = 'wb.tint'; page.steps[1].changes = [{ control: 'wb.tint', before: 0, after: -10 }]; return page;
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

it.each(['Shift navigation', 'Shift navigation under stationary pointer', 'mouse focus'] as const)('records RAW slider focus across a History commit after %s', async method => {
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
  act(() => vi.advanceTimersByTime(500)); await flush();
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
  act(() => vi.advanceTimersByTime(500)); await flush();
  expect(pendingRequest.action).toBe('commit');
  await act(async () => resolve()); await flush();
});

it.each(['another element', 'another window'])('does not reclaim a RAW slider after focus moves to %s during a save lock', async destination => {
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
  act(() => vi.advanceTimersByTime(500)); await flush();
  expect(pendingRequest.action).toBe('commit'); expect(range.disabled).toBe(true);
  simulateChromiumRangeDisableBlur(range);
  const external = document.createElement('button'); document.body.append(external);
  act(() => destination === 'another element' ? external.focus() : window.dispatchEvent(new Event('blur')));
  await act(async () => resolve()); await flush();
  expect(document.activeElement).toBe(destination === 'another element' ? external : document.body);
  expect(keyboardAdjustment()).toBeNull();
  external.remove();
});
