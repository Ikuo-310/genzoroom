// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { RawAdjustmentControls } from './RawAdjustmentControls';
import { RAW_DEVELOPMENT_PANEL_UI_KEY, defaultRawDevelopmentPanelUi, updateSetting } from './appSettings';
import type { RawPointColor } from './rawApi';
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
const point = (hue = 42, overrides: Partial<RawPointColor> = {}): RawPointColor => ({ lum: 0.4, chroma: 0.15, hue,
  hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0, range: 50, hue_range: 50, sat_range: 50, lum_range: 50, ...overrides });
function createRaw(colors: ReturnType<typeof point>[] = []) {
  const identity = documentInfo();
  const settings = { ...rawSettings(identity), point_colors: colors };
  return { assetId: identity.assetId, status: 'ready', settings, history: {},
    pointColorPickActive: false, pointColorPickAvailable: colors.length < 8 && settings.sections.color,
    togglePointColorPick: vi.fn(), cancelPointColorPick: vi.fn(),
    operate: vi.fn(), beginControls: vi.fn(), changeControls: vi.fn(), flushControls: vi.fn(), desired: {} };
}
function draw(raw: ReturnType<typeof createRaw>, disabled = false) { act(() => root.render(<RawAdjustmentControls raw={raw as never} disabled={disabled} />)); }
function openPointColor() {
  const toggle = host.querySelector<HTMLButtonElement>('.raw-point-color-title')!;
  if (toggle.getAttribute('aria-expanded') !== 'true') act(() => toggle.click());
}
function swatches() { return [...host.querySelectorAll<HTMLButtonElement>('.raw-point-color-swatch')]; }
function pointColorAdjustments() { return [...host.querySelectorAll<HTMLElement>('.raw-point-color-adjustments .adjustment-control')]; }

it('shows an inactive eyedropper and localized prompt for an empty Point Color array', async () => {
  const raw = createRaw();
  await i18n.changeLanguage('ja');
  draw(raw);
  expect(host.querySelector('.raw-point-color')).not.toBeNull();
  expect(swatches()).toHaveLength(0);
  openPointColor();
  expect(host.textContent).toContain('スポイトで写真の色を選択してください。');
  expect(host.querySelector<HTMLButtonElement>('.raw-point-color-pick')?.disabled).toBe(false);
  expect(host.querySelector('.raw-point-color-content .adjustment-control')).toBeNull();
  await i18n.changeLanguage('en');
  draw(raw);
  expect(host.textContent).toContain('Use the eyedropper to pick a color from the photo.');
});

it('disables Point Color sampling at capacity, when Color is off, or while edits are locked', () => {
  const color = (index: number): RawPointColor => ({ lum: .5, chroma: .1, hue: index, hue_shift: 0, sat_shift: 0,
    lum_shift: 0, variance: 0, range: 50, hue_range: 50, sat_range: 50, lum_range: 50 });
  const seven = createRaw(Array.from({ length: 7 }, (_, index) => color(index)));
  draw(seven); openPointColor(); expect(host.querySelector<HTMLButtonElement>('.raw-point-color-pick')!.disabled).toBe(false);
  const eight = createRaw(Array.from({ length: 8 }, (_, index) => color(index)));
  draw(eight); openPointColor(); expect(host.querySelector<HTMLButtonElement>('.raw-point-color-pick')!.disabled).toBe(true);
  const colorOff = createRaw(); colorOff.settings.sections.color = false; colorOff.pointColorPickAvailable = false;
  draw(colorOff); openPointColor(); expect(host.querySelector<HTMLButtonElement>('.raw-point-color-pick')!.disabled).toBe(true);
  const unlocked = createRaw(); draw(unlocked, true); openPointColor();
  expect(host.querySelector<HTMLButtonElement>('.raw-point-color-pick')!.disabled).toBe(true);
});

