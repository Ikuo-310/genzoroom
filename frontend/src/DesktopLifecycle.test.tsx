// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopLifecycleProvider, useDesktopCloseGuard } from './DesktopLifecycle';
import i18n from './i18n';

const respond = vi.fn();
let host: HTMLDivElement;
let root: Root;
const prepare = vi.fn<() => Promise<boolean>>();
const resume = vi.fn();

function GuardedApp() {
  useDesktopCloseGuard({ prepare, resume });
  return <main>Workspace</main>;
}

function event(name: string, detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('__GENZOROOM_DESKTOP__', { respond });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  await i18n.changeLanguage('en');
  respond.mockReset().mockResolvedValue(undefined);
  prepare.mockReset(); resume.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<DesktopLifecycleProvider><GuardedApp /></DesktopLifecycleProvider>));
});

afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
});

it('ignores a stale cancellation after a newer close request has begun', async () => {
  let finishFirst!: (saved: boolean) => void;
  let finishSecond!: (saved: boolean) => void;
  prepare.mockImplementationOnce(() => new Promise<boolean>(resolve => { finishFirst = resolve; }))
    .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishSecond = resolve; }));
  const first = 'a'.repeat(64), second = 'b'.repeat(64);

  await act(async () => event('genzoroom:close-request', { requestId: first }));
  await flush();
  await act(async () => event('genzoroom:close-cancelled', { code: 'backend_exited_unexpectedly', requestId: first }));
  expect(resume).toHaveBeenCalledOnce();

  await act(async () => event('genzoroom:close-request', { requestId: second }));
  await flush();
  await act(async () => event('genzoroom:close-cancelled', { code: 'backend_exited_unexpectedly', requestId: first }));
  expect(document.body.querySelector('dialog[open]')).not.toBeNull();
  expect(document.body.textContent).toContain('Saving edits before closing');

  await act(async () => finishFirst(true));
  await act(async () => finishSecond(true));
  await flush();
  expect(respond).toHaveBeenCalledWith({ kind: 'closeResult', requestId: second, saved: true });
});

it('keeps the existing close guard active when a save fails', async () => {
  prepare.mockResolvedValue(false);
  const requestId = 'c'.repeat(64);
  await act(async () => event('genzoroom:close-request', { requestId }));
  await flush();
  expect(respond).toHaveBeenCalledWith({ kind: 'closeResult', requestId, saved: false });
  expect(resume).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain('Closing was cancelled');
});

it('does not let a delayed rejection for an old closeResult cancel the current request', async () => {
  let finishFirst!: (saved: boolean) => void;
  let finishSecond!: (saved: boolean) => void;
  let rejectFirstResponse!: (error: Error) => void;
  const first = 'd'.repeat(64), second = 'e'.repeat(64);
  prepare.mockImplementationOnce(() => new Promise<boolean>(resolve => { finishFirst = resolve; }))
    .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishSecond = resolve; }));
  respond.mockImplementation(message => {
    if (message.kind === 'closeResult' && message.requestId === first) {
      return new Promise((_resolve, reject) => { rejectFirstResponse = reject; });
    }
    return Promise.resolve();
  });

  await act(async () => event('genzoroom:close-request', { requestId: first }));
  await flush();
  await act(async () => finishFirst(true));
  await flush();
  expect(respond).toHaveBeenCalledWith({ kind: 'closeResult', requestId: first, saved: true });

  await act(async () => event('genzoroom:close-cancelled', { code: 'backend_exited_unexpectedly', requestId: first }));
  await act(async () => event('genzoroom:close-request', { requestId: second }));
  await flush();
  await act(async () => finishSecond(true));
  await flush();
  expect(document.body.textContent).toContain('Waiting for the current export and Backend to finish');

  await act(async () => rejectFirstResponse(new Error('stale request')));
  await flush();
  expect(document.body.textContent).toContain('Waiting for the current export and Backend to finish');
  expect(document.body.textContent).not.toContain('Closing was cancelled');
});
