import { createFrontendLogsReport, projectLogEntry, projectLogBufferStats, type FrontendLogEntry, type LogEntry, type LogLevel, type LogBufferStats } from './frontendLogging';

export const LOG_LEVELS: readonly LogLevel[] = ['off', 'error', 'warn', 'info', 'debug'];
export const BACKEND_LOG_CAPACITY = 5000;
export type BackendLogEntry = LogEntry & { source: 'backend' };
export interface BackendLogsReport {
  schemaVersion: 1;
  generatedAt: string;
  source: 'backend';
  entries: BackendLogEntry[];
  buffer?: LogBufferStats;
}
export interface AllLogsReport {
  schemaVersion: 1;
  generatedAt: string;
  frontend: FrontendLogEntry[];
  backend: BackendLogEntry[];
  buffers?: { frontend?: LogBufferStats; backend?: LogBufferStats };
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const utc = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);

export function parseBackendLevel(value: unknown): LogLevel {
  if (!record(value) || !LOG_LEVELS.includes(value.level as LogLevel)) throw new Error('Invalid backend level');
  return value.level as LogLevel;
}

export function parseBackendLogsReport(value: unknown): BackendLogsReport {
  if (!record(value) || value.schemaVersion !== 1 || value.source !== 'backend' || !utc(value.generatedAt)
    || !Array.isArray(value.entries) || value.entries.length > BACKEND_LOG_CAPACITY) throw new Error('Invalid backend logs report');
  const entries = value.entries.map(entry => {
    if (!record(entry) || entry.source !== 'backend' || !utc(entry.timestamp)
      || typeof entry.level !== 'string' || !LOG_LEVELS.includes(entry.level as LogLevel) || entry.level === 'off'
      || typeof entry.component !== 'string' || typeof entry.event !== 'string'
      || (entry.message !== undefined && typeof entry.message !== 'string')
      || (entry.context !== undefined && !record(entry.context))) throw new Error('Invalid backend log entry');
    return projectLogEntry(entry as unknown as BackendLogEntry) as BackendLogEntry;
  });
  let buffer: LogBufferStats | undefined;
  if (value.buffer !== undefined) {
    if (!record(value.buffer)) throw new Error('Invalid buffer statistics');
    buffer = projectLogBufferStats(value.buffer as unknown as LogBufferStats, BACKEND_LOG_CAPACITY);
  }
  return { schemaVersion: 1, generatedAt: new Date(value.generatedAt).toISOString(), source: 'backend', entries,
    ...(buffer === undefined ? {} : { buffer }) };
}

export class DeveloperLogsError extends Error {
  constructor(readonly code: 'unreachable' | 'request_failed' | 'unexpected_response', readonly httpStatus?: number) {
    super('Developer logs request failed');
  }
}
const root = '/api/developer/logs/backend';
async function request(path: string, options: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(path, { cache: 'no-store', ...options }); }
  catch { throw new DeveloperLogsError('unreachable'); }
  // Upstream bodies and exception text never become UI messages or structured logs.
  if (!response.ok) throw new DeveloperLogsError('request_failed', response.status);
  return response;
}
async function validatedJson<T>(response: Response, parse: (data: unknown) => T): Promise<T> {
  try { return parse(await response.json()); }
  catch { throw new DeveloperLogsError('unexpected_response', response.status); }
}
export async function getBackendLogLevel(signal: AbortSignal): Promise<LogLevel> {
  return validatedJson(await request(`${root}/level`, { signal }), parseBackendLevel);
}
export async function setBackendLogLevel(level: LogLevel, signal: AbortSignal): Promise<LogLevel> {
  const result = await validatedJson(await request(`${root}/level`, {
    signal, method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }),
  }), parseBackendLevel);
  if (result !== level) throw new DeveloperLogsError('unexpected_response');
  return result;
}
export async function getBackendLogsReport(signal: AbortSignal): Promise<BackendLogsReport> {
  return validatedJson(await request(root, { signal }), parseBackendLogsReport);
}
export async function clearBackendLogs(signal: AbortSignal): Promise<void> {
  await request(root, { signal, method: 'DELETE' });
}

export function createAllLogsReport(frontend: readonly FrontendLogEntry[], backend: BackendLogsReport, date = new Date(), frontendBuffer?: LogBufferStats): AllLogsReport {
  const fe = createFrontendLogsReport(frontend, date, frontendBuffer), be = parseBackendLogsReport(backend);
  return { schemaVersion: 1, generatedAt: date.toISOString(),
    frontend: fe.entries, backend: be.entries,
    ...(fe.buffer === undefined && be.buffer === undefined ? {} : { buffers: {
      ...(fe.buffer === undefined ? {} : { frontend: fe.buffer }), ...(be.buffer === undefined ? {} : { backend: be.buffer }),
    } }) };
}

export function mergeLogEntries(frontend: readonly FrontendLogEntry[], backend: readonly BackendLogEntry[]): LogEntry[] {
  // ES stable sort retains source/insertion order for equal timestamps without mutating either buffer.
  return [...frontend, ...backend].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function formatLogTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '—';
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  // Date local getters use browser timezone independently of the selected UI language.
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
