// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdjustmentSlider } from './AdjustmentSlider';
import { EXPOSURE, type EditSession } from './editing';
import { useAssetEdits } from './useAssetEdits';

let host: HTMLDivElement;
let root: Root;
function Harness({ assetId = 'a' }: { assetId?: string }) {
  const { session, dispatch } = useAssetEdits(assetId, true);
  return <>
    <AdjustmentSlider key={assetId} label="Exposure" {...EXPOSURE} value={session.recipe.adjustments.exposure}
      valueText={String(session.recipe.adjustments.exposure)}
      onBegin={() => dispatch({ type: 'begin', kind: 'exposure' })}
      onChange={(value) => dispatch({ type: 'exposure', value })} onCommit={() => dispatch({ type: 'commit' })} />
    <pre>{JSON.stringify(session)}</pre>
    <input type="text" /><textarea /><select><option>one</option></select><div contentEditable />
    <button onClick={() => dispatch({ type: 'allReset' })}>All Reset</button>
  </>;
}
const session = (): EditSession => JSON.parse(host.querySelector('pre')!.textContent!);
const range = () => host.querySelector<HTMLInputElement>('input[type="range"]')!;
function key(key: string, target: EventTarget = window, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}
function pointer(type: string, target: EventTarget = range()) {
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 })); });
}
function change(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range(), value);
    range().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('edit controls DOM interaction', () => {
  it('groups hover keyboard input until inactivity and supports every undo/redo binding', () => {
    pointer('pointerover');
    expect(document.activeElement).not.toBe(range());
    key('ArrowRight'); key('ArrowRight'); key('ArrowUp'); key('ArrowLeft'); key('ArrowDown');
    expect(session().recipe.adjustments.exposure).toBe(0.01);
    expect(session().history).toHaveLength(0);
    act(() => vi.advanceTimersByTime(400));
    expect(session().history).toHaveLength(1);
    key('z', window, { ctrlKey: true });
    expect(session().recipe.adjustments.exposure).toBe(0);
    key('z', window, { ctrlKey: true, shiftKey: true });
    expect(session().recipe.adjustments.exposure).toBe(0.01);
    key('z', window, { ctrlKey: true });
    key('y', window, { ctrlKey: true });
    expect(session().recipe.adjustments.exposure).toBe(0.01);
  });
  it('keeps a pointer gesture open across initial focus and a long pause', () => {
    pointer('pointerdown');
    act(() => range().focus());
    change('0.1');
    act(() => vi.advanceTimersByTime(1000));
    expect(session().history).toHaveLength(0);
    change('0.3');
    pointer('pointerup', window);
    expect(session().history).toHaveLength(1);
    expect(session().history[0].before.adjustments.exposure).toBe(0);
    expect(session().history[0].after.adjustments.exposure).toBe(0.3);
  });
  it.each(['input[type="text"]', 'textarea', 'select', '[contenteditable]'])('preserves native shortcuts in %s while hovered', (selector) => {
    pointer('pointerover');
    key('ArrowUp');
    const target = host.querySelector<HTMLElement>(selector)!;
    act(() => target.focus());
    for (const init of [{ key: 'ArrowRight' }, { key: 'z', ctrlKey: true }, { key: 'z', ctrlKey: true, shiftKey: true }, { key: 'y', ctrlKey: true }]) {
      expect(key(init.key, target, init).defaultPrevented).toBe(false);
    }
    expect(session().recipe.adjustments.exposure).toBe(0.1);
  });
  it('supports focused sliders and commits on focus departure', () => {
    act(() => range().focus());
    key('ArrowUp', range());
    expect(session().recipe.adjustments.exposure).toBe(0.1);
    act(() => host.querySelector('button')!.focus());
    expect(session().history).toHaveLength(1);
  });
  it('does not intercept keys for hidden controls, other focused ranges, or IME', () => {
    pointer('pointerover');
    const other = document.createElement('input'); other.type = 'range'; host.append(other);
    expect(key('ArrowUp', other).defaultPrevented).toBe(false);
    expect(key('ArrowUp', window, { isComposing: true }).defaultPrevented).toBe(false);
    host.hidden = true;
    expect(key('ArrowUp').defaultPrevented).toBe(false);
    expect(session().recipe.adjustments.exposure).toBe(0);
  });
  it('commits pending edits to the old asset when switching, and restores its history', () => {
    pointer('pointerover'); key('ArrowUp');
    act(() => root.render(<Harness assetId="b" />));
    expect(session().recipe.adjustments.exposure).toBe(0);
    act(() => vi.advanceTimersByTime(500));
    expect(session().history).toHaveLength(0);
    act(() => root.render(<Harness assetId="a" />));
    expect(session().recipe.adjustments.exposure).toBe(0.1);
    expect(session().history).toHaveLength(1);
  });
});
