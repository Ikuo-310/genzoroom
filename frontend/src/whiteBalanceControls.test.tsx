// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnshitsuPage } from './AnshitsuPage';
import { activeAdjustmentId } from './adjustmentFocus';
import { type EditRecipe } from './editing';
import { TEMPERATURE_TRACK_GRADIENT, TINT_TRACK_GRADIENT } from './WhiteBalanceAdjustmentControls';
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
const tintSlider = () => category().querySelectorAll<HTMLInputElement>('input[type="range"]')[1]!;
const number = (index = 0) => category().querySelectorAll<HTMLInputElement>('input[type="number"]')[index]!;
const history = () => Array.from(host.querySelectorAll('.edit-history li:not(.initial-state)'), item => item.textContent);
function click(element: HTMLElement) { act(() => element.click()); }
function key(value: string, target: EventTarget = slider(), init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event));
  // jsdom does not perform the native keyboard activation of buttons.
  if (target instanceof HTMLButtonElement && ['Enter', ' '].includes(value) && !event.defaultPrevented && !init.isComposing) {
    act(() => { target.dispatchEvent(new KeyboardEvent('keyup', { key: value, bubbles: true })); target.click(); });
  }
  return event;
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
  if (type === 'pointerover') {
    const movement = new MouseEvent('pointermove', { bubbles: true, clientX: ++mouseX });
    Object.defineProperty(movement, 'movementX', { value: 1 });
    act(() => target.dispatchEvent(movement));
  }
  act(() => target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 })));
}
let mouseX = 0;
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
  savedEdits.clear();
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
  const ranges = () => Array.from(host.querySelectorAll<HTMLInputElement>('.adjustment-range'));
  const navigate = (direction: 'ArrowUp' | 'ArrowDown') => key(direction, document.activeElement!, { shiftKey: true });

  it('moves across all category controls only with Shift and skips a disabled Reset', () => {
    const title = category().querySelector<HTMLButtonElement>('.adjustment-category-title')!;
    const toggle = category().querySelector<HTMLButtonElement>('[data-category-switch]')!;
    const reset = category().querySelector<HTMLButtonElement>('.adjustment-category-reset')!;
    act(() => title.focus());
    key('ArrowRight', title);
    expect(document.activeElement).toBe(title);
    key('ArrowRight', title, { shiftKey: true });
    expect(document.activeElement).toBe(toggle);
    key('ArrowLeft', toggle);
    expect(document.activeElement).toBe(toggle);
    key('ArrowRight', toggle, { shiftKey: true });
    expect(document.activeElement).toBe(toggle);
    expect(reset.disabled).toBe(true);
    wheel(-1);
    advance();
    const before = recipe();
    const beforeHistory = history();
    act(() => toggle.focus());
    key('ArrowRight', toggle, { shiftKey: true });
    expect(document.activeElement).toBe(reset);
    key('ArrowRight', reset, { shiftKey: true });
    expect(document.activeElement).toBe(reset);
    key('ArrowLeft', reset, { shiftKey: true });
    expect(document.activeElement).toBe(toggle);
    key('ArrowLeft', toggle, { shiftKey: true });
    expect(document.activeElement).toBe(title);
    key('ArrowLeft', title, { shiftKey: true });
    expect(document.activeElement).toBe(title);
    expect(recipe()).toEqual(before);
    expect(history()).toEqual(beforeHistory);
  });

  it.each(['.adjustment-category-title', '[data-category-switch]', '.adjustment-category-reset'])
    ('uses one vertical position from Basic %s', (selector) => {
      wheel(-1, false, slider(1));
      advance();
      const source = category(1).querySelector<HTMLElement>(selector)!;
      const before = recipe();
      const beforeHistory = history();
      act(() => source.focus());
      navigate('ArrowUp');
      expect(document.activeElement).toBe(tintSlider());
      act(() => source.focus());
      navigate('ArrowDown');
      expect(document.activeElement).toBe(slider(1));
      expect(recipe()).toEqual(before);
      expect(history()).toEqual(beforeHistory);
    });

  it.each(['Enter', ' '])('activates category Reset once with native %s', (value) => {
    wheel(-1);
    advance();
    const reset = category().querySelector<HTMLButtonElement>('.adjustment-category-reset')!;
    act(() => reset.focus());
    expect(key(value, reset).defaultPrevented).toBe(false);
    expect(recipe().adjustments.temperature).toBe(0);
    expect(history()).toEqual(['Reset White Balance adjustments', 'Temperature 0 → +10']);
  });

  it('navigates from category Reset while its sliders are disabled', () => {
    wheel(-1, false, slider(1));
    advance();
    const reset = category(1).querySelector<HTMLButtonElement>('.adjustment-category-reset')!;
    click(category(1).querySelector<HTMLButtonElement>('[data-category-switch]')!);
    expect(slider(1).disabled).toBe(true);
    expect(reset.disabled).toBe(false);
    const before = recipe();
    const beforeHistory = history();
    act(() => reset.focus());
    navigate('ArrowUp');
    expect(document.activeElement).toBe(tintSlider());
    act(() => reset.focus());
    navigate('ArrowDown');
    expect(document.activeElement).toBe(category(2).querySelector('.adjustment-category-title'));
    expect(recipe()).toEqual(before);
    expect(history()).toEqual(beforeHistory);
  });

  it.each(['.adjustment-range', '.adjustment-number', '.adjustment-reset'])
    ('uses one vertical position from Exposure %s and keeps scrolling within the list', (selector) => {
      wheel(-1, false, slider(1));
      advance();
      const row = slider(1).closest('.adjustment-control')!;
      const source = row.querySelector<HTMLElement>(selector)!;
      const scroll = host.querySelector<HTMLElement>('.develop-scroll-region')!;
      Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 200 });
      vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
      const title = category(1).querySelector<HTMLButtonElement>('.adjustment-category-title')!;
      vi.spyOn(title, 'getBoundingClientRect').mockReturnValue({ top: 80, bottom: 108 } as DOMRect);
      scroll.scrollTop = 200;
      const beforeHistory = history();
      act(() => source.focus());
      navigate('ArrowUp');
      expect(document.activeElement).toBe(title);
      expect(scroll.scrollTop).toBe(180);
      act(() => source.focus());
      navigate('ArrowDown');
      expect(document.activeElement).toBe(category(1).querySelectorAll('.adjustment-range')[1]);
      expect(history()).toEqual(beforeHistory);
      expect(host.querySelector('.scope-section')!.scrollTop).toBe(0);
      expect(host.querySelector('.develop-panel > .workspace-section-header')!.scrollTop).toBe(0);
    });

  it.each([0, 1, 2, 3])('moves horizontally only within category %s without edits or scrolling', (index) => {
    const title = category(index).querySelector<HTMLButtonElement>('.adjustment-category-title')!;
    const toggle = category(index).querySelector<HTMLButtonElement>('[data-category-switch]')!;
    const scroll = host.querySelector<HTMLElement>('.develop-scroll-region')!;
    scroll.scrollTop = 140;
    const before = recipe();
    const expanded = title.getAttribute('aria-expanded');
    const focusTitle = vi.spyOn(title, 'focus');
    const focusToggle = vi.spyOn(toggle, 'focus');
    act(() => title.focus());
    key('ArrowRight', title, { shiftKey: true });
    expect(document.activeElement).toBe(toggle);
    expect(activeAdjustmentId()).toBeNull();
    expect(focusToggle).toHaveBeenLastCalledWith({ preventScroll: true });
    key('ArrowLeft', toggle, { shiftKey: true });
    expect(document.activeElement).toBe(title);
    expect(focusTitle).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(title.getAttribute('aria-expanded')).toBe(expanded);
    expect(recipe()).toEqual(before);
    expect(history()).toEqual([]);
    expect(scroll.scrollTop).toBe(140);
  });

  it.each(['Enter', ' '])('leaves %s switch activation to one native button click', (value) => {
    const toggle = category().querySelector<HTMLButtonElement>('[data-category-switch]')!;
    act(() => toggle.focus());
    const before = recipe();
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
    act(() => toggle.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(recipe()).toEqual(before);
    // jsdom does not synthesize native keyboard button clicks; emulate its one default click.
    act(() => {
      toggle.dispatchEvent(new KeyboardEvent('keyup', { key: value, bubbles: true }));
      toggle.click();
    });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(history()).toEqual(['White Balance OFF']);
    expect(category().querySelector('.adjustment-category-title')?.getAttribute('aria-expanded')).toBe('true');
  });

  it.each(['Enter', ' '])('keeps title %s activation a single collapse', (value) => {
    const title = category().querySelector<HTMLButtonElement>('.adjustment-category-title')!;
    act(() => title.focus());
    const before = recipe();
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
    act(() => title.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(title.getAttribute('aria-expanded')).toBe('true');
    click(title);
    expect(title.getAttribute('aria-expanded')).toBe('false');
    expect(recipe()).toEqual(before);
    expect(history()).toEqual([]);
  });

  it.each(['expanded', 'collapsed', 'disabled'])('shares the title position for switch navigation when Basic is %s', (mode) => {
    const title = category(1).querySelector<HTMLButtonElement>('.adjustment-category-title')!;
    const toggle = category(1).querySelector<HTMLButtonElement>('[data-category-switch]')!;
    if (mode === 'collapsed') click(title);
    if (mode === 'disabled') click(toggle);
    const before = recipe();
    const beforeHistory = history();
    act(() => toggle.focus());
    navigate('ArrowUp');
    expect(document.activeElement).toBe(tintSlider());
    act(() => toggle.focus());
    navigate('ArrowDown');
    expect(document.activeElement).toBe(mode === 'expanded' ? slider(1)
      : category(2).querySelector('.adjustment-category-title'));
    navigate('ArrowUp');
    expect(document.activeElement).toBe(title);
    expect(recipe()).toEqual(before);
    expect(history()).toEqual(beforeHistory);
  });

  it('stops switch navigation at the first and last positions', () => {
    const first = category().querySelector<HTMLButtonElement>('[data-category-switch]')!;
    act(() => first.focus());
    navigate('ArrowUp');
    expect(document.activeElement).toBe(first);
    const lastTitle = category(3).querySelector<HTMLButtonElement>('.adjustment-category-title')!;
    click(lastTitle);
    const last = category(3).querySelector<HTMLButtonElement>('[data-category-switch]')!;
    act(() => last.focus());
    navigate('ArrowDown');
    expect(document.activeElement).toBe(last);
  });

  it.each([
    ['ArrowDown', 120, 148, 200], ['ArrowDown', 280, 308, 208], ['ArrowUp', 80, 108, 180],
  ] as const)('reveals switch navigation destination %s at %s..%s only within the list', (direction, top, bottom, expected) => {
    const scroll = host.querySelector<HTMLElement>('.develop-scroll-region')!;
    const toggle = category(1).querySelector<HTMLButtonElement>('[data-category-switch]')!;
    const destination = direction === 'ArrowDown' ? slider(1) : tintSlider();
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 200 });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 300 } as DOMRect);
    vi.spyOn(destination, 'getBoundingClientRect').mockReturnValue({ top, bottom } as DOMRect);
    scroll.scrollTop = 200;
    act(() => toggle.focus());
    navigate(direction);
    expect(document.activeElement).toBe(destination);
    expect(scroll.scrollTop).toBe(expected);
    for (const selector of ['.right-panel', '.scope-section', '.develop-panel', '.workspace-section-header']) {
      expect(host.querySelector(selector)!.scrollTop).toBe(0);
    }
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it('moves through a category title and toggles once with Enter without changing edits', () => {
    const title = category().querySelector<HTMLButtonElement>('.adjustment-category-title')!;
    const basicTitle = category(1).querySelector<HTMLButtonElement>('.adjustment-category-title')!;
    act(() => title.focus());
    navigate('ArrowDown');
    expect(document.activeElement).toBe(slider());
    navigate('ArrowUp');
    expect(document.activeElement).toBe(title);
    expect(activeAdjustmentId()).toBeNull();
    key('ArrowRight', title);
    expect(history()).toEqual([]);
    const before = recipe();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => title.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    click(title);
    expect(title.getAttribute('aria-expanded')).toBe('false');
    expect(category().querySelector('.adjustment-range')).toBeNull();
    navigate('ArrowDown');
    expect(document.activeElement).toBe(basicTitle);
    navigate('ArrowUp');
    key('Enter', title);
    expect(title.getAttribute('aria-expanded')).toBe('true');
    expect(recipe()).toEqual(before);
    expect(history()).toEqual([]);
  });

  it.each([
    [120, 148, 200, 'ArrowDown'], [280, 308, 208, 'ArrowDown'],
    [80, 108, 180, 'ArrowUp'],
  ] as const)('scrolls only the adjustment list to reveal %s..%s', (top, bottom, expected, direction) => {
    const scroll = host.querySelector<HTMLElement>('.develop-scroll-region')!;
    const title = category().querySelector<HTMLButtonElement>('.adjustment-category-title')!;
    const destination = direction === 'ArrowDown' ? slider() : title;
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 200 });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 300 } as DOMRect);
    vi.spyOn(destination, 'getBoundingClientRect').mockReturnValue({ top, bottom } as DOMRect);
    const focus = vi.spyOn(destination, 'focus');
    scroll.scrollTop = 200;
    act(() => (direction === 'ArrowDown' ? title : slider()).focus());
    navigate(direction);
    expect(document.activeElement).toBe(destination);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(scroll.scrollTop).toBe(expected);
    for (const selector of ['.right-panel', '.scope-section', '.develop-panel', '.workspace-section-header']) {
      expect(host.querySelector(selector)!.scrollTop).toBe(0);
    }
    // Read the current geometry again after resizing the sidebar.
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 80 });
    act(() => (direction === 'ArrowDown' ? title : slider()).focus());
    navigate(direction);
    expect(scroll.scrollTop).toBe(expected + (top < 100 ? top - 100 : Math.max(0, bottom - 180)));
  });

  it('does not scroll an unconstrained narrow layout', () => {
    const scroll = host.querySelector<HTMLElement>('.develop-scroll-region')!;
    scroll.style.overflowY = 'visible';
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 200 });
    act(() => category().querySelector<HTMLButtonElement>('.adjustment-category-title')!.focus());
    navigate('ArrowDown');
    expect(scroll.scrollTop).toBe(0);
    expect(document.activeElement).toBe(slider());
  });

  it('keeps keyboard focus when scrolling causes stationary pointer events and resumes on mouse movement', () => {
    const items = ranges();
    pointer('pointerover', items[0]);
    act(() => items[0].focus());
    navigate('ArrowDown');
    const before = recipe();
    act(() => items[3].dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    act(() => items[3].dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 0 })));
    expect(document.activeElement).toBe(items[1]);
    expect(activeAdjustmentId()).toBe('tint');
    expect(recipe()).toEqual(before);
    pointer('pointerover', category(1).querySelector('.adjustment-category-title')!);
    pointer('pointerover', category(1).querySelector('label')!);
    expect(document.activeElement).toBe(items[1]);
    pointer('pointerover', items[3]);
    expect(document.activeElement).not.toBe(items[1]);
    expect(activeAdjustmentId()).toBe('contrast');
    key('ArrowRight', document.activeElement!);
    expect(items[3].value).toBe('1');
  });

  it.each([[0, 3], [9, 1]])('routes arrows and wheel to hovered %s → %s despite old DOM focus', (from, to) => {
    const items = ranges();
    pointer('pointerdown', items[from]);
    act(() => items[from].focus());
    pointer('pointerup', window);
    pointer('pointerover', items[to]);
    expect(document.activeElement).not.toBe(items[from]);
    expect(document.activeElement).not.toBe(items[to]);
    wheel(-1, false, items[to]);
    wheel(-1, true, items[to]);
    key('ArrowRight', items[from]);
    key('ArrowUp', items[from]);
    key('ArrowLeft', items[from]);
    key('ArrowDown', items[from]);
    expect(items[to].value).toBe('11');
    expect(items[from].value).toBe('0');
    advance();
    expect(history()).toHaveLength(1);
  });

  it.each([0, 2, 8])('releases keyboard focus for mouse hover and restores it on Shift navigation from %s', (index) => {
    const items = ranges();
    act(() => items[index].focus());
    navigate('ArrowDown');
    const previous = items[index + 1];
    expect(document.activeElement).toBe(previous);
    key('ArrowRight', previous);
    const beforeHover = recipe();
    pointer('pointerover', items[index]);
    expect(document.activeElement).not.toBe(previous);
    expect(document.activeElement).not.toBe(items[index]);
    expect(recipe()).toEqual(beforeHover);
    expect(history()).toHaveLength(0);
    advance(499);
    expect(history()).toHaveLength(0);
    advance(1);
    expect(history()).toHaveLength(1);
    key('ArrowRight', document.activeElement!);
    wheel(-1, false, items[index]);
    wheel(-1, true, items[index]);
    expect(Number(items[index].value)).toBeCloseTo(12 * Number(items[index].step));
    expect(previous.value).toBe('1');
    expect(document.activeElement).not.toBe(items[index]);
    navigate('ArrowDown');
    expect(document.activeElement).toBe(previous);
    expect(history()).toHaveLength(2);
    key('ArrowRight', previous);
    expect(previous.value).toBe('2');
    advance();
    expect(history()).toHaveLength(3);
    key('z', previous, { ctrlKey: true });
    expect(previous.value).toBe('1');
    key('z', previous, { ctrlKey: true, shiftKey: true });
    expect(previous.value).toBe('2');
  });

  it('navigates every gradient, Basic and Color slider in UI order without values or History changes or wrapping', () => {
    const items = Array.from(host.querySelectorAll<HTMLElement>('.adjustment-category-title, .grading-range-title, .adjustment-range'));
    const before = recipe();
    act(() => items[0].focus());
    navigate('ArrowUp');
    expect(document.activeElement).toBe(items[0]);
    for (const item of items.slice(1)) {
      navigate('ArrowDown');
      expect(document.activeElement).toBe(item);
    }
    navigate('ArrowDown');
    expect(document.activeElement).toBe(items.at(-1));
    for (const item of items.slice(0, -1).reverse()) {
      navigate('ArrowUp');
      expect(document.activeElement).toBe(item);
    }
    advance();
    expect(recipe()).toEqual(before);
    expect(history()).toEqual([]);
  });

  it('keeps the keyboard destination active until another hover and commits pending edits on navigation', () => {
    const items = ranges();
    act(() => items[0].focus());
    pointer('pointerover', items[0]);
    key('ArrowUp', items[0]);
    advance(300);
    navigate('ArrowDown');
    expect(history()).toEqual(['Temperature 0 → +10']);
    expect(items[1].value).toBe('0');
    key('ArrowRight', items[1]);
    advance(499);
    expect(history()).toHaveLength(1);
    advance(1);
    expect(history()).toEqual(['Tint 0 → +1', 'Temperature 0 → +10']);
    pointer('pointerout', items[0]);
    pointer('pointerover', items[3]);
    key('ArrowUp', items[1]);
    expect(items[3].value).toBe('10');
    expect(items[1].value).toBe('1');
    // Navigation also flushes a pending edit on a previously hovered adjustment.
    pointer('pointerout', items[3]);
    pointer('pointerover', items[8]);
    key('ArrowDown', items[1], { shiftKey: true });
    expect(document.activeElement).toBe(items[9]);
    expect(history()[0]).toBe('Contrast 0 → +10');
    advance();
    expect(history()).toHaveLength(3);
    key('z', items[9], { ctrlKey: true });
    expect(items[3].value).toBe('0');
    key('z', items[9], { ctrlKey: true, shiftKey: true });
    expect(items[3].value).toBe('10');
  });

  it.each([0, 2, 8])('applies the next arrow only to the destination after navigating from UI index %s', (index) => {
    const items = ranges();
    act(() => items[index].focus());
    pointer('pointerover', items[index]);
    navigate('ArrowDown');
    const destination = items[index + 1];
    key('ArrowRight', destination);
    expect(Number(destination.value)).toBe(Number(destination.step));
    for (const item of items.filter(item => item !== destination)) expect(item.value).toBe('0');
    advance();
    expect(history()).toHaveLength(1);
  });

  it.each(['collapse', 'disable'])('skips a %s category in both directions', (mode) => {
    click(category(1).querySelector<HTMLElement>(mode === 'collapse' ? '[aria-expanded]' : '[aria-pressed]')!);
    const before = recipe();
    const beforeHistory = history();
    act(() => tintSlider().focus());
    navigate('ArrowDown');
    expect(document.activeElement).toBe(category(1).querySelector('.adjustment-category-title'));
    navigate('ArrowDown');
    expect(document.activeElement).toBe(category(2).querySelector('.adjustment-category-title'));
    navigate('ArrowDown');
    expect(document.activeElement).toBe(slider(2));
    navigate('ArrowUp');
    navigate('ArrowUp');
    navigate('ArrowUp');
    expect(document.activeElement).toBe(tintSlider());
    advance();
    expect(recipe()).toEqual(before);
    expect(history()).toEqual(beforeHistory);
  });

  it('skips individually disabled and hidden sliders and releases an unmounted active target', () => {
    const items = ranges();
    items[1].disabled = true;
    items[2].closest<HTMLElement>('.adjustment-control')!.hidden = true;
    act(() => items[0].focus());
    navigate('ArrowDown');
    expect(document.activeElement).toBe(category(1).querySelector('.adjustment-category-title'));
    navigate('ArrowDown');
    expect(document.activeElement).toBe(items[3]);
    click(category(1).querySelector<HTMLElement>('[aria-expanded]')!);
    const before = recipe();
    key('ArrowUp', window);
    expect(recipe()).toEqual(before);
    act(() => slider(2).focus());
    key('ArrowRight', slider(2));
    expect(slider(2).value).toBe('1');
  });

  it('places White Balance above Basic with unitless Temperature and Tint gradients', () => {
    expect(Array.from(host.querySelectorAll('.adjustment-category-label'), item => item.textContent)).toEqual(['White Balance', 'Basic', 'Color', 'Color Grading']);
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
    expect([tintSlider().min, tintSlider().max, tintSlider().step, tintSlider().value]).toEqual(['-100', '100', '1', '0']);
    expect(Array.from(category().querySelectorAll('label'), item => item.textContent)).toEqual(['Temperature', 'Tint']);
    expect(category().querySelectorAll('.adjustment-power')).toHaveLength(2);
    expect(slider().style.getPropertyValue('--adjustment-track-gradient')).toBe(TEMPERATURE_TRACK_GRADIENT);
    expect(tintSlider().style.getPropertyValue('--adjustment-track-gradient')).toBe(TINT_TRACK_GRADIENT);
    expect(slider().classList.contains('has-gradient')).toBe(true);
    expect(tintSlider().classList.contains('has-gradient')).toBe(true);
    const basics = category(1).querySelectorAll<HTMLInputElement>('input[type="range"]');
    expect(basics).toHaveLength(6);
    for (const item of basics) {
      expect(item.className).toBe('adjustment-range');
      expect(item.getAttribute('style')).toBeNull();
    }
  });
  it('uses Tint keyboard, wheel, direct input, disabled, pending commit and individual Reset behavior', () => {
    act(() => tintSlider().focus());
    key('ArrowRight', tintSlider());
    key('ArrowUp', tintSlider());
    wheel(1, true, tintSlider());
    expect(recipe().adjustments.tint).toBe(10);
    advance();
    expect(history()).toEqual(['Tint 0 → +10']);
    act(() => number(1).focus());
    change(number(1), '-25.6');
    key('Enter', number(1));
    expect(recipe().adjustments.tint).toBe(-26);
    expect(history()[0]).toBe('Tint +10 → -26');
    click(category().querySelectorAll<HTMLElement>('.adjustment-reset')[1]);
    expect(recipe().adjustments.tint).toBe(0);
    expect(history()[0]).toBe('Reset Tint -26 → 0');
    click(category().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(tintSlider().disabled).toBe(true);
    expect(number(1).disabled).toBe(true);
    expect(wheel(-1, false, tintSlider()).defaultPrevented).toBe(false);
  });
  it('keeps Tint drag pending until pointer release', () => {
    pointer('pointerdown', tintSlider());
    change(tintSlider(), '50');
    advance(1000);
    expect(recipe().adjustments.tint).toBe(50);
    expect(history()).toHaveLength(0);
    pointer('pointerup', window);
    expect(history()).toEqual(['Tint 0 → +50']);
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
    expect(history()[0]).toBe('Reset Temperature +100 → 0');
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
    expect(tintSlider().disabled).toBe(true);
    expect(number().disabled).toBe(true);
    expect(number(1).disabled).toBe(true);
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
    expect(tintSlider().disabled).toBe(false);
    wheel(-1);
    advance();
    expect(recipe().adjustments.temperature).toBe(20);
  });
  it('separates Scope and Develop header from the category scroll region while preserving the left panel', () => {
    const right = host.querySelector('.right-panel')!;
    const scope = right.querySelector('.scope-section')!;
    const develop = right.querySelector('.develop-panel')!;
    const header = develop.querySelector('.workspace-section-header')!;
    const scroll = develop.querySelector('.develop-scroll-region')!;
    expect(scope.parentElement).toBe(right);
    expect(develop.parentElement).toBe(right);
    expect(scope.nextElementSibling).toBe(develop);
    expect(scope.textContent).toContain('Scope');
    expect(header.querySelector('h2')?.textContent).toBe('Develop controls');
    expect(header.querySelector('button')?.textContent).toBe('Reset all');
    expect(scroll.contains(header)).toBe(false);
    expect(scroll.contains(scope)).toBe(false);
    expect(scroll.querySelectorAll('.adjustment-category')).toHaveLength(4);
    const left = host.querySelector('.left-panel')!;
    expect(left.querySelector('.history-scroll-region')).not.toBeNull();
    expect(left.querySelector('.exif-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(left.querySelector('.develop-scroll-region')).toBeNull();
    const initialRecipe = recipe();
    click(category().querySelector<HTMLElement>('.adjustment-category-title')!);
    expect(scroll.querySelectorAll('.adjustment-category')).toHaveLength(4);
    expect(category().querySelector('input')).toBeNull();
    expect(recipe()).toEqual(initialRecipe);
    click(category().querySelector<HTMLElement>('.adjustment-category-title')!);
    expect(category().querySelector('input')).not.toBeNull();
    expect(develop.querySelector('.workspace-section-header')).toBe(header);
  });

  it('resets White Balance while OFF in one operation, preserves Basic and supports Undo/Redo and All Reset', () => {
    wheel(-1, false, slider(1));
    wheel(-1);
    wheel(1, false, tintSlider());
    click(category().querySelector<HTMLElement>('[aria-pressed]')!);
    click(category().querySelector<HTMLElement>('.adjustment-category-reset')!);
    expect(category().querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    expect(recipe().adjustments.temperature).toBe(0);
    expect(recipe().adjustments.tint).toBe(0);
    expect(recipe().whiteBalanceEnabled).toBe(false);
    expect(recipe().adjustments.exposure).toBe(0.1);
    expect(history()[0]).toBe('Reset White Balance adjustments');
    click(button('Undo'));
    expect(recipe().adjustments.temperature).toBe(10);
    click(button('Redo'));
    expect(recipe().adjustments.temperature).toBe(0);
    click(category(1).querySelector<HTMLElement>('[aria-pressed]')!);
    click(button('Reset all'));
    expect(recipe().whiteBalanceEnabled).toBe(true);
    expect(recipe().basicEnabled).toBe(true);
    expect(Object.values(recipe().adjustments).every(value => value === 0)).toBe(true);
    expect(history()[0]).toBe('Reset all');
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
  it('localizes Temperature, Tint and category History in Japanese, newest first', async () => {
    await act(async () => { await i18n.changeLanguage('ja'); });
    wheel(1);
    wheel(-1, false, tintSlider());
    click(category().querySelector<HTMLElement>('[aria-pressed]')!);
    click(category().querySelector<HTMLElement>('.adjustment-category-reset')!);
    expect(history()).toEqual(['色温度補正をリセット', '色温度補正 OFF', '色かぶり補正 0 → +10', '色温度 0 → -10']);
    click(category().querySelector<HTMLElement>('[aria-pressed]')!);
    expect(history()[0]).toBe('色温度補正 ON');
    expect(Array.from(category().querySelectorAll('label'), item => item.textContent)).toEqual(['色温度', '色かぶり補正']);
  });
});
