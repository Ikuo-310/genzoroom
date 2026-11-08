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

function sendPointer(target: Element, type: string, pointerId: number, clientX: number, clientY: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId, button: 0, clientX, clientY });
  act(() => target.dispatchEvent(event));
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
  expect(host.querySelector<SVGPathElement>('[data-testid="raw-curve-line"]')!.getAttribute('d')).toContain('128,186');
  act(() => host.querySelector<HTMLButtonElement>('[data-channel="green"]')!.click());
  expect(host.querySelector<SVGPathElement>('[data-testid="raw-curve-line"]')!.getAttribute('d')).toBe('M12,244 L244,12');
});

it('updates the displayed channel when RAW settings change', () => {
  const curve = emptyCurve();
  act(() => root.render(<RawPointCurveControls curve={curve} />));
  act(() => host.querySelector<HTMLButtonElement>('[data-channel="blue"]')!.click());
  const updated = { ...curve, blue: [{ x: 0.4, y: 0.8 }] };
  act(() => root.render(<RawPointCurveControls curve={updated} />));
  expect(host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!.dataset.channel).toBe('blue');
  const d = host.querySelector<SVGPathElement>('[data-testid="raw-curve-line"]')!.getAttribute('d')!;
  expect(d).toContain('M12,244');
  expect(d).toContain('244,12');
});

it('marks endpoint and interior cursor targets and preserves the active drag target', () => {
  const curve = emptyCurve();
  curve.master = [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }];
  act(() => root.render(<RawPointCurveControls curve={curve} />));
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  const points = [...host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')];
  expect(graph.classList.contains('is-dragging')).toBe(false);
  expect(points.map(point => point.classList.contains('is-endpoint'))).toEqual([true, false, true]);
  expect(points[1].classList.contains('is-interior')).toBe(true);
  Object.defineProperty(points[1], 'setPointerCapture', { configurable: true, value: vi.fn() });
  sendPointer(points[1], 'pointerdown', 91, 128, 104);
  expect(graph.classList.contains('is-dragging-interior')).toBe(true);
  sendPointer(graph, 'pointercancel', 91, 128, 104);
  expect(graph.classList.contains('is-dragging')).toBe(false);
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
  expect(host.querySelector<SVGPathElement>('[data-testid="raw-curve-line"]')!.getAttribute('d')).toBe('M12,244 L244,12');
});

it('emits one complete channel edit for additions and interior deletion only', () => {
  const curve = emptyCurve();
  curve.red = [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }];
  const onPointEdit = vi.fn();
  act(() => root.render(<RawPointCurveControls curve={curve} onPointEdit={onPointEdit} />));
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  const points = () => [...host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')];
  act(() => host.querySelector<HTMLButtonElement>('[data-channel="red"]')!.click());

  act(() => points()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })));
  graph.focus();
  act(() => graph.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })));
  expect(onPointEdit).not.toHaveBeenCalled();

  act(() => points()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(onPointEdit).not.toHaveBeenCalled();
  act(() => graph.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })));
  expect(onPointEdit).toHaveBeenCalledTimes(1);
  expect(onPointEdit).toHaveBeenLastCalledWith('red', [{ x: 0, y: 0 }, { x: 1, y: 1 }]);

  act(() => root.render(<RawPointCurveControls curve={emptyCurve()} onPointEdit={onPointEdit} />));
  const emptyGraph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  act(() => host.querySelector<HTMLButtonElement>('[data-channel="master"]')!.click());
  clickPoint(emptyGraph, 0.4, 0.2);
  expect(onPointEdit).toHaveBeenCalledTimes(2);
  expect(onPointEdit.mock.lastCall?.[0]).toBe('master');
  expect(onPointEdit.mock.lastCall?.[1]).toHaveLength(3);
  expect(onPointEdit.mock.lastCall?.[1][1].x).toBeCloseTo(0.4);
  expect(onPointEdit.mock.lastCall?.[1][1].y).toBeCloseTo(0.2);
});

it('prevents edit submission while the existing operation lock is active', () => {
  const onPointEdit = vi.fn();
  act(() => root.render(<RawPointCurveControls curve={emptyCurve()} editDisabled onPointEdit={onPointEdit} />));
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  clickPoint(graph, 0.4, 0.2);
  expect(host.querySelectorAll('[data-testid="raw-curve-point"]')).toHaveLength(2);
  expect(onPointEdit).not.toHaveBeenCalled();
});

