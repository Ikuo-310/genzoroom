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
// Message and context values must be caller-selected technical data, never user content or secrets.
export type FrontendLogInput = Pick<LogEntry, 'level' | 'component' | 'event' | 'message' | 'context'>;
export interface FrontendLogsReport {
  schemaVersion: 1;
  generatedAt: string;
  source: 'frontend';
  entries: FrontendLogEntry[];
}

// Diagnostics are opt-in; reload must not enable continuous collection or persistence.
export const DEFAULT_FRONTEND_LOG_LEVEL: LogLevel = 'off';
// 1,000 bounded entries retain a useful diagnostic session without unbounded memory growth.
export const FRONTEND_LOG_CAPACITY = 1000;
export const MAX_LOG_CONTEXT_BYTES = 4096;
const priorities: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };
const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/;
const privateKey = /apikey|cookie|authorization|token|password|secret|credential|recipe|history|clipboard|binary|pixels|payload/;

function copyContext(context: FrontendLogInput['context']): FrontendLogInput['context'] {
  if (context === undefined) return undefined;
  // Callers must explicitly supply safe metadata, never user content, URLs or credentials.
  // This bounded check rejects suspicious contexts; it cannot redact secrets in arbitrary text.
  let remaining = 64;
  function copy(value: LogContextValue, depth: number): LogContextValue {
    if (--remaining < 0 || depth > 3) throw new Error('Context too large');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= 256) return value;
    if (typeof value !== 'object' || value === null) throw new Error('Invalid context');
    if (Array.isArray(value)) return value.map(item => copy(item, depth + 1));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Invalid context');
    return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => {
      if (key.length > 64 || privateKey.test(key.toLowerCase().replace(/[^a-z0-9]/g, '')) || !('value' in descriptor)) throw new Error('Unsafe context');
      return [key, copy(descriptor.value, depth + 1)];
    }));
  }
  try {
    if (context === null || Array.isArray(context)) return undefined;
    const result = copy(context, 0) as NonNullable<FrontendLogInput['context']>;
    return new TextEncoder().encode(JSON.stringify(result)).length <= MAX_LOG_CONTEXT_BYTES ? result : undefined;
  } catch { return undefined; }
}

export function createFrontendLogger() {
  let level = DEFAULT_FRONTEND_LOG_LEVEL;
  const buffer: Array<FrontendLogEntry | undefined> = new Array(FRONTEND_LOG_CAPACITY);
  let start = 0, size = 0;
  return {
    getLevel(): LogLevel { return level; },
    setLevel(value: LogLevel): void {
      if (!Object.hasOwn(priorities, value)) throw new Error('Invalid log level');
      level = value;
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
      buffer[(start + size) % FRONTEND_LOG_CAPACITY] = entry;
      if (size < FRONTEND_LOG_CAPACITY) size++;
      else start = (start + 1) % FRONTEND_LOG_CAPACITY;
    },
    getEntries(): FrontendLogEntry[] {
      return Array.from({ length: size }, (_, index) => {
        const entry = buffer[(start + index) % FRONTEND_LOG_CAPACITY]!;
        return { ...entry, ...(entry.context === undefined ? {} : { context: copyContext(entry.context) }) };
      });
    },
    clear(): void { buffer.fill(undefined); start = 0; size = 0; },
  };
}

export const frontendLogger = createFrontendLogger();

export function createFrontendLogsReport(entries: readonly FrontendLogEntry[], date = new Date()): FrontendLogsReport {
  // Project known fields again so extra caller properties cannot enter an exported report.
  const projected = entries.map(entry => {
    if (!entry.timestamp.endsWith('Z') || !Number.isFinite(Date.parse(entry.timestamp)) || entry.source !== 'frontend'
      || !Object.hasOwn(priorities, entry.level) || priorities[entry.level] === 0
      || !identifier.test(entry.component) || !identifier.test(entry.event)) throw new Error('Invalid log entry');
    const context = copyContext(entry.context);
    return {
      timestamp: new Date(entry.timestamp).toISOString(), source: 'frontend' as const, level: entry.level,
      component: entry.component, event: entry.event,
      ...(typeof entry.message === 'string' && entry.message.length <= 512 ? { message: entry.message } : {}),
      ...(context === undefined ? {} : { context }),
    };
  });
  return { schemaVersion: 1, generatedAt: date.toISOString(), source: 'frontend', entries: projected };
}

export function exportFrontendLogsReport(report: FrontendLogsReport): void {
  downloadJsonReport(createFrontendLogsReport(report.entries, new Date(report.generatedAt)), 'genzoroom-frontend-logs');
}
