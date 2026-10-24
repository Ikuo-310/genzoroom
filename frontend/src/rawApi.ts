import { frontendLogger } from './frontendLogging';

export type RawDocument = {
  workspaceId: string; handle: string; assetId: string; generation: number; documentToken: string; revision: number;
  recipeRevision?: number; recipeFingerprint?: string | null; settingsFingerprint?: string;
  beforeKey?: string | null;
};
export type RawGeometry = { geometryId: string; nativeWidth: number; nativeHeight: number; aspect: number;
  fullWidth: number; fullHeight: number; window: null };
export type RawDisplayTarget = { quality: 'draft' | 'full'; mode: 'whole'; maxSide: number; viewGeneration: number; geometryId: string | null };
export type RawFrame = { blob: Blob; width: number; height: number; epoch: number; sequence: number; kind?: 'before' | 'after'; key?: string;
  quality?: 'draft' | 'full'; frame?: RawGeometry };
export class RawSuperseded extends Error {
  constructor(public readonly reason: 'revision' | 'replaced' | 'cancelled') { super(reason); }
}
const RAW_PREVIEW_MAX_SIDE = 1024;
export const RAW_CONTROL_IDS = ['light.exposure', 'light.contrast', 'light.highlights', 'light.shadows', 'light.whites', 'light.blacks',
  'wb.temp', 'wb.tint', 'color.vibrance', 'color.saturation'] as const;
export type RawControlId = typeof RAW_CONTROL_IDS[number];
export type RawValues = Record<RawControlId, number>;
export type RawSettings = RawDocument & { settingsFingerprint: string; recipeRevision: number; recipeFingerprint: string | null;
  sections: { light: boolean; color: boolean };
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
export type RawHistoryOperation = { kind: 'controlReset'; metadata: { control: RawControlId } }
  | { kind: 'sectionReset'; metadata: { section: 'light' | 'color' } }
  | { kind: 'sectionToggle'; metadata: { section: 'light' | 'color'; enabled: boolean } }
  | { kind: 'allReset'; metadata: Record<string, never> };
export type RawHistoryRequest = RawRecipeRequest & { action: 'initialize' | 'commit' | 'undo' | 'redo' | 'jump' | 'operate';
  control?: RawControlId; targetStepId?: string | null; operation?: RawHistoryOperation };
export type RawHistoryStep = { stepId: string; kind: 'control' | 'controlReset' | 'sectionToggle' | 'sectionReset' | 'allReset';
  metadata: { control?: RawControlId; section?: 'light' | 'color'; enabled?: boolean }; createdAt: string;
  changes: { control: RawControlId; before: number; after: number }[] | null };
export type RawHistoryResult = RawSettings & {
  history: { initialized: boolean; cursor: number; length: number; selectedStepId: string | null };
  historyPending: boolean; nativeState: string; nativeMatchesRecipe: boolean; replayed: boolean;
  ack: { saveId: string; revision: number; settingsFingerprint: string; updatedAt: string;
    historyCursor: number; historyLength: number; stepId: string | null };
};
export type RawHistoryPage = RawDocument & Pick<RawHistoryResult, 'history' | 'historyPending' | 'nativeState' | 'nativeMatchesRecipe'> & {
  recipeRevision: number; recipeFingerprint: string | null; offset: number; limit: number; hasMore: boolean; steps: RawHistoryStep[] };
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const uuid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);