it('opens channel and graph reset actions at the pointer location without adding points', () => {
  const onReset = vi.fn();
  act(() => root.render(<RawPointCurveControls curve={emptyCurve()} onReset={onReset} />));
  const open = (target: Element, x = 24, y = 32) => act(() => target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y,
  })));
  const menuItem = () => document.querySelector<HTMLButtonElement>('.raw-curve-context-menu [role="menuitem"]')!;
  open(host.querySelector<HTMLButtonElement>('[data-channel="red"]')!);
  expect(menuItem().textContent).toBe('Reset Red Curve');
  act(() => menuItem().click());
  expect(onReset).toHaveBeenLastCalledWith('red');

  act(() => host.querySelector<HTMLButtonElement>('[data-channel="blue"]')!.click());
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  open(graph);
  expect(menuItem().textContent).toBe('Reset Blue Curve');
  act(() => menuItem().click());
  expect(onReset).toHaveBeenLastCalledWith('blue');
  expect(host.querySelectorAll('[data-testid="raw-curve-point"]')).toHaveLength(2);
});

it('right-click deletes only interior points and suppresses endpoint or locked menus', () => {
  const curve = emptyCurve();
  curve.master = [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }];
  const onPointEdit = vi.fn();
  act(() => root.render(<RawPointCurveControls curve={curve} onPointEdit={onPointEdit} />));
  const points = () => [...host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')];
  const open = (point: Element) => act(() => point.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2, clientX: 50, clientY: 60,
  })));
  open(points()[0]);
  expect(document.querySelector('.raw-curve-context-menu')).toBeNull();
  expect(points()).toHaveLength(3);
  open(points()[1]);
  expect(document.querySelector<HTMLButtonElement>('.raw-curve-context-menu [role="menuitem"]')?.textContent).toBe('Delete this point');
  act(() => document.querySelector<HTMLButtonElement>('.raw-curve-context-menu [role="menuitem"]')!.click());
  expect(points()).toHaveLength(2);
  expect(onPointEdit).toHaveBeenCalledOnce();
  expect(onPointEdit).toHaveBeenCalledWith('master', [{ x: 0, y: 0 }, { x: 1, y: 1 }]);

  act(() => root.render(<RawPointCurveControls curve={curve} editDisabled onReset={vi.fn()} />));
  open(host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')[1]);
  expect(document.querySelector('.raw-curve-context-menu')).toBeNull();
});

it('closes the curve context menu on Escape and outside pointer input', () => {
  act(() => root.render(<RawPointCurveControls curve={emptyCurve()} onReset={vi.fn()} />));
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  act(() => graph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })));
  expect(document.querySelector('.raw-curve-context-menu')).not.toBeNull();
  act(() => document.querySelector('.raw-curve-context-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(document.querySelector('.raw-curve-context-menu')).toBeNull();
  act(() => graph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })));
  act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(document.querySelector('.raw-curve-context-menu')).toBeNull();
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
  const d = host.querySelector<SVGPathElement>('[data-testid="raw-curve-line"]')!.getAttribute('d')!;
  expect(d).toContain('M12,244');
  expect(d).toContain('244,12');
});

it('draws a shape-preserving cubic path for multiple control points', () => {
  const curve = emptyCurve();
  curve.master = [
    { x: 0, y: 0 }, { x: 0.25, y: 1 }, { x: 0.5, y: 0.1 }, { x: 0.75, y: 0.95 }, { x: 1, y: 0.2 },
  ];
  act(() => root.render(<RawPointCurveControls curve={curve} />));
  const path = host.querySelector<SVGPathElement>('[data-testid="raw-curve-line"]')!.getAttribute('d')!;
  expect((path.match(/ C/g) ?? [])).toHaveLength(4);
  const segments = [...path.matchAll(/C([0-9., -]+)/g)].map(match => match[1].trim().split(/[ ,]+/).map(Number));
  let previousY = 244;
  for (const [, firstY, , secondY, , endY] of segments) {
    const low = Math.min(previousY, endY) - 1e-8;
    const high = Math.max(previousY, endY) + 1e-8;
    expect(firstY).toBeGreaterThanOrEqual(low);
    expect(firstY).toBeLessThanOrEqual(high);
    expect(secondY).toBeGreaterThanOrEqual(low);
    expect(secondY).toBeLessThanOrEqual(high);
    previousY = endY;
  }
});

