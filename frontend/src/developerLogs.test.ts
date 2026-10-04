import { afterEach, expect, it, vi } from 'vitest';
import { clearBackendLogs, createAllLogsReport, formatLogTimestamp, getBackendLogLevel, getBackendLogsReport,
  disableBackendLoggingOnExit, mergeLogEntries, parseBackendLevel, parseBackendLogsReport, setBackendLogLevel, type BackendLogEntry } from './developerLogs';
import type { FrontendLogEntry } from './frontendLogging';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const backend: BackendLogEntry = { timestamp: '2026-10-03T16:16:42.381Z', source: 'backend', level: 'debug',
  component: 'immich', event: 'request.response', context: { requestId: 'request-1', httpStatus: 200 } };
const frontend: FrontendLogEntry = { ...backend, source: 'frontend', component: 'stack', event: 'apply.completed' };
const report = { schemaVersion: 1, generatedAt: backend.timestamp, source: 'backend', entries: [backend] };

it.each(['off', 'error', 'warn', 'info', 'debug'])('validates %s level responses', level => {
  expect(parseBackendLevel({ level, extra: 'PRIVATE' })).toBe(level);
});
it.each([null, [], {}, { level: 'WARNING' }, { level: 1 }])('rejects malformed level %j', value => {
  expect(() => parseBackendLevel(value)).toThrow();
});
it.each([null, { ...report, source: 'frontend' }, { ...report, schemaVersion: 2 }, { ...report, generatedAt: 'invalidZ' },
  { ...report, generatedAt: '2026-02-30T00:00:00Z' }, { ...report, entries: [{ ...backend, level: 'off' }] },
  { ...report, entries: [{ ...backend, timestamp: '2026-10-03T16:16:42+09:00' }] },
  { ...report, entries: [{ ...backend, context: [] }] }, { ...report, entries: [{ ...backend, event: 'translated event' }] },
  { ...report, entries: [{ ...backend, message: 1 }] }])('rejects malformed report %j', value => {
  expect(() => parseBackendLogsReport(value)).toThrow();
});
it('projects Backend privacy fields and creates independent UTC All reports', () => {
  const value = { ...report, secret: 'PRIVATE', entries: [{ ...backend, extra: 'PRIVATE',
    context: { memberIds: ['asset-1', 'asset-2'], historyCursor: 2, authorization: 'PRIVATE' } }] };
  const parsed = parseBackendLogsReport(value);
  const all = createAllLogsReport([{ ...frontend, context: { recipeVersion: 1, apiKey: 'PRIVATE' } }], parsed, new Date('2026-10-04T01:00:00+09:00'));
  expect(Object.keys(all)).toEqual(['schemaVersion', 'generatedAt', 'frontend', 'backend']);
  expect(all.generatedAt).toBe('2026-10-03T16:00:00.000Z');
  expect(all.frontend[0].timestamp).toBe(frontend.timestamp);
  expect(all.backend[0].timestamp).toBe(backend.timestamp);
  expect(all.backend[0].context).toEqual({ memberIds: ['asset-1', 'asset-2'], historyCursor: 2 });
  expect(all.frontend[0].context).toEqual({ recipeVersion: 1 });
  expect(JSON.stringify(all)).not.toContain('PRIVATE');
  all.backend[0].context!.historyCursor = 99;
  expect(parsed.entries[0].context!.historyCursor).toBe(2);
});
it('merges chronologically with deterministic equal-time source/insertion order and no buffer mutation', () => {
  const early = { ...backend, timestamp: '2026-10-03T16:00:00.000Z' };
  const fe = [frontend, { ...frontend, event: 'second' }];
  const be = [backend, early];
  expect(mergeLogEntries(fe, be).map(entry => [entry.source, entry.event])).toEqual([
    ['backend', early.event], ['frontend', frontend.event], ['frontend', 'second'], ['backend', backend.event],
  ]);
  expect(be).toEqual([backend, early]);
});
it('formats browser local timezone with milliseconds independently of language', () => {
  const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23', fractionalSecondDigits: 3 }).formatToParts(new Date(backend.timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  expect(formatLogTimestamp(backend.timestamp)).toBe(`${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}.${values.fractionalSecond}`);
  expect(backend.timestamp).toBe('2026-10-03T16:16:42.381Z');
  expect(formatLogTimestamp('invalid')).toBe('—');
});
it('preserves optional overflow evidence in Backend and All snapshots and rejects invalid counts', () => {
  const parsed = parseBackendLogsReport({ ...report, buffer: { capacity: 5000, droppedEntryCount: 23, secret: 'PRIVATE' } });
  const all = createAllLogsReport([frontend], parsed, new Date(), { capacity: 1000, droppedEntryCount: 12 });
  expect(all.buffers).toEqual({ frontend: { capacity: 1000, droppedEntryCount: 12 }, backend: { capacity: 5000, droppedEntryCount: 23 } });
  expect(JSON.stringify(all)).not.toContain('PRIVATE');
  for (const buffer of [{ capacity: 5000, droppedEntryCount: -1 }, { capacity: 5000, droppedEntryCount: Infinity }, { capacity: 1000, droppedEntryCount: 0 }, null]) {
    expect(() => parseBackendLogsReport({ ...report, buffer })).toThrow();
  }
  expect(parseBackendLogsReport(report).buffer).toBeUndefined();
});
it('uses the four narrow API operations with no-store, abort signals and level validation', async () => {
  const signal = new AbortController().signal;
  const fetch = vi.fn(async (url: string, options?: RequestInit): Promise<{ ok: boolean; json: () => Promise<unknown> }> => ({ ok: true, json: async () =>
    url.endsWith('/level') ? { level: options?.method === 'PUT' ? 'debug' : 'off' } : report }));
  vi.stubGlobal('fetch', fetch);
  expect(await getBackendLogLevel(signal)).toBe('off');
  expect(await setBackendLogLevel('debug', signal)).toBe('debug');
  expect(await getBackendLogsReport(signal)).toEqual(report);
  await clearBackendLogs(signal);
  expect(fetch.mock.calls.map(([url, options]) => [url, options?.method ?? 'GET'])).toEqual([
    ['/api/developer/logs/backend/level', 'GET'], ['/api/developer/logs/backend/level', 'PUT'],
    ['/api/developer/logs/backend', 'GET'], ['/api/developer/logs/backend', 'DELETE'],
  ]);
  expect(fetch.mock.calls.every(([, options]) => options?.signal === signal && options.cache === 'no-store')).toBe(true);
  expect(fetch.mock.calls[1][1]?.body).toBe('{"level":"debug"}');
  fetch.mockImplementation(async () => ({ ok: true, json: async () => ({ level: 'info' }) }));
  await expect(setBackendLogLevel('debug', signal)).rejects.toThrow();
  fetch.mockImplementation(async () => ({ ok: false, json: async () => ({ secret: 'PRIVATE' }) }));
  await expect(getBackendLogsReport(signal)).rejects.toThrow('Developer logs request failed');
});
it('sends best-effort backend OFF with keepalive and absorbs fetch failures', async () => {
  const fetch = vi.fn(async (_url: string, _options?: RequestInit) => ({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  expect(() => disableBackendLoggingOnExit()).not.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe('/api/developer/logs/backend/level');
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: '{"level":"off"}', cache: 'no-store', keepalive: true });
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('signal');

  vi.stubGlobal('fetch', vi.fn((_url: string, _options?: RequestInit) => Promise.reject(new Error('offline'))));
  expect(() => disableBackendLoggingOnExit()).not.toThrow();
  await Promise.resolve();
  vi.stubGlobal('fetch', vi.fn((_url: string, _options?: RequestInit) => { throw new Error('unavailable'); }));
  expect(() => disableBackendLoggingOnExit()).not.toThrow();
});
