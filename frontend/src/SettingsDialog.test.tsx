// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsButton, SettingsProvider } from './SettingsDialog';
import { changeAppLanguage } from './i18n';
import { ANSHITSU_INITIAL_SELECTION_KEY, DATE_LOCALE_KEY, DATE_LOCALES, SHOW_KEYBOARD_SHORTCUTS_KEY, updateSetting } from './appSettings';
import { WebGpuAdjustmentRenderer } from './webgpuAdjustmentRenderer';

vi.mock('./webgpuAdjustmentRenderer', () => ({ WebGpuAdjustmentRenderer: { create: vi.fn() } }));
let host: HTMLDivElement, root: Root;
const fetchMock = vi.fn();
async function click(element: HTMLElement) { await act(async () => element.click()); }
const dialog = () => host.querySelector<HTMLDialogElement>('dialog')!;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  await changeAppLanguage('en');
  updateSetting('dateLocale', 'auto'); updateSetting('weekStart', 'auto'); updateSetting('initialImage', 'auto');
  updateSetting('showKeyboardShortcuts', true);
  vi.stubGlobal('isSecureContext', false);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false; } });
  fetchMock.mockReset().mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith('/health') ? { status: 'ok' }
    : url.endsWith('/status') ? { configured: true, connected: true } : { version: 'v3.0.0', build: 'release', sourceRef: 'main' } }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<SettingsProvider><SettingsButton /></SettingsProvider>));
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});
describe('shared Settings modal', () => {
  it('uses native grouped radios for shortcut hints and retains session choice when storage fails', async () => {
    await click(host.querySelector('button')!);
    const group = dialog().querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Show keyboard shortcuts');
    const radios = group.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(2);
    expect(radios[0].name).toBe(radios[1].name);
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
    await click(radios[1]);
    expect(radios[1].checked).toBe(true);
    expect(localStorage.getItem(SHOW_KEYBOARD_SHORTCUTS_KEY)).toBe('false');
    radios[0].focus(); expect(document.activeElement).toBe(radios[0]);
    await click(radios[0]);
    expect(localStorage.getItem(SHOW_KEYBOARD_SHORTCUTS_KEY)).toBe('true');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied'); });
    await click(radios[1]);
    await click(dialog().querySelector('header button')!); await click(host.querySelector('button')!);
    expect(dialog().querySelector<HTMLInputElement>('input[value="false"]')!.checked).toBe(true);
  });
  it('shows the Non-RAW default, keeps RAW presets disabled, and exposes a keyboard-dismissable translated explanation', async () => {
    await click(host.querySelector('button')!);
    const group = dialog().querySelector<HTMLElement>('.anshitsu-selection-options')!;
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map(radio => radio.value)).toEqual(['nonRaw', 'raw', 'both']);
    expect(radios[0].checked).toBe(true);
    expect(radios.slice(1).every(radio => radio.disabled)).toBe(true);
    expect(localStorage.getItem(ANSHITSU_INITIAL_SELECTION_KEY)).toBeNull();
    const info = dialog().querySelector<HTMLButtonElement>('.anshitsu-selection-info-button')!;
    expect(info.getAttribute('aria-expanded')).toBe('false');
    await click(info);
    expect(info.getAttribute('aria-expanded')).toBe('true');
    expect(dialog().querySelector('[role="note"]')?.textContent).toContain('Gallery type badges');
    act(() => info.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(dialog().open).toBe(true);
    expect(dialog().querySelector('[role="note"]')).toBeNull();
    expect(document.activeElement).toBe(info);
    await act(async () => changeAppLanguage('ja'));
    expect(dialog().querySelector<HTMLElement>('.anshitsu-initial-selection-label')?.textContent).toContain('暗室送りの初期設定');
    await click(info);
    expect(dialog().querySelector('[role="note"]')?.textContent).toContain('種別バッジ');
  });
  it('closes the initial-selection explanation on an outside pointer press', async () => {
    await click(host.querySelector('button')!);
    const info = dialog().querySelector<HTMLButtonElement>('.anshitsu-selection-info-button')!;
    await click(info);
    act(() => dialog().querySelector('header button')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(dialog().querySelector('[role="note"]')).toBeNull();
    expect(dialog().open).toBe(true);
  });
  it('offers two date Auto modes before a disabled separator and never saves the separator', async () => {
    await click(host.querySelector('button')!);
    const select = dialog().querySelectorAll<HTMLSelectElement>('select')[1]!;
    const options = [...select.options];
    expect(options.map(option => option.value)).toEqual(['auto', 'auto-language', '', ...DATE_LOCALES]);
    expect(options[0].textContent).toBe('Auto (browser regional settings)');
    expect(options[1].textContent).toBe('Auto (follow language)');
    expect(options[2].disabled).toBe(true);
    await act(async () => { select.value = 'auto-language'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(localStorage.getItem(DATE_LOCALE_KEY)).toBe('auto-language');
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(localStorage.getItem(DATE_LOCALE_KEY)).toBe('auto-language');
    await click(dialog().querySelector('header button')!); await click(host.querySelector('button')!);
    expect(dialog().querySelectorAll<HTMLSelectElement>('select')[1]!.value).toBe('auto-language');
    await act(async () => changeAppLanguage('ja'));
    const translated = dialog().querySelectorAll<HTMLSelectElement>('select')[1]!.options;
    expect(translated[0].textContent).toBe('自動（ブラウザの地域設定）');
    expect(translated[1].textContent).toBe('自動（言語設定に同期）');
  });

  it('traps focus, closes with Escape and restores focus while isolating background shortcuts', async () => {
    const trigger = host.querySelector<HTMLButtonElement>('button')!; trigger.focus();
    await click(trigger);
    expect(dialog().open).toBe(true); expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(dialog().querySelector('h2')!.id).toBe(dialog().getAttribute('aria-labelledby'));
    const background = vi.fn(); window.addEventListener('keydown', background);
    try {
      const first = dialog().querySelector<HTMLButtonElement>('button')!;
      const last = dialog().querySelectorAll<HTMLButtonElement>('button');
      first.focus();
      act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
      expect(document.activeElement).toBe(last[last.length - 1]);
      act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
      expect(document.activeElement).toBe(first);
      for (const target of [window, dialog().querySelector('select')!]) {
        act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })));
        act(() => target.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad0', key: 'Insert', bubbles: true, cancelable: true })));
      }
      expect(background).not.toHaveBeenCalled();
      act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      expect(dialog()).toBeNull(); expect(document.activeElement).toBe(trigger);
    } finally { window.removeEventListener('keydown', background); }
  });
  it('closes only for a pointer press and release on the backdrop, without bubbling behind it', async () => {
    const trigger = host.querySelector<HTMLButtonElement>('button')!;
    const open = async () => { await click(trigger); return dialog(); };
    const bounds = { x: 10, y: 10, top: 10, left: 10, right: 310, bottom: 410, width: 300, height: 400, toJSON: () => ({}) };
    const send = (target: Element, type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
      act(() => target.dispatchEvent(event));
    };
    trigger.focus();
    let current = await open();
    vi.spyOn(current, 'getBoundingClientRect').mockReturnValue(bounds);
    const behind = vi.fn(); window.addEventListener('pointerup', behind);
    try {
      send(current, 'pointerdown', 5, 5); send(current, 'pointerup', 5, 5);
      expect(dialog()).toBeNull(); expect(document.activeElement).toBe(trigger); expect(behind).not.toHaveBeenCalled();

      current = await open(); vi.spyOn(current, 'getBoundingClientRect').mockReturnValue(bounds);
      send(current, 'pointerdown', 100, 100); send(current, 'pointerup', 100, 100);
      expect(dialog()).toBe(current);
      send(current, 'pointerdown', 100, 100); send(current, 'pointerup', 5, 5);
      expect(dialog()).toBe(current);
      send(current, 'pointerdown', 5, 5); send(current, 'pointerup', 100, 100);
      expect(dialog()).toBe(current);
      send(current, 'pointerdown', 5, 5); send(current, 'pointercancel', 5, 5);
      send(current, 'pointerup', 5, 5);
      expect(dialog()).toBe(current);
      send(current, 'pointerdown', 5, 5); send(current, 'pointerup', 5, 5);
      expect(dialog()).toBeNull(); expect(document.activeElement).toBe(trigger);
    } finally { window.removeEventListener('pointerup', behind); }
  });
  it('retains session preferences when localStorage is blocked and the dialog is reopened', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked'); });
    await click(host.querySelector('button')!);
    const select = dialog().querySelector<HTMLSelectElement>('select')!;
    await act(async () => { select.value = 'ja'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(dialog().querySelector('header button')!);
    await click(host.querySelector('button')!);
    expect(dialog().querySelector<HTMLSelectElement>('select')!.value).toBe('ja');
  });
  it('shows independent connection and safe server information', async () => {
    await click(host.querySelector('button')!);
    expect(dialog().textContent).toContain('Development build');
    expect(dialog().textContent).toContain('Backend: Connected');
    expect(dialog().textContent).toContain('v3.0.0');
    expect(dialog().textContent).toContain('release');
    expect(dialog().querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
  });
  it.each(['authentication_failed', 'unreachable'])('does not conflate %s about failure with the working photo connection', async error_code => {
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith('/health') ? { status: 'ok' }
      : url.endsWith('/status') ? { configured: true, connected: true } : { error_code } }));
    await click(host.querySelector('button')!);
    expect(dialog().textContent).toContain('Connected');
    expect(dialog().querySelector('.error-text')!.textContent).toContain(error_code === 'authentication_failed' ? 'server.about' : 'could not be retrieved');
    fetchMock.mockRejectedValue(new Error('Offline'));
    await click([...dialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check again')!);
    expect(dialog().textContent).toContain('Backend: Connection failed');
  });
  it('releases the Home probe immediately and does not fetch originals', async () => {
    vi.stubGlobal('isSecureContext', true); vi.stubGlobal('navigator', { gpu: {} });
    const probe = { available: true, dispose: vi.fn() };
    vi.mocked(WebGpuAdjustmentRenderer.create).mockResolvedValue(probe as unknown as WebGpuAdjustmentRenderer);
    await click(host.querySelector('button')!);
    expect(probe.dispose).toHaveBeenCalledOnce();
    expect(dialog().querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(false);
    expect(dialog().textContent).not.toContain('GPU active');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/original'))).toBe(false);
  });
});

it.each([
  { platform: 'Win32', primary: { ctrlKey: true }, opposite: { metaKey: true } },
  { platform: 'MacIntel', primary: { metaKey: true }, opposite: { ctrlKey: true } },
])('opens Developer only for the platform Primary click: %o', async ({ platform, primary, opposite }) => {
  vi.stubGlobal('navigator', { platform });
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const button = host.querySelector('button')!;
  const afterClick = vi.fn();
  window.addEventListener('click', afterClick, { once: true });
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, ...primary })));
  expect(open).toHaveBeenCalledExactlyOnceWith('/developer', '_blank', 'noopener,noreferrer');
  expect(open.mock.invocationCallOrder[0]).toBeLessThan(afterClick.mock.invocationCallOrder[0]);
  expect(dialog()).toBeNull();
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, ...opposite })));
  expect(open).toHaveBeenCalledOnce();
  expect(dialog().open).toBe(true);
  await click(dialog().querySelector('header button')!);
  await click(button);
  expect(dialog().open).toBe(true);
  expect(open).toHaveBeenCalledOnce();
});
