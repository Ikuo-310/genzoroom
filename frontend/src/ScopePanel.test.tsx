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

function render(data: Histogram | null) {
  act(() => root.render(<ScopePanel histogram={data} />));
}

function button(label: string) {
  return [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
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

  it('shows an empty graph when all RGB channels are off', () => {
    render(histogram(40, 90, 180, 100));
    act(() => button('R').click());
    act(() => button('G').click());
    act(() => button('B').click());
    expect(host.querySelectorAll('.histogram-series')).toHaveLength(0);
    expect(host.querySelector('.histogram-baseline')).not.toBeNull();
    expect(host.textContent).toContain('Select a channel to display.');
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
