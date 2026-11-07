// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { RawPointCurveControls } from './RawPointCurveControls';
import type { RawCurvePoint } from './rawApi';

const emptyCurve = () => ({ master: [] as RawCurvePoint[], red: [] as RawCurvePoint[], green: [] as RawCurvePoint[], blue: [] as RawCurvePoint[] });
let host: HTMLDivElement, root: Root;

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('shows the selected channel, existing points with inverted SVG Y, and identity for empty curves', () => {
  const curve = emptyCurve();
  curve.master = [{ x: 0.25, y: 0.75 }, { x: 0.75, y: 0.25 }];
  curve.red = [{ x: 0.5, y: 0.25 }];
  act(() => root.render(<RawPointCurveControls curve={curve} />));

  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  expect(graph.dataset.channel).toBe('master');
  expect(host.querySelector<HTMLButtonElement>('[data-channel="master"]')!.getAttribute('aria-pressed')).toBe('true');
  expect([...host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')].map(point => [point.getAttribute('cx'), point.getAttribute('cy')]))
    .toEqual([['70', '70'], ['186', '186']]);

  act(() => host.querySelector<HTMLButtonElement>('[data-channel="red"]')!.click());
  expect(graph.dataset.channel).toBe('red');
  expect(host.querySelector<SVGPolylineElement>('[data-testid="raw-curve-line"]')!.getAttribute('points')).toBe('128,186');
  act(() => host.querySelector<HTMLButtonElement>('[data-channel="green"]')!.click());
  expect(host.querySelector<SVGPolylineElement>('[data-testid="raw-curve-line"]')!.getAttribute('points')).toBe('12,244 244,12');
});

it('updates the displayed channel when RAW settings change', () => {
  const curve = emptyCurve();
  act(() => root.render(<RawPointCurveControls curve={curve} />));
  act(() => host.querySelector<HTMLButtonElement>('[data-channel="blue"]')!.click());
  const updated = { ...curve, blue: [{ x: 0.4, y: 0.8 }] };
  act(() => root.render(<RawPointCurveControls curve={updated} />));
  expect(host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!.dataset.channel).toBe('blue');
  const [x, y] = host.querySelector<SVGPolylineElement>('[data-testid="raw-curve-line"]')!.getAttribute('points')!.split(',').map(Number);
  expect(x).toBeCloseTo(104.8);
  expect(y).toBeCloseTo(58.4);
});
