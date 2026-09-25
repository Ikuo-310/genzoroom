// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnshitsuPage } from './AnshitsuPage';
import type { EditRecipe } from './editing';
import i18n from './i18n';

const savedEdits = vi.hoisted(() => new Map<string, { state: unknown; revision: number; updatedAt: string; lastSaveId: string }>());
vi.mock('./editStateApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('./editStateApi')>(),
  getAssetEditState: vi.fn(async (id: string) => savedEdits.get(id) ?? { state: null }),
  putAssetEditState: vi.fn(async (id: string, state: unknown, revision: number, saveId: string) => {
    const result = { state, revision: revision + 1, updatedAt: '2026-09-25T00:00:00Z', lastSaveId: saveId };
    savedEdits.set(id, result); return result;
  }),
}));

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
const categories = () => host.querySelectorAll<HTMLElement>('.adjustment-category');
const color = () => categories()[2];
const slider = (index = 0) => color().querySelectorAll<HTMLInputElement>('input[type="range"]')[index]!;
const number = (index = 0) => color().querySelectorAll<HTMLInputElement>('input[type="number"]')[index]!;
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
  savedEdits.clear();
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

describe('production Color controls', () => {
  it('places Color below Basic and Vibrance above Saturation with unitless normal tracks', () => {
    expect(Array.from(host.querySelectorAll('.adjustment-category-label'), (item) => item.textContent))
      .toEqual(['White Balance', 'Basic', 'Color', 'Color Grading']);
    expect(Array.from(color().querySelectorAll('label'), (item) => item.textContent)).toEqual(['Vibrance', 'Saturation']);
    for (const control of [slider(), slider(1)]) {
      expect([control.min, control.max, control.step, control.value]).toEqual(['-100', '100', '1', '0']);
      expect(control.className).toBe('adjustment-range');
      expect(control.getAttribute('style')).toBeNull();
    }
    expect(Array.from(color().querySelectorAll('.adjustment-unit'), (item) => item.textContent)).toEqual(['', '']);
  });

  it('supports keyboard, wheel, Shift+wheel, direct input, inactivity commit, and individual Reset', () => {
    act(() => slider().focus());
    key('ArrowRight', slider());
    key('ArrowUp', slider());
    expect(wheel(1, true).defaultPrevented).toBe(true);
    expect(recipe().adjustments.vibrance).toBe(10);
    act(() => vi.advanceTimersByTime(500));
    expect(history()).toEqual(['Vibrance 0 → +10']);

    expect(wheel(-1).defaultPrevented).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    expect(recipe().adjustments.vibrance).toBe(20);
    act(() => number().focus());
    change(number(), '-25.6');
    key('Enter', number());
    expect(recipe().adjustments.vibrance).toBe(-26);
    expect(history()[0]).toBe('Vibrance +20 → -26');

    click(color().querySelector<HTMLElement>('.adjustment-reset')!);
    expect(recipe().adjustments.vibrance).toBe(0);
    expect(history()[0]).toBe('Vibrance Reset -26 → 0');
  });

  it('collapses independently and disables controls while preserving the value across OFF/ON', () => {
    wheel(-1);
    wheel(-1, false, slider(1));
    act(() => vi.advanceTimersByTime(500));
    click(color().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(recipe().colorEnabled).toBe(false);
    expect(recipe().adjustments.vibrance).toBe(10);
    expect(recipe().adjustments.saturation).toBe(10);
    expect(slider().disabled).toBe(true);
    expect(number().disabled).toBe(true);
    expect(slider(1).disabled).toBe(true);
    expect(number(1).disabled).toBe(true);
    expect(wheel(-1).defaultPrevented).toBe(false);
    expect(history()[0]).toBe('Color OFF');

    click(color().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(recipe().colorEnabled).toBe(true);
    expect(slider().value).toBe('10');
    expect(slider(1).value).toBe('10');
    const title = color().querySelector<HTMLElement>('.adjustment-category-title')!;
    click(title);
    expect(title.getAttribute('aria-expanded')).toBe('false');
    expect(color().querySelector('input')).toBeNull();
    click(title);
    expect(slider().value).toBe('10');
    expect(slider(1).value).toBe('10');
  });

  it('resets Color as one undoable operation and localizes its History', async () => {
    wheel(-1);
    wheel(-1, false, slider(1));
    act(() => vi.advanceTimersByTime(500));
    click(color().querySelector<HTMLElement>('.adjustment-category-reset')!);
    expect(recipe().adjustments.vibrance).toBe(0);
    expect(recipe().adjustments.saturation).toBe(0);
    expect(history()[0]).toBe('Reset Color adjustments');
    click(Array.from(host.querySelectorAll('button')).find((item) => item.textContent === 'Undo')!);
    expect(recipe().adjustments.vibrance).toBe(10);
    expect(recipe().adjustments.saturation).toBe(10);
    click(Array.from(host.querySelectorAll('button')).find((item) => item.textContent === 'Redo')!);
    expect(recipe().adjustments.vibrance).toBe(0);
    expect(recipe().adjustments.saturation).toBe(0);

    await act(async () => { await i18n.changeLanguage('ja'); });
    click(color().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(history()[0]).toBe('色補正 OFF');
    expect(Array.from(color().querySelectorAll('label'), (item) => item.textContent)).toEqual(['自然な彩度', '彩度']);
    click(color().querySelector<HTMLElement>('[aria-pressed]')!);
    wheel(-1);
    act(() => vi.advanceTimersByTime(500));
    expect(history()[0]).toBe('自然な彩度 0 → +10');
  });
});
