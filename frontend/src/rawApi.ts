export type RawDocument = {
  workspaceId: string; handle: string; assetId: string; generation: number; documentToken: string; revision: number;
};
export type RawFrame = { blob: Blob; width: number; height: number; epoch: number; sequence: number };
export class RawApiError extends Error {
  constructor(public readonly code: string) { super(code); }
}
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

async function readBounded(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) throw new RawApiError('raw_invalid_response');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new RawApiError('raw_response_too_large');
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`/api/raw${path}`, { ...init, cache: 'no-store', credentials: 'same-origin',
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) });
  if (!response.ok) {
    let code = response.status === 404 ? 'raw_unsupported' : 'raw_request_failed';
    try {
      const value = JSON.parse(new TextDecoder().decode(await readBounded(response, 4096)));
      if (typeof value.code === 'string' && /^raw_[a-z_]{1,60}$/.test(value.code)) code = value.code;
    } catch { /* Arbitrary upstream text must not become user-facing diagnostics. */ }
    throw new RawApiError(code);
  }
  return response;
}

async function json(path: string, init?: RequestInit) {
  const response = await request(path, init);
  if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new RawApiError('raw_invalid_response');
  try { return JSON.parse(new TextDecoder().decode(await readBounded(response, 4096))); }
  catch { throw new RawApiError('raw_invalid_response'); }
}
const post = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

export async function rawCapability(signal?: AbortSignal) {
  const value = await json('/capabilities', { signal });
  if (typeof value.available !== 'boolean' || value.version !== '0.10.0') throw new RawApiError('raw_invalid_response');
  return value.available as boolean;
}
export async function createRawWorkspace() {
  const value = await json('/workspaces', post({}));
  if (!opaque(value.workspaceId)) throw new RawApiError('raw_invalid_response');
  return value.workspaceId as string;
}
function document(value: RawDocument, workspaceId: string, assetId?: string) {
  if (!value || value.workspaceId !== workspaceId || !opaque(value.handle) || !opaque(value.documentToken)
    || !integer(value.generation) || !integer(value.revision) || typeof value.assetId !== 'string'
    || assetId !== undefined && value.assetId !== assetId) throw new RawApiError('raw_invalid_response');
  return value;
}
export async function openRawDocument(workspaceId: string, assetId: string) {
  return document(await json('/documents', post({ workspaceId, assetId })), workspaceId, assetId);
}
export async function readRawDocument(doc: RawDocument, signal?: AbortSignal) {
  const next = document(await json(`/documents/${doc.handle}`, { headers: { 'X-Raw-Workspace': doc.workspaceId }, signal }), doc.workspaceId, doc.assetId);
  if (next.generation !== doc.generation || next.documentToken !== doc.documentToken || next.revision !== doc.revision)
    throw new RawApiError('raw_stale_handle');
  return next;
}
export async function releaseRawWorkspace(workspaceId: string) {
  await request(`/workspaces/${workspaceId}`, { method: 'DELETE' });
}
export async function rawPreview(doc: RawDocument, serial: number, signal: AbortSignal): Promise<RawFrame> {
  const response = await request(`/documents/${doc.handle}/preview`, { ...post({ workspaceId: doc.workspaceId,
    generation: doc.generation, documentToken: doc.documentToken, revision: doc.revision, serial }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]) });
  const numeric = (name: string) => {
    const text = response.headers.get(`x-raw-${name}`);
    if (!text || !/^\d{1,16}$/.test(text) || !integer(Number(text))) throw new RawApiError('raw_invalid_response');
    return Number(text);
  };
  const check = () => {
    signal.throwIfAborted();
    if (response.status !== 200 || response.headers.get('content-type') !== 'image/png'
      || numeric('generation') !== doc.generation || numeric('revision') !== doc.revision
      || numeric('serial') !== serial || response.headers.get('x-raw-token') !== doc.documentToken)
      throw new RawApiError('raw_stale_handle');
  };
  check();
  const width = numeric('width'), height = numeric('height'), epoch = numeric('epoch'), sequence = numeric('sequence');
  if (!width || !height || Math.max(width, height) > 1024 || width * height > 1_048_576) throw new RawApiError('raw_invalid_response');
  const bytes = await readBounded(response, MAX_IMAGE_BYTES);
  check();
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw new RawApiError('raw_invalid_response');
  return { blob: new Blob([bytes], { type: 'image/png' }), width, height, epoch, sequence };
}
