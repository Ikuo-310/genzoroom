// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsButton, SettingsProvider } from './SettingsDialog';
import { changeAppLanguage } from './i18n';
import { updateSetting } from './appSettings';
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
