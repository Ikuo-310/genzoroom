// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { RawPointCurveControls } from './RawPointCurveControls';
import type { RawCurvePoint } from './rawApi';

const emptyCurve = () => ({ master: [] as RawCurvePoint[], red: [] as RawCurvePoint[], green: [] as RawCurvePoint[], blue: [] as RawCurvePoint[] });
let host: HTMLDivElement, root: Root;

function clickPoint(svg: SVGSVGElement, x: number, y: number) {
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 256, 256));
  const clientX = 100 + (12 + x * 232);
  const clientY = 200 + (12 + (1 - y) * 232);
  act(() => svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY })));
}

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

it('adds sorted local points, selects nearby or duplicate-X points, and ignores clicks outside the plot', () => {
  act(() => root.render(<RawPointCurveControls curve={emptyCurve()} />));
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  clickPoint(graph, 0.4, 0.2);
  const points = () => [...host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')];
  expect(points()).toHaveLength(3);
  expect(points().map(point => Number(point.dataset.pointIndex))).toEqual([0, 1, 2]);
  expect(points()[0].getAttribute('cx')).toBe('12');
  expect(points()[2].getAttribute('cx')).toBe('244');
  expect(Number(points()[1].getAttribute('cx'))).toBeCloseTo(104.8);
  expect(Number(points()[1].getAttribute('cy'))).toBeCloseTo(197.6);
  expect(points()[1].getAttribute('aria-selected')).toBe('true');

  clickPoint(graph, 0.405, 0.205);
  expect(points()).toHaveLength(3);
  expect(points()[1].getAttribute('aria-selected')).toBe('true');
  clickPoint(graph, 0.4, 0.8);
  expect(points()).toHaveLength(3);
  expect(points()[1].getAttribute('aria-selected')).toBe('true');
  vi.spyOn(graph, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 256, 256));
  act(() => graph.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 200 })));
  expect(points()).toHaveLength(3);
});

it('selects points and deletes only selected interior points while protecting endpoints', () => {
  const curve = emptyCurve();
  curve.master = [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }];
  act(() => root.render(<RawPointCurveControls curve={curve} />));
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  const points = () => [...host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')];
  graph.focus();
  act(() => graph.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })));
  expect(points()).toHaveLength(3);
  act(() => points()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })));
  act(() => graph.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })));
  expect(points()).toHaveLength(3);
  act(() => points()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(points()[1].getAttribute('aria-selected')).toBe('true');
  graph.blur();
  act(() => graph.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })));
  expect(points()).toHaveLength(3);
  graph.focus();
  act(() => graph.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })));
  expect(points()).toHaveLength(2);
  expect(host.querySelector<SVGPolylineElement>('[data-testid="raw-curve-line"]')!.getAttribute('points')).toBe('12,244 244,12');
});

it('keeps separate channel drafts and replaces them when RAW settings refresh', () => {
  act(() => root.render(<RawPointCurveControls curve={emptyCurve()} />));
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  clickPoint(graph, 0.3, 0.7);
  act(() => host.querySelector<HTMLButtonElement>('[data-channel="red"]')!.click());
  clickPoint(graph, 0.6, 0.4);
  act(() => host.querySelector<HTMLButtonElement>('[data-channel="master"]')!.click());
  expect(host.querySelectorAll('[data-testid="raw-curve-point"]')).toHaveLength(3);
  act(() => host.querySelector<HTMLButtonElement>('[data-channel="red"]')!.click());
  expect(host.querySelectorAll('[data-testid="raw-curve-point"]')).toHaveLength(3);
  expect(host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')[1].getAttribute('aria-selected')).toBe('true');

  const refreshed = emptyCurve();
  refreshed.red = [{ x: 0.2, y: 0.8 }];
  act(() => root.render(<RawPointCurveControls curve={refreshed} />));
  expect(host.querySelectorAll('[data-testid="raw-curve-point"]')).toHaveLength(1);
  const [x, y] = host.querySelector<SVGPolylineElement>('[data-testid="raw-curve-line"]')!.getAttribute('points')!.split(',').map(Number);
  expect(x).toBeCloseTo(58.4);
  expect(y).toBeCloseTo(58.4);
});