export async function readBounded(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
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

async function json(path: string, init?: RequestInit, limit = 4096) {
  const response = await request(path, init);
  if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new RawApiError('raw_invalid_response');
  try { return JSON.parse(new TextDecoder().decode(await readBounded(response, limit))); }
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
    || !fingerprint(value.settingsFingerprint) || value.beforeKey != null && !fingerprint(value.beforeKey) || !integer(value.recipeRevision)
    || value.recipeFingerprint !== null && !fingerprint(value.recipeFingerprint)
    || !integer(value.mutationAttempts) || value.mutationLimit !== 256 || value.regenerationThreshold !== 200
    || value.mutationAttempts > value.mutationLimit || !integer(value.process) || !value.wb || typeof value.wb.available !== 'boolean'
    || typeof value.wb.mode !== 'string' || value.wb.mode.length > 32 || typeof value.wb.scale !== 'string' || value.wb.scale.length > 32
    || !value.sections || typeof value.sections.light !== 'boolean' || typeof value.sections.color !== 'boolean'
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
  const { doc, action, expectedRecipeRevision, saveId, control, targetStepId, operation } = request;
  let accepted = false;
  try {
    const value = await json(`/documents/${doc.handle}/history/${action}`, post({ ...identityBody(doc),
      documentRevision: doc.revision, settingsFingerprint: doc.settingsFingerprint, expectedRecipeRevision, saveId,
      ...(action === 'commit' ? { kind: 'control', metadata: { control } } : {}),
      ...(action === 'operate' ? operation : {}),
      ...(action === 'jump' ? { targetStepId } : {}) }));
    accepted = true;
    settings(value, doc);
    const h = value.history, ack = value.ack;
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
export async function readRawHistory(doc: RawDocument, offset: number): Promise<RawHistoryPage> {
  if (!integer(offset) || offset > 200) throw new RawApiError('raw_invalid_request');
  const value = await json(`/documents/${doc.handle}/history?offset=${offset}&limit=20`, { headers: {
    'X-Raw-Workspace': doc.workspaceId, 'X-Raw-Generation': String(doc.generation), 'X-Raw-Token': doc.documentToken } }, 16384);
  document(value, doc.workspaceId, doc.assetId);
  const h = value.history;
  if (value.handle !== doc.handle || value.generation !== doc.generation || value.documentToken !== doc.documentToken
    || value.revision !== doc.revision || !fingerprint(value.settingsFingerprint)
    || !integer(value.recipeRevision) || value.recipeFingerprint !== null && !fingerprint(value.recipeFingerprint)
    || !h || typeof h.initialized !== 'boolean' || !integer(h.cursor) || !integer(h.length) || h.length > 200 || h.cursor > h.length
    || (h.cursor === 0 ? h.selectedStepId !== null : !uuid(h.selectedStepId))
    || typeof value.historyPending !== 'boolean' || typeof value.nativeMatchesRecipe !== 'boolean'
    || !['synced', 'desynchronized'].includes(value.nativeState) || value.offset !== offset || value.limit !== 20
    || value.hasMore !== (offset + 20 < h.length) || !Array.isArray(value.steps)
    || value.steps.length !== Math.min(20, Math.max(0, h.length - offset))) throw new RawApiError('raw_invalid_response');
  const ids = new Set<string>();
  for (const step of value.steps) {
    const m = step?.metadata;
    if (!step || !uuid(step.stepId) || ids.has(step.stepId) || typeof step.createdAt !== 'string' || !Number.isFinite(Date.parse(step.createdAt))
      || !m || typeof m !== 'object' || Array.isArray(m)
      || (step.kind === 'control' || step.kind === 'controlReset' ? Object.keys(m).length !== 1 || !RAW_CONTROL_IDS.includes(m.control)
        : step.kind === 'sectionToggle' ? Object.keys(m).length !== 2 || !['light', 'color'].includes(m.section) || typeof m.enabled !== 'boolean'
        : step.kind === 'sectionReset' ? Object.keys(m).length !== 1 || !['light', 'color'].includes(m.section)
        : step.kind !== 'allReset' || Object.keys(m).length !== 0)
      || !(step.changes === null || Array.isArray(step.changes) && step.changes.length <= RAW_CONTROL_IDS.length
        && step.changes.every((change: unknown, index: number, changes: unknown[]) => {
          const item = change as { control?: unknown; before?: unknown; after?: unknown } | null;
          return !!item && RAW_CONTROL_IDS.includes(item.control as RawControlId)
            && typeof item.before === 'number' && Number.isFinite(item.before)
            && typeof item.after === 'number' && Number.isFinite(item.after)
            && changes.findIndex(other => (other as { control?: unknown } | null)?.control === item.control) === index;
        }))) throw new RawApiError('raw_invalid_response');
    ids.add(step.stepId);
  }
  if (h.cursor > offset && h.cursor <= offset + value.steps.length && value.steps[h.cursor - offset - 1].stepId !== h.selectedStepId)
    throw new RawApiError('raw_invalid_response');
  // Keep only the display contract, even if a server accidentally adds internal fields.
  return { workspaceId: value.workspaceId, handle: value.handle, assetId: value.assetId, generation: value.generation,
    documentToken: value.documentToken, revision: value.revision, settingsFingerprint: value.settingsFingerprint,
    recipeRevision: value.recipeRevision, recipeFingerprint: value.recipeFingerprint,
    history: { initialized: h.initialized, cursor: h.cursor, length: h.length, selectedStepId: h.selectedStepId },
    historyPending: value.historyPending, nativeState: value.nativeState, nativeMatchesRecipe: value.nativeMatchesRecipe,
    offset, limit: 20, hasMore: value.hasMore, steps: value.steps.map((step: RawHistoryStep) => ({ stepId: step.stepId,
      kind: step.kind, metadata: { ...step.metadata }, createdAt: step.createdAt,
      changes: step.changes?.map(change => ({ ...change })) ?? null })) };
}
export async function cancelRawPreview(doc: RawDocument, kind: 'before' | 'after', serial: number) {
  await request(`/documents/${doc.handle}/preview/cancel`, post({ ...identityBody(doc), kind, serial }));
}
export async function rawPreview(doc: RawDocument, serial: number, signal: AbortSignal, kind: 'before' | 'after' = 'after', target?: RawDisplayTarget): Promise<RawFrame> {
  const started = performance.now();
  const response = await request(`/documents/${doc.handle}/preview`, { ...post({ workspaceId: doc.workspaceId,
    generation: doc.generation, documentToken: doc.documentToken, revision: doc.revision, serial, ...target, ...(kind === 'before' ? { kind } : {}) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]) });
  try {
    const responseStarted = performance.now();
    if (response.status === 204) {
      const reason = response.headers.get('x-raw-superseded-reason');
      if (reason !== 'revision' && reason !== 'replaced' && reason !== 'cancelled') throw new RawApiError('raw_invalid_response');
      throw new RawSuperseded(reason);
    }
    let frame: RawGeometry | undefined, quality: 'draft' | 'full' | undefined;
    if (target) {
      const contract = response.headers.get('x-raw-preview-contract');
      const actual = response.headers.get('x-raw-quality');
      if (response.headers.get('x-raw-mode') !== 'whole' || response.headers.get('x-raw-view-generation') !== String(target.viewGeneration)
        || contract !== '0' && contract !== '1' || actual !== 'full' && actual !== 'draft'
        || (contract === '1' ? actual !== target.quality : actual !== 'full')) throw new RawApiError('raw_invalid_response');
      quality = actual;
      if (contract === '1') {
        const encoded = response.headers.get('x-raw-frame');
        try {
          if (!encoded || encoded.length > 16 * 1024) throw new Error();
          const value = JSON.parse(encoded);
          if (!value || Object.keys(value).sort().join(',') !== 'aspect,fullHeight,fullWidth,geometryId,nativeHeight,nativeWidth,window'
            || !fingerprint(value.geometryId) || target.geometryId !== null && target.geometryId !== value.geometryId
            || !['nativeWidth', 'nativeHeight', 'fullWidth', 'fullHeight'].every(k => integer(value[k]) && value[k] > 0 && value[k] <= 2 ** 31 - 1)
            || typeof value.aspect !== 'number' || !Number.isFinite(value.aspect) || value.aspect <= 0 || value.window !== null) throw new Error();
          frame = value;
        } catch { throw new RawApiError('raw_invalid_response'); }
      } else if (response.headers.has('x-raw-frame')) throw new RawApiError('raw_invalid_response');
    }
    const numeric = (name: string) => {
      const text = response.headers.get(`x-raw-${name}`);
      if (!text || !/^\d{1,16}$/.test(text) || !integer(Number(text))) throw new RawApiError('raw_invalid_response');
      return Number(text);
    };
    const check = () => {
      signal.throwIfAborted();
      if (response.status !== 200 || response.headers.get('content-type') !== 'image/png'
        || numeric('generation') !== doc.generation || numeric('revision') !== doc.revision
        || numeric('serial') !== serial || response.headers.get('x-raw-token') !== doc.documentToken
        || (response.headers.get('x-raw-kind') ?? 'after') !== kind
        || kind === 'before' && (!fingerprint(doc.beforeKey) || !target && response.headers.get('x-raw-before-key') !== doc.beforeKey
          || !!target && !fingerprint(response.headers.get('x-raw-before-key'))))
        throw new RawApiError('raw_stale_handle');
    };
    check();
    const width = numeric('width'), height = numeric('height'), epoch = numeric('epoch'), sequence = numeric('sequence');
    if (frame && (frame.fullWidth !== width || frame.fullHeight !== height)) throw new RawApiError('raw_invalid_response');
    if (!width || !height || Math.max(width, height) > RAW_PREVIEW_MAX_SIDE || width * height > RAW_PREVIEW_MAX_SIDE ** 2) throw new RawApiError('raw_invalid_response');
    const bytes = await readBounded(response, MAX_IMAGE_BYTES);
    try { frontendLogger.add({ level: 'debug', component: 'raw', event: 'preview.received', context: {
      generation: doc.generation, revision: doc.revision, renderSerial: serial, kind, quality: quality ?? 'full',
      width, height, payloadBytes: bytes.length, responseWaitMs: responseStarted - started,
      bodyReadMs: performance.now() - responseStarted } }); } catch { /* Optional diagnostics. */ }
    check();
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw new RawApiError('raw_invalid_response');
    return { blob: new Blob([bytes], { type: 'image/png' }), width, height, epoch, sequence,
      kind, quality, frame, ...(kind === 'before' ? { key: doc.beforeKey! } : {}) };
  } finally { await response.body?.cancel().catch(() => {}); }
}

/** A repeated DELETE can lose its ack; only an observed empty owner permits moving on. */
export async function rawWorkspaceEmpty(): Promise<boolean> {
  const value = await json('/capabilities');
  return value.workspaceState === 'empty' && value.cleanupPending === false;
}
