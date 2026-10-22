// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AnshitsuPage } from './AnshitsuPage';
import { SettingsProvider } from './SettingsDialog';
import i18n from './i18n';
import type { AssetDetail } from './assets';
import * as rawApi from './rawApi';
import { rawSettings } from './test/rawSettings';
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
  saveRawRecipe: vi.fn(), readRawRecipe: vi.fn() }));
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
  vi.mocked(rawApi.saveRawRecipe).mockReset().mockImplementation(async request => ({ documentRevision: request.doc.revision,
    settingsFingerprint: request.doc.settingsFingerprint, recipeRevision: request.expectedRecipeRevision + 1,
    saveId: request.saveId, updatedAt: '2026-10-22T00:00:00.000Z' }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); await flush(); host.remove(); delete window.__GENZOROOM_DESKTOP__; vi.unstubAllGlobals(); });

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
  await mount(); await editRaw();
  vi.mocked(rawApi.saveRawRecipe).mockRejectedValueOnce(new rawApi.RawSaveError('raw_connection_failed', 'unknown'));
  act(() => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[1].click()); await flush();
  expect(host.querySelector('[role="alertdialog"]')).not.toBeNull(); expect(host.querySelector('[data-jpeg-renderer]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('[data-adjustment-id="exposure"]')!.disabled).toBe(true);
  const first = vi.mocked(rawApi.saveRawRecipe).mock.calls[0][0];
  await clickText('Retry RAW save', host.querySelector('[role="alertdialog"]')!);
  expect(vi.mocked(rawApi.saveRawRecipe).mock.calls[1][0]).toEqual(first);
  expect(host.querySelector('[data-jpeg-renderer]')).not.toBeNull();
});

it('blocks Gallery return on a failed RAW save, preserves editing on cancel, and exits only after retry', async () => {
  await mount(); await editRaw();
  vi.mocked(rawApi.saveRawRecipe).mockRejectedValueOnce(new rawApi.RawSaveError('raw_recipe_save_failed', 'unknown', 503));
  await clickText('Back to Gallery');
  expect(host.querySelector('[data-gallery]')).toBeNull(); expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
  await clickText(i18n.t('workspace.stayInAnshitsu'));
  expect(host.querySelector<HTMLInputElement>('[data-adjustment-id="exposure"]')!.disabled).toBe(false);
  await clickText('Retry RAW save');
  await clickText('Back to Gallery'); expect(host.querySelector('[data-gallery]')).not.toBeNull();
});

it('restores the saved RAW readback when returning through JPEG', async () => {
  const saved = new Map<string, rawApi.RawSettings>();
  vi.mocked(rawApi.saveRawRecipe).mockImplementation(async request => {
    saved.set(request.doc.assetId, request.doc);
    return { documentRevision: request.doc.revision, settingsFingerprint: request.doc.settingsFingerprint,
      recipeRevision: request.expectedRecipeRevision + 1, saveId: request.saveId, updatedAt: '2026-10-22T00:00:00.000Z' };
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
  const respond = desktop(); await mount(); await editRaw();
  let resolve!: (ack: rawApi.RawRecipeAck) => void;
  vi.mocked(rawApi.saveRawRecipe).mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
  act(() => window.dispatchEvent(new CustomEvent('genzoroom:close-request', { detail: { requestId: 'a'.repeat(64) } }))); await flush();
  expect(respond).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'closeResult', saved: true }));
  const request = vi.mocked(rawApi.saveRawRecipe).mock.calls[0][0];
  await act(async () => resolve({ documentRevision: request.doc.revision, settingsFingerprint: request.doc.settingsFingerprint,
    recipeRevision: 1, saveId: request.saveId, updatedAt: '2026-10-22T00:00:00.000Z' })); await flush();
  expect(respond).toHaveBeenCalledWith({ kind: 'closeResult', saved: true, requestId: 'a'.repeat(64) });
});

it('waits for saving RAW A before opening RAW B and restores A on Gallery reentry', async () => {
  let saved: rawApi.RawSettings | undefined;
  let resolve!: (ack: rawApi.RawRecipeAck) => void;
  vi.mocked(rawApi.saveRawRecipe).mockImplementation(async request => {
    saved = request.doc;
    return new Promise(yes => { resolve = yes; });
  });
  vi.mocked(rawApi.readRawSettings).mockImplementation(async doc => saved?.assetId === doc.assetId
    ? { ...saved, ...doc, settingsFingerprint: saved.settingsFingerprint, recipeFingerprint: saved.settingsFingerprint, recipeRevision: 1 }
    : rawSettings(doc));
  await mount(); await editRaw();
  act(() => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[2].click()); await flush();
  expect(rawApi.openRawDocument).toHaveBeenCalledTimes(1);
  const request = vi.mocked(rawApi.saveRawRecipe).mock.calls[0][0];
  await act(async () => resolve({ documentRevision: request.doc.revision, settingsFingerprint: request.doc.settingsFingerprint,
    recipeRevision: 1, saveId: request.saveId, updatedAt: '2026-10-22T00:00:00.000Z' })); await flush();
  expect(rawApi.openRawDocument).toHaveBeenLastCalledWith('workspace', rawB.id);
  await clickText('Back to Gallery'); expect(host.querySelector('[data-gallery]')).not.toBeNull();
  // Reenter through a fresh route owner; persistence, not a visited-photo snapshot, supplies A.
  act(() => root.unmount()); await flush(); root = createRoot(host); await mount();
  const exposure = host.querySelector<HTMLElement>('[data-adjustment-id="exposure"]')!.closest('.adjustment-control')!
    .querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(exposure.value).toBe('1.25');
});

it('refuses Windows close after RAW save failure and allows explicit retry', async () => {
  const respond = desktop(); await mount(); await editRaw();
  vi.mocked(rawApi.saveRawRecipe).mockRejectedValueOnce(new rawApi.RawSaveError('raw_connection_failed', 'unknown'));
  act(() => window.dispatchEvent(new CustomEvent('genzoroom:close-request', { detail: { requestId: 'b'.repeat(64) } }))); await flush();
  expect(respond).toHaveBeenCalledWith({ kind: 'closeResult', saved: false, requestId: 'b'.repeat(64) });
  act(() => document.querySelector<HTMLButtonElement>('dialog button')!.click()); await flush();
  await clickText('Retry RAW save');
  act(() => window.dispatchEvent(new CustomEvent('genzoroom:close-request', { detail: { requestId: 'c'.repeat(64) } }))); await flush();
  expect(respond).toHaveBeenCalledWith({ kind: 'closeResult', saved: true, requestId: 'c'.repeat(64) });
});
