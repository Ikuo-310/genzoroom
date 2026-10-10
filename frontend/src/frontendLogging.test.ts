// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createFrontendLogger, createFrontendLogsReport, exportFrontendLogsReport,
  DEFAULT_FRONTEND_LOG_LEVEL, FRONTEND_LOG_CAPACITY, FRONTEND_LOG_CHANNEL_NAME, type FrontendLogChannel, type LogLevel, type LogEntryLevel } from './frontendLogging';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const levels: LogEntryLevel[] = ['error', 'warn', 'info', 'debug'];

function createChannelNetwork() {
  const channels: TestChannel[] = [];
  class TestChannel implements FrontendLogChannel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    readonly sent: unknown[] = [];
    constructor(readonly name: string) { channels.push(this); }
    postMessage(message: unknown): void {
      this.sent.push(structuredClone(message));
      for (const peer of channels) if (peer !== this && peer.name === this.name) peer.onmessage?.({ data: structuredClone(message) } as MessageEvent);
    }
    close(): void { const index = channels.indexOf(this); if (index >= 0) channels.splice(index, 1); }
    deliver(message: unknown): void { this.onmessage?.({ data: message } as MessageEvent); }
  }
  return { channels, channelFactory: (name: string) => new TestChannel(name) };
}

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

it('shares levels, answers a new tab handshake and does not echo remote level updates', () => {
  const network = createChannelNetwork();
  const first = createFrontendLogger({ broadcast: true, channelFactory: network.channelFactory });
  expect(first.getLevel()).toBe('off');
  first.setLevel('debug');
  const second = createFrontendLogger({ broadcast: true, channelFactory: network.channelFactory });
  expect(network.channels.map(channel => channel.name)).toEqual([FRONTEND_LOG_CHANNEL_NAME, FRONTEND_LOG_CHANNEL_NAME]);
  expect(second.getLevel()).toBe('debug');
  const secondSent = network.channels[1].sent.length;
  expect(network.channels[0].sent).toContainEqual({ type: 'level.set', level: 'debug' });
  expect(network.channels[0].sent).toContainEqual({ type: 'level.state', level: 'debug' });
  expect(network.channels[1].sent).toContainEqual({ type: 'level.request' });
  network.channels[0].deliver({ type: 'level.set', level: 'warn' });
  expect(first.getLevel()).toBe('warn');
  expect(network.channels[0].sent).toHaveLength(3);
  expect(network.channels[1].sent).toHaveLength(secondSent);
  first.dispose(); second.dispose();
});

it('keeps the default OFF with no peer and syncs local entries after source filtering and privacy projection', () => {
  const network = createChannelNetwork();
  const local = createFrontendLogger({ broadcast: true, channelFactory: network.channelFactory });
  local.add({ level: 'info', component: 'test', event: 'disabled' });
  expect(local.getEntries()).toEqual([]);
  expect(network.channels[0].sent.some(message => (message as { type?: string }).type === 'entry')).toBe(false);

  const remote = createFrontendLogger({ broadcast: true, channelFactory: network.channelFactory });
  local.setLevel('info');
  expect(remote.getLevel()).toBe('info');
  local.add({ level: 'debug', component: 'test', event: 'filtered' });
  local.add({ level: 'info', component: 'stack_resolve', event: 'validation.mismatch', context: {
    assetId: 'asset-1', memberIds: ['asset-1', 'asset-2'], authorization: 'PRIVATE',
  } });
  expect(local.getEntries()).toHaveLength(1);
  expect(remote.getEntries()).toEqual(local.getEntries());
  expect(remote.getEntries()[0].context).toEqual({ assetId: 'asset-1', memberIds: ['asset-1', 'asset-2'] });
  expect(JSON.stringify(network.channels[0].sent)).not.toContain('PRIVATE');
  expect(network.channels[0].sent.filter(message => (message as { type?: string }).type === 'entry')).toHaveLength(1);
  const remoteSent = network.channels[1].sent.length;
  expect(remoteSent).toBe(1);
  local.dispose(); remote.dispose();
});

