// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScopeResizeHandle } from './ScopeResizeHandle';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('ScopeResizeHandle', () => {
  it('exposes the current size and supports keyboard resizing within limits', () => {
    const onChange = vi.fn();
    act(() => root.render(<ScopeResizeHandle value={34} onChange={onChange} label="Resize Scope area" />));
    const handle = host.querySelector<HTMLElement>('[role="separator"]')!;

    expect(handle.getAttribute('aria-valuenow')).toBe('34');
    act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(36);
    act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(15);
    act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(70);
  });

  it('adjusts the Scope height by dragging the divider', () => {
    const onChange = vi.fn();
    act(() => root.render(<div style={{ height: '200px' }}><ScopeResizeHandle value={34} onChange={onChange} label="Resize Scope area" /></div>));
    const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
    Object.defineProperty(handle.parentElement, 'clientHeight', { configurable: true, value: 200 });

    act(() => handle.dispatchEvent(new MouseEvent('pointerdown', { clientY: 10, bubbles: true })));
    act(() => handle.dispatchEvent(new MouseEvent('pointermove', { clientY: 30, bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith(44);
    act(() => handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })));
  });
});
