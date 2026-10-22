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
    values: { ...rawSettings(doc).values, ...patch } })), releaseRawWorkspace: vi.fn(async () => {}) }));
let root: Root, host: HTMLDivElement;
async function flush() { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); }
async function mount() {
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: `/anshitsu/${base.id}`,
    state: { selectedAssets: [base, jpeg, rawB], activeAssetId: base.id } }]}><SettingsProvider><Routes>
    <Route path="/anshitsu/:assetId" element={<AnshitsuPage />} />
  </Routes></SettingsProvider></MemoryRouter>));
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
  vi.mocked(rawApi.rawPreview).mockResolvedValue({ blob: new Blob(['png']), width: 16, height: 12, epoch: 1, sequence: 1 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); await flush(); host.remove(); vi.unstubAllGlobals(); });

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
  expect(sliders[0].min).toBe('2000'); expect(sliders[0].max).toBe('50000'); expect(sliders[0].step).toBe('50');
  expect(sliders[1].min).toBe('-150'); expect(sliders[2].step).toBe('0.01');
  expect(host.querySelector('.adjustment-power')).toBeNull(); expect(host.querySelector('.adjustment-reset')).toBeNull();
  const number = sliders[2].closest('.adjustment-control')!.querySelector<HTMLInputElement>('input[type="number"]')!;
  act(() => {
    number.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(number, '1.25');
    number.dispatchEvent(new Event('input', { bubbles: true }));
    number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }); await flush();
  expect(rawApi.setRawControls).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }), { 'light.exposure': 1.25 });
  expect(rawApi.rawPreview).toHaveBeenCalledTimes(2); expect(adjusted).not.toHaveBeenCalled();
  expect(number.value).toBe('1.25'); expect(host.textContent).toContain('RAW edits are temporary');
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
