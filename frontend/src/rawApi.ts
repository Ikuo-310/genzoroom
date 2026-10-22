export type RawDocument = {
  workspaceId: string; handle: string; assetId: string; generation: number; documentToken: string; revision: number;
  recipeRevision?: number; recipeFingerprint?: string | null; settingsFingerprint?: string;
};
export type RawFrame = { blob: Blob; width: number; height: number; epoch: number; sequence: number };
export const RAW_CONTROL_IDS = ['light.exposure', 'light.contrast', 'light.highlights', 'light.shadows', 'light.whites', 'light.blacks',
  'wb.temp', 'wb.tint', 'color.vibrance', 'color.saturation'] as const;
export type RawControlId = typeof RAW_CONTROL_IDS[number];
export type RawValues = Record<RawControlId, number>;
export type RawSettings = RawDocument & { settingsFingerprint: string; recipeRevision: number; recipeFingerprint: string | null;
  mutationAttempts: number; mutationLimit: number; regenerationThreshold: number;
  values: RawValues; process: number;
  controls: { id: RawControlId; min: number; max: number; step: number; default: number; precision: number }[];
  wb: { available: boolean; mode: string; scale: string } };
export class RawApiError extends Error {
  constructor(public readonly code: string, public readonly status?: number) { super(code); }
}
export class RawSaveError extends RawApiError {
  constructor(code: string, public readonly outcome: 'unknown' | 'rejected', status?: number) { super(code, status); }
}
export type RawRecipeRequest = { doc: RawSettings; expectedRecipeRevision: number; saveId: string };
export type RawRecipeAck = { recipeRevision: number; saveId: string; updatedAt: string;
  documentRevision: number; settingsFingerprint: string };
