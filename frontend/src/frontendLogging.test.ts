// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createFrontendLogger, createFrontendLogsReport, exportFrontendLogsReport,
  DEFAULT_FRONTEND_LOG_LEVEL, FRONTEND_LOG_CAPACITY, type LogLevel, type LogEntryLevel } from './frontendLogging';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const levels: LogEntryLevel[] = ['error', 'warn', 'info', 'debug'];

it.each< [LogLevel, number] >([['off', 0], ['error', 1], ['warn', 2], ['info', 3], ['debug', 4]])('filters at %s', (level, count) => {
  const logger = createFrontendLogger();
  expect(logger.getLevel()).toBe(DEFAULT_FRONTEND_LOG_LEVEL);
  logger.add({ level: 'error', component: 'test', event: 'before.enabled' });
  expect(logger.getEntries()).toEqual([]);
  logger.setLevel(level);
  levels.forEach(level => logger.add({ level, component: 'test', event: 'filter' }));
  expect(logger.getEntries().map(entry => entry.level)).toEqual(levels.slice(0, count));
  expect(logger.getLevel()).toBe(level);
});

it('captures UTC frontend entries and keeps deep snapshots across input, getter and report mutations', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T01:02:03+09:00'));
  const logger = createFrontendLogger(); logger.setLevel('info');
  const context = { operationCount: 3, nested: { flags: [true] } };
  logger.add({ level: 'info', component: 'stack', event: 'apply.completed', context });
  context.nested.flags.push(false);
  const entries = logger.getEntries();
  expect(entries).toEqual([{ timestamp: '2026-10-03T16:02:03.000Z', source: 'frontend', level: 'info',
    component: 'stack', event: 'apply.completed', context: { operationCount: 3, nested: { flags: [true] } } }]);
  const report = createFrontendLogsReport(entries, new Date('2026-10-04T02:00:00+09:00'));
  expect(report).toEqual({ schemaVersion: 1, generatedAt: '2026-10-03T17:00:00.000Z', source: 'frontend', entries });
  entries[0].context!.operationCount = 99; entries[0].event = 'changed'; entries.push(entries[0]);
  report.entries[0].context!.operationCount = 88;
  expect(logger.getEntries()[0].context!.operationCount).toBe(3);
  expect(logger.getEntries()[0].event).toBe('apply.completed');
  expect(logger.getEntries()).toHaveLength(1);
});

it('wraps the ring in chronological insertion order, clears it and retains the configured level', () => {
  const logger = createFrontendLogger(); logger.setLevel('debug');
  for (let index = 0; index < FRONTEND_LOG_CAPACITY * 2 + 3; index++) {
    logger.add({ level: 'debug', component: 'test', event: 'ring', context: { index } });
  }
  const entries = logger.getEntries();
  expect(entries).toHaveLength(FRONTEND_LOG_CAPACITY);
  expect(entries.map(entry => entry.context!.index)).toEqual(Array.from({ length: FRONTEND_LOG_CAPACITY }, (_, index) => index + FRONTEND_LOG_CAPACITY + 3));
  logger.setLevel('off'); expect(logger.getEntries()).toHaveLength(FRONTEND_LOG_CAPACITY);
  logger.clear(); expect(logger.getEntries()).toEqual([]); expect(logger.getLevel()).toBe('off');
  logger.setLevel('error'); logger.add({ level: 'error', component: 'test', event: 'after.clear' });
  expect(logger.getEntries()).toHaveLength(1);
  expect(createFrontendLogger().getLevel()).toBe('off');
});

it.each(['api_key', 'Cookie', 'Authorization', 'sessionToken', 'password', 'secret', 'urlCredential', 'Recipe', 'History', 'Clipboard', 'photoBinary'])('rejects the entire context containing %s, also during export', key => {
  const logger = createFrontendLogger(); logger.setLevel('debug');
  logger.add({ level: 'warn', component: 'test', event: 'privacy', context: { nested: { [key]: 'PRIVATE_FIXTURE' }, count: 1 } });
  expect(logger.getEntries()[0].context).toBeUndefined();
  const entry = { ...logger.getEntries()[0], context: { [key]: 'PRIVATE_FIXTURE' }, extra: 'PRIVATE_EXTRA' };
  expect(JSON.stringify(createFrontendLogsReport([entry]))).not.toMatch(/PRIVATE|context|extra/);
});

it('rejects oversized, circular, binary, non-finite and accessor contexts without interrupting logging', () => {
  const logger = createFrontendLogger(); logger.setLevel('debug');
  const circular: Record<string, unknown> = {}; circular.self = circular;
  const getter = vi.fn(() => 'PRIVATE');
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
  for (const context of [{ text: 'x'.repeat(257) }, { data: new Uint8Array(2) }, { value: Infinity }, circular, accessor,
    Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, 'x'.repeat(256)]))]) {
    logger.add({ level: 'error', component: 'test', event: 'invalid.context', context: context as never });
  }
  expect(logger.getEntries()).toHaveLength(6);
  expect(logger.getEntries().every(entry => entry.context === undefined)).toBe(true);
  expect(getter).not.toHaveBeenCalled();
  expect(() => logger.setLevel('invalid' as never)).toThrow();
  logger.add({ level: 'off' as never, component: 'test', event: 'invalid' });
  logger.add({ level: 'error', component: 'translated component', event: 'invalid' });
  expect(logger.getEntries()).toHaveLength(6);
});

it('downloads an independent machine-readable JSON snapshot with the shared download lifecycle', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const create = vi.fn((_blob: Blob) => 'blob:logs'); const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('genzoroom-frontend-logs-20261003T160000Z.json');
  });
  try {
    const logger = createFrontendLogger(); logger.setLevel('error');
    logger.add({ level: 'error', component: 'renderer', event: 'initialization.failed' });
    const report = createFrontendLogsReport(logger.getEntries(), new Date('2026-10-03T16:00:00Z'));
    exportFrontendLogsReport(report); expect(click).toHaveBeenCalledOnce();
    const blob = create.mock.calls[0][0]; expect(blob.type).toBe('application/json');
    const text = await new Promise<string>(resolve => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob);
    });
    expect(JSON.parse(text)).toEqual(report);
    expect(report.entries[0]).not.toHaveProperty('message');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled(); vi.runAllTimers();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:logs');
  } finally { Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL'); }
});
