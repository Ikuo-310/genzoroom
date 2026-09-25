import { restoreEditSession, type EditStateSnapshot } from './editState';

export type EditStateResponse = {
  state: EditStateSnapshot | null;
  revision?: number;
  updatedAt?: string;
  lastSaveId?: string;
};

export type EditStateApiErrorKind = 'conflict' | 'too_large' | 'invalid_state' | 'unavailable' | 'network' | 'unexpected';

export class EditStateApiError extends Error {
  constructor(public readonly kind: EditStateApiErrorKind, public readonly status?: number, public readonly code?: string) {
    super(kind);
  }
}

/** randomUUID is unavailable outside secure contexts in some browsers; getRandomValues also works on HTTP LAN origins. */
export function createEditStateSaveId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkedResponse(value: unknown, assetId: string): EditStateResponse {
  if (!isRecord(value) || !('state' in value)) throw new EditStateApiError('invalid_state');
  if (value.state === null && Object.keys(value).length === 1) return { state: null };
  if (value.state === null || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || typeof value.updatedAt !== 'string' || typeof value.lastSaveId !== 'string'
    || Number.isNaN(Date.parse(value.updatedAt))) throw new EditStateApiError('invalid_state');
  const restored = restoreEditSession(value.state);
  if (!restored.ok || !isRecord(value.state) || !isRecord(value.state.sourceIdentity)
    || value.state.sourceIdentity.assetId !== assetId) throw new EditStateApiError('invalid_state');
  return value as EditStateResponse;
}

async function readResponse(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch (cause) { throw new EditStateApiError(cause instanceof SyntaxError ? 'invalid_state' : 'network'); }
}

async function request(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetch(url, { cache: 'no-store', ...init }); }
  catch { throw new EditStateApiError('network'); }
  if (response.ok) return response;
  let code: string | undefined;
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.detail) && typeof body.detail.code === 'string') code = body.detail.code;
  } catch { /* Preserve the HTTP status even if the error body is unavailable. */ }
  const kind: EditStateApiErrorKind = response.status === 409 ? 'conflict'
    : response.status === 413 ? 'too_large'
      : response.status === 422 ? 'invalid_state'
        : response.status === 503 ? 'unavailable' : 'unexpected';
  throw new EditStateApiError(kind, response.status, code);
}

export async function getAssetEditState(assetId: string, signal: AbortSignal): Promise<EditStateResponse> {
  const response = await request(`/api/assets/${encodeURIComponent(assetId)}/edit-state`, { signal });
  return checkedResponse(await readResponse(response), assetId);
}

export async function putAssetEditState(assetId: string, snapshot: EditStateSnapshot, expectedRevision: number, saveId: string): Promise<Required<EditStateResponse>> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await request(`/api/assets/${encodeURIComponent(assetId)}/edit-state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ ...snapshot, expectedRevision, saveId }),
    });
    const checked = checkedResponse(await readResponse(response), assetId);
    if (!checked.state || checked.revision === undefined || !checked.updatedAt || !checked.lastSaveId) {
      throw new EditStateApiError('invalid_state');
    }
    return checked as Required<EditStateResponse>;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