export type RawRecipeState = { recipeRevision: number; recipeFingerprint: string | null; lastSaveId: string | null; updatedAt: string | null };
export type RawHistoryRequest = RawRecipeRequest & { action: 'initialize' | 'commit'; control?: RawControlId };
export type RawHistoryResult = RawSettings & {
  history: { initialized: boolean; cursor: number; length: number; selectedStepId: string | null };
  historyPending: boolean; nativeState: string; nativeMatchesRecipe: boolean; replayed: boolean;
  ack: { saveId: string; revision: number; settingsFingerprint: string; updatedAt: string;
    historyCursor: number; historyLength: number; stepId: string | null };
};
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
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
    throw new RawApiError(code, response.status);
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
function settings(value: RawSettings, doc: RawDocument): RawSettings {
  document(value, doc.workspaceId, doc.assetId);
  if (value.handle !== doc.handle || value.generation !== doc.generation || value.documentToken !== doc.documentToken
    || !fingerprint(value.settingsFingerprint) || !integer(value.recipeRevision)
    || value.recipeFingerprint !== null && !fingerprint(value.recipeFingerprint)
    || !integer(value.mutationAttempts) || value.mutationLimit !== 256 || value.regenerationThreshold !== 200
    || value.mutationAttempts > value.mutationLimit || !integer(value.process) || !value.wb || typeof value.wb.available !== 'boolean'
    || typeof value.wb.mode !== 'string' || value.wb.mode.length > 32 || typeof value.wb.scale !== 'string' || value.wb.scale.length > 32
    || !value.values || !RAW_CONTROL_IDS.every(id => Number.isFinite(value.values[id]))
    || !Array.isArray(value.controls) || value.controls.length !== RAW_CONTROL_IDS.length
    || new Set(value.controls.map(c => c.id)).size !== RAW_CONTROL_IDS.length
    || value.controls.some(c => !RAW_CONTROL_IDS.includes(c.id) || ![c.min, c.max, c.step, c.default].every(Number.isFinite)
      || c.min >= c.max || c.step <= 0 || !integer(c.precision) || c.precision > 4)) throw new RawApiError('raw_invalid_response');
  return value;
}
const identityBody = (doc: RawDocument) => ({ workspaceId: doc.workspaceId, generation: doc.generation, documentToken: doc.documentToken });
export async function readRawSettings(doc: RawDocument): Promise<RawSettings> {
  return settings(await json(`/documents/${doc.handle}/settings`, post(identityBody(doc))), doc);
}
export async function setRawControls(doc: RawDocument, values: Partial<RawValues>): Promise<RawSettings> {
  const result = settings(await json(`/documents/${doc.handle}/controls`, post({ ...identityBody(doc), expectedRevision: doc.revision, values })), doc);
  if (result.revision <= doc.revision) throw new RawApiError('raw_invalid_response');
  return result;
}
export async function readRawRecipe(doc: RawDocument): Promise<RawRecipeState> {
  const value = await json(`/documents/${doc.handle}/recipe`, { headers: { 'X-Raw-Workspace': doc.workspaceId,
    'X-Raw-Generation': String(doc.generation), 'X-Raw-Token': doc.documentToken } });
  document(value, doc.workspaceId, doc.assetId);
  if (value.handle !== doc.handle || value.generation !== doc.generation || value.documentToken !== doc.documentToken
    || !integer(value.recipeRevision) || value.recipeFingerprint !== null && !fingerprint(value.recipeFingerprint)
    || (value.recipeRevision === 0 ? value.recipeFingerprint !== null || value.lastSaveId !== null || value.updatedAt !== null
      : !fingerprint(value.recipeFingerprint) || typeof value.lastSaveId !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.lastSaveId)
        || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)))) throw new RawApiError('raw_invalid_response');
  return value;
}
export async function saveRawRecipe(request: RawRecipeRequest): Promise<RawRecipeAck> {
  const { doc, expectedRecipeRevision, saveId } = request;
  let accepted = false;
  try {
    const value = await json(`/documents/${doc.handle}/recipe`, { ...post({ ...identityBody(doc),
      documentRevision: doc.revision, expectedRecipeRevision, saveId }), method: 'PUT' });
    accepted = true;
    document({ ...value, revision: value.documentRevision }, doc.workspaceId, doc.assetId);
    if (value.handle !== doc.handle || value.generation !== doc.generation || value.documentToken !== doc.documentToken
      || value.documentRevision !== doc.revision || value.settingsFingerprint !== doc.settingsFingerprint
      || !integer(value.recipeRevision) || value.recipeRevision !== expectedRecipeRevision + 1 || value.saveId !== saveId
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new RawApiError('raw_invalid_response');
    return value;
  } catch (cause) {
    const error = cause instanceof RawApiError ? cause : new RawApiError('raw_connection_failed');
    throw new RawSaveError(error.code, accepted || !error.status || error.status >= 500 || error.status === 408 ? 'unknown' : 'rejected', error.status);
  }
}
/** A retry keeps the exact document/body; current metadata is independent of the original ack. */
export async function saveRawHistory(request: RawHistoryRequest): Promise<RawHistoryResult> {
  const { doc, action, expectedRecipeRevision, saveId, control } = request;
  let accepted = false;
  try {
    const value = await json(`/documents/${doc.handle}/history/${action}`, post({ ...identityBody(doc),
      documentRevision: doc.revision, settingsFingerprint: doc.settingsFingerprint, expectedRecipeRevision, saveId,
      ...(action === 'commit' ? { kind: 'control', metadata: { control } } : {}) }));
    accepted = true;
    settings(value, doc);
    const h = value.history, ack = value.ack;
    const uuid = (id: unknown) => typeof id === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
    if (!h || h.initialized !== true || !integer(h.cursor) || !integer(h.length) || h.cursor > h.length
      || h.length > 200 || (h.cursor === 0 ? h.selectedStepId !== null : !uuid(h.selectedStepId))
      || typeof value.historyPending !== 'boolean' || typeof value.nativeMatchesRecipe !== 'boolean'
      || !['synced', 'desynchronized'].includes(value.nativeState) || typeof value.replayed !== 'boolean'
      || !ack || ack.saveId !== saveId || ack.revision !== expectedRecipeRevision + 1
      || !fingerprint(ack.settingsFingerprint) || !integer(ack.historyCursor) || !integer(ack.historyLength)
      || ack.historyCursor > ack.historyLength || (ack.historyCursor === 0 ? ack.stepId !== null : !uuid(ack.stepId))
      || typeof ack.updatedAt !== 'string' || !Number.isFinite(Date.parse(ack.updatedAt))) throw new RawApiError('raw_invalid_response');
    return value;
  } catch (cause) {
    const error = cause instanceof RawApiError ? cause : new RawApiError('raw_connection_failed');
    throw new RawSaveError(error.code, accepted || !error.status || error.status >= 500 || error.status === 408 ? 'unknown' : 'rejected', error.status);
  }
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

/** A repeated DELETE can lose its ack; only an observed empty owner permits moving on. */
export async function rawWorkspaceEmpty(): Promise<boolean> {
  const value = await json('/capabilities');
  return value.workspaceState === 'empty' && value.cleanupPending === false;
}
