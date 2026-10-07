export type ExportQueueStatus = 'queued' | 'waiting' | 'encoding' | 'registering' | 'failed';
export type ExportQueueItem = { assetId: string; status: ExportQueueStatus; queuedAt: string; updatedAt: string };
export type ExportQueueApiErrorKind = 'duplicate' | 'not_eligible' | 'locked' | 'unavailable' | 'invalid_request' | 'invalid_response' | 'network' | 'unexpected';

export class ExportQueueApiError extends Error {
  constructor(public readonly kind: ExportQueueApiErrorKind, public readonly status?: number, public readonly code?: string) {
    super(kind);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly string[] = ['queued', 'waiting', 'encoding', 'registering', 'failed'];
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const time = Date.parse(value);
  // Date.parse accepts calendar rollover; compare canonical UTC to reject invalid dates.
  return Number.isFinite(time) && new Date(time).toISOString() === `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
}
function checkedItems(value: unknown): ExportQueueItem[] {
  if (!isRecord(value) || !hasKeys(value, ['items']) || !Array.isArray(value.items)) throw new ExportQueueApiError('invalid_response');
  const ids = new Set<string>();
  return value.items.map((item: unknown) => {
    if (!isRecord(item) || !hasKeys(item, ['assetId', 'status', 'queuedAt', 'updatedAt'])
      || typeof item.assetId !== 'string' || !UUID_PATTERN.test(item.assetId)
      || typeof item.status !== 'string' || !STATUSES.includes(item.status)
      || !validTimestamp(item.queuedAt) || !validTimestamp(item.updatedAt)
      || ids.has(item.assetId.toLowerCase())) throw new ExportQueueApiError('invalid_response');
    ids.add(item.assetId.toLowerCase());
    return { assetId: item.assetId, status: item.status as ExportQueueStatus, queuedAt: item.queuedAt, updatedAt: item.updatedAt };
  });
}

async function request(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(path, { ...init, cache: 'no-store' }); }
  catch { throw new ExportQueueApiError('network'); }
  if (response.ok) return response;
  let code: string | undefined;
  try {
    const value: unknown = await response.json();
    if (isRecord(value) && isRecord(value.detail) && typeof value.detail.code === 'string') code = value.detail.code;
  } catch { /* Preserve the HTTP status when a proxy returns a non-JSON error. */ }
  const kind: ExportQueueApiErrorKind = response.status === 503 ? 'unavailable'
    : response.status === 422 && code === 'duplicate_asset_ids' ? 'duplicate'
    : response.status === 422 && code === 'asset_not_eligible' ? 'not_eligible'
    : response.status === 409 ? 'locked'
    : response.status === 422 ? 'invalid_request' : 'unexpected';
  throw new ExportQueueApiError(kind, response.status, code);
}
async function readItems(response: Response): Promise<ExportQueueItem[]> {
  let body: unknown;
  try { body = await response.json(); }
  catch (cause) { throw new ExportQueueApiError(cause instanceof SyntaxError ? 'invalid_response' : 'network'); }
  return checkedItems(body);
}
function checkedAssetId(assetId: string): string {
  if (typeof assetId !== 'string' || !UUID_PATTERN.test(assetId)) throw new ExportQueueApiError('invalid_request');
  return assetId.toLowerCase();
}

export async function listExportQueue(signal: AbortSignal): Promise<ExportQueueItem[]> {
  return readItems(await request('/api/export/queue', { signal }));
}
export async function enqueueExportAssets(assetIds: readonly string[], signal: AbortSignal): Promise<ExportQueueItem[]> {
  if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 100) throw new ExportQueueApiError('invalid_request');
  const ids = assetIds.map(checkedAssetId);
  if (new Set(ids).size !== ids.length) throw new ExportQueueApiError('duplicate');
  return readItems(await request('/api/export/queue', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetIds: ids }),
  }));
}
export async function dequeueExportAsset(assetId: string, signal: AbortSignal): Promise<void> {
  const id = checkedAssetId(assetId);
  const response = await request(`/api/export/queue/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
  if (response.status !== 204) throw new ExportQueueApiError('invalid_response');
}

export async function retryExportAssets(assetIds: readonly string[], signal: AbortSignal): Promise<ExportQueueItem[]> {
  if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 100) throw new ExportQueueApiError('invalid_request');
  const ids = assetIds.map(checkedAssetId);
  if (new Set(ids).size !== ids.length) throw new ExportQueueApiError('duplicate');
  return readItems(await request('/api/export/queue/retry', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetIds: ids }),
  }));
}

export type ExportRuntimeState = {
  runId: string | null; status: 'active' | 'completed' | 'failed' | 'stopped' | null;
  stopRequested: boolean; stopAllowed: boolean; currentAssetId: string | null;
};
async function readRuntime(response: Response): Promise<ExportRuntimeState> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new ExportQueueApiError('invalid_response'); }
  if (!isRecord(value) || !hasKeys(value, ['runId', 'status', 'stopRequested', 'stopAllowed', 'currentAssetId'])
    || value.runId !== null && (typeof value.runId !== 'string' || !UUID_PATTERN.test(value.runId))
    || value.currentAssetId !== null && (typeof value.currentAssetId !== 'string' || !UUID_PATTERN.test(value.currentAssetId))
    || ![null, 'active', 'completed', 'failed', 'stopped'].includes(value.status as null | string)
    || typeof value.stopRequested !== 'boolean' || typeof value.stopAllowed !== 'boolean'
    || (value.runId === null) !== (value.status === null)
    || value.stopAllowed !== (value.status === 'active' && !value.stopRequested)
    || value.status !== 'active' && value.currentAssetId !== null
    || value.runId === null && value.stopRequested
    || value.status === 'stopped' && !value.stopRequested) throw new ExportQueueApiError('invalid_response');
  return value as ExportRuntimeState;
}
export async function listExportRuntime(signal: AbortSignal): Promise<ExportRuntimeState> {
  const state = await readRuntime(await request('/api/export/runtime', { signal }));
  if (state.status !== null && state.status !== 'active') throw new ExportQueueApiError('invalid_response');
  return state;
}
export async function stopExportRuntime(runId: string, signal: AbortSignal): Promise<ExportRuntimeState> {
  const id = checkedAssetId(runId);
  const state = await readRuntime(await request(`/api/export/runs/${id}/stop`, { method: 'POST', signal }));
  if (state.runId?.toLowerCase() !== id || !state.stopRequested) throw new ExportQueueApiError('invalid_response');
  return state;
}

export async function startExportRuntime(assetIds: readonly string[], signal: AbortSignal): Promise<ExportRuntimeState> {
  if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 100) throw new ExportQueueApiError('invalid_request');
  const ids = assetIds.map(checkedAssetId);
  if (new Set(ids).size !== ids.length) throw new ExportQueueApiError('duplicate');
  const state = await readRuntime(await request('/api/export/runtime/start', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetIds: ids }),
  }));
  if (!state.runId) throw new ExportQueueApiError('invalid_response');
  return state;
}
