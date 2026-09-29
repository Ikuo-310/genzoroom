// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Filmstrip } from './Filmstrip';
import type { RecentAsset } from './assets';

const assets: RecentAsset[] = ['a', 'b', 'c'].map((id) => ({ id, filename: `${id}.jpg`, date: '2026-09-25',
  thumbnail_url: `/${id}`, format: 'JPEG', is_raw: false }));
let host: HTMLDivElement;
let root: Root;
let activate = vi.fn<(id: string) => void>();
function Harness({ disabled = false, blocked = false, items = assets }: { disabled?: boolean; blocked?: boolean; items?: RecentAsset[] }) {
  const [active, setActive] = useState('a');
  return <><Filmstrip assets={items} activeAssetId={active} disabled={disabled} keyboardBlocked={blocked}
    onActivate={(id) => { activate(id); setActive(id); }} />
    <input type="range" /><input type="number" /><input type="text" /><button className="other">Other</button></>;
}
const scroll = () => host.querySelector<HTMLElement>('.filmstrip-scroll')!;
const item = (index: number) => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[index];
const current = () => host.querySelector('.filmstrip-item[aria-current="true"]')?.getAttribute('aria-label');
function hover(inside = true) {
  const event = new MouseEvent('pointermove', { bubbles: true, clientX: inside ? 20 : 200, clientY: 20 });
  Object.defineProperty(event, 'movementX', { value: 1 });
  act(() => (inside ? scroll() : document.body).dispatchEvent(event));
}
function key(value = 'ArrowRight', target: EventTarget = window, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event));
  return event;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); activate = vi.fn();
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Filmstrip keyboard navigation', () => {
  it('uses current selection order on hovered gaps, stops at edges and stops after pointer exit', () => {
    expect(key().defaultPrevented).toBe(false);
    hover();
    expect(key('ArrowLeft').defaultPrevented).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    key(); expect(current()).toBe('b.jpg');
    key(); expect(current()).toBe('c.jpg');
    key(); expect(activate.mock.calls).toEqual([['b'], ['c']]);
    key('ArrowLeft'); expect(current()).toBe('b.jpg');
    hover(false);
    key(); expect(current()).toBe('b.jpg');
  });

  it('prioritizes real Filmstrip hover over a retained range focus, then returns arrows to the range', () => {
    const range = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    act(() => range.focus()); hover();
    expect(document.activeElement).toBe(range);
    expect(key('ArrowRight', range).defaultPrevented).toBe(true);
    expect(activate).toHaveBeenCalledWith('b');
    expect(document.activeElement).toBe(range);
    hover(false);
    expect(key('ArrowLeft', range).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(range);
  });

  it('does not treat an unchanged pointer position as Filmstrip hover', () => {
    const stationary = new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 20 });
    act(() => scroll().dispatchEvent(stationary));
    expect(key().defaultPrevented).toBe(false); expect(activate).not.toHaveBeenCalled();
  });

  it('supports focused thumbnails outside hover and follows focus with preventScroll', () => {
    act(() => item(0).focus());
    expect(key('ArrowRight', item(0)).defaultPrevented).toBe(true);
    expect(current()).toBe('b.jpg');
    expect(document.activeElement).toBe(item(1));
    key('ArrowLeft', item(1)); expect(document.activeElement).toBe(item(0));
    expect(key('Tab', item(0)).defaultPrevented).toBe(false);
    const enter = key('Enter', item(2));
    expect(enter.defaultPrevented).toBe(false);
    // Native Enter/Space activation is not synthesized by jsdom.
    act(() => item(2).click()); expect(current()).toBe('c.jpg');
    expect(key(' ', item(1)).defaultPrevented).toBe(false);
    act(() => item(1).click()); expect(current()).toBe('b.jpg');
  });

  it.each(['input[type="number"]', 'input[type="text"]', '.other'])
    ('does not override focus on %s despite hover', (selector) => {
      hover(); const target = host.querySelector<HTMLElement>(selector)!;
      act(() => target.focus()); key('ArrowRight', target);
      expect(activate).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(target);
    });

  it.each([{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }])
    ('preserves modified keys %j', (modifier) => {
      hover(); expect(key('ArrowRight', window, modifier).defaultPrevented).toBe(false);
      expect(activate).not.toHaveBeenCalled();
    });

  it('ignores already processed events and blocked/disabled navigation', () => {
    hover();
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
    event.preventDefault(); act(() => window.dispatchEvent(event));
    expect(activate).not.toHaveBeenCalled();
    act(() => root.render(<Harness blocked />)); key();
    expect(activate).not.toHaveBeenCalled();
    act(() => root.render(<Harness disabled />)); expect(key().defaultPrevented).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    act(() => root.render(<Harness items={[assets[0]]} />)); key();
    expect(activate).not.toHaveBeenCalled();
  });

  it('does not consume hovered arrow keys while a menu is open', () => {
    hover();
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); document.body.append(menu);
    try {
      expect(key().defaultPrevented).toBe(false);
      expect(activate).not.toHaveBeenCalled();
    } finally { menu.remove(); }
  });

  it.each([[120, 212, 200], [260, 352, 252], [80, 172, 180]])
    ('reveals only the active thumbnail at %s..%s after a click or rerender', (left, right, expected) => {
      Object.defineProperty(scroll(), 'clientWidth', { configurable: true, value: 200 });
      vi.spyOn(scroll(), 'getBoundingClientRect').mockReturnValue({ left: 100 } as DOMRect);
      vi.spyOn(item(1), 'getBoundingClientRect').mockReturnValue({ left, right } as DOMRect);
      scroll().scrollLeft = 200;
      act(() => item(1).click());
      expect(scroll().scrollLeft).toBe(expected);
      expect(scroll().scrollTop).toBe(0);
      expect(document.documentElement.scrollTop).toBe(0);
      expect(document.documentElement.scrollLeft).toBe(0);
    });

  it('reveals keyboard destinations after rerender and keeps the page stationary', () => {
    Object.defineProperty(scroll(), 'clientWidth', { configurable: true, value: 200 });
    vi.spyOn(scroll(), 'getBoundingClientRect').mockReturnValue({ left: 100 } as DOMRect);
    vi.spyOn(item(1), 'getBoundingClientRect').mockImplementation(() => ({
      left: 260 - scroll().scrollLeft, right: 352 - scroll().scrollLeft,
    } as DOMRect));
    hover(); key();
    expect(current()).toBe('b.jpg');
    expect(scroll().scrollLeft).toBe(52);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.documentElement.scrollLeft).toBe(0);
  });
});
