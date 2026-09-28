// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Histogram } from './histogram';
import i18n from './i18n';
import { histogramDisplayMaximum } from './HistogramGraph';
import { ScopePanel } from './ScopePanel';

function histogram(r: number, g: number, b: number, y: number): Histogram {
  const make = (value: number) => {
    const bins = new Uint32Array(256);
    bins[value] = value + 1;
    return bins;
  };
  return { r: make(r), g: make(g), b: make(b), y: make(y) };
}

function denseHistogram(value = 10): Histogram {
  const channel = () => {
    const bins = new Uint32Array(256);
    bins.fill(value);
    return bins;
  };
  return { r: channel(), g: channel(), b: channel(), y: channel() };
}

let host: HTMLDivElement;
let root: Root;

function render(data: Histogram | null, keyboardBlocked = false) {
  act(() => root.render(<ScopePanel histogram={data} keyboardBlocked={keyboardBlocked} />));
}

function button(label: string) {
  return [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
}

function numpad(code: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Unidentified', code, bubbles: true, cancelable: true, ...init });
  act(() => window.dispatchEvent(event));
  return event;
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await i18n.changeLanguage('en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

describe('ScopePanel', () => {
  it('starts with all RGB channels enabled and plots the adjusted histogram', () => {
    render(histogram(40, 90, 180, 100));
    expect(button('R').getAttribute('aria-pressed')).toBe('true');
    expect(button('G').getAttribute('aria-pressed')).toBe('true');
    expect(button('B').getAttribute('aria-pressed')).toBe('true');
    expect(button('Y Only').getAttribute('aria-pressed')).toBe('false');
    expect(button('Normal').getAttribute('aria-pressed')).toBe('true');
    expect(button('Expanded').getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelectorAll('.histogram-series')).toHaveLength(3);
    expect(host.querySelector('[data-channel="r"]')?.getAttribute('d')).toContain('40,');
    expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('histogram');
    expect(host.querySelectorAll('select option')).toHaveLength(1);
  });

  it('keeps normal mode on the previous maximum-bin scale', () => {
    const data = histogram(40, 90, 180, 100);
    expect(histogramDisplayMaximum(data, false, false)).toBe(181);
    expect(histogramDisplayMaximum(data, true, false)).toBe(101);
    render(data);
    expect(host.querySelector('.histogram-y-axis')?.firstElementChild?.textContent).toBe('181');
  });

  it('uses nearest-rank P99 across all RGB bins, including zero bins', () => {
    const data = denseHistogram();
    data.r.fill(100, 0, 7);
    expect(histogramDisplayMaximum(data, false, true)).toBe(10);
    data.r[7] = 100;
    expect(histogramDisplayMaximum(data, false, true)).toBe(100);
  });

  it('clips extreme black and white peaks at the expanded plot ceiling without mutating data', () => {
    const data = denseHistogram();
    data.r[0] = 10000;
    data.b[255] = 20000;
    const original = Object.fromEntries(Object.entries(data).map(([key, bins]) => [key, bins.slice()]));
    expect(histogramDisplayMaximum(data, false, true)).toBe(10);
    render(data);
    act(() => button('Expanded').click());
    expect(host.querySelector('.histogram-y-axis')?.firstElementChild?.textContent).toBe('P99 10');
    const path = host.querySelector('[data-channel="r"]')?.getAttribute('d') ?? '';
    const bluePath = host.querySelector('[data-channel="b"]')?.getAttribute('d') ?? '';
    expect(path).toContain('0,14');
    expect(bluePath).toContain('255,14');
    for (const [key, bins] of Object.entries(data)) expect(bins).toEqual(original[key as keyof Histogram]);
  });

  it('uses the Y-only bins for its own expanded scale and floors an empty distribution at one', () => {
    const data = denseHistogram(900);
    data.y.fill(10);
    data.y[0] = 10000;
    data.y[255] = 20000;
    expect(histogramDisplayMaximum(data, true, true)).toBe(10);
    const empty = denseHistogram(0);
    expect(histogramDisplayMaximum(empty, false, true)).toBe(1);
    expect(histogramDisplayMaximum(empty, true, true)).toBe(1);
  });

  it('keeps the expanded scale independent from RGB channel visibility and preserves the mode across photos', () => {
    const first = denseHistogram();
    first.r[0] = 20000;
    const second = denseHistogram(20);
    render(first);
    act(() => button('Expanded').click());
    const initialMaximum = host.querySelector('.histogram-y-axis')?.firstElementChild?.textContent;
    act(() => button('R').click());
    expect(host.querySelector('.histogram-y-axis')?.firstElementChild?.textContent).toBe(initialMaximum);
    render(second);
    expect(button('Expanded').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.histogram-y-axis')?.firstElementChild?.textContent).toBe('P99 20');
  });

  it('keeps RGB channel toggles out of the Y-only scale calculation', () => {
    const data = histogram(40, 90, 180, 100);
    render(data);
    act(() => button('Y Only').click());
    expect(host.querySelector('.histogram-y-axis')?.firstElementChild?.textContent).toBe('101');
    expect(histogramDisplayMaximum(data, true, false)).toBe(101);
  });

  it.each([
    ['Numpad1', 'R'],
    ['Numpad2', 'G'],
    ['Numpad3', 'B'],
  ])('%s exits Y Only without toggling %s, then toggles it on the next press', (code, label) => {
    render(histogram(40, 90, 180, 100));
    numpad('Numpad0');
    expect(button('Y Only').getAttribute('aria-pressed')).toBe('true');
    numpad(code);
    expect(button('Y Only').getAttribute('aria-pressed')).toBe('false');
    expect(button(label).getAttribute('aria-pressed')).toBe('true');
    numpad(code);
    expect(button(label).getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps Y Only RGB choices and restores them when Numpad0 toggles it off', () => {
    render(histogram(40, 90, 180, 100));
    act(() => button('G').click());
    numpad('Numpad0');
    expect(button('R').getAttribute('aria-pressed')).toBe('true');
    expect(button('G').getAttribute('aria-pressed')).toBe('false');
    expect(button('B').getAttribute('aria-pressed')).toBe('true');
    numpad('Numpad0');
    expect(button('Y Only').getAttribute('aria-pressed')).toBe('false');
    expect(button('G').getAttribute('aria-pressed')).toBe('false');
  });

  it('ignores top-row numbers, modifiers, repeats, prevented and composing events', () => {
    render(histogram(40, 90, 180, 100));
    numpad('Digit1', { key: '1' });
    numpad('Numpad1', { ctrlKey: true });
    numpad('Numpad1', { altKey: true });
    numpad('Numpad1', { metaKey: true });
    numpad('Numpad2', { shiftKey: true });
    numpad('Numpad3', { repeat: true });
    numpad('Numpad0', { isComposing: true });
    const prevented = new KeyboardEvent('keydown', { code: 'Numpad1', cancelable: true });
    prevented.preventDefault();
    act(() => window.dispatchEvent(prevented));
    expect(button('R').getAttribute('aria-pressed')).toBe('true');
    expect(button('G').getAttribute('aria-pressed')).toBe('true');
    expect(button('B').getAttribute('aria-pressed')).toBe('true');
    expect(button('Y Only').getAttribute('aria-pressed')).toBe('false');
  });

  it('preserves Numpad entry in native fields and ignores keys while menus or blocked operations are active', () => {
    render(histogram(40, 90, 180, 100));
    const number = document.createElement('input');
    number.type = 'number';
    host.append(number);
    const numberEvent = new KeyboardEvent('keydown', { code: 'Numpad1', key: '1', bubbles: true, cancelable: true });
    act(() => number.dispatchEvent(numberEvent));
    expect(numberEvent.defaultPrevented).toBe(false);
    expect(button('R').getAttribute('aria-pressed')).toBe('true');
    number.remove();
    const blockedLayers: HTMLElement[] = [];
    for (const role of ['menu', 'dialog', 'alertdialog']) {
      const layer = document.createElement('div');
      layer.setAttribute('role', role);
      document.body.append(layer);
      blockedLayers.push(layer);
      numpad('Numpad1');
    }
    const toolbarMenu = document.createElement('details');
    toolbarMenu.className = 'edit-settings-menu';
    toolbarMenu.open = true;
    document.body.append(toolbarMenu);
    blockedLayers.push(toolbarMenu);
    numpad('Numpad1');
    blockedLayers.forEach((layer) => layer.remove());
    render(histogram(40, 90, 180, 100), true);
    numpad('Numpad1');
    expect(button('R').getAttribute('aria-pressed')).toBe('true');
  });

  it('toggles R, G and B separately without changing the other selections', () => {
    render(histogram(40, 90, 180, 100));
    act(() => button('G').click());
    expect(button('R').getAttribute('aria-pressed')).toBe('true');
    expect(button('G').getAttribute('aria-pressed')).toBe('false');
    expect(button('B').getAttribute('aria-pressed')).toBe('true');
    expect([...host.querySelectorAll('.histogram-series')].map((path) => path.getAttribute('data-channel'))).toEqual(['r', 'b']);
    act(() => button('B').click());
    expect(host.querySelectorAll('.histogram-series')).toHaveLength(1);
    expect(host.querySelector('[data-channel="r"]')).not.toBeNull();
  });

  it('shows only Y-prime in Y Only, restores RGB choices, and disables RGB controls while active', () => {
    render(histogram(40, 90, 180, 100));
    act(() => button('G').click());
    act(() => button('Y Only').click());
    expect(host.querySelectorAll('.histogram-series')).toHaveLength(1);
    expect(host.querySelector('[data-channel="y"]')).not.toBeNull();
    expect(button('R').disabled).toBe(true);
    expect(button('G').disabled).toBe(true);
    act(() => button('Y Only').click());
    expect(button('R').disabled).toBe(false);
    expect(button('R').getAttribute('aria-pressed')).toBe('true');
    expect(button('G').getAttribute('aria-pressed')).toBe('false');
    expect(button('B').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelectorAll('.histogram-series')).toHaveLength(2);
  });

  it('keeps one RGB channel on when every channel is toggled off', () => {
    render(histogram(40, 90, 180, 100));
    act(() => button('R').click());
    act(() => button('G').click());
    act(() => button('B').click());
    expect(button('R').getAttribute('aria-pressed')).toBe('false');
    expect(button('G').getAttribute('aria-pressed')).toBe('false');
    expect(button('B').getAttribute('aria-pressed')).toBe('true');
    expect(button('B').disabled).toBe(false);
    expect(host.querySelectorAll('.histogram-series')).toHaveLength(1);
  });

  it('prevents the last RGB channel from being turned off by either input method', () => {
    render(histogram(40, 90, 180, 100));
    act(() => button('G').click());
    act(() => button('B').click());
    numpad('Numpad1');
    expect(button('R').getAttribute('aria-pressed')).toBe('true');
    expect(button('R').disabled).toBe(false);
    act(() => button('R').click());
    expect(button('R').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps mouse and Numpad channel changes in the same RGB selection state', () => {
    render(histogram(40, 90, 180, 100));
    act(() => button('G').click());
    numpad('Numpad3');
    expect(button('R').getAttribute('aria-pressed')).toBe('true');
    expect(button('G').getAttribute('aria-pressed')).toBe('false');
    expect(button('B').getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelectorAll('.histogram-series')).toHaveLength(1);
  });

  it('treats unavailable data as pending and updates when the selected photo changes', () => {
    render(null);
    expect(host.querySelectorAll('.histogram-series')).toHaveLength(0);
    expect(host.textContent).toContain('Histogram is not available yet.');
    render(histogram(12, 34, 56, 78));
    expect(host.querySelector('[data-channel="r"]')?.getAttribute('d')).toContain('12,');
    render(histogram(101, 102, 103, 104));
    expect(host.querySelector('[data-channel="r"]')?.getAttribute('d')).toContain('101,');
  });
});
