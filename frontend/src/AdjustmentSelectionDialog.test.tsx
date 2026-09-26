// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdjustmentSelectionDialog } from './AdjustmentSelectionDialog';
import { ADJUSTMENT_IDS, BASIC_ADJUSTMENT_KEYS, COLOR_GRADING_ADJUSTMENT_KEYS, type AdjustmentId } from './editing';
import i18n from './i18n';

let host: HTMLDivElement; let root: Root; let opener: HTMLButtonElement;
let restoreDialog: () => void;
const confirmed = vi.fn(); const cancelled = vi.fn();
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await i18n.changeLanguage('en');
  const prototype = HTMLDialogElement.prototype;
  const show = Object.getOwnPropertyDescriptor(prototype, 'showModal');
  const close = Object.getOwnPropertyDescriptor(prototype, 'close');
  // jsdom does not implement the native top layer. Stub only that boundary.
  Object.defineProperty(prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  restoreDialog = () => {
    if (show) Object.defineProperty(prototype, 'showModal', show); else Reflect.deleteProperty(prototype, 'showModal');
    if (close) Object.defineProperty(prototype, 'close', close); else Reflect.deleteProperty(prototype, 'close');
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  opener = document.createElement('button'); document.body.append(opener); opener.focus();
  confirmed.mockReset(); cancelled.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); opener.remove(); restoreDialog(); vi.unstubAllGlobals(); });
function mount(mode: 'copy' | 'paste' = 'copy', ids: readonly AdjustmentId[] = ADJUSTMENT_IDS) {
  act(() => root.render(<AdjustmentSelectionDialog mode={mode} availableIds={ids} onConfirm={confirmed} onCancel={cancelled} />));
}
function button(text: string) {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === text)!;
}
const item = (id: AdjustmentId) => host.querySelector<HTMLInputElement>(`input[name="${id}"]`)!;
const categories = () => Array.from(host.querySelectorAll<HTMLInputElement>('legend input'));
function click(element: HTMLElement) { act(() => element.click()); }
function key(target: EventTarget, key: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  act(() => target.dispatchEvent(event)); return event;
}

describe('adjustment selection dialog', () => {
  it('opens modal with sixteen selected values and distinct grading ranges, without enabled flags', () => {
    mount();
    expect(host.querySelector('dialog')!.open).toBe(true);
    expect(document.activeElement).toBe(button('Select all'));
    expect(host.querySelectorAll('input[name]')).toHaveLength(16);
    expect(ADJUSTMENT_IDS.every((id) => item(id).checked && !item(id).disabled)).toBe(true);
    expect(categories().every((input) => input.checked && !input.indeterminate)).toBe(true);
    expect(Array.from(host.querySelectorAll('h3')).map((heading) => heading.textContent)).toEqual(['Shadows', 'Midtones', 'Highlights']);
    expect(host.querySelectorAll('input')).toHaveLength(20);
  });
  it('supports individual, category, all and zero-item selection with indeterminate feedback', () => {
    mount(); click(item('exposure'));
    expect(categories()[1].checked).toBe(false);
    expect(categories()[1].indeterminate).toBe(true);
    click(categories()[1]);
    expect(item('exposure').checked).toBe(true);
    expect(categories()[1].indeterminate).toBe(false);
    click(categories()[1]);
    expect(BASIC_ADJUSTMENT_KEYS.every((id) => !item(id).checked)).toBe(true);
    click(categories()[3]);
    expect(COLOR_GRADING_ADJUSTMENT_KEYS.every((id) => !item(id).checked)).toBe(true);
    click(button('Clear all'));
    expect(button('Copy').disabled).toBe(true);
    click(button('Copy')); expect(confirmed).not.toHaveBeenCalled();
    click(item('tint'));
    expect(button('Copy').disabled).toBe(false);
    expect(categories()[0].indeterminate).toBe(true);
    click(button('Copy')); expect(confirmed).toHaveBeenLastCalledWith(['tint']);
    click(button('Select all'));
    expect(ADJUSTMENT_IDS.every((id) => item(id).checked)).toBe(true);
  });
  it('shows only copied items and selects every candidate again on a fresh open', () => {
    mount('paste', ['temperature', 'shadowsTint']);
    expect(host.querySelectorAll('input[name]')).toHaveLength(2);
    expect(host.querySelectorAll('fieldset')).toHaveLength(2);
    expect(Array.from(host.querySelectorAll('h3')).map((heading) => heading.textContent)).toEqual(['Shadows']);
    click(item('shadowsTint')); click(button('Paste'));
    expect(confirmed).toHaveBeenCalledWith(['temperature']);
    act(() => root.render(null)); mount('paste', ['temperature', 'shadowsTint']);
    expect(item('temperature').checked && item('shadowsTint').checked).toBe(true);
  });
  it('cancels on Escape and native cancel, then restores the prior focus on close', () => {
    mount(); key(button('Select all'), 'Escape');
    expect(cancelled).toHaveBeenCalledTimes(1);
    const cancel = new Event('cancel', { cancelable: true });
    act(() => host.querySelector('dialog')!.dispatchEvent(cancel));
    expect(cancel.defaultPrevented).toBe(true);
    expect(cancelled).toHaveBeenCalledTimes(2);
    act(() => root.render(null)); expect(document.activeElement).toBe(opener);
  });
  it('wraps Tab and Shift+Tab at modal boundaries, including a disabled confirm button', () => {
    mount(); const first = button('Select all'); const last = button('Copy');
    act(() => last.focus());
    expect(key(last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(key(first, 'Tab', true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    act(() => item('exposure').focus());
    expect(key(item('exposure'), 'Tab').defaultPrevented).toBe(false);
    click(button('Clear all')); act(() => button('Cancel').focus());
    expect(key(button('Cancel'), 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });
  it('isolates background keys while retaining checkbox Space and removes guards on close', () => {
    mount(); const background = vi.fn(); window.addEventListener('keydown', background);
    expect(key(opener, 'ArrowUp').defaultPrevented).toBe(true);
    expect(background).not.toHaveBeenCalled();
    expect(key(item('exposure'), ' ').defaultPrevented).toBe(false);
    expect(background).not.toHaveBeenCalled();
    act(() => root.render(null)); key(opener, 'ArrowUp');
    expect(background).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', background);
  });
});
