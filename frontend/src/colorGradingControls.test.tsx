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
  it('renders below Color with Temperature followed by Tint', () => {
    expect(Array.from(host.querySelectorAll('.adjustment-category-label'), (item) => item.textContent))
      .toEqual(['White Balance', 'Basic', 'Color', 'Color Grading']);
    expect(grading().querySelector('.adjustment-subsection-title')?.textContent).toBe('Shadows');
    expect(Array.from(grading().querySelectorAll('label'), (item) => item.textContent)).toEqual(['Temperature', 'Tint']);
    for (const control of [slider(), slider(1)]) {
      expect([control.min, control.max, control.step, control.value]).toEqual(['-100', '100', '1', '0']);
      expect(control.classList.contains('has-gradient')).toBe(true);
    }
    expect(slider().style.getPropertyValue('--adjustment-track-gradient')).toBe(TEMPERATURE_TRACK_GRADIENT);
    expect(slider(1).style.getPropertyValue('--adjustment-track-gradient')).toBe(TINT_TRACK_GRADIENT);
    expect(Array.from(grading().querySelectorAll('.adjustment-unit'), (item) => item.textContent)).toEqual(['', '']);
  });

  it('localizes the Shadows section label in Japanese', async () => {
    await act(async () => i18n.changeLanguage('ja'));
    expect(grading().querySelector('.adjustment-subsection-title')?.textContent).toBe('シャドウ');
    expect(Array.from(grading().querySelectorAll('label'), (item) => item.textContent)).toEqual(['色温度', '色かぶり補正']);
    wheel(-1, false, slider(1));
    act(() => vi.advanceTimersByTime(500));
    expect(history()[0]).toBe('シャドウ 色かぶり補正 0 → +10');
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

  it('uses Shift+Arrow navigation between Temperature and Tint without changing values', () => {
    act(() => slider().focus());
    key('ArrowDown', slider(), { shiftKey: true });
    expect(document.activeElement).toBe(slider(1));
    key('ArrowUp', slider(1), { shiftKey: true });
    expect(document.activeElement).toBe(slider());
    expect(recipe().adjustments.shadowsTemperature).toBe(0);
    expect(recipe().adjustments.shadowsTint).toBe(0);
  });

  it('bypasses and disables both controls while preserving values across OFF/ON', () => {
    wheel(-1);
    wheel(1, false, slider(1));
    act(() => vi.advanceTimersByTime(500));

    click(grading().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(recipe().colorGradingEnabled).toBe(false);
    expect(recipe().adjustments.shadowsTemperature).toBe(10);
    expect(recipe().adjustments.shadowsTint).toBe(-10);
    expect(slider().disabled).toBe(true);
    expect(slider(1).disabled).toBe(true);
    expect(number(1).disabled).toBe(true);
    expect(wheel(-1, false, slider(1)).defaultPrevented).toBe(false);
    click(grading().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(recipe().colorGradingEnabled).toBe(true);
    expect([slider().value, slider(1).value]).toEqual(['10', '-10']);
  });

  it('resets both grading values as one operation and includes Tint in All Reset', () => {
    wheel(-1);
    wheel(-1, false, slider(1));
    act(() => vi.advanceTimersByTime(500));
    click(grading().querySelector<HTMLElement>('.adjustment-category-reset')!);
    expect(recipe().adjustments.shadowsTemperature).toBe(0);
    expect(recipe().adjustments.shadowsTint).toBe(0);
    expect(history()[0]).toBe('Reset Color Grading adjustments');
    click(Array.from(host.querySelectorAll('button')).find((item) => item.textContent === 'Undo')!);
    expect(recipe().adjustments.shadowsTemperature).toBe(10);
    expect(recipe().adjustments.shadowsTint).toBe(10);
    click(Array.from(host.querySelectorAll('button')).find((item) => item.textContent === 'Redo')!);
    expect(recipe().adjustments.shadowsTint).toBe(0);

    wheel(-1, false, slider(1));
    act(() => vi.advanceTimersByTime(500));
    click(host.querySelector<HTMLButtonElement>('.workspace-section-action')!);
    expect(recipe()).toEqual(expect.objectContaining({ version: 12, colorGradingEnabled: true }));
    expect(Object.values(recipe().adjustments).every((value) => value === 0)).toBe(true);
  });
});
