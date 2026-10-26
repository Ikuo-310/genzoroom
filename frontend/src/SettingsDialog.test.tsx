// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applicationBuildLabel, SettingsButton, SettingsProvider } from './SettingsDialog';
import { BUILD_INFO } from './buildInfo';
import { changeAppLanguage } from './i18n';
import { ANSHITSU_INITIAL_SELECTION_KEY, DATE_LOCALE_KEY, DATE_LOCALES, SHOW_KEYBOARD_SHORTCUTS_KEY, readSettings, updateSetting, ZOOM_NAVIGATOR_POSITION_KEY, ZOOM_NAVIGATOR_POSITIONS } from './appSettings';
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
  updateSetting('anshitsuInitialSelection', 'nonRaw');
  updateSetting('zoomNavigatorPosition', 'bottom-right');
  localStorage.removeItem(ZOOM_NAVIGATOR_POSITION_KEY);
  localStorage.removeItem(ANSHITSU_INITIAL_SELECTION_KEY);
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
  Reflect.deleteProperty(window, '__GENZOROOM_DESKTOP__');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});
describe('shared Settings modal', () => {
  it('persists the Navigator position choices and falls back to bottom-right for invalid storage', async () => {
    expect(readSettings().zoomNavigatorPosition).toBe('bottom-right');
    await click(host.querySelector('button')!);
    const label = [...dialog().querySelectorAll('label')].find(item => item.textContent?.includes('Zoom Navigator Position'))!;
    const select = label.querySelector('select')!;
    expect(select.value).toBe('bottom-right');
    expect([...select.options].map(option => option.value)).toEqual([...ZOOM_NAVIGATOR_POSITIONS]);
    await act(async () => { select.value = 'top-left'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(localStorage.getItem(ZOOM_NAVIGATOR_POSITION_KEY)).toBe('top-left');
    await act(async () => changeAppLanguage('ja'));
    expect(label.textContent).toContain('拡大表示ナビゲーターの位置');
    expect([...select.options].map(option => option.textContent)).toEqual(['表示しない', '左上', '右上', '左下', '右下']);
    localStorage.setItem(ZOOM_NAVIGATOR_POSITION_KEY, 'center');
    expect(readSettings().zoomNavigatorPosition).toBe('bottom-right');
  });

  it('unlocks and saves RAW and Both only after the Windows RAW capability is available', async () => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) => url === '/api/raw/capabilities'
      ? new Response(JSON.stringify({ available: true, version: '0.14.0' }), { headers: { 'Content-Type': 'application/json' } }) : fallback(url));
    await click(host.querySelector('button')!);
    const radios = [...dialog().querySelectorAll<HTMLInputElement>('.anshitsu-selection-options input')];
    expect(radios.every(radio => !radio.disabled)).toBe(true);
    await click(radios[1]); expect(localStorage.getItem(ANSHITSU_INITIAL_SELECTION_KEY)).toBe('raw');
    await click(radios[2]); expect(localStorage.getItem(ANSHITSU_INITIAL_SELECTION_KEY)).toBe('both');
  });
  it('synchronizes the resolved app language to the native menu only in desktop mode', async () => {
    const setMenuLanguage = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, '__GENZOROOM_DESKTOP__', {
      configurable: true,
      value: { respond: vi.fn().mockResolvedValue(undefined), setMenuLanguage },
    });
    await act(async () => {
      root.unmount();
      root = createRoot(host);
      root.render(<SettingsProvider><SettingsButton /></SettingsProvider>);
    });
    expect(setMenuLanguage).toHaveBeenLastCalledWith('en');
    await act(async () => changeAppLanguage('ja'));
    expect(setMenuLanguage).toHaveBeenLastCalledWith('ja');
  });
  it('opens the existing Settings dialog from the native menu event without duplicating it', async () => {
    act(() => window.dispatchEvent(new Event('genzoroom:open-settings')));
    expect(dialog().querySelector('h2')?.textContent).toBe('Settings');
    act(() => window.dispatchEvent(new Event('genzoroom:open-settings')));
    await click(host.querySelector('button')!);
    expect(host.querySelectorAll('dialog')).toHaveLength(1);
  });
  it('shows About with the embedded build metadata and localizes its labels', async () => {
    act(() => window.dispatchEvent(new Event('genzoroom:show-about')));
    expect(dialog().querySelector('h2')?.textContent).toBe('About GenzoRoom');
    expect(dialog().textContent).toContain(BUILD_INFO.name);
    expect(dialog().textContent).toContain(BUILD_INFO.version);
    expect(dialog().textContent).toContain(applicationBuildLabel(BUILD_INFO, key => key === 'settings.development' ? 'Development build' : key));
    expect(dialog().textContent).toContain('AGPL-3.0-only');
    const outsideKey = new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true, ctrlKey: true });
    act(() => document.body.dispatchEvent(outsideKey));
    expect(outsideKey.defaultPrevented).toBe(true);
    await act(async () => changeAppLanguage('ja'));
    expect(dialog().querySelector('h2')?.textContent).toBe('GenzoRoomについて');
    expect(dialog().textContent).toContain('ライセンス');
  });
  it('does not expose Windows connection settings or request credentials in a browser', async () => {
    await click(host.querySelector('button')!);
    expect(host.textContent).not.toContain('Windows Immich connection');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/__local/connection'))).toBe(false);
  });
  it('localizes each embedded release channel and does not present validation as stable', async () => {
    const { default: i18n } = await import('./i18n');
    const tr = (key: string) => i18n.t(key);
    expect(applicationBuildLabel({ name: 'GenzoRoom', version: '0.0.0-development', channel: 'development', commit: null }, tr))
      .toBe(i18n.t('settings.development'));
    expect(applicationBuildLabel({ name: 'GenzoRoom', version: '0.0.0-validation', channel: 'validation', commit: 'abcdef0123456789'.padEnd(40, '0') }, tr))
      .toBe(`${i18n.t('settings.validation')} (abcdef0)`);
    expect(applicationBuildLabel({ name: 'GenzoRoom', version: 'v0.1.0', channel: 'stable', commit: 'a'.repeat(40) }, tr))
      .toBe(`${i18n.t('settings.stable')} · v0.1.0`);
  });
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
    const groups = dialog().querySelectorAll<HTMLElement>('.settings-connection-group');
    expect(groups).toHaveLength(3);
    expect(groups[0].querySelector('h4')?.textContent).toBe('GenzoRoom');
    expect(groups[0].textContent).toContain('Backend: Connected');
    expect(groups[1].querySelector('h4')?.textContent).toBe('Immich');
    expect(groups[1].querySelector('dl')?.textContent).toContain('v3.0.0');
    expect(groups[1].querySelector('button')?.textContent).toBe('Check again');
    expect(dialog().textContent).toContain('Development build');
    expect(dialog().textContent).not.toContain('v0.1.0');
    expect(dialog().textContent).toContain('Backend: Connected');
    expect(dialog().textContent).toContain('v3.0.0');
    expect(dialog().textContent).toContain('release');
    expect(dialog().querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
  });
  it.each([
    { state: 'disabled', artifact: null },
    { state: 'ready', version: '0.14.0', artifact: { version: '0.14.0' } },
    { state: 'ready', version: '0.14.0', artifact: { version: '9.9.9', upstreamCommit: 'a'.repeat(40), managedPatch: true, geometryDescriptorContract: 2 } },
    null,
  ])('does not claim a LightCraft version from unavailable or malformed metadata %#', async metadata => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) => url === '/api/raw/capabilities'
      ? { ok: true, json: async () => metadata } : fallback(url));
    await click(host.querySelector('button')!);
    const group = dialog().querySelectorAll('.settings-connection-group')[2];
    expect(group.textContent).toContain('Unavailable');
    expect(group.textContent).not.toContain('0.14.0');
  });
  it('shows the verified process version and discards a response from before refresh', async () => {
    const fallback = fetchMock.getMockImplementation()!;
    const waiting: ((value: unknown) => void)[] = [];
    const metadata = (version: string) => ({ state: 'ready', available: true, version,
      artifact: { version, upstreamCommit: 'a'.repeat(40), managedPatch: true, geometryDescriptorContract: 2 } });
    fetchMock.mockImplementation(async (url: string) => url === '/api/raw/capabilities'
      ? { ok: true, json: () => new Promise(resolve => waiting.push(resolve)) } : fallback(url));
    await click(host.querySelector('button')!);
    fetchMock.mockImplementation(async (url: string) => url === '/api/raw/capabilities'
      ? { ok: true, json: async () => metadata('0.14.0') } : fallback(url));
    await click([...dialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check again')!);
    expect(dialog().querySelectorAll('.settings-connection-group')[2].textContent).toContain('LightCraft 0.14.0');
    await act(async () => waiting.forEach(resolve => resolve(metadata('9.9.9'))));
    expect(dialog().querySelectorAll('.settings-connection-group')[2].textContent).toContain('LightCraft 0.14.0');
    expect(dialog().textContent).not.toContain('9.9.9');
    expect(dialog().textContent).toContain('v3.0.0');
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
  it('places the status beside the WebGPU label and uses the accessible shared-style ON/OFF switch', async () => {
    await click(host.querySelector('button')!);
    const row = dialog().querySelector<HTMLElement>('.settings-webgpu-row')!;
    const label = row.querySelector(':scope > span')!;
    const status = row.querySelector<HTMLElement>('[role="status"]')!;
    const toggle = row.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(label.textContent).toBe('WebGPU');
    expect(label.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.className).toBe('webgpu-switch');
    expect(toggle.getAttribute('aria-label')).toBe('Use WebGPU');
    expect(toggle.getAttribute('aria-describedby')).toBe('webgpu-status');
    expect(toggle.querySelector('.webgpu-switch-on')?.textContent).toBe('ON');
    expect(toggle.querySelector('.webgpu-switch-off')?.textContent).toBe('OFF');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
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