it('keeps empty, one-point, and two-point paths renderable', () => {
  const curve = emptyCurve();
  act(() => root.render(<RawPointCurveControls curve={curve} />));
  expect(host.querySelector<SVGPathElement>('[data-testid="raw-curve-line"]')!.getAttribute('d')).toBe('M12,244 L244,12');
  curve.master = [{ x: 0.5, y: 0.3 }];
  act(() => root.render(<RawPointCurveControls curve={{ ...curve }} />));
  expect(host.querySelector<SVGPathElement>('[data-testid="raw-curve-line"]')!.getAttribute('d')).toContain('C');
  curve.master = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  act(() => root.render(<RawPointCurveControls curve={{ ...curve }} />));
  expect(host.querySelector<SVGPathElement>('[data-testid="raw-curve-line"]')!.getAttribute('d')).toBe('M12,244 L244,12');
});

it('drags an interior point live, applies the Pointer Up position, and suppresses the follow-up click', () => {
  const curve = emptyCurve();
  curve.master = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
  const onDragCommit = vi.fn();
  act(() => root.render(<RawPointCurveControls curve={curve} onDragCommit={onDragCommit} />));
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  vi.spyOn(graph, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 256, 256));
  const point = host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')[1];
  const capture = vi.fn(), release = vi.fn();
  Object.defineProperty(point, 'setPointerCapture', { configurable: true, value: capture });
  Object.defineProperty(point, 'releasePointerCapture', { configurable: true, value: release });

  sendPointer(point, 'pointerdown', 9, 228, 328);
  expect(capture).toHaveBeenCalledWith(9);
  expect(graph.classList.contains('is-dragging')).toBe(true);
  sendPointer(graph, 'pointermove', 9, 262.8, 281.6);
  const moved = host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')[1];
  expect(moved).toBe(point);
  expect(Number(moved.getAttribute('cx'))).toBeCloseTo(162.8);
  expect(Number(moved.getAttribute('cy'))).toBeCloseTo(81.6);
  expect(host.querySelector<SVGPathElement>('[data-testid="raw-curve-line"]')!.getAttribute('d')).toContain('162.8,81.6');

  sendPointer(graph, 'pointerup', 9, 274.4, 258.4);
  const finalPoint = host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')[1];
  expect(Number(finalPoint.getAttribute('cx'))).toBeCloseTo(174.4);
  expect(Number(finalPoint.getAttribute('cy'))).toBeCloseTo(58.4);
  expect(graph.classList.contains('is-dragging')).toBe(false);
  expect(release).toHaveBeenCalledWith(9);
  expect(onDragCommit).toHaveBeenCalledOnce();
  expect(onDragCommit).toHaveBeenCalledWith({ channel: 'master', before: curve.master,
    after: [{ x: 0, y: 0 }, { x: expect.closeTo(0.7), y: expect.closeTo(0.8) }, { x: 1, y: 1 }], changed: true });
  act(() => graph.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 274.4, clientY: 258.4 })));
  expect(host.querySelectorAll('[data-testid="raw-curve-point"]')).toHaveLength(3);
  expect(curve.master[1]).toEqual({ x: 0.5, y: 0.5 });
});

