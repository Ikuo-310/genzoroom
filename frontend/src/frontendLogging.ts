import { downloadJsonReport } from './jsonReportDownload';

export type LogEntryLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogLevel = 'off' | LogEntryLevel;
export type LogSource = 'frontend' | 'backend';
export type LogContextValue = null | boolean | number | string | LogContextValue[] | { [key: string]: LogContextValue };
export interface LogEntry {
  timestamp: string;
  source: LogSource;
  level: LogEntryLevel;
  component: string;
  event: string;
  message?: string;
  context?: { [key: string]: LogContextValue };
}
export type FrontendLogEntry = LogEntry & { source: 'frontend' };
export interface LogBufferStats { capacity: number; droppedEntryCount: number }
// Message and context values must be caller-selected technical data, never user content or secrets.
export type FrontendLogInput = Pick<LogEntry, 'level' | 'component' | 'event' | 'message' | 'context'>;
export interface FrontendLogsReport {
  schemaVersion: 1;
  generatedAt: string;
  source: 'frontend';
  entries: FrontendLogEntry[];
  buffer?: LogBufferStats;
}

// Diagnostics are opt-in; reload must not enable continuous collection or persistence.
export const DEFAULT_FRONTEND_LOG_LEVEL: LogLevel = 'off';
// 1,000 bounded entries retain a useful diagnostic session without unbounded memory growth.
export const FRONTEND_LOG_CAPACITY = 1000;
export const MAX_LOG_CONTEXT_BYTES = 4096;
export const FRONTEND_LOG_CHANNEL_NAME = 'genzoroom-frontend-logging';
const priorities: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };
const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/;
// Match content names, not substrings: historyCursor and payloadBytes are useful diagnostics.
const privateKeys = new Set([
  'apikey', 'immichapikey', 'authorization', 'cookie', 'cookies', 'password', 'secret', 'credential', 'credentials',
  'token', 'accesstoken', 'refreshtoken', 'sessiontoken', 'authtoken', 'sessioncredential', 'urlcredential',
  'headers', 'requestheaders', 'responseheaders', 'url', 'fullurl', 'immichurl', 'querystring',
  'body', 'requestbody', 'responsebody', 'payload', 'binary', 'photobinary', 'binarypayload',
  'pixels', 'pixelbuffer', 'arraybuffer', 'bytes', 'previewbytes', 'thumbnailbytes', 'originalbytes',
  'recipe', 'rawrecipe', 'history', 'rawhistory', 'clipboard', 'clipboardcontent',
]);

function copyContext(context: FrontendLogInput['context']): FrontendLogInput['context'] {
  if (context === undefined) return undefined;
  // Callers must explicitly supply safe metadata, never user content, URLs or credentials.
  // Prune known private fields while preserving siblings; arbitrary text is the caller's responsibility.
  let remaining = 64;
  function copy(value: LogContextValue, depth: number): LogContextValue {
    if (--remaining < 0 || depth > 3) throw new Error('Context too large');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= 256) return value;
    if (typeof value !== 'object' || value === null) throw new Error('Invalid context');
    if (Array.isArray(value)) return value.map(item => copy(item, depth + 1));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Invalid context');
    const fields = Object.entries(Object.getOwnPropertyDescriptors(value));
    if (fields.length > remaining) throw new Error('Context too large');
    return Object.fromEntries(fields.flatMap(([key, descriptor]) => {
      if (key.length > 64) throw new Error('Invalid context key');
      if (privateKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) { remaining--; return []; }
      if (!('value' in descriptor)) throw new Error('Invalid context');
      return [[key, copy(descriptor.value, depth + 1)]];
    }));
  }
  try {
    if (context === null || Array.isArray(context)) return undefined;
    const result = copy(context, 0) as NonNullable<FrontendLogInput['context']>;
    return new TextEncoder().encode(JSON.stringify(result)).length <= MAX_LOG_CONTEXT_BYTES ? result : undefined;
  } catch { return undefined; }
}

