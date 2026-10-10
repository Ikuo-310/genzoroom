// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { DeveloperLogs } from './DeveloperLogsPanel';
import { frontendLogger } from './frontendLogging';
import type { BackendLogsReport } from './developerLogs';

let host: HTMLDivElement, root: Root;
let level = 'off', failLevel = false, failReport = false, failClear = false, failPut = false;
let report: BackendLogsReport;
const initialReport = (): BackendLogsReport => ({ schemaVersion: 1, generatedAt: '2026-10-03T16:16:42.381Z', source: 'backend', entries: [{
  timestamp: '2026-10-03T16:16:41.381Z', source: 'backend', level: 'debug', component: 'immich', event: 'request.response',
  message: '<img src=x> technical', context: { memberIds: ['asset-1', 'asset-2'], httpStatus: 200, api_key: 'PRIVATE' },
}] });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frontendLogger.clear(); frontendLogger.setLevel('off');
  level = 'off'; failLevel = failReport = failClear = failPut = false; report = initialReport();
  fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.signal?.aborted) throw new Error('Aborted');
    if (url.endsWith('/immich/about')) return { ok: true, json: async () => ({ version: 'v3.2.4' }) };
    if (url.endsWith('/level')) {
      if (options?.method === 'PUT') { if (failPut) throw new Error('PRIVATE'); level = JSON.parse(options.body as string).level; }
      else if (failLevel) throw new Error('PRIVATE');
      return { ok: true, json: async () => ({ level }) };
    }
    if (options?.method === 'DELETE') { if (failClear) throw new Error('PRIVATE'); report = { ...report, entries: [] }; return { ok: true }; }
    if (failReport) throw new Error('PRIVATE');
    return { ok: true, json: async () => report };
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); frontendLogger.clear(); frontendLogger.setLevel('off');
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
  Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL');
});
const button = (key: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === i18n.t(`developer.logs.${key}`))!;
const card = (source: string) => host.querySelector(`#${source}-logs-title`)!.parentElement!;
const action = (source: string, key: string) => [...card(source).querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === i18n.t(`developer.logs.${key}`))!;
const viewer = () => host.querySelector('.developer-log-console')!;
const click = async (element: HTMLButtonElement) => { await act(async () => element.click()); };
const select = async (source: string, value: string) => {
  await act(async () => { const element = card(source).querySelector('select')!; element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); });
};
const mount = async () => { await act(async () => root.render(<DeveloperLogs />)); };
const feEntry = () => frontendLogger.add({ level: 'info', component: 'stack', event: 'apply.completed', context: { operationCount: 3 } });

