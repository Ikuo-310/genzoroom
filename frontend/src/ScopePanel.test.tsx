// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Histogram } from './histogram';
import i18n from './i18n';
import { ScopePanel } from './ScopePanel';

function histogram(r: number, g: number, b: number, y: number): Histogram {
  const make = (value: number) => {
    const bins = new Uint32Array(256);
    bins[value] = value + 1;
    return bins;
  };
  return { r: make(r), g: make(g), b: make(b), y: make(y) };
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
    expect(host.querySelectorAll('.histogram-series')).toHaveLength(3);
    expect(host.querySelector('[data-channel="r"]')?.getAttribute('d')).toContain('40,');
    expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('histogram');
    expect(host.querySelectorAll('select option')).toHaveLength(1);
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