it('reprojects remote entries, ignores malformed messages and notifies local subscribers', () => {
  const network = createChannelNetwork();
  const local = createFrontendLogger({ broadcast: true, channelFactory: network.channelFactory });
  const remote = createFrontendLogger({ broadcast: true, channelFactory: network.channelFactory });
  const observed = vi.fn();
  remote.subscribe(observed);
  network.channels[0].postMessage({ type: 'entry', entry: {
    timestamp: '2026-10-03T16:00:00.000Z', source: 'frontend', level: 'warn', component: 'stack_resolve', event: 'validation.mismatch',
    context: { selectedAssetId: 'asset-1', cookie: 'PRIVATE' }, unexpected: 'discarded',
  } });
  expect(remote.getEntries()).toHaveLength(1);
  expect(remote.getEntries()[0].context).toEqual({ selectedAssetId: 'asset-1' });
  expect(network.channels[1].sent.filter(message => (message as { type?: string }).type === 'entry')).toHaveLength(0);
  expect(observed).toHaveBeenCalledOnce();
  network.channels[0].postMessage({ type: 'entry', entry: { timestamp: 'invalid', source: 'frontend', level: 'debug', component: 'bad', event: 'entry' } });
  network.channels[0].postMessage({ type: 'unknown', secret: 'PRIVATE' });
  expect(remote.getEntries()).toHaveLength(1);
  expect(() => local.add({ level: 'info', component: 'test', event: 'still.running' })).not.toThrow();
  local.dispose(); remote.dispose();
});

it('synchronizes clear without echo and resets local and remote drop counts', () => {
  const network = createChannelNetwork();
  const local = createFrontendLogger({ broadcast: true, channelFactory: network.channelFactory });
  const remote = createFrontendLogger({ broadcast: true, channelFactory: network.channelFactory });
  local.setLevel('debug');
  for (let index = 0; index <= FRONTEND_LOG_CAPACITY; index++) {
    local.add({ level: 'debug', component: 'test', event: 'overflow', context: { index } });
  }
  expect(local.getBufferStats().droppedEntryCount).toBe(1);
  expect(remote.getBufferStats().droppedEntryCount).toBe(1);
  const remoteClearCount = network.channels[1].sent.filter(message => (message as { type?: string }).type === 'clear').length;
  local.clear();
  expect(local.getEntries()).toEqual([]); expect(remote.getEntries()).toEqual([]);
  expect(local.getBufferStats().droppedEntryCount).toBe(0); expect(remote.getBufferStats().droppedEntryCount).toBe(0);
  expect(network.channels[0].sent.filter(message => (message as { type?: string }).type === 'clear')).toHaveLength(1);
  expect(network.channels[1].sent.filter(message => (message as { type?: string }).type === 'clear')).toHaveLength(remoteClearCount);
  local.dispose(); remote.dispose();
});

it('isolates unavailable channels, posting failures and listener exceptions from local logging', () => {
  const unavailable = createFrontendLogger({ broadcast: true, channelFactory: () => { throw new Error('channel unavailable'); } });
  unavailable.setLevel('debug'); unavailable.add({ level: 'debug', component: 'test', event: 'local' });
  expect(unavailable.getEntries()).toHaveLength(1);

  let onmessage: ((event: MessageEvent) => void) | null = null;
  const broken = createFrontendLogger({ broadcast: true, channelFactory: () => ({
    get onmessage() { return onmessage; }, set onmessage(value) { onmessage = value; },
    postMessage() { throw new Error('transport unavailable'); }, close() { throw new Error('close unavailable'); },
  }) });
  const listener = vi.fn(); broken.subscribe(() => { throw new Error('observer failed'); }); broken.subscribe(listener);
  expect(() => broken.setLevel('info')).not.toThrow();
  expect(() => broken.add({ level: 'info', component: 'test', event: 'local' })).not.toThrow();
  expect(broken.getEntries()).toHaveLength(1); expect(listener).toHaveBeenCalledTimes(2);
  expect(() => broken.clear()).not.toThrow(); expect(broken.getEntries()).toEqual([]);
  expect(() => broken.dispose()).not.toThrow(); expect(unavailable.getLevel()).toBe('debug');
  unavailable.dispose();
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
  expect(logger.getBufferStats()).toEqual({ capacity: 1000, droppedEntryCount: 1003 });
  const report = createFrontendLogsReport(entries, new Date(), logger.getBufferStats());
  expect(report.buffer).toEqual({ capacity: 1000, droppedEntryCount: 1003 });
  const stats = logger.getBufferStats(); stats.droppedEntryCount = 0;
  expect(logger.getBufferStats().droppedEntryCount).toBe(1003);
  expect(entries.map(entry => entry.context!.index)).toEqual(Array.from({ length: FRONTEND_LOG_CAPACITY }, (_, index) => index + FRONTEND_LOG_CAPACITY + 3));
  logger.setLevel('off'); expect(logger.getEntries()).toHaveLength(FRONTEND_LOG_CAPACITY);
  logger.clear(); expect(logger.getEntries()).toEqual([]); expect(logger.getLevel()).toBe('off');
  expect(logger.getBufferStats().droppedEntryCount).toBe(0);
  logger.setLevel('error'); logger.add({ level: 'error', component: 'test', event: 'after.clear' });
  expect(logger.getEntries()).toHaveLength(1);
  expect(createFrontendLogger().getLevel()).toBe('off');
});