export type FrontendLogChannel = Pick<BroadcastChannel, 'postMessage' | 'close' | 'onmessage'>;
export interface FrontendLoggerOptions {
  broadcast?: boolean;
  channelFactory?: (name: string) => FrontendLogChannel | null;
}
type FrontendLogMessage = { type: 'level.request' } | { type: 'level.state' | 'level.set'; level: LogLevel }
  | { type: 'entry'; entry: unknown } | { type: 'clear' };
const defaultChannelFactory = (name: string): FrontendLogChannel | null =>
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name);

export function createFrontendLogger(options: FrontendLoggerOptions = {}) {
  let level = DEFAULT_FRONTEND_LOG_LEVEL;
  const buffer: Array<FrontendLogEntry | undefined> = new Array(FRONTEND_LOG_CAPACITY);
  let start = 0, size = 0;
  let droppedEntryCount = 0;
  let channel: FrontendLogChannel | null = null;
  let ignoreHandshakeState = false;
  const subscribers = new Set<() => void>();
  const notify = () => {
    for (const subscriber of subscribers) {
      try { subscriber(); } catch { /* UI observers are isolated from logging callers. */ }
    }
  };
  const post = (message: FrontendLogMessage) => {
    try { channel?.postMessage(message); } catch { /* Cross-tab transport is best effort. */ }
  };
  const clearBuffer = () => {
    buffer.fill(undefined); start = 0; size = 0; droppedEntryCount = 0;
    notify();
  };
  const append = (entry: FrontendLogEntry, remote: boolean) => {
    buffer[(start + size) % FRONTEND_LOG_CAPACITY] = entry;
    if (size < FRONTEND_LOG_CAPACITY) size++;
    else { start = (start + 1) % FRONTEND_LOG_CAPACITY; droppedEntryCount++; }
    notify();
    if (!remote) {
      try { post({ type: 'entry', entry: projectLogEntry(entry) }); } catch { /* Local capture remains valid if projection or transport fails. */ }
    }
  };
  const applyRemoteLevel = (value: unknown, handshake: boolean) => {
    if (typeof value !== 'string' || !Object.hasOwn(priorities, value)) return;
    if (handshake && ignoreHandshakeState) return;
    ignoreHandshakeState = true;
    if (level === value) return;
    level = value as LogLevel;
    notify();
  };
  const receive = (message: unknown) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
    const data = message as Record<string, unknown>;
    if (data.type === 'level.request') { post({ type: 'level.state', level }); return; }
    if (data.type === 'level.state') { applyRemoteLevel(data.level, true); return; }
    if (data.type === 'level.set') { applyRemoteLevel(data.level, false); return; }
    if (data.type === 'clear') { clearBuffer(); return; }
    if (data.type === 'entry') {
      try {
        const entry = projectLogEntry(data.entry as LogEntry);
        if (entry.source === 'frontend') append(entry as FrontendLogEntry, true);
      } catch { /* Ignore malformed or unsafe remote entries without affecting the receiving app. */ }
    }
  };
  const logger = {
    getLevel(): LogLevel { return level; },
    setLevel(value: LogLevel): void {
      if (!Object.hasOwn(priorities, value)) throw new Error('Invalid log level');
      ignoreHandshakeState = true;
      level = value;
      notify();
      post({ type: 'level.set', level });
    },
    add(input: FrontendLogInput): void {
      if (!Object.hasOwn(priorities, input.level) || priorities[input.level] === 0
        || priorities[input.level] > priorities[level] || level === 'off') return;
      if (!identifier.test(input.component) || !identifier.test(input.event)) return;
      const context = copyContext(input.context);
      const entry: FrontendLogEntry = {
        // UTC keeps saved data independent of display locale and future backend merging.
        timestamp: new Date().toISOString(), source: 'frontend', level: input.level,
        component: input.component, event: input.event,
        ...(typeof input.message === 'string' && input.message.length <= 512 ? { message: input.message } : {}),
        ...(context === undefined ? {} : { context }),
      };
      append(entry, false);
    },
    getEntries(): FrontendLogEntry[] {
      return Array.from({ length: size }, (_, index) => {
        const entry = buffer[(start + index) % FRONTEND_LOG_CAPACITY]!;
        return { ...entry, ...(entry.context === undefined ? {} : { context: copyContext(entry.context) }) };
      });
    },
    getBufferStats(): LogBufferStats { return { capacity: FRONTEND_LOG_CAPACITY, droppedEntryCount }; },
    clear(): void { clearBuffer(); post({ type: 'clear' }); },
    subscribe(listener: () => void): () => void {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    dispose(): void {
      if (!channel) return;
      try { channel.onmessage = null; } catch { /* Closing remains best effort in test and unsupported hosts. */ }
      try { channel.close(); } catch { /* Transport cleanup must not affect local logger state. */ }
      channel = null;
      subscribers.clear();
    },
  };
  if (options.broadcast) {
    let candidate: FrontendLogChannel | null = null;
    try {
      candidate = (options.channelFactory ?? defaultChannelFactory)(FRONTEND_LOG_CHANNEL_NAME);
      channel = candidate;
      if (channel) {
        channel.onmessage = event => { try { receive(event.data); } catch { /* Ignore malformed transport events. */ } };
        post({ type: 'level.request' });
      }
    } catch {
      channel = null;
      try { candidate?.close(); } catch { /* A partially initialized channel must not affect local logging. */ }
    }
  }
  return logger;
}

