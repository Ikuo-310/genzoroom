// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnshitsuPage } from './AnshitsuPage';
import type { EditRecipe } from './editing';
import i18n from './i18n';
import { TEMPERATURE_TRACK_GRADIENT, TINT_TRACK_GRADIENT } from './WhiteBalanceAdjustmentControls';

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  fetchAssetDetail: vi.fn(async (id: string) => ({
    id, filename: `${id}.jpg`, date: '2026-09-17T00:00:00Z', format: 'JPEG', is_raw: false,
    preview_url: `/preview/${id}`, thumbnail_url: `/thumbnail/${id}`, exif: {},
  })),
}));
vi.mock('./ImageViewer', () => ({
  ImageViewer: ({ recipe }: { recipe: EditRecipe }) => <pre data-recipe>{JSON.stringify(recipe)}</pre>,
}));

let host: HTMLDivElement;
let root: Root;
const recipe = (): EditRecipe => JSON.parse(host.querySelector('[data-recipe]')!.textContent!);
const grading = () => host.querySelectorAll<HTMLElement>('.adjustment-category')[3];
const slider = (index = 0) => grading().querySelectorAll<HTMLInputElement>('input[type="range"]')[index]!;
const number = (index = 0) => grading().querySelectorAll<HTMLInputElement>('input[type="number"]')[index]!;
const history = () => Array.from(host.querySelectorAll('.edit-history li'), (item) => item.textContent);
function click(element: HTMLElement) { act(() => element.click()); }
function key(value: string, target: EventTarget, init: KeyboardEventInit = {}) {
  act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init })));
}
function wheel(deltaY: number, shiftKey = false, target = slider()) {
  const event = new WheelEvent('wheel', { deltaY, shiftKey, bubbles: true, cancelable: true });
  act(() => target.dispatchEvent(event));
  return event;
}
function change(target: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[{ pathname: '/anshitsu/a', state: {
      selectedAssets: [{ id: 'a', filename: 'a.jpg', date: '2026-09-17T00:00:00Z', format: 'JPEG', is_raw: false, thumbnail_url: '/thumbnail/a' }],
      activeAssetId: 'a',
    } }]}><Routes><Route path="/anshitsu/:assetId" element={<AnshitsuPage />} /></Routes></MemoryRouter>,
  ));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Color Grading controls', () => {
  it('renders Shadows and Midtones Temperature/Tint, then Highlights Temperature', () => {
    expect(Array.from(host.querySelectorAll('.adjustment-category-label'), (item) => item.textContent))
      .toEqual(['White Balance', 'Basic', 'Color', 'Color Grading']);
    expect(Array.from(grading().querySelectorAll('.adjustment-subsection-title'), (item) => item.textContent)).toEqual(['Shadows', 'Midtones', 'Highlights']);
    expect(Array.from(grading().querySelectorAll('label'), (item) => item.textContent)).toEqual(['Temperature', 'Tint', 'Temperature', 'Tint', 'Temperature']);
    for (const control of [slider(), slider(1), slider(2), slider(3), slider(4)]) {
      expect([control.min, control.max, control.step, control.value]).toEqual(['-100', '100', '1', '0']);
      expect(control.classList.contains('has-gradient')).toBe(true);
    }
    expect(slider().style.getPropertyValue('--adjustment-track-gradient')).toBe(TEMPERATURE_TRACK_GRADIENT);
    expect(slider(1).style.getPropertyValue('--adjustment-track-gradient')).toBe(TINT_TRACK_GRADIENT);
    expect(slider(2).style.getPropertyValue('--adjustment-track-gradient')).toBe(TEMPERATURE_TRACK_GRADIENT);
    expect(slider(3).style.getPropertyValue('--adjustment-track-gradient')).toBe(TINT_TRACK_GRADIENT);
    expect(slider(4).style.getPropertyValue('--adjustment-track-gradient')).toBe(TEMPERATURE_TRACK_GRADIENT);
    expect(Array.from(grading().querySelectorAll('.adjustment-unit'), (item) => item.textContent)).toEqual(['', '', '', '', '']);
  });

  it('localizes the Shadows section label in Japanese', async () => {
    await act(async () => i18n.changeLanguage('ja'));
    expect(Array.from(grading().querySelectorAll('.adjustment-subsection-title'), (item) => item.textContent)).toEqual(['シャドウ', '中間調', 'ハイライト']);
    expect(Array.from(grading().querySelectorAll('label'), (item) => item.textContent)).toEqual(['色温度', '色かぶり補正', '色温度', '色かぶり補正', '色温度']);
    wheel(-1, false, slider(1));
    act(() => vi.advanceTimersByTime(500));
    expect(history()[0]).toBe('シャドウ 色かぶり補正 0 → +10');
    wheel(-1, false, slider(2));
    act(() => vi.advanceTimersByTime(500));
    expect(history()[0]).toBe('中間調 色温度 0 → +10');
    wheel(-1, false, slider(3));
    act(() => vi.advanceTimersByTime(500));
    expect(history()[0]).toBe('中間調 色かぶり補正 0 → +10');
    wheel(-1, false, slider(4));
    act(() => vi.advanceTimersByTime(500));
    expect(history()[0]).toBe('ハイライト 色温度 0 → +10');
  });

  it('supports Highlights Temperature keyboard, wheel, direct input, grouped commit, and Reset', () => {
    act(() => slider(4).focus());
    key('ArrowRight', slider(4));
    key('ArrowUp', slider(4));
    expect(wheel(1, true, slider(4)).defaultPrevented).toBe(true);
    expect(recipe().adjustments.highlightsTemperature).toBe(10);
    expect(history()).toEqual([]);
    act(() => vi.advanceTimersByTime(500));
    expect(history()).toEqual(['Highlights Temperature 0 → +10']);
    expect(wheel(-1, false, slider(4)).defaultPrevented).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    expect(recipe().adjustments.highlightsTemperature).toBe(20);
    act(() => number(4).focus());
    change(number(4), '-25.6');
    key('Enter', number(4));
    expect(recipe().adjustments.highlightsTemperature).toBe(-26);
    expect(history()[0]).toBe('Highlights Temperature +20 → -26');
    click(grading().querySelectorAll<HTMLElement>('.adjustment-reset')[4]);
    expect(recipe().adjustments.highlightsTemperature).toBe(0);
    expect(history()[0]).toBe('Highlights Temperature Reset -26 → 0');
  });

  it('supports Midtones Tint keyboard, wheel, direct input, grouped commit, and Reset', () => {
    act(() => slider(3).focus());
    key('ArrowRight', slider(3));
    key('ArrowUp', slider(3));
    expect(wheel(1, true, slider(3)).defaultPrevented).toBe(true);
    expect(recipe().adjustments.midtonesTint).toBe(10);
    expect(history()).toEqual([]);
    act(() => vi.advanceTimersByTime(500));
    expect(history()).toEqual(['Midtones Tint 0 → +10']);
    expect(wheel(-1, false, slider(3)).defaultPrevented).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    expect(recipe().adjustments.midtonesTint).toBe(20);
    act(() => number(3).focus());
    change(number(3), '-25.6');
    key('Enter', number(3));
    expect(recipe().adjustments.midtonesTint).toBe(-26);
    expect(history()[0]).toBe('Midtones Tint +20 → -26');
    click(grading().querySelectorAll<HTMLElement>('.adjustment-reset')[3]);
    expect(recipe().adjustments.midtonesTint).toBe(0);
    expect(history()[0]).toBe('Midtones Tint Reset -26 → 0');
  });

  it('supports Midtones keyboard, wheel, direct input, pending commit, and individual Reset', () => {
    act(() => slider(2).focus());
    key('ArrowRight', slider(2));
    key('ArrowUp', slider(2));
    expect(recipe().adjustments.midtonesTemperature).toBe(11);
    expect(wheel(1, true, slider(2)).defaultPrevented).toBe(true);
    expect(recipe().adjustments.midtonesTemperature).toBe(10);
    expect(history()).toEqual([]);
    act(() => vi.advanceTimersByTime(500));
    expect(history()[0]).toBe('Midtones Temperature 0 → +10');
    expect(wheel(-1, false, slider(2)).defaultPrevented).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    expect(recipe().adjustments.midtonesTemperature).toBe(20);
    act(() => number(2).focus());
    change(number(2), '-25.6');
    key('Enter', number(2));
    expect(recipe().adjustments.midtonesTemperature).toBe(-26);
    expect(history()[0]).toBe('Midtones Temperature +20 → -26');
    click(grading().querySelectorAll<HTMLElement>('.adjustment-reset')[2]);
    expect(recipe().adjustments.midtonesTemperature).toBe(0);
    expect(history()[0]).toBe('Midtones Temperature Reset -26 → 0');
  });

  it('supports Tint keyboard, wheel, direct input, pending commit, and individual Reset', () => {
    act(() => slider(1).focus());
    key('ArrowRight', slider(1));
    key('ArrowUp', slider(1));
    expect(wheel(1, true, slider(1)).defaultPrevented).toBe(true);
    expect(recipe().adjustments.shadowsTint).toBe(10);
    act(() => vi.advanceTimersByTime(500));
    expect(history()).toEqual(['Shadows Tint 0 → +10']);

    expect(wheel(-1, false, slider(1)).defaultPrevented).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    expect(recipe().adjustments.shadowsTint).toBe(20);
    act(() => number(1).focus());
    change(number(1), '-25.6');
    key('Enter', number(1));
    expect(recipe().adjustments.shadowsTint).toBe(-26);
    expect(history()[0]).toBe('Shadows Tint +20 → -26');
    click(grading().querySelectorAll<HTMLElement>('.adjustment-reset')[1]);
    expect(recipe().adjustments.shadowsTint).toBe(0);
    expect(history()[0]).toBe('Shadows Tint Reset -26 → 0');
  });

  it('uses Shift+Arrow navigation in DOM order through Midtones without changing values', () => {
    act(() => slider().focus());
    key('ArrowDown', slider(), { shiftKey: true });
    expect(document.activeElement).toBe(slider(1));
    key('ArrowDown', slider(1), { shiftKey: true });
    expect(document.activeElement).toBe(slider(2));
    key('ArrowDown', slider(2), { shiftKey: true });
    expect(document.activeElement).toBe(slider(3));
    key('ArrowDown', slider(3), { shiftKey: true });
    expect(document.activeElement).toBe(slider(4));
    key('ArrowUp', slider(4), { shiftKey: true });
    expect(document.activeElement).toBe(slider(3));
    key('ArrowUp', slider(3), { shiftKey: true });
    expect(document.activeElement).toBe(slider(2));
    key('ArrowUp', slider(2), { shiftKey: true });
    expect(document.activeElement).toBe(slider(1));
    key('ArrowUp', slider(1), { shiftKey: true });
    expect(document.activeElement).toBe(slider());
    expect(recipe().adjustments.shadowsTemperature).toBe(0);
    expect(recipe().adjustments.shadowsTint).toBe(0);
    expect(recipe().adjustments.midtonesTemperature).toBe(0);
    expect(recipe().adjustments.midtonesTint).toBe(0);
    expect(recipe().adjustments.highlightsTemperature).toBe(0);
  });

  it('skips disabled and collapsed grading sliders during Shift+Arrow navigation', () => {
    const colorLast = host.querySelectorAll<HTMLElement>('.adjustment-category')[2]
      .querySelectorAll<HTMLInputElement>('input[type="range"]')[1];
    act(() => colorLast.focus());
    click(grading().querySelector<HTMLElement>('[aria-pressed]')!);
    key('ArrowDown', colorLast, { shiftKey: true });
    expect(document.activeElement).toBe(colorLast);
    click(grading().querySelector<HTMLElement>('[aria-pressed]')!);
    click(grading().querySelector<HTMLElement>('.adjustment-category-title')!);
    key('ArrowDown', colorLast, { shiftKey: true });
    expect(document.activeElement).toBe(colorLast);
    click(grading().querySelector<HTMLElement>('.adjustment-category-title')!);
    key('ArrowDown', colorLast, { shiftKey: true });
    expect(document.activeElement).toBe(slider());
  });

  it('bypasses and disables all five controls while preserving values across OFF/ON', () => {
    wheel(-1);
    wheel(1, false, slider(1));
    wheel(-1, false, slider(2));
    wheel(1, false, slider(3));
    wheel(-1, false, slider(4));
    act(() => vi.advanceTimersByTime(500));

    click(grading().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(recipe().colorGradingEnabled).toBe(false);
    expect(recipe().adjustments.shadowsTemperature).toBe(10);
    expect(recipe().adjustments.shadowsTint).toBe(-10);
    expect(recipe().adjustments.midtonesTemperature).toBe(10);
    expect(recipe().adjustments.midtonesTint).toBe(-10);
    expect(recipe().adjustments.highlightsTemperature).toBe(10);
    expect(slider().disabled).toBe(true);
    expect(slider(1).disabled).toBe(true);
    expect(slider(2).disabled).toBe(true);
    expect(slider(3).disabled).toBe(true);
    expect(slider(4).disabled).toBe(true);
    expect(number(1).disabled).toBe(true);
    expect(wheel(-1, false, slider(1)).defaultPrevented).toBe(false);
    click(grading().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(recipe().colorGradingEnabled).toBe(true);
    expect([slider().value, slider(1).value, slider(2).value, slider(3).value, slider(4).value]).toEqual(['10', '-10', '10', '-10', '10']);
  });

  it('resets all five grading values as one operation and includes Highlights in All Reset', () => {
    wheel(-1);
    wheel(-1, false, slider(1));
    wheel(-1, false, slider(2));
    wheel(-1, false, slider(3));
    wheel(-1, false, slider(4));
    act(() => vi.advanceTimersByTime(500));
    click(grading().querySelector<HTMLElement>('.adjustment-category-reset')!);
    expect(recipe().adjustments.shadowsTemperature).toBe(0);
    expect(recipe().adjustments.shadowsTint).toBe(0);
    expect(recipe().adjustments.midtonesTemperature).toBe(0);
    expect(recipe().adjustments.midtonesTint).toBe(0);
    expect(recipe().adjustments.highlightsTemperature).toBe(0);
    expect(history()[0]).toBe('Reset Color Grading adjustments');
    click(Array.from(host.querySelectorAll('button')).find((item) => item.textContent === 'Undo')!);
    expect(recipe().adjustments.shadowsTemperature).toBe(10);
    expect(recipe().adjustments.shadowsTint).toBe(10);
    expect(recipe().adjustments.midtonesTemperature).toBe(10);
    expect(recipe().adjustments.midtonesTint).toBe(10);
    expect(recipe().adjustments.highlightsTemperature).toBe(10);
    click(Array.from(host.querySelectorAll('button')).find((item) => item.textContent === 'Redo')!);
    expect(recipe().adjustments.shadowsTint).toBe(0);

    wheel(-1, false, slider(4));
    act(() => vi.advanceTimersByTime(500));
    click(host.querySelector<HTMLButtonElement>('.workspace-section-action')!);
    expect(recipe()).toEqual(expect.objectContaining({ version: 15, colorGradingEnabled: true }));
    expect(Object.values(recipe().adjustments).every((value) => value === 0)).toBe(true);
  });
});