it.each(['apiKey', 'api_key', 'IMMICH_API_KEY', 'Cookie', 'Authorization', 'accessToken', 'refreshToken', 'sessionToken', 'authToken', 'password', 'secret', 'credential', 'urlCredential', 'Recipe', 'History', 'Clipboard', 'photoBinary', 'binaryPayload', 'pixelBuffer', 'requestHeaders', 'responseHeaders', 'requestBody', 'responseBody', 'fullUrl', 'queryString'])('prunes %s while preserving safe siblings, also during export', key => {
  const logger = createFrontendLogger(); logger.setLevel('debug');
  logger.add({ level: 'warn', component: 'test', event: 'privacy', context: { nested: { [key]: 'PRIVATE_FIXTURE' }, count: 1 } });
  expect(logger.getEntries()[0].context).toEqual({ nested: {}, count: 1 });
  const entry = { ...logger.getEntries()[0], context: { [key]: 'PRIVATE_FIXTURE' }, extra: 'PRIVATE_EXTRA' };
  expect(JSON.stringify(createFrontendLogsReport([entry]))).not.toMatch(/PRIVATE|extra/);
  expect(createFrontendLogsReport([entry]).entries[0].context).toEqual({});
});

it('retains technical metadata and short messages through pruning, snapshots and export', () => {
  const safe = { assetId: 'asset-1', stackId: 'stack-1', memberIds: ['asset-1', 'asset-2'], operationId: 'draft:17',
    requestId: 'request-1', generationId: 2, saveId: 'save-1', tokenCount: 3, recipeVersion: 1,
    historyCursor: 0, historyLength: 2, payloadBytes: 512, pixelCount: 64, durationMs: 12.3,
    errorCode: 'unreachable', exceptionType: 'ReadTimeout', endpoint: '/stacks', httpStatus: 201,
    state: 'completed', phase: 'apply', attempt: 1, aborted: false, stale: true, processingVersion: 1 };
  const logger = createFrontendLogger(); logger.setLevel('debug');
  logger.add({ level: 'debug', component: 'test', event: 'metadata', message: 'Request completed',
    context: { ...safe, authorization: 'PRIVATE', nested: { status: 'ok', api_key: 'PRIVATE' } } });
  const expected = { ...safe, nested: { status: 'ok' } };
  expect(logger.getEntries()[0].context).toEqual(expected);
  const report = createFrontendLogsReport(logger.getEntries());
  expect(report.entries[0].message).toBe('Request completed');
  expect(report.entries[0].context).toEqual(expected);
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
});

it('keeps byte, depth, node and UTF-16 string/message boundaries', () => {
  const logger = createFrontendLogger(); logger.setLevel('debug');
  logger.add({ level: 'debug', component: 'test', event: 'boundary', message: '😀'.repeat(256),
    context: { value: '😀'.repeat(128) } });
  expect(logger.getEntries()[0].message).toHaveLength(512);
  expect(logger.getEntries()[0].context).toEqual({ value: '😀'.repeat(128) });
  for (const context of [{ value: '😀'.repeat(129) }, { nested: { a: { b: { c: 1 } } } },
    Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`field${index}`, index])),
    Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`field${index}`, 'あ'.repeat(256)]))]) {
    logger.add({ level: 'debug', component: 'test', event: 'boundary', message: '😀'.repeat(257), context });
  }
  expect(logger.getEntries().slice(1).every(entry => entry.context === undefined && entry.message === undefined)).toBe(true);
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
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const logger = createFrontendLogger(); logger.setLevel('error');
    logger.add({ level: 'error', component: 'renderer', event: 'initialization.failed' });
    const report = createFrontendLogsReport(logger.getEntries(), new Date('2026-10-03T16:00:00Z'));
    await exportFrontendLogsReport(report); expect(click).toHaveBeenCalledOnce();
    const blob = create.mock.calls[0][0]; expect(blob.type).toBe('application/json');
    const text = await new Promise<string>(resolve => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob);
    });
    expect(JSON.parse(text)).toMatchObject({ ...report, schemaVersion: 2,
      application: { name: 'GenzoRoom', channel: 'development' },
      immich: { status: 'error', version: null, build: null, sourceRef: null, errorCode: 'backend_request_failed' } });
    expect(report.entries[0]).not.toHaveProperty('message');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled(); vi.runAllTimers();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:logs');
  } finally { Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL'); }
});