it('controls levels independently and retains existing entries after level changes', async () => {
  frontendLogger.setLevel('info'); feEntry();
  await mount();
  expect(card('frontend').querySelector('select')!.value).toBe('info');
  expect(card('backend').querySelector('select')!.value).toBe('off');
  await select('frontend', 'debug'); await select('backend', 'warn');
  expect(frontendLogger.getLevel()).toBe('debug'); expect(level).toBe('warn');
  expect(viewer().textContent).toContain('apply.completed');
  failPut = true; await select('backend', 'debug');
  expect(card('backend').querySelector('select')!.value).toBe('warn');
  expect(host.textContent).toContain(i18n.t('developer.logs.levelUpdateFailed'));
  await select('frontend', 'off'); expect(frontendLogger.getEntries().some(entry => entry.event === 'apply.completed')).toBe(true);
});
it('shows the localized auto-off note above the log controls and preserves the existing controls', async () => {
  const originalLanguage = i18n.language;
  try {
    for (const [language, expected] of [
      ['ja', 'Developer Diagnosticsページを閉じると、ログ収集は自動的にOFFになります。'],
      ['en', 'Logging is automatically turned off when you close Developer Diagnostics.'],
    ] as const) {
      await i18n.changeLanguage(language);
      await mount();
      const note = host.querySelector<HTMLElement>('.developer-log-note')!;
      expect(note.textContent).toBe(expected);
      expect(note.compareDocumentPosition(card('frontend')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(note.className).toBe('developer-log-note');
      expect(card('frontend').querySelector('select')).not.toBeNull();
      expect(card('backend').querySelector('select')).not.toBeNull();
      for (const key of ['clear', 'export', 'clearAll', 'exportAll', 'refresh']) expect(button(key)).not.toBeNull();
      act(() => root.unmount()); root = createRoot(host);
    }
  } finally { await i18n.changeLanguage(originalLanguage); }
});
it('shows the same diagnostic level order and labels for Frontend and Backend', async () => {
  await mount();
  const expected = [['off', 'OFF'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR'], ['debug', 'ALL (DEBUG)']];
  for (const source of ['frontend', 'backend']) {
    const options = [...card(source).querySelectorAll<HTMLOptionElement>('select option')].map(option => [option.value, option.textContent]);
    expect(options).toEqual(expected);
  }
  expect(card('frontend').querySelector<HTMLOptionElement>('select option:last-child')?.value).toBe('debug');
  await select('frontend', 'debug');
  expect(frontendLogger.getLevel()).toBe('debug');
  await select('backend', 'debug');
  expect(level).toBe('debug');
});
it('updates Frontend and ALL views when shared logger entries, level or clear change remotely', async () => {
  await mount();
  await act(async () => frontendLogger.setLevel('debug'));
  expect(card('frontend').querySelector('select')!.value).toBe('debug');
  await act(async () => frontendLogger.add({ level: 'debug', component: 'stack_resolve', event: 'validation.mismatch',
    context: { selectedAssetId: 'asset-1', expectedStackId: 'stack-1', memberIds: ['asset-1', 'asset-2'] } }));
  expect(viewer().textContent).toContain('stack_resolve  validation.mismatch');
  expect(viewer().textContent).toContain('memberIds');
  await click([...host.querySelectorAll<HTMLButtonElement>('.developer-log-sources button')].find(item => item.textContent === 'Frontend')!);
  expect(viewer().textContent).toContain('validation.mismatch');
  await act(async () => frontendLogger.clear());
  expect(viewer().textContent).toContain(i18n.t('developer.logs.empty'));
});
it('shows source selection, all technical fields and escaped text without live announcements', async () => {
  frontendLogger.setLevel('info'); feEntry();
  await mount();
  expect(viewer().textContent).toContain('BE  DEBUG  immich  request.response');
  expect(viewer().textContent).toContain('FE  INFO  stack  apply.completed');
  expect(viewer().textContent).toContain('memberIds'); expect(viewer().textContent).toContain('<img src=x> technical');
  expect(viewer().querySelector('img')).toBeNull(); expect(viewer().textContent).not.toContain('PRIVATE');
  expect(viewer().hasAttribute('aria-live')).toBe(false); expect(viewer().getAttribute('tabindex')).toBe('0');
  for (const scope of ['Frontend', 'Backend', 'ALL']) {
    await click([...host.querySelectorAll<HTMLButtonElement>('.developer-log-sources button')].find(item => item.textContent === scope)!);
    expect([...host.querySelectorAll<HTMLButtonElement>('.developer-log-sources button')]
      .filter(item => item.getAttribute('aria-pressed') === 'true').map(item => item.textContent)).toEqual([scope]);
    if (scope === 'Frontend') expect(viewer().textContent).not.toContain('request.response');
    if (scope === 'Backend') expect(viewer().textContent).not.toContain('apply.completed');
  }
});
it('refreshes Frontend while retaining Backend snapshot on failure, and retries unknown Backend level', async () => {
  failLevel = true;
  await mount(); expect(host.textContent).toContain(i18n.t('developer.logs.levelUnavailable'));
  expect(card('frontend').querySelector('select')!.disabled).toBe(false);
  frontendLogger.setLevel('info'); feEntry(); failReport = true; failLevel = false;
  await click(button('refresh'));
  expect(viewer().textContent).toContain('apply.completed'); expect(viewer().textContent).toContain('request.response');
  expect(host.textContent).toContain(i18n.t('developer.logs.backend.refreshFailed'));
  expect(card('backend').querySelector('select')!.disabled).toBe(false);
  expect(host.textContent).not.toContain('PRIVATE');
});
it('clears each source and handles All partial failure without rollback', async () => {
  frontendLogger.setLevel('info'); feEntry(); await mount();
  await click(action('frontend', 'clear'));
  expect(frontendLogger.getEntries()).toEqual([]); expect(viewer().textContent).toContain('request.response');
  feEntry(); await click(button('refresh')); failClear = true;
  await click(button('clearAll'));
  expect(frontendLogger.getEntries().every(entry => entry.component === 'developer_logs')).toBe(true); expect(viewer().textContent).not.toContain('apply.completed');
  expect(viewer().textContent).toContain('request.response');
  expect(host.textContent).toContain(i18n.t('developer.logs.partialClearFailed'));
  expect(card('backend').textContent).toContain(i18n.t('developer.logs.backend.clearFailed'));
  failClear = false; await click(action('backend', 'clear'));
  await click(action('frontend', 'clear'));
  expect(viewer().textContent).toContain(i18n.t('developer.logs.empty'));
  feEntry(); report = initialReport(); await click(button('clearAll'));
  expect(frontendLogger.getEntries()).toEqual([]); expect(report.entries).toEqual([]);
});
it('still clears Backend when Frontend clear fails, and clears the snapshot after DELETE even if its GET fails', async () => {
  await mount();
  const clear = vi.spyOn(frontendLogger, 'clear').mockImplementation(() => { throw new Error('PRIVATE'); });
  await click(button('clearAll'));
  expect(report.entries).toEqual([]);
  expect(host.textContent).toContain(i18n.t('developer.logs.frontend.clearFailed'));
  expect(host.textContent).toContain(i18n.t('developer.logs.partialClearFailed'));
  clear.mockRestore();
  report = initialReport(); await click(button('refresh'));
  failReport = true; await click(action('backend', 'clear'));
  expect(viewer().textContent).toBe(i18n.t('developer.logs.empty'));
  expect(host.textContent).toContain(i18n.t('developer.logs.backend.logsUnavailable'));
});
it('downloads fresh independent FE/BE/All reports regardless of viewer selection and suppresses incomplete exports', async () => {
  frontendLogger.setLevel('info'); feEntry(); await mount();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const blobs: Blob[] = [], names: string[] = [];
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (blob: Blob) => { blobs.push(blob); return 'blob:logs'; } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
  const read = (blob: Blob) => new Promise<Record<string, any>>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(JSON.parse(String(reader.result))); reader.readAsText(blob); });
  fetchMock.mockClear();
  await click(action('frontend', 'export')); expect(names[0]).toMatch(/^genzoroom-frontend-logs-/);
  report.entries[0].event = 'fresh.response';
  await click(action('backend', 'export')); expect(names[1]).toMatch(/^genzoroom-backend-logs-/);
  const backendDownload = await read(blobs[1]);
  expect(backendDownload.entries[0].event).toBe('fresh.response');
  expect(backendDownload).toMatchObject({ schemaVersion: 2, application: { name: 'GenzoRoom' }, immich: { status: 'ok', version: 'v3.2.4' } });
  feEntry();
  await click(host.querySelectorAll<HTMLButtonElement>('.developer-log-sources button')[2]);
  await click(button('exportAll')); expect(names[2]).toMatch(/^genzoroom-all-logs-/);
  const all = await read(blobs[2]);
  expect(Object.keys(all)).toEqual(['schemaVersion', 'generatedAt', 'frontend', 'backend', 'buffers', 'application', 'immich']);
  expect(all.schemaVersion).toBe(2); expect(all.application.name).toBe('GenzoRoom');
  expect(all.immich).toMatchObject({ status: 'ok', version: 'v3.2.4', build: null, sourceRef: null });
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/immich/about')).toHaveLength(3);
  expect(all.frontend).toHaveLength(2); expect(all.backend).toHaveLength(1);
  expect(all.generatedAt).toMatch(/Z$/); expect(all.backend[0].timestamp).toMatch(/Z$/);
  expect(JSON.stringify(all)).not.toContain('PRIVATE');
  failReport = true; await click(button('exportAll'));
  expect(blobs).toHaveLength(3); expect(host.textContent).toContain(i18n.t('developer.logs.allExportFailed'));
  vi.runAllTimers();
});
it.each(['en', 'ja'])('translates empty, loading and error states in %s', async language => {
  const original = i18n.language;
  await i18n.changeLanguage(language);
  try {
    report.entries = []; failReport = true; failLevel = true;
    await mount();
    expect(viewer().textContent).toBe(i18n.t('developer.logs.empty'));
    expect(host.textContent).toContain(i18n.t('developer.logs.backend.logsUnavailable'));
    expect(host.textContent).not.toMatch(/developer\./);
  } finally { await act(async () => i18n.changeLanguage(original)); }
});
it('shows loading and keeps Frontend controls usable during a pending Backend snapshot', async () => {
  let resolve!: (value: unknown) => void;
  fetchMock.mockImplementation((url: string) => url.endsWith('/level')
    ? Promise.resolve({ ok: true, json: async () => ({ level: 'off' }) }) : new Promise(done => { resolve = done; }));
  await mount();
  expect(host.querySelector('[role="status"]')!.textContent).toBe(i18n.t('developer.logs.loading'));
  expect(action('frontend', 'clear').disabled).toBe(false);
  expect(card('frontend').querySelector('select')!.disabled).toBe(false);
  expect(button('refresh').disabled).toBe(true);
  await select('frontend', 'debug');
  expect(frontendLogger.getLevel()).toBe('debug');
  await act(async () => resolve({ ok: true, json: async () => ({ ...report, entries: [] }) }));
  expect(host.querySelector('[role="status"]')).toBeNull();
});
it('ignores a late initial snapshot across StrictMode cleanup and does not poll', async () => {
  let resolve!: (value: unknown) => void;
  let pending = true;
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith('/level')) return Promise.resolve({ ok: true, json: async () => ({ level: 'off' }) });
    if (pending) { pending = false; return new Promise(done => { resolve = done; }); }
    return Promise.resolve({ ok: true, json: async () => ({ ...report, entries: [] }) });
  });
  await act(async () => root.render(<StrictMode><DeveloperLogs /></StrictMode>));
  await act(async () => resolve({ ok: true, json: async () => initialReport() }));
  expect(viewer().textContent).toBe(i18n.t('developer.logs.empty'));
  expect(fetchMock).toHaveBeenCalledTimes(4);
});
it('records safe Backend failure transitions once, keeps snapshots and records a recurrence after recovery', async () => {
  frontendLogger.setLevel('warn');
  await mount(); failReport = true;
  for (let index = 0; index < 3; index++) await click(button('refresh'));
  expect(frontendLogger.getEntries()).toHaveLength(1);
  expect(frontendLogger.getEntries()[0]).toMatchObject({ level: 'warn', component: 'developer_logs',
    context: { action: 'backend.logs', errorCode: 'unreachable' } });
  expect(viewer().textContent).toContain('request.response');
  expect(viewer().textContent).toContain('operation.failed');
  failReport = false; await click(button('refresh')); failReport = true; await click(button('refresh'));
  expect(frontendLogger.getEntries()).toHaveLength(2);
  expect(JSON.stringify(frontendLogger.getEntries())).not.toContain('PRIVATE');
});
it('displays both overflow counts without discarding technical entries', async () => {
  frontendLogger.setLevel('debug');
  for (let index = 0; index < 1002; index++) frontendLogger.add({ level: 'debug', component: 'test', event: 'entry', context: { index } });
  report.buffer = { capacity: 5000, droppedEntryCount: 20 };
  await mount();
  expect(host.textContent).toContain(i18n.t('developer.logs.truncated', { source: 'Frontend', count: 2, capacity: 1000 }));
  expect(host.textContent).toContain(i18n.t('developer.logs.truncated', { source: 'Backend', count: 20, capacity: 5000 }));
  await click(action('frontend', 'clear'));
  expect(frontendLogger.getBufferStats().droppedEntryCount).toBe(0);
});
it('rejects an invalid Backend timestamp without replacing the usable prior snapshot', async () => {
  frontendLogger.setLevel('warn'); await mount();
  report.entries[0].timestamp = 'invalidZ';
  await click(button('refresh'));
  expect(viewer().textContent).toContain('request.response');
  expect(host.textContent).toContain(i18n.t('developer.logs.backend.refreshFailed'));
  expect(frontendLogger.getEntries()[0].context!.errorCode).toBe('unexpected_response');
});
