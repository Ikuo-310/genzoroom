// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { WindowsConnectionSettings } from './WindowsConnectionSettings';
import i18n from './i18n';

let host: HTMLDivElement, root: Root;
const request = vi.fn();
const respond = vi.fn();
const close = vi.fn();
const metadata = { url: '', keyConfigured: false, managed: true, source: 'saved', error: null as string | null, pendingRestart: false, cleanupPending: false };
let current = { ...metadata };
let failure: string | null;
let putPendingRestart = true;
const methods: string[] = [];
const secretsSent: string[] = [];
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__GENZOROOM_DESKTOP__', { respond });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  await i18n.changeLanguage('en');
  current = { ...metadata }; failure = null; putPendingRestart = true; methods.length = 0; secretsSent.length = 0;
  close.mockReset(); respond.mockReset().mockResolvedValue(undefined);
  request.mockReset().mockImplementation(async (_url, init) => {
    methods.push(init?.method ?? 'GET');
    if (!init?.method) return { ok: true, json: async () => current };
    if (init.body) secretsSent.push(JSON.parse(init.body).apiKey);
    if (!failure && init?.method === 'PUT') current = { ...current, pendingRestart: putPendingRestart, keyConfigured: true };
    if (!failure && init?.method === 'DELETE') current = { ...current, pendingRestart: true, keyConfigured: false };
    return { ok: !failure, json: async () => failure ? { error: failure } : { ...current, tested: 'user.read' } };
  });
  vi.stubGlobal('fetch', request);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => root.render(<WindowsConnectionSettings onClose={close} />)); }
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
async function click(text: string) { await act(async () => button(text).click()); }
async function input(type: string, value: string) {
  const element = host.querySelector<HTMLInputElement>(`input[type="${type}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('starts unconfigured, authenticates before saving, clears the secret and requests guarded restart', async () => {
  await mount();
  expect(button('Save and restart Backend').disabled).toBe(true);
  const key = crypto.randomUUID();
  await input('url', 'http://immich.invalid'); await input('password', key);
  await click('Test connection');
  expect(button('Save and restart Backend').disabled).toBe(false);
  expect(respond).not.toHaveBeenCalled();
  await click('Save and restart Backend');
  expect(methods).toEqual(['GET', 'POST', 'PUT']);
  expect(secretsSent.every(value => value === key)).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
  expect(close).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledWith({ kind: 'restart' });
});
it('never fills a stored key and invalidates a successful test after editing', async () => {
  current = { ...current, url: 'https://immich.invalid', keyConfigured: true };
  await mount();
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
  await click('Test connection');
  expect(secretsSent).toEqual(['']);
  await input('url', 'http://other.invalid');
  expect(button('Save and restart Backend').disabled).toBe(true);
});
it('does not restart when saving an unchanged active connection', async () => {
  current = { ...current, url: 'http://immich.invalid', keyConfigured: true };
  putPendingRestart = false;
  await mount(); await click('Test connection'); await click('Save and restart Backend');
  expect(methods).toEqual(['GET', 'POST', 'PUT']);
  expect(close).not.toHaveBeenCalled(); expect(respond).not.toHaveBeenCalled();
  expect([...host.querySelectorAll('[role="status"]')].some(status => status.textContent === i18n.t('windowsConnection.savedWithoutRestart'))).toBe(true);
});
it.each(['authentication_failed', 'permission_denied', 'connection_timeout', 'tls_certificate_error', 'credential_write_failed'])
('keeps the dialog open and does not restart after %s', async code => {
  current = { ...current, url: 'http://immich.invalid', keyConfigured: true };
  failure = code;
  await mount(); await click('Test connection');
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(i18n.t(`windowsConnection.errors.${code}`));
  expect(button('Save and restart Backend').disabled).toBe(true);
  expect(close).not.toHaveBeenCalled(); expect(respond).not.toHaveBeenCalled();
});
it('retains a recoverable pending setting and can retry the existing lifecycle handshake', async () => {
  current = { ...current, pendingRestart: true, error: 'restart_failed' };
  await mount(); await click('Apply saved settings / retry restart');
  expect(respond).toHaveBeenCalledWith({ kind: 'restart' });
  expect(methods).toEqual(['GET']);
});
it('removes the saved connection before requesting the same guarded restart', async () => {
  current = { ...current, url: 'http://immich.invalid', keyConfigured: true };
  await mount(); await click('Remove saved connection');
  expect(methods).toEqual(['GET', 'DELETE']);
  expect(respond).toHaveBeenCalledWith({ kind: 'restart' });
});
it('makes explicit environment mode read-only instead of mixing configuration sources', async () => {
  current = { ...current, source: 'environment', url: 'http://saved.invalid', keyConfigured: true };
  await mount();
  expect(host.querySelector<HTMLInputElement>('input[type="url"]')!.disabled).toBe(true);
  expect(button('Test connection').disabled).toBe(true);
  expect(button('Remove saved connection').disabled).toBe(true);
});
