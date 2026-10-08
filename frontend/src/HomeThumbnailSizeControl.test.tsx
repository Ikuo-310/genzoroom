// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOME_THUMBNAIL_COLUMNS_KEY, SHOW_KEYBOARD_SHORTCUTS_KEY, updateSetting } from './appSettings';
import { changeAppLanguage } from './i18n';
import { HomeThumbnailSizeControl } from './HomeThumbnailSizeControl';
import { formatShortcut } from './shortcutDisplay';

let host: HTMLDivElement;
let root: Root;
async function change(control: HTMLElement, value: string) {
  const slider = control.querySelector<HTMLInputElement>('input[type="range"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, value);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear(); updateSetting('homeThumbnailColumns', 6); updateSetting('showKeyboardShortcuts', true); await changeAppLanguage('en');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<HomeThumbnailSizeControl />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); updateSetting('homeThumbnailColumns', 6); });

describe('Home thumbnail size controls', () => {
  function dispatch(code: string, key: string, target: EventTarget = window, modifiers: KeyboardEventInit = {}) {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, key, ...modifiers }));
  }

  it('uses visibly different thumbnail sizes for the smaller and larger controls', () => {
    const icons = [...host.querySelectorAll('.thumbnail-size-icon svg path')].map(path => path.getAttribute('d'));
    expect(icons[0]).toContain('M3 3h5v5H3z');
    expect(icons[1]).toBe('M3 3h14v14H3z');
    expect(icons[0]).not.toBe(icons[1]);
  });

  it('moves one step per icon click and disables both limits', async () => {
    const home = host.querySelector<HTMLElement>('.thumbnail-size-control')!;
    expect(home.querySelector('input')!.getAttribute('aria-valuetext')).toBe('6 columns');
    await act(async () => home.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails smaller"]')!.click());
    expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('7');
    for (let i = 0; i < 4; i++) await act(async () => home.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails smaller"]')!.click());
    expect(home.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails smaller"]')!.disabled).toBe(true);
    expect(home.querySelector('input')!.getAttribute('aria-valuetext')).toBe('10 columns');
    for (let i = 0; i < 7; i++) await act(async () => home.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails larger"]')!.click());
    expect(home.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails larger"]')!.disabled).toBe(true);
    expect(home.querySelector('input')!.getAttribute('aria-valuetext')).toBe('3 columns');
  });
  it('updates the saved Home setting immediately while the slider moves', async () => {
    const home = host.querySelector<HTMLElement>('.thumbnail-size-control')!;
    const slider = home.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.min).toBe('0'); expect(slider.max).toBe('7');
    await change(home, '0');
    expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('10');
    expect(home.querySelector('input')!.value).toBe('0');
    await change(home, '7');
    expect(home.querySelector('input')!.getAttribute('aria-valuetext')).toBe('3 columns');
  });

  it('uses physical numpad codes and shares the button step callbacks', async () => {
    await act(async () => dispatch('NumpadSubtract', '-'));
    expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('7');
    await act(async () => dispatch('NumpadAdd', '+'));
    expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('6');
    for (const [code, key] of [['Minus', '-'], ['Equal', '=']] as const) await act(async () => dispatch(code, key));
    expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('6');
    await act(async () => dispatch('NumpadAdd', '+', window, { ctrlKey: true }));
    await act(async () => dispatch('NumpadSubtract', '-', window, { altKey: true }));
    expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('6');
  });

  it.each(['input', 'range', 'textarea', 'select', 'contenteditable'] as const)('ignores numpad sizing while editing in %s', async kind => {
    const target = kind === 'contenteditable' ? document.createElement('div') : document.createElement(kind === 'range' ? 'input' : kind);
    if (kind === 'range') (target as HTMLInputElement).type = 'range';
    if (kind === 'contenteditable') target.setAttribute('contenteditable', 'true');
    document.body.append(target);
    try {
      await act(async () => dispatch('NumpadSubtract', '-', target));
      expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('6');
    } finally { target.remove(); }
  });

  it('keeps numpad actions inert at the same min and max limits as the buttons', async () => {
    await act(async () => updateSetting('homeThumbnailColumns', 10));
    await act(async () => dispatch('NumpadSubtract', '-'));
    expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('10');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails smaller"]')!.disabled).toBe(true);
    await act(async () => updateSetting('homeThumbnailColumns', 3));
    await act(async () => dispatch('NumpadAdd', '+'));
    expect(localStorage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('3');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails larger"]')!.disabled).toBe(true);
  });

  it('shows formatted shortcut hints only when the existing setting is enabled', async () => {
    const smaller = host.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails smaller"]')!;
    const larger = host.querySelector<HTMLButtonElement>('[aria-label="Make thumbnails larger"]')!;
    expect(smaller.title).toContain(formatShortcut('thumbnailSizeDecrease'));
    expect(larger.title).toContain(formatShortcut('thumbnailSizeIncrease'));
    await act(async () => updateSetting('showKeyboardShortcuts', false));
    expect(localStorage.getItem(SHOW_KEYBOARD_SHORTCUTS_KEY)).toBe('false');
    expect(smaller.title).toBe(smaller.getAttribute('aria-label'));
    expect(larger.title).toBe(larger.getAttribute('aria-label'));
    await act(async () => updateSetting('showKeyboardShortcuts', true));
    await act(async () => changeAppLanguage('ja'));
    expect(smaller.title).toContain(formatShortcut('thumbnailSizeDecrease'));
    expect(larger.title).toContain(formatShortcut('thumbnailSizeIncrease'));
  });
});
