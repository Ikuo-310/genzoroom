// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarResizeHandle } from './SidebarResizeHandle';

let host: HTMLDivElement;
let root: Root;
const onResize = vi.fn();
const onResizeEnd = vi.fn();

function pointer(type: string, target: EventTarget, pointerId: number, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  act(() => target.dispatchEvent(event));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<SidebarResizeHandle side="left" width={240} label="Resize left"
    hidden={false} onResize={onResize} onResizeEnd={onResizeEnd} />));
  Object.defineProperty(host.firstElementChild!, 'setPointerCapture', { configurable: true, value: vi.fn() });
  onResize.mockClear();
  onResizeEnd.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.classList.remove('sidebar-resizing');
  host.remove();
  vi.unstubAllGlobals();
});

describe('SidebarResizeHandle', () => {
  it('resizes with captured pointer events and reliably clears drag state', () => {
    const handle = host.firstElementChild!;
    pointer('pointerdown', handle, 7, 100);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(true);
    pointer('pointermove', window, 7, 145);
    expect(onResize).toHaveBeenLastCalledWith('left', 285);
    pointer('pointerup', window, 7, 145);
    expect(onResizeEnd).toHaveBeenCalledOnce();
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false);
    pointer('pointermove', window, 7, 180);
    expect(onResize).toHaveBeenCalledOnce();
  });

  it('reverses the drag direction for the right sidebar', () => {
    act(() => root.render(<SidebarResizeHandle side="right" width={270} label="Resize right"
      hidden={false} onResize={onResize} onResizeEnd={onResizeEnd} />));
    Object.defineProperty(host.firstElementChild!, 'setPointerCapture', { configurable: true, value: vi.fn() });
    pointer('pointerdown', host.firstElementChild!, 8, 500);
    pointer('pointermove', window, 8, 460);
    expect(onResize).toHaveBeenLastCalledWith('right', 310);
    pointer('pointercancel', window, 8, 460);
    expect(onResizeEnd).toHaveBeenCalledOnce();
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false);
  });

  it('does not start on narrow or coarse-pointer layouts', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    pointer('pointerdown', host.firstElementChild!, 9, 100);
    pointer('pointermove', window, 9, 200);
    expect(onResize).not.toHaveBeenCalled();
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false);
  });
});
