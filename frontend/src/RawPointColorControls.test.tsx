// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { RawAdjustmentControls } from './RawAdjustmentControls';
import { RAW_DEVELOPMENT_PANEL_UI_KEY, defaultRawDevelopmentPanelUi, updateSetting } from './appSettings';
import { rawSettings } from './test/rawSettings';

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  updateSetting('rawDevelopmentPanelUi', defaultRawDevelopmentPanelUi());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();
  updateSetting('rawDevelopmentPanelUi', defaultRawDevelopmentPanelUi());
  window.localStorage.removeItem(RAW_DEVELOPMENT_PANEL_UI_KEY);
});

const documentInfo = (assetId = 'asset-a', suffix = 'a') => ({ workspaceId: 'workspace', assetId, handle: `handle-${suffix}`,
  documentToken: `token-${suffix}`, generation: 1, revision: 1 });
const point = (hue = 42) => ({ lum: 0.4, chroma: 0.15, hue, hue_shift: 0, sat_shift: 0, lum_shift: 0,
  variance: 0, range: 50, hue_range: 50, sat_range: 50, lum_range: 50 });
function createRaw(colors: ReturnType<typeof point>[] = []) {
  const identity = documentInfo();
  return { assetId: identity.assetId, status: 'ready', settings: { ...rawSettings(identity), point_colors: colors }, history: {},
    operate: vi.fn(), beginControls: vi.fn(), changeControls: vi.fn(), flushControls: vi.fn(), desired: {} };
}
function draw(raw: ReturnType<typeof createRaw>) { act(() => root.render(<RawAdjustmentControls raw={raw as never} />)); }
function openPointColor() {
  act(() => host.querySelector<HTMLButtonElement>('.raw-point-color-title')!.click());
}
function swatches() { return [...host.querySelectorAll<HTMLButtonElement>('.raw-point-color-swatch')]; }

it('shows an inactive eyedropper and localized prompt for an empty Point Color array', async () => {
  const raw = createRaw();
  await i18n.changeLanguage('ja');
  draw(raw);
  expect(host.querySelector('.raw-point-color')).not.toBeNull();
  expect(swatches()).toHaveLength(0);
  openPointColor();
  expect(host.textContent).toContain('スポイトで写真の色を選択してください。');
  expect(host.querySelector<HTMLButtonElement>('.raw-point-color-pick')?.disabled).toBe(true);
  expect(host.querySelector('.raw-point-color-content .adjustment-control')).toBeNull();
  await i18n.changeLanguage('en');
  draw(raw);
  expect(host.textContent).toContain('Use the eyedropper to pick a color from the photo.');
});

it('shows each ordered entry including duplicates and keeps selection local to the UI', () => {
  const raw = createRaw([point(), point(), point(220)]);
  draw(raw);
  openPointColor();
  const buttons = swatches();
  expect(buttons.map(button => button.dataset.pointColorIndex)).toEqual(['0', '1', '2']);
  expect(buttons.filter(button => button.getAttribute('aria-pressed') === 'true')).toEqual([buttons[0]]);
  const savedUi = window.localStorage.getItem(RAW_DEVELOPMENT_PANEL_UI_KEY);
  act(() => buttons[2].click());
  expect(swatches().map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
  expect(window.localStorage.getItem(RAW_DEVELOPMENT_PANEL_UI_KEY)).toBe(savedUi);
  expect(raw.operate).not.toHaveBeenCalled();
  expect(raw.beginControls).not.toHaveBeenCalled();
  expect(raw.changeControls).not.toHaveBeenCalled();
  expect(raw.flushControls).not.toHaveBeenCalled();
});

it('clamps selection after array shrink and clears it for an empty array', () => {
  const raw = createRaw([point(), point(100), point(220)]);
  draw(raw); openPointColor(); act(() => swatches()[2].click());
  raw.settings.point_colors = [point(), point(100)]; draw(raw);
  expect(swatches().map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  raw.settings.point_colors = []; draw(raw);
  expect(swatches()).toHaveLength(0);
  raw.settings.point_colors = [point(330)]; draw(raw);
  expect(swatches()).toHaveLength(1);
  expect(swatches()[0].getAttribute('aria-pressed')).toBe('true');
});

it('resets selection to the first entry when the RAW document changes', () => {
  const raw = createRaw([point(), point(120), point(240)]);
  draw(raw); openPointColor(); act(() => swatches()[2].click());
  const next = documentInfo('asset-b', 'b');
  raw.assetId = next.assetId;
  raw.settings = { ...rawSettings(next), point_colors: [point(), point(120), point(240)] };
  draw(raw);
  expect(swatches().map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
});
