// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { RawAdjustmentControls } from './RawAdjustmentControls';
import { RAW_DEVELOPMENT_PANEL_UI_KEY, defaultRawDevelopmentPanelUi, updateSetting } from './appSettings';
import type { RawPointColor } from './rawApi';
import { rawSettings } from './test/rawSettings';
import { sliderAdjustmentId } from './adjustmentSliderIds';

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
    operationError: undefined as string | undefined,
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

it('shows eight editable controls in order with localized labels, Native ranges and rounded display text', async () => {
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
  const controlIds = ['hueShift', 'satShift', 'lumShift', 'variance', 'range', 'hueRange', 'satRange', 'lumRange'];
  expect(controls.map(control => control.querySelector<HTMLInputElement>('.adjustment-range')?.dataset.adjustmentId))
    .toEqual(controlIds.map(field => `pointColor.0.${field}`));
  expect(controlIds.map(field => sliderAdjustmentId(`pointColor.0.${field}`)))
    .toEqual(controlIds.map(field => `pointColor.0.${field}`));
  expect(sliderAdjustmentId('pointColor.8.range')).toBeNull();
  expect(sliderAdjustmentId('pointColor.0.hue_shift')).toBeNull();
  expect(controls.map(control => control.querySelector('label')?.textContent)).toEqual(labels);
  expect(controls.map(control => control.querySelector<HTMLInputElement>('.adjustment-range')?.min)).toEqual(ranges.map(String));
  expect(controls.map(control => control.querySelector<HTMLInputElement>('.adjustment-range')?.max)).toEqual(maxima.map(String));
  expect(controls.map(control => control.querySelector<HTMLInputElement>('.adjustment-range')?.step)).toEqual(Array(8).fill('1'));
  expect(controls.map(control => control.querySelector<HTMLInputElement>('.adjustment-number')?.value)).toEqual(displayedValues);
  expect(controls.every(control => !control.querySelector<HTMLInputElement>('.adjustment-range')?.disabled
    && !control.querySelector<HTMLInputElement>('.adjustment-number')?.disabled)).toBe(true);
  expect(controls.map(control => control.querySelector<HTMLButtonElement>('.adjustment-reset')?.disabled))
    .toEqual([false, false, false, true, false, true, false, false]);
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

it.each([
  ['hue_shift', 'hueShift', -88], ['sat_shift', 'satShift', 72], ['lum_shift', 'lumShift', -31],
  ['variance', 'variance', 19], ['range', 'range', 25], ['hue_range', 'hueRange', 36],
  ['sat_range', 'satRange', 64], ['lum_range', 'lumRange', 91],
] as const)('commits %s through one indexed History operation', (field, controlField, value) => {
  const raw = createRaw([point(42)]);
  draw(raw); openPointColor();
  const index = ['hue_shift', 'sat_shift', 'lum_shift', 'variance', 'range', 'hue_range', 'sat_range', 'lum_range'].indexOf(field);
  const number = pointColorAdjustments()[index].querySelector<HTMLInputElement>('.adjustment-number')!;
  act(() => {
    number.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(number, String(value));
    number.dispatchEvent(new Event('input', { bubbles: true }));
    number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(raw.operate).toHaveBeenCalledOnce();
  expect(raw.operate).toHaveBeenCalledWith({ kind: 'pointColorControl', metadata: {
    control: `pointColor.0.${controlField}`, value,
  } });
  expect(raw.settings.point_colors[0][field]).toBe(['range', 'hue_range', 'sat_range', 'lum_range'].includes(field) ? 50 : 0);
  expect(pointColorAdjustments()[index].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe(String(value));
});

it.each([
  ['hue_shift', 'hueShift', 0, 23], ['sat_shift', 'satShift', 1, -17], ['lum_shift', 'lumShift', 2, 38],
  ['variance', 'variance', 3, -42], ['range', 'range', 4, 20], ['hue_range', 'hueRange', 5, 25],
  ['sat_range', 'satRange', 6, 75], ['lum_range', 'lumRange', 7, 80],
] as const)('resets selected Point Color %s through History control %s', (field, controlField, index, changed) => {
  const first = point(10, { [field]: changed } as Partial<RawPointColor>);
  const second = point(200, { [field]: changed } as Partial<RawPointColor>);
  const raw = createRaw([first, second]);
  draw(raw); openPointColor(); act(() => swatches()[1].click());
  const control = pointColorAdjustments()[index];
  const reset = control.querySelector<HTMLButtonElement>('.adjustment-reset')!;
  expect(reset.disabled).toBe(false);
  act(() => reset.click());
  expect(raw.operate).toHaveBeenCalledOnce();
  expect(raw.operate).toHaveBeenCalledWith({ kind: 'pointColorControlReset', metadata: {
    control: `pointColor.1.${controlField}`,
  } });
  expect(raw.settings.point_colors).toEqual([first, second]);
});

it('cancels an unfinished numeric draft before resetting and waits for confirmed settings', () => {
  const raw = createRaw([point(42, { hue_shift: 21 })]);
  draw(raw); openPointColor();
  const control = pointColorAdjustments()[0];
  const number = control.querySelector<HTMLInputElement>('.adjustment-number')!;
  act(() => {
    number.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(number, '67');
    number.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(number.value).toBe('67');
  act(() => control.querySelector<HTMLButtonElement>('.adjustment-reset')!.click());
  expect(raw.operate).toHaveBeenCalledOnce();
  expect(raw.operate).toHaveBeenCalledWith({ kind: 'pointColorControlReset', metadata: {
    control: 'pointColor.0.hueShift',
  } });
  expect(raw.settings.point_colors[0].hue_shift).toBe(21);
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('21');

  raw.settings = { ...raw.settings, revision: raw.settings.revision + 1,
    point_colors: [{ ...raw.settings.point_colors[0], hue_shift: 0 }] };
  draw(raw);
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('0');
});

it('cancels an active slider drag when its Reset button becomes the pointer target', () => {
  const raw = createRaw([point(42, { hue_shift: 21 })]);
  draw(raw); openPointColor();
  const control = pointColorAdjustments()[0];
  const range = control.querySelector<HTMLInputElement>('.adjustment-range')!;
  const reset = control.querySelector<HTMLButtonElement>('.adjustment-reset')!;
  act(() => {
    range.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { button: 0 }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, '67');
    range.dispatchEvent(new Event('input', { bubbles: true }));
    reset.dispatchEvent(new Event('pointerup', { bubbles: true }));
  });
  act(() => reset.click());
  expect(raw.operate).toHaveBeenCalledOnce();
  expect(raw.operate).toHaveBeenCalledWith({ kind: 'pointColorControlReset', metadata: {
    control: 'pointColor.0.hueShift',
  } });
});

it('discards another Point Color field draft before Reset and never sends that draft later', () => {
  const raw = createRaw([point(42, { hue_shift: 21, range: 80 })]);
  draw(raw); openPointColor();
  const hue = pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')!;
  act(() => {
    hue.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(hue, '67');
    hue.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => pointColorAdjustments()[4].querySelector<HTMLButtonElement>('.adjustment-reset')!.click());
  expect(raw.operate).toHaveBeenCalledOnce();
  expect(raw.operate).toHaveBeenCalledWith({ kind: 'pointColorControlReset', metadata: { control: 'pointColor.0.range' } });
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('21');
  expect(pointColorAdjustments()[4].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('80');
});

it('cancels a drag on one Point Color field when Reset is released on another field', () => {
  const raw = createRaw([point(42, { hue_shift: 21, range: 80 })]);
  draw(raw); openPointColor();
  const hue = pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-range')!;
  const resetRange = pointColorAdjustments()[4].querySelector<HTMLButtonElement>('.adjustment-reset')!;
  act(() => {
    hue.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { button: 0 }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(hue, '67');
    hue.dispatchEvent(new Event('input', { bubbles: true }));
    resetRange.dispatchEvent(new Event('pointerup', { bubbles: true }));
  });
  act(() => resetRange.click());
  expect(raw.operate).toHaveBeenCalledOnce();
  expect(raw.operate).toHaveBeenCalledWith({ kind: 'pointColorControlReset', metadata: { control: 'pointColor.0.range' } });
});

it('keeps Point Color Reset disabled for defaults, locked edits, and Color off', () => {
  const normal = createRaw([point()]);
  draw(normal); openPointColor();
  expect(pointColorAdjustments().every(control => control.querySelector<HTMLButtonElement>('.adjustment-reset')?.disabled)).toBe(true);
  const colorOff = createRaw([point(42, { hue_shift: 15 })]);
  colorOff.settings.sections.color = false;
  draw(colorOff); openPointColor();
  expect(pointColorAdjustments()[0].querySelector<HTMLButtonElement>('.adjustment-reset')?.disabled).toBe(true);
  const locked = createRaw([point(42, { hue_shift: 15 })]);
  draw(locked, true); openPointColor();
  expect(pointColorAdjustments()[0].querySelector<HTMLButtonElement>('.adjustment-reset')?.disabled).toBe(true);
});

it('does not optimistically reset values when the History operation fails', () => {
  const raw = createRaw([point(42, { range: 80 })]);
  draw(raw); openPointColor();
  act(() => pointColorAdjustments()[4].querySelector<HTMLButtonElement>('.adjustment-reset')!.click());
  expect(raw.operate).toHaveBeenCalledWith({ kind: 'pointColorControlReset', metadata: { control: 'pointColor.0.range' } });
  raw.operationError = 'raw_connection_failed'; draw(raw);
  expect(pointColorAdjustments()[4].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('80');
});

it('groups slider drag changes until pointer release and applies them to the captured selected index', () => {
  const raw = createRaw([point(10), point(200)]);
  draw(raw); openPointColor(); act(() => swatches()[1].click());
  const range = pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-range')!;
  act(() => {
    range.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { button: 0 }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, '-12');
    range.dispatchEvent(new Event('input', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, '37');
    range.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(raw.operate).not.toHaveBeenCalled();
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('37');
  act(() => window.dispatchEvent(new Event('pointerup')));
  expect(raw.operate).toHaveBeenCalledOnce();
  expect(raw.operate).toHaveBeenCalledWith({ kind: 'pointColorControl', metadata: {
    control: 'pointColor.1.hueShift', value: 37,
  } });
  raw.settings = { ...raw.settings, revision: raw.settings.revision + 1,
    point_colors: [raw.settings.point_colors[0], { ...raw.settings.point_colors[1], hue_shift: 37 }] };
  draw(raw);
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('37');
});

it('groups keyboard and wheel changes at the operation boundary before changing swatches', () => {
  const raw = createRaw([point(10), point(200)]);
  draw(raw); openPointColor();
  const range = pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-range')!;
  act(() => range.focus());
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('1');
  expect(raw.operate).not.toHaveBeenCalled();
  act(() => range.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true })));
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('11');
  expect(raw.operate).not.toHaveBeenCalled();
  act(() => swatches()[1].click());
  expect(raw.operate).toHaveBeenCalledOnce();
  expect(raw.operate).toHaveBeenCalledWith({ kind: 'pointColorControl', metadata: {
    control: 'pointColor.0.hueShift', value: 11,
  } });
});

it('commits the old index before swatch selection and does not apply stale edits after Document or revision changes', () => {
  const raw = createRaw([point(10), point(200)]);
  draw(raw); openPointColor();
  const range = pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-range')!;
  act(() => {
    range.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { button: 0 }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, '24');
    range.dispatchEvent(new Event('input', { bubbles: true }));
    swatches()[1].click();
  });
  expect(raw.operate).toHaveBeenCalledWith({ kind: 'pointColorControl', metadata: { control: 'pointColor.0.hueShift', value: 24 } });

  raw.operate.mockClear();
  const nextRange = pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-range')!;
  act(() => {
    nextRange.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { button: 0 }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nextRange, '63');
    nextRange.dispatchEvent(new Event('input', { bubbles: true }));
    raw.settings = { ...raw.settings, revision: raw.settings.revision + 1 };
  });
  draw(raw);
  act(() => window.dispatchEvent(new Event('pointerup')));
  expect(raw.operate).not.toHaveBeenCalled();
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('0');

  const documentRange = pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-range')!;
  act(() => {
    documentRange.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { button: 0 }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(documentRange, '48');
    documentRange.dispatchEvent(new Event('input', { bubbles: true }));
    const next = documentInfo('asset-b', 'b');
    raw.assetId = next.assetId;
    raw.settings = { ...rawSettings(next), point_colors: [point(10), point(200)] };
  });
  draw(raw);
  act(() => window.dispatchEvent(new Event('pointerup')));
  expect(raw.operate).not.toHaveBeenCalled();
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('0');
});

it('discards an unconfirmed slider value when History reports a save error', () => {
  const raw = createRaw([point()]);
  draw(raw); openPointColor();
  const number = pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')!;
  act(() => {
    number.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(number, '54');
    number.dispatchEvent(new Event('input', { bubbles: true }));
    number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('54');
  raw.operationError = 'raw_connection_failed'; draw(raw);
  expect(pointColorAdjustments()[0].querySelector<HTMLInputElement>('.adjustment-number')?.value).toBe('0');
});

it('keeps Point Color controls disabled when Color is off or editing is locked', () => {
  const raw = createRaw([point()]);
  raw.settings.sections.color = false;
  draw(raw); openPointColor();
  expect(pointColorAdjustments().every(control => control.querySelector<HTMLInputElement>('.adjustment-range')?.disabled)).toBe(true);
  raw.settings.sections.color = true;
  draw(raw, true);
  expect(pointColorAdjustments().every(control => control.querySelector<HTMLInputElement>('.adjustment-range')?.disabled)).toBe(true);
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