export const frontendLogger = createFrontendLogger({ broadcast: true });

export function projectLogEntry(entry: LogEntry): LogEntry {
  if (typeof entry.timestamp !== 'string' || !entry.timestamp.endsWith('Z') || !Number.isFinite(Date.parse(entry.timestamp))
    || (entry.source !== 'frontend' && entry.source !== 'backend')
    || !Object.hasOwn(priorities, entry.level) || priorities[entry.level] === 0
    || typeof entry.component !== 'string' || typeof entry.event !== 'string'
    || !identifier.test(entry.component) || !identifier.test(entry.event)) throw new Error('Invalid log entry');
  const context = copyContext(entry.context);
  // Both sources use the same known-field/privacy projection at display and export boundaries.
  return {
    timestamp: new Date(entry.timestamp).toISOString(), source: entry.source, level: entry.level,
    component: entry.component, event: entry.event,
    ...(typeof entry.message === 'string' && entry.message.length <= 512 ? { message: entry.message } : {}),
    ...(context === undefined ? {} : { context }),
  };
}

export function createFrontendLogsReport(entries: readonly FrontendLogEntry[], date = new Date(), buffer?: LogBufferStats): FrontendLogsReport {
  // Project known fields again so extra caller properties cannot enter an exported report.
  const projected = entries.map(entry => {
    if (entry.source !== 'frontend') throw new Error('Invalid log entry');
    return projectLogEntry(entry) as FrontendLogEntry;
  });
  return { schemaVersion: 1, generatedAt: date.toISOString(), source: 'frontend', entries: projected,
    ...(buffer === undefined ? {} : { buffer: projectLogBufferStats(buffer) }) };
}

export function projectLogBufferStats(buffer: LogBufferStats, expectedCapacity = FRONTEND_LOG_CAPACITY): LogBufferStats {
  if (buffer.capacity !== expectedCapacity || !Number.isSafeInteger(buffer.droppedEntryCount) || buffer.droppedEntryCount < 0) throw new Error('Invalid buffer statistics');
  return { capacity: expectedCapacity, droppedEntryCount: buffer.droppedEntryCount };
}

export function exportFrontendLogsReport(report: FrontendLogsReport): void {
  downloadJsonReport(createFrontendLogsReport(report.entries, new Date(report.generatedAt), report.buffer), 'genzoroom-frontend-logs');
}