it('toggles the Point Color sampling button state and cancels when the section closes', async () => {
  await i18n.changeLanguage('en');
  const raw = createRaw();
  draw(raw); openPointColor();
  const picker = host.querySelector<HTMLButtonElement>('.raw-point-color-pick')!;
  expect(picker.disabled).toBe(false);
  expect(picker.getAttribute('aria-pressed')).toBe('false');
  act(() => picker.click()); expect(raw.togglePointColorPick).toHaveBeenCalledOnce();
  raw.pointColorPickActive = true; draw(raw);
  expect(picker.getAttribute('aria-pressed')).toBe('true');
  expect(picker.title).toBe('Cancel Point Color picking');
  act(() => host.querySelector<HTMLButtonElement>('.raw-point-color-title')!.click());
  expect(raw.cancelPointColorPick).toHaveBeenCalledOnce();
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

it('renders each center color as CSS OkLCh and ignores Point Color adjustments', () => {
  const colors = [
    point(20, { lum: 0.3, chroma: 0.08, hue_shift: -80, sat_shift: 40 }),
    point(20, { lum: 0.3, chroma: 0.08, hue_shift: 80, sat_shift: -40 }),
    point(20, { lum: 0.65, chroma: 0.08 }),
    point(20, { lum: 0.3, chroma: 0.22 }),
    point(140, { lum: 0.3, chroma: 0.08 }),
  ];
  const raw = createRaw(colors);
  draw(raw); openPointColor();
  const buttons = swatches();
  const swatchColors = buttons.map(button => button.style.getPropertyValue('--point-color-swatch'));
  expect(swatchColors).toEqual([
    'oklch(0.3 0.08 20)', 'oklch(0.3 0.08 20)', 'oklch(0.65 0.08 20)',
    'oklch(0.3 0.22 20)', 'oklch(0.3 0.08 140)',
  ]);
  expect(swatchColors[0]).toBe(swatchColors[1]);
  expect(new Set(swatchColors).size).toBe(4);
  expect(buttons.map(button => button.dataset.pointColorIndex)).toEqual(['0', '1', '2', '3', '4']);
  expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
});

it('shows eight disabled controls in order with localized labels, Native ranges and rounded display text', async () => {
  await i18n.changeLanguage('ja');
  const selected = point(42, { hue_shift: -100, sat_shift: -12.75, lum_shift: 17.6, variance: 0,
    range: 25, hue_range: 50, sat_range: 75, lum_range: 100 });
  const raw = createRaw([selected]);
  draw(raw);
  const fields = ['hue_shift', 'sat_shift', 'lum_shift', 'variance', 'range', 'hue_range', 'sat_range', 'lum_range'];
  const labels = ['色相', '彩度', '輝度', 'ばらつき', '範囲', '色相範囲', '彩度範囲', '輝度範囲'];
  const ranges = [-100, -100, -100, -100, 0, 0, 0, 0];
  const maxima = [100, 100, 100, 100, 100, 100, 100, 100];
  const displayedValues = ['-100', '-13', '18', '0', '25', '50', '75', '100'];
  expect(pointColorAdjustments()).toHaveLength(0);
  openPointColor();
  const controls = pointColorAdjustments();
  expect(controls).toHaveLength(8);
  expect([...host.querySelector('.raw-point-color-content')!.children].map(element => element.className))
    .toEqual(['raw-point-color-empty', 'raw-point-color-swatches', 'raw-point-color-adjustments']);
  expect(controls.map(control => control.querySelector<HTMLInputElement>('.adjustment-range')?.dataset.adjustmentId))
    .toEqual(fields.map(field => `pointColor.0.${field}`));
  expect(controls.map(control => control.querySelector('label')?.textContent)).toEqual(labels);
  expect(controls.map(control => control.querySelector<HTMLInputElement>('.adjustment-range')?.min)).toEqual(ranges.map(String));
  expect(controls.map(control => control.querySelector<HTMLInputElement>('.adjustment-range')?.max)).toEqual(maxima.map(String));
  expect(controls.map(control => control.querySelector<HTMLInputElement>('.adjustment-range')?.step)).toEqual(Array(8).fill('1'));
  expect(controls.map(control => control.querySelector<HTMLInputElement>('.adjustment-number')?.value)).toEqual(displayedValues);
  expect(controls.every(control => control.querySelector<HTMLInputElement>('.adjustment-range')?.disabled
    && control.querySelector<HTMLInputElement>('.adjustment-number')?.disabled
    && control.querySelector<HTMLButtonElement>('.adjustment-reset')?.disabled)).toBe(true);
  expect(raw.settings.point_colors[0]).toEqual(selected);
  expect(raw.operate).not.toHaveBeenCalled();
  expect(raw.beginControls).not.toHaveBeenCalled();
  expect(raw.changeControls).not.toHaveBeenCalled();
  expect(raw.flushControls).not.toHaveBeenCalled();

  await i18n.changeLanguage('en'); draw(raw);
  expect(pointColorAdjustments().map(control => control.querySelector('label')?.textContent)).toEqual([
    'Hue', 'Saturation', 'Luminance', 'Variance', 'Range', 'Hue Range', 'Saturation Range', 'Luminance Range',
  ]);
});

it('switches read-only values with the selected swatch and follows array shrink and empty settings', () => {
  const raw = createRaw([point(10, { hue_shift: -25 }), point(200, { hue_shift: 65, range: 80 })]);
  draw(raw); openPointColor();
  expect(pointColorAdjustments().map(control => control.querySelector<HTMLInputElement>('.adjustment-number')?.value))
    .toEqual(['-25', '0', '0', '0', '50', '50', '50', '50']);
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('-25');
  act(() => swatches()[1].click());
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('65');
  expect(pointColorAdjustments()[4].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('80');

  raw.settings.point_colors = [point(10, { hue_shift: -25 })]; draw(raw);
  expect(swatches()[0].getAttribute('aria-pressed')).toBe('true');
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('-25');
  raw.settings.point_colors = []; draw(raw);
  expect(pointColorAdjustments()).toHaveLength(0);
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
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('0');
});
