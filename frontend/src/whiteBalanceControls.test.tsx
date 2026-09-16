// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnshitsuPage } from './AnshitsuPage';
import { type EditRecipe } from './editing';
import { TEMPERATURE_TRACK_GRADIENT } from './WhiteBalanceAdjustmentControls';
import i18n from './i18n';

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  fetchAssetDetail: vi.fn(async (id: string) => ({
    id, filename: id + '.jpg', date: '2026-09-16T00:00:00Z', format: 'JPEG', is_raw: false,
    preview_url: '/preview/' + id, thumbnail_url: '/thumbnail/' + id, exif: {},
  })),
}));
vi.mock('./ImageViewer', () => ({
  ImageViewer: ({ recipe }: { recipe: EditRecipe }) => <pre data-recipe>{JSON.stringify(recipe)}</pre>,
}));

let host: HTMLDivElement;
let root: Root;
const recipe = (): EditRecipe => JSON.parse(host.querySelector('[data-recipe]')!.textContent!);
const category = (index = 0) => host.querySelectorAll<HTMLElement>('.adjustment-category')[index];
const slider = (index = 0) => category(index).querySelector<HTMLInputElement>('input[type="range"]')!;
const number = () => category().querySelector<HTMLInputElement>('input[type="number"]')!;
const history = () => Array.from(host.querySelectorAll('.edit-history li'), item => item.textContent);
function click(element: HTMLElement) { act(() => element.click()); }
function key(value: string, target: EventTarget = slider(), init: KeyboardEventInit = {}) {
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
function pointer(type: string, target: EventTarget = slider()) {
  act(() => target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 })));
}
function advance(ms = 500) { act(() => vi.advanceTimersByTime(ms)); }
function button(text: string) { return Array.from(host.querySelectorAll('button')).find(item => item.textContent === text)!; }
async function mount() {
  const selectedAssets = ['a', 'b'].map(id => ({
    id, filename: id + '.jpg', date: '2026-09-16T00:00:00Z', format: 'JPEG', is_raw: false, thumbnail_url: '/thumbnail/' + id,
  }));
  await act(async () => root.render(<MemoryRouter initialEntries={[{
    pathname: '/anshitsu/a', state: { selectedAssets, activeAssetId: 'a' },
  }]}><Routes><Route path="/anshitsu/:assetId" element={<AnshitsuPage />} /></Routes></MemoryRouter>));
}
beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await mount();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('production White Balance controls', () => {
  it('places only White Balance above Basic, expanded, with integer unitless Temperature and opt-in gradient', () => {
    expect(Array.from(host.querySelectorAll('.adjustment-category-label'), item => item.textContent)).toEqual(['White Balance', 'Basic']);
    expect(category().querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    expect(category().querySelectorAll('.adjustment-category-actions > button')).toHaveLength(2);
    expect(category().querySelector('.adjustment-category-chevron')?.getAttribute('aria-hidden')).toBe('true');
    for (const title of host.querySelectorAll<HTMLButtonElement>('.adjustment-category-title')) {
      expect(title.disabled).toBe(false);
      expect(title.hasAttribute('title')).toBe(false);
      expect(title.getAttribute('aria-label')).toMatch(/^Collapse /);
      expect(title.firstElementChild?.className).toBe('adjustment-category-chevron');
      expect(title.firstElementChild?.textContent).toBe('▾');
    }
    expect([slider().min, slider().max, slider().step, slider().value]).toEqual(['-100', '100', '1', '0']);
    expect(category().querySelector('label')?.textContent).toBe('Temperature');
    expect(category().querySelector('.adjustment-unit')?.textContent).toBe('');
    expect(slider().style.getPropertyValue('--adjustment-track-gradient')).toBe(TEMPERATURE_TRACK_GRADIENT);
    expect(slider().classList.contains('has-gradient')).toBe(true);
    const basics = category(1).querySelectorAll<HTMLInputElement>('input[type="range"]');
    expect(basics).toHaveLength(6);
    for (const item of basics) {
      expect(item.className).toBe('adjustment-range');
      expect(item.getAttribute('style')).toBeNull();
    }
  });
  it('keeps Temperature drag pending until pointer release', () => {
    pointer('pointerdown');
    change(slider(), '-25');
    advance(1000);
    expect(recipe().adjustments.temperature).toBe(-25);
    expect(history()).toHaveLength(0);
    change(slider(), '-50');
    pointer('pointerup', window);
    expect(history()).toEqual(['Temperature 0 → -50']);
  });
  it('uses arrow steps and coalesces for 500ms inactivity with Undo/Redo', () => {
    act(() => slider().focus());
    key('ArrowRight');
    key('ArrowUp');
    key('ArrowLeft');
    expect(recipe().adjustments.temperature).toBe(10);
    advance(499);
    expect(history()).toHaveLength(0);
    key('ArrowDown');
    key('ArrowLeft');
    advance();
    expect(history()).toEqual(['Temperature 0 → -1']);
    click(button('Undo'));
    expect(recipe().adjustments.temperature).toBe(0);
    click(button('Redo'));
    expect(recipe().adjustments.temperature).toBe(-1);
  });
  it('uses wheel ten steps and Shift+wheel one step in a single pending operation', () => {
    expect(wheel(-1).defaultPrevented).toBe(true);
    expect(recipe().adjustments.temperature).toBe(10);
    advance(300);
    wheel(-120, true);
    expect(recipe().adjustments.temperature).toBe(11);
    wheel(1);
    wheel(1, true);
    expect(recipe().adjustments.temperature).toBe(0);
    wheel(1, true);
    advance(499);
    expect(history()).toHaveLength(0);
    advance(1);
    expect(history()).toEqual(['Temperature 0 → -1']);
  });
  it('normalizes direct input and supports Enter, blur, Escape, and individual Reset', () => {
    act(() => number().focus());
    change(number(), '-25.6');
    expect(recipe().adjustments.temperature).toBe(-26);
    key('Enter', number());
    expect(history()).toEqual(['Temperature 0 → -26']);
    change(number(), '200');
    expect(recipe().adjustments.temperature).toBe(100);
    act(() => number().blur());
    expect(history()[0]).toBe('Temperature -26 → +100');
    act(() => number().focus());
    change(number(), '-50');
    key('Escape', number());
    expect(recipe().adjustments.temperature).toBe(100);
    click(category().querySelector<HTMLElement>('.adjustment-reset')!);
    expect(recipe().adjustments.temperature).toBe(0);
    expect(history()[0]).toBe('Temperature Reset +100 → 0');
    expect(category().querySelector<HTMLButtonElement>('.adjustment-reset')!.disabled).toBe(true);
  });
  it('commits pending input across adjustments and ignores stale debounce callbacks', () => {
    wheel(-1);
    wheel(-1, false, slider(1));
    expect(history()).toEqual(['Temperature 0 → +10']);
    advance();
    expect(history()).toEqual(['Exposure 0.00 → +0.10', 'Temperature 0 → +10']);
    wheel(1);
    click(category(1).querySelector<HTMLElement>('.adjustment-category-reset')!);
    advance();
    expect(history().slice(0, 2)).toEqual(['Reset Basic adjustments', 'Temperature +10 → 0']);
  });
  it('keeps category toggles independent and commits pending before disabling', () => {
    const collapse = category().querySelector<HTMLButtonElement>('.adjustment-category-title')!;
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    wheel(-1);
    click(category().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    expect(history()).toEqual(['White Balance OFF', 'Temperature 0 → +10']);
    expect(recipe().whiteBalanceEnabled).toBe(false);
    expect(recipe().basicEnabled).toBe(true);
    expect(slider().disabled).toBe(true);
    expect(number().disabled).toBe(true);
    expect(category().querySelector<HTMLButtonElement>('.adjustment-reset')!.disabled).toBe(true);
    expect(wheel(-1).defaultPrevented).toBe(false);
    key('ArrowUp');
    advance();
    expect(recipe().adjustments.temperature).toBe(10);
    wheel(-1, false, slider(1));
    advance();
    expect(recipe().adjustments.exposure).toBe(0.1);
    click(category().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    expect(history()[0]).toBe('White Balance ON');
    expect(slider().value).toBe('10');
    click(category(1).querySelector<HTMLElement>('[aria-pressed]')!);
    expect(slider(1).disabled).toBe(true);
    expect(slider().disabled).toBe(false);
    wheel(-1);
    advance();
    expect(recipe().adjustments.temperature).toBe(20);
  });
  it('resets White Balance while OFF in one operation, preserves Basic and supports Undo/Redo and All Reset', () => {
    wheel(-1, false, slider(1));
    wheel(-1);
    click(category().querySelector<HTMLElement>('[aria-pressed]')!);
    click(category().querySelector<HTMLElement>('.adjustment-category-reset')!);
    expect(category().querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    expect(recipe().adjustments.temperature).toBe(0);
    expect(recipe().whiteBalanceEnabled).toBe(false);
    expect(recipe().adjustments.exposure).toBe(0.1);
    expect(history()[0]).toBe('Reset White Balance adjustments');
    click(button('Undo'));
    expect(recipe().adjustments.temperature).toBe(10);
    click(button('Redo'));
    expect(recipe().adjustments.temperature).toBe(0);
    click(category(1).querySelector<HTMLElement>('[aria-pressed]')!);
    click(button('All Reset'));
    expect(recipe().whiteBalanceEnabled).toBe(true);
    expect(recipe().basicEnabled).toBe(true);
    expect(Object.values(recipe().adjustments).every(value => value === 0)).toBe(true);
    expect(history()[0]).toBe('All Reset');
    click(button('Undo'));
    expect(recipe().whiteBalanceEnabled).toBe(false);
    expect(recipe().basicEnabled).toBe(false);
    expect(recipe().adjustments.exposure).toBe(0.1);
  });
  it('collapses with a pending commit, preserves values and starts expanded on re-entry', async () => {
    wheel(-1);
    click(category().querySelector<HTMLElement>('[aria-expanded]')!);
    expect(category().querySelector('input')).toBeNull();
    expect(recipe().adjustments.temperature).toBe(10);
    expect(history()).toEqual(['Temperature 0 → +10']);
    click(category().querySelector<HTMLElement>('[aria-expanded]')!);
    expect(slider().value).toBe('10');
    click(category().querySelector<HTMLElement>('[aria-expanded]')!);
    act(() => root.render(null));
    await mount();
    expect(slider().value).toBe('0');
    expect(category().querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
  });
  it('commits to the original asset during Filmstrip switching', async () => {
    wheel(-1);
    await act(async () => host.querySelector<HTMLElement>('.filmstrip [aria-label="b.jpg"]')!.click());
    expect(recipe().adjustments.temperature).toBe(0);
    wheel(1);
    advance();
    await act(async () => host.querySelector<HTMLElement>('.filmstrip [aria-label="a.jpg"]')!.click());
    expect(recipe().adjustments.temperature).toBe(10);
    expect(history()).toEqual(['Temperature 0 → +10']);
  });
  it('localizes Temperature and category History in Japanese, newest first', async () => {
    await act(async () => { await i18n.changeLanguage('ja'); });
    wheel(1);
    click(category().querySelector<HTMLElement>('[aria-pressed]')!);
    click(category().querySelector<HTMLElement>('.adjustment-category-reset')!);
    expect(history()).toEqual(['色温度補正をリセット', '色温度補正 OFF', '色温度 0 → -10']);
    click(category().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(history()[0]).toBe('色温度補正 ON');
    expect(category().querySelector('label')?.textContent).toBe('色温度');
  });
});