it('reports unchanged Pointer Up as a no-op and reports nothing for cancelled drags', () => {
  const curve = emptyCurve();
  curve.master = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
  const onDragCommit = vi.fn();
  act(() => root.render(<RawPointCurveControls curve={curve} onDragCommit={onDragCommit} />));
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  vi.spyOn(graph, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 256, 256));
  const point = host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')[1];
  Object.defineProperty(point, 'setPointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(point, 'releasePointerCapture', { configurable: true, value: vi.fn() });
  sendPointer(point, 'pointerdown', 10, 228, 328);
  sendPointer(graph, 'pointerup', 10, 228, 328);
  expect(onDragCommit).toHaveBeenCalledWith({ channel: 'master', before: curve.master, after: curve.master, changed: false });

  sendPointer(point, 'pointerdown', 11, 228, 328);
  sendPointer(graph, 'pointermove', 11, 250, 300);
  sendPointer(graph, 'pointercancel', 11, 250, 300);
  expect(onDragCommit).toHaveBeenCalledOnce();
  expect(Number(host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')[1].getAttribute('cx'))).toBe(128);
});

it('keeps an identity channel empty after a no-op endpoint drag and materializes it only when changed', () => {
  const curve = emptyCurve();
  const onDragCommit = vi.fn();
  act(() => root.render(<RawPointCurveControls curve={curve} onDragCommit={onDragCommit} />));
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  vi.spyOn(graph, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 256, 256));
  const left = () => host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')[0];
  Object.defineProperty(left(), 'setPointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(left(), 'releasePointerCapture', { configurable: true, value: vi.fn() });
  sendPointer(left(), 'pointerdown', 12, 112, 444);
  sendPointer(graph, 'pointerup', 12, 112, 444);
  expect(onDragCommit).toHaveBeenLastCalledWith({ channel: 'master', before: [], after: [], changed: false });

  Object.defineProperty(left(), 'setPointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(left(), 'releasePointerCapture', { configurable: true, value: vi.fn() });
  sendPointer(left(), 'pointerdown', 13, 112, 444);
  sendPointer(graph, 'pointerup', 13, 112, 386);
  expect(onDragCommit).toHaveBeenLastCalledWith({ channel: 'master', before: [],
    after: [{ x: 0, y: expect.closeTo(0.25) }, { x: 1, y: 1 }], changed: true });
  expect(Number(left().getAttribute('cx'))).toBe(12);
  expect(Number(left().getAttribute('cy'))).toBeCloseTo(186);
});

it('locks endpoint X, constrains interior spacing, and restores cancelled drags', () => {
  const curve = emptyCurve();
  curve.master = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
  act(() => root.render(<RawPointCurveControls curve={curve} />));
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  vi.spyOn(graph, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 256, 256));
  const points = () => [...host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')];
  const capture = (point: SVGCircleElement) => {
    Object.defineProperty(point, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(point, 'releasePointerCapture', { configurable: true, value: vi.fn() });
  };

  capture(points()[0]);
  sendPointer(points()[0], 'pointerdown', 1, 112, 444);
  sendPointer(graph, 'pointermove', 1, 228, 386);
  expect(points()[0].getAttribute('cx')).toBe('12');
  expect(Number(points()[0].getAttribute('cy'))).toBeCloseTo(186);
  sendPointer(graph, 'pointerup', 1, 228, 386);

  capture(points()[1]);
  sendPointer(points()[1], 'pointerdown', 2, 228, 328);
  sendPointer(graph, 'pointermove', 2, 353, 328);
  const clamped = points();
  expect(Number(clamped[1].getAttribute('cx'))).toBeLessThan(244);
  expect(Number(clamped[2].getAttribute('cx')) - Number(clamped[1].getAttribute('cx'))).toBeGreaterThanOrEqual(7.99);
  sendPointer(graph, 'pointercancel', 2, 353, 328);
  expect(Number(points()[1].getAttribute('cx'))).toBe(128);

  capture(points()[1]);
  sendPointer(points()[1], 'pointerdown', 3, 228, 328);
  sendPointer(graph, 'pointermove', 3, 250, 300);
  act(() => graph.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(Number(points()[1].getAttribute('cx'))).toBe(128);
  expect(Number(points()[1].getAttribute('cy'))).toBe(128);
});

it('cancels an active drag when switching channels', () => {
  const curve = emptyCurve();
  curve.master = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
  act(() => root.render(<RawPointCurveControls curve={curve} />));
  const graph = host.querySelector<SVGSVGElement>('[data-testid="raw-curve-graph"]')!;
  vi.spyOn(graph, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 256, 256));
  const point = host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')[1];
  Object.defineProperty(point, 'setPointerCapture', { configurable: true, value: vi.fn() });
  Object.defineProperty(point, 'releasePointerCapture', { configurable: true, value: vi.fn() });
  sendPointer(point, 'pointerdown', 4, 228, 328);
  sendPointer(graph, 'pointermove', 4, 250, 300);
  act(() => host.querySelector<HTMLButtonElement>('[data-channel="red"]')!.click());
  act(() => host.querySelector<HTMLButtonElement>('[data-channel="master"]')!.click());
  expect(Number(host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')[1].getAttribute('cx'))).toBe(128);
  expect(Number(host.querySelectorAll<SVGCircleElement>('[data-testid="raw-curve-point"]')[1].getAttribute('cy'))).toBe(128);
});
