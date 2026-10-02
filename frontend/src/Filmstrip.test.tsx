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
    <input type="range" /><input type="number" /><input type="text" /><textarea /><select><option>one</option></select>
    <div contentEditable /><div role="textbox" /><button className="other">Other</button></>;
}
const scroll = () => host.querySelector<HTMLElement>('.filmstrip-scroll')!;
const item = (index: number) => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[index];
const current = () => host.querySelector('.filmstrip-item[aria-current="true"]')?.getAttribute('aria-label');
function key(value: string, target: EventTarget = window, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event));
  return event;
}
function move(direction: 'previous' | 'next', target: EventTarget = window, init: KeyboardEventInit = {}) {
  return key(direction === 'previous' ? 'ArrowLeft' : 'ArrowRight', target,
    { ctrlKey: true, shiftKey: true, ...init });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); activate = vi.fn();
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Filmstrip keyboard navigation', () => {
  it('moves globally in both directions without hover or Filmstrip focus', () => {
    expect(move('next').defaultPrevented).toBe(true);
    expect(current()).toBe('b.jpg');
    expect(move('next').defaultPrevented).toBe(true);
    expect(current()).toBe('c.jpg');
    expect(move('next').defaultPrevented).toBe(true);
    expect(current()).toBe('c.jpg');
    expect(move('previous').defaultPrevented).toBe(true);
    expect(current()).toBe('b.jpg');
    expect(activate.mock.calls).toEqual([['b'], ['c'], ['b']]);
  });

  it('works while an ordinary Viewer-like control is focused and keeps that focus', () => {
    const target = host.querySelector<HTMLButtonElement>('.other')!;
    act(() => target.focus());
    expect(move('next', target).defaultPrevented).toBe(true);
    expect(current()).toBe('b.jpg');
    expect(document.activeElement).toBe(target);
  });

  it('does not intercept standalone arrows or incomplete/extra modifiers', () => {
    for (const options of [{}, { ctrlKey: true }, { shiftKey: true }, { ctrlKey: true, shiftKey: true, altKey: true },
      { ctrlKey: true, shiftKey: true, metaKey: true }, { ctrlKey: true, shiftKey: true, metaKey: true, altKey: true }]) {
      for (const arrow of ['ArrowLeft', 'ArrowRight']) {
        expect(key(arrow, window, options).defaultPrevented).toBe(false);
      }
    }
    expect(activate).not.toHaveBeenCalled();
  });

  it('ignores repeated, composing, and already prevented commands', () => {
    expect(move('next', window, { repeat: true }).defaultPrevented).toBe(false);
    expect(move('next', window, { isComposing: true }).defaultPrevented).toBe(false);
    const prevented = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true, cancelable: true });
    prevented.preventDefault(); act(() => window.dispatchEvent(prevented));
    expect(current()).toBe('a.jpg');
    expect(activate).not.toHaveBeenCalled();
  });

  it.each(['input[type="number"]', 'input[type="text"]', 'textarea', 'select', '[contenteditable]', '[role="textbox"]'])
    ('preserves native editing in %s', (selector) => {
      const target = host.querySelector<HTMLElement>(selector)!;
      act(() => target.focus());
      expect(move('next', target).defaultPrevented).toBe(false);
      expect(activate).not.toHaveBeenCalled();
    });

  it('ignores blocked and disabled filmstrips', () => {
    act(() => root.render(<Harness blocked />));
    expect(move('next').defaultPrevented).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    act(() => root.render(<Harness disabled />));
    expect(move('next').defaultPrevented).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  it.each(['dialog', 'alertdialog', 'menu'])('ignores commands while a %s is open', (role) => {
    const overlay = role === 'dialog' ? document.createElement('dialog') : document.createElement('div');
    if (role === 'dialog') (overlay as HTMLDialogElement).setAttribute('open', '');
    else overlay.setAttribute('role', role);
    document.body.append(overlay);
    try {
      expect(move('next').defaultPrevented).toBe(false);
      expect(activate).not.toHaveBeenCalled();
    } finally { overlay.remove(); }
  });

  it('ignores the edit settings menu and preserves active thumbnail reveal', () => {
    const menu = document.createElement('details'); menu.className = 'edit-settings-menu'; menu.open = true;
    document.body.append(menu);
    try { expect(move('next').defaultPrevented).toBe(false); } finally { menu.remove(); }

    Object.defineProperty(scroll(), 'clientWidth', { configurable: true, value: 200 });
    vi.spyOn(scroll(), 'getBoundingClientRect').mockReturnValue({ left: 100 } as DOMRect);
    vi.spyOn(item(1), 'getBoundingClientRect').mockImplementation(() => ({
      left: 260 - scroll().scrollLeft, right: 352 - scroll().scrollLeft,
    } as DOMRect));
    move('next');
    expect(current()).toBe('b.jpg');
    expect(scroll().scrollLeft).toBe(52);
    expect(document.activeElement).toBe(document.body);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.documentElement.scrollLeft).toBe(0);
  });

  it('reveals active thumbnails after clicks without moving focus', () => {
    Object.defineProperty(scroll(), 'clientWidth', { configurable: true, value: 200 });
    vi.spyOn(scroll(), 'getBoundingClientRect').mockReturnValue({ left: 100 } as DOMRect);
    vi.spyOn(item(1), 'getBoundingClientRect').mockReturnValue({ left: 260, right: 352 } as DOMRect);
    act(() => item(1).click());
    expect(scroll().scrollLeft).toBe(52);
  });
});
