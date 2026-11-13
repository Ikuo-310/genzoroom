import { LIGHTCRAFT_ENGINE } from './lightcraftEngine';
import { RAW_WHOLE_MAX_SIDE, RAW_WHOLE_MAX_BYTES } from './rawWholePreview';
import { frontendLogger } from './frontendLogging';
import { checkRegionResponse, confirmRegionFullFrame, validateRegionFrameRequest, validateRegionRequest,
  type RegionRequest, type RegionResponse, type RegionFrameRequest, type RegionFrameResponse } from './rawRegionContract';
import { C1_REGION_BUDGET, validRegionGeometry, type RegionGeometry } from './rawRegionPlanner';

export type RawDocument = {
  workspaceId: string; handle: string; assetId: string; generation: number; documentToken: string; revision: number;
  sourceWidth?: number; sourceHeight?: number;
  recipeRevision?: number; recipeFingerprint?: string | null; settingsFingerprint?: string; importDefaultsFingerprint?: string;
  recipeRecoveryPending?: boolean;
  beforeKey?: string | null;
};
export type RawGeometry = { geometryId: string; nativeWidth: number; nativeHeight: number; aspect: number;
  fullWidth: number; fullHeight: number; window: null };
export type RawDisplayTarget = { quality: 'draft' | 'full'; mode: 'whole' | 'crop-edit'; maxSide: number; viewGeneration: number; geometryId: string | null };
export type RawCropDisplay = { canonicalGeometry: { crop: RawCrop; orientation: string }; bitmapSpace: 'oriented-warped-unstraightened-flipped'; settingsFingerprint: string };
export type RawFrame = { blob: Blob; width: number; height: number; epoch: number; sequence: number; kind?: 'before' | 'after'; key?: string;
  quality?: 'draft' | 'full'; frame?: RawGeometry; cropDisplay?: RawCropDisplay; interactionId?: string; interactionSequence?: number;
  curvePoints?: RawCurvePoint[] };
export class RawSuperseded extends Error {
  constructor(public readonly reason: 'revision' | 'replaced' | 'cancelled') { super(reason); }
}
const RAW_PREVIEW_MAX_SIDE = RAW_WHOLE_MAX_SIDE;
// Match the Backend bound for the RAW control specs, flags, full-precision values and History receipt.
const RAW_SETTINGS_RESPONSE_BYTES = 16384;
export const RAW_CONTROL_IDS = ['light.exposure', 'light.contrast', 'light.highlights', 'light.shadows', 'light.whites', 'light.blacks',
  'grading.shadows.hue', 'grading.shadows.sat', 'grading.shadows.lum',
  'grading.midtones.hue', 'grading.midtones.sat', 'grading.midtones.lum',
  'grading.highlights.hue', 'grading.highlights.sat', 'grading.highlights.lum', 'grading.blending', 'grading.balance',
  'wb.temp', 'wb.tint', 'color.vibrance', 'color.saturation', 'effects.texture', 'effects.clarity', 'effects.dehaze',
  'vignette.amount', 'vignette.midpoint', 'vignette.feather', 'vignette.roundness', 'vignette.highlights',
  'detail.sharpenAmount', 'detail.sharpenMasking',
  'detail.nrLuminance', 'detail.nrDetail', 'detail.nrColor', 'detail.nrColorDetail', 'detail.nrColorSmoothness'] as const;
export type RawControlId = typeof RAW_CONTROL_IDS[number];
export const RAW_SETTINGS_CONTROL_IDS = [...RAW_CONTROL_IDS,
  'optics.distortion', 'optics.vignetting', 'optics.vignettingMidpoint', 'optics.profileDistortion', 'optics.profileVignetting',
  'optics.defringePurple', 'optics.defringePurpleHueLo', 'optics.defringePurpleHueHi', 'optics.defringeGreen',
  'optics.defringeGreenHueLo', 'optics.defringeGreenHueHi', 'optics.caRed', 'optics.caBlue'] as const;
export const RAW_HISTORY_CONTROL_IDS = RAW_SETTINGS_CONTROL_IDS;
export type RawHistoryControlId = typeof RAW_HISTORY_CONTROL_IDS[number];
export type RawSettingControlId = RawHistoryControlId;
export type RawOpticsFlagId = 'optics.remove_ca' | 'optics.lens_profile' | 'profile.camera_local_tone';
export const RAW_OPTICS_FLAG_IDS: readonly RawOpticsFlagId[] = ['optics.remove_ca', 'optics.lens_profile', 'profile.camera_local_tone'];
export const RAW_SECTION_IDS = ['light', 'color', 'grading', 'effects', 'detail', 'optics'] as const;
export type RawSectionId = typeof RAW_SECTION_IDS[number];
export const RAW_SETTINGS_SECTION_IDS = RAW_SECTION_IDS;
export type RawSettingsSectionId = typeof RAW_SETTINGS_SECTION_IDS[number];
export const RAW_RESET_SECTION_IDS = [...RAW_SECTION_IDS, 'vignette'] as const;
export type RawResetSectionId = typeof RAW_RESET_SECTION_IDS[number];
export const RAW_VIGNETTE_STYLES = ['highlightPriority', 'colorPriority', 'paintOverlay'] as const;
export type RawVignetteStyle = typeof RAW_VIGNETTE_STYLES[number];
export type RawValues = Record<RawSettingControlId, number>;
export type RawLensProfileInfo = { cameraMake: string | null; cameraModel: string | null; lensMake: string | null;
  lensModel: string | null; lensId: string | null; profileAvailable: boolean | null;
  profileSource: 'file' | 'database' | 'none' | 'unknown'; profileName: string | null; profileApplied: boolean | null };
export type RawLensDatabaseState = { available: boolean; lensCount: number; userDirectoryConfigured: boolean;
  download: { state: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'; bytes?: number; total?: number; files?: number } };
export type RawControlValues = Partial<RawValues> & Partial<Record<RawOpticsFlagId, boolean>>;
export type RawCurveChannel = 'master' | 'red' | 'green' | 'blue';
export type RawCurveResetChannel = RawCurveChannel | 'point';
export type RawCurvePoint = { x: number; y: number };
export type RawCurveCommandPoint = [x: number, y: number];
export const RAW_CURVE_CHANNELS: readonly RawCurveChannel[] = ['master', 'red', 'green', 'blue'];
export const RAW_CURVE_MAX_POINTS = 4096;
export const RAW_CURVE_MAX_BYTES = 64 * 1024;
export const RAW_GEOMETRY_OPERATIONS = ['set', 'drag', 'aspect', 'swap', 'reset', 'straighten', 'rotateLeft', 'rotateRight', 'flipHorizontal', 'flipVertical'] as const;
export type RawGeometryOperationId = typeof RAW_GEOMETRY_OPERATIONS[number];
export type RawCropRect = [number, number, number, number];
export type RawCrop = { geometry: { rect: { x0: number; y0: number; x1: number; y1: number }; angle: number };
  aspect: [number, number] | null; flip_h: boolean; flip_v: boolean };
export type RawGeometryOperation = { type: 'set'; params: { rect?: RawCropRect; angle?: number } }
  | { type: 'drag'; params: { handle: 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft' | 'top' | 'right' | 'bottom' | 'left' | 'move';
      from: [number, number]; to: [number, number]; start?: RawCropRect; keepRatio?: boolean } }
  | { type: 'aspect'; params: { aspect: 'free' | 'original' | 'current' | 'toggle' | `${number}x${number}` | [number, number]; orientation?: 'crop' | 'given' } }
  | { type: 'straighten'; params: { angle: number } }
  | { type: 'swap' | 'reset' | 'rotateLeft' | 'rotateRight' | 'flipHorizontal' | 'flipVertical'; params: Record<string, never> };
export type RawSettings = RawDocument & { settingsFingerprint: string; recipeRevision: number; recipeFingerprint: string | null;
  curve: Record<RawCurveChannel, RawCurvePoint[]>;
  crop?: RawCrop; orientation?: string;
  importDefaultsFingerprint: string;
  recipeRecoveryPending?: boolean;
  sections: Record<RawSettingsSectionId, boolean>;
  mutationAttempts: number; mutationLimit: number; regenerationThreshold: number;
  values: RawValues; opticsFlags: { remove_ca: boolean; lens_profile: boolean }; cameraLocalTone: boolean; lensProfileInfo: RawLensProfileInfo;
  vignetteStyle: RawVignetteStyle; process: number; wbAutoAvailable?: boolean;
  controls: { id: RawSettingControlId; min: number; max: number; step: number; default: number; precision: number }[];
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
export type RawPickFrame = { kind: 'before' | 'after'; geometryId: string; maxSide: number; quality: 'draft' | 'full'; x: number; y: number };
export type RawPickTarget = { url: string; doc: RawDocument; frame: Omit<RawPickFrame, 'x' | 'y'> };
export type RawGeometryAction = 'move' | 'resize' | 'lock' | 'unlock';
export function validGeometryMetadata(m: { operation?: RawGeometryOperationId; action?: RawGeometryAction }) {
  return !!m.operation && RAW_GEOMETRY_OPERATIONS.includes(m.operation) && Object.keys(m).every(k => k === 'operation' || k === 'action')
    && (m.action === undefined || (m.operation === 'drag' ? ['move','resize'] : m.operation === 'aspect' ? ['lock','unlock'] : []).includes(m.action));
}
export type RawHistoryOperation = { kind: 'controlReset'; metadata: { control: RawHistoryControlId } }
  | { kind: 'curve'; metadata: { channel: RawCurveChannel }; points: RawCurveCommandPoint[] }
  | { kind: 'curveReset'; metadata: { channel: RawCurveResetChannel } }
  | { kind: 'opticsFlag'; metadata: { control: RawOpticsFlagId; enabled: boolean } }
  | { kind: 'opticsFlagReset'; metadata: { control: RawOpticsFlagId } }
  | { kind: 'geometry'; metadata: { operation: RawGeometryOperationId; action?: RawGeometryAction }; geometry: RawGeometryOperation }
  | { kind: 'sectionReset'; metadata: { section: RawResetSectionId } }
  | { kind: 'vignetteStyle'; metadata: { style: RawVignetteStyle } }
  | { kind: 'sectionToggle'; metadata: { section: RawSectionId; enabled: boolean } }
  | { kind: 'wbPick'; metadata: Record<string, never>; frame: RawPickFrame }
  | { kind: 'allReset' | 'wbAuto'; metadata: Record<string, never> };
export type RawHistoryRequest = RawRecipeRequest & { action: 'initialize' | 'commit' | 'undo' | 'redo' | 'jump' | 'operate';
  control?: RawHistoryControlId; targetStepId?: string | null; operation?: RawHistoryOperation;
  curveInteractionId?: string;
  geometryCommit?: { gestureId: string; operation: 'set' | 'drag' | 'straighten'; action?: RawGeometryAction } };
export type RawHistoryStep = { stepId: string; kind: 'control' | 'controlReset' | 'opticsFlag' | 'opticsFlagReset' | 'sectionToggle' | 'sectionReset' | 'vignetteStyle' | 'allReset' | 'wbAuto' | 'wbPick' | 'geometry' | 'curve' | 'curveReset';
  metadata: { control?: RawHistoryControlId | RawOpticsFlagId; section?: RawResetSectionId; enabled?: boolean; style?: RawVignetteStyle; operation?: RawGeometryOperationId; action?: RawGeometryAction; channel?: RawCurveResetChannel }; createdAt: string;
  changes: { control: RawHistoryControlId; before: number; after: number }[] | null;
  flagChanges?: { control: RawOpticsFlagId; before: boolean; after: boolean }[] | null };
export type RawHistoryResult = RawSettings & {
  history: { initialized: boolean; cursor: number; length: number; selectedStepId: string | null };
  historyPending: boolean; nativeState: string; nativeMatchesRecipe: boolean; replayed: boolean;
  ack: { saveId: string; revision: number; settingsFingerprint: string; updatedAt: string;
    historyCursor: number; historyLength: number; stepId: string | null } | null;
};
export type RawHistoryData = RawDocument & Pick<RawHistoryResult, 'history' | 'historyPending' | 'nativeState' | 'nativeMatchesRecipe'> & {
  recipeRevision: number; recipeFingerprint: string | null; steps: RawHistoryStep[] };
const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const MAX_IMAGE_BYTES = RAW_WHOLE_MAX_BYTES;
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

const workspaceTransports=new Map<string,AbortController>();
export function abortRawWorkspaceRequests(workspaceId:string){
  workspaceTransports.get(workspaceId)?.abort();
}
async function request(path: string, init: RequestInit = {}) {
  let workspaceId=new Headers(init.headers).get('X-Raw-Workspace');
  if(!workspaceId && typeof init.body==='string'){
    try{const body=JSON.parse(init.body);if(typeof body.workspaceId==='string')workspaceId=body.workspaceId;}catch{/* Validation belongs to the endpoint. */}
  }
  const ownerSignal=workspaceId?workspaceTransports.get(workspaceId)?.signal:undefined;
  const signals=[AbortSignal.timeout(180_000),...(init.signal?[init.signal]:[]),...(ownerSignal?[ownerSignal]:[])];
  const response = await fetch(`/api/raw${path}`, { ...init, cache: 'no-store', credentials: 'same-origin',signal:AbortSignal.any(signals) });
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
  if (typeof value.available !== 'boolean' || value.available && value.version !== LIGHTCRAFT_ENGINE.version) throw new RawApiError('raw_invalid_response');
  return value.available as boolean;
}

function checkLensDatabaseState(value: unknown): RawLensDatabaseState {
  if (!value || typeof value !== 'object') throw new RawApiError('raw_invalid_response');
  const state = value as Record<string, unknown>;
  const download = state.download;
  if (typeof state.available !== 'boolean' || !Number.isSafeInteger(state.lensCount) || (state.lensCount as number) < 0
    || typeof state.userDirectoryConfigured !== 'boolean' || !download || typeof download !== 'object')
    throw new RawApiError('raw_invalid_response');
  const details = download as Record<string, unknown>;
  if (!['idle', 'running', 'done', 'failed', 'cancelled'].includes(String(details.state))) throw new RawApiError('raw_invalid_response');
  if (details.state === 'running' && (!Number.isSafeInteger(details.bytes) || !Number.isSafeInteger(details.total)
    || (details.bytes as number) < 0 || (details.total as number) <= 0 || (details.bytes as number) > (details.total as number)))
    throw new RawApiError('raw_invalid_response');
  if (details.state === 'done' && (!Number.isSafeInteger(details.files) || (details.files as number) <= 0))
    throw new RawApiError('raw_invalid_response');
  return state as unknown as RawLensDatabaseState;
}
export async function readRawLensDatabaseStatus(signal?: AbortSignal) {
  return checkLensDatabaseState(await json('/lens-database', signal ? { signal } : undefined));
}
export async function downloadRawLensDatabase(signal?: AbortSignal) {
  return checkLensDatabaseState(await json('/lens-database', { ...post({}), ...(signal ? { signal } : {}) }));
}

export async function rawRegionOwner(doc: RawDocument, signal: AbortSignal) {
  const started = performance.now();
  let status: number | undefined;
  const trace = (event: string, errorCode?: string, supported?: boolean) => {
    try { frontendLogger.add({ level: errorCode ? 'warn' : 'debug', component: 'raw', event, context: {
      generation: doc.generation, revision: doc.revision, status: status ?? null,
      elapsedMs: performance.now() - started, ...(errorCode ? { errorCode } : {}),
      ...(supported === undefined ? {} : { supported }) } }); } catch { /* Optional diagnostics. */ }
  };
  trace('region.owner.started');
  try {
    const response = await request(`/documents/${doc.handle}/region`, { signal, headers: {
      'X-Raw-Workspace': doc.workspaceId, 'X-Raw-Generation': String(doc.generation), 'X-Raw-Token': doc.documentToken } });
    status = response.status;
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new RawApiError('raw_invalid_response', status);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(await readBounded(response, 4096))); }
    catch { throw new RawApiError('raw_invalid_response', status); }
    if (!value || typeof value !== 'object' || !('sourceId' in value) || !('regionContract' in value)
      || !fingerprint(value.sourceId) || value.regionContract !== null && value.regionContract !== 1)
      throw new RawApiError('raw_invalid_response', status);
    const supported = value.regionContract === 1;
    trace('region.owner.completed', undefined, supported);
    return { sourceId: value.sourceId, supported };
  } catch (error) {
    if (error instanceof RawApiError) status = error.status ?? status;
    trace('region.owner.failed', error instanceof RawApiError ? error.code : signal.aborted ? 'raw_region_cancelled' : 'raw_connection_failed');
    throw error;
  }
}
export type RawRegionResult = { operation: 'plan'; metadata: RegionFrameResponse }
  | { operation: 'render'; metadata: RegionResponse; blob: Blob };
export async function cancelRawRegion(doc: RawDocument, requestId: string) {
  await request(`/documents/${doc.handle}/region/cancel`, post({ ...identityBody(doc), requestId }));
}
export async function rawRegion(doc: RawDocument, target: RegionRequest | RegionFrameRequest,
  geometry: RegionGeometry, supported: boolean, signal: AbortSignal): Promise<RawRegionResult> {
  if (!supported) throw new RawApiError('raw_region_unsupported');
  const operation = 'desiredLongEdge' in target ? 'plan' : 'render';
  if (!(operation === 'plan' ? validateRegionFrameRequest(target) : validateRegionRequest(target))
    || !validRegionGeometry(geometry) || target.geometryId !== geometry.geometryId
    || target.identity.assetId !== doc.assetId || target.identity.generation !== doc.generation
    || target.identity.documentToken !== doc.documentToken || target.documentRevision !== doc.revision
    || target.identity.kind === 'before' && target.identity.beforeKey !== doc.beforeKey)
    throw new RawApiError('raw_invalid_region_request');
  const started = performance.now();
  const response = await request(`/documents/${doc.handle}/region`, { ...post({ workspaceId: doc.workspaceId, operation, target }), signal });
  const received = performance.now();
  try {
    if (response.status === 204) throw new RawSuperseded('replaced');
    if (response.status !== 200) throw new RawApiError('raw_invalid_response');
    const plan = 'desiredLongEdge' in target;
    if (response.headers.get('content-type')?.split(';')[0] !== (plan ? 'application/json' : 'image/png'))
      throw new RawApiError('raw_invalid_response');
    const bytes = await readBounded(response, plan ? 16384 : C1_REGION_BUDGET.maxPngBytes);
    const read = performance.now();
    signal.throwIfAborted();
    const encoded = plan ? new TextDecoder().decode(bytes) : response.headers.get('x-raw-region');
    if (!encoded || encoded.length > 16384) throw new RawApiError('raw_invalid_response');
    let metadata: unknown;
    try { metadata = JSON.parse(encoded); } catch { throw new RawApiError('raw_invalid_response'); }
    const trace = () => {
      try { frontendLogger.add({ level: 'debug', component: 'raw', event: 'region.received', context: {
        requestId: target.requestId, operation, viewGeneration: target.viewGeneration, revision: doc.revision,
        quality: target.quality, kind: target.identity.kind, geometryId: target.geometryId,
        responseWaitMs: received - started, bodyReadMs: read - received, validationMs: performance.now() - read } }); } catch { /* Optional diagnostics. */ }
    };
    if (plan) {
      if (!confirmRegionFullFrame(target, metadata, geometry)) throw new RawApiError('raw_invalid_response');
      trace();
      return { operation: 'plan', metadata: metadata as RegionFrameResponse };
    }
    if (checkRegionResponse(target, metadata).status !== 'accepted') throw new RawApiError('raw_invalid_response');
    const meta = metadata as RegionResponse;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 33 || ![137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)
      || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452
      || view.getUint32(16) !== meta.width || view.getUint32(20) !== meta.height) throw new RawApiError('raw_invalid_response');
    try { frontendLogger.add({ level: 'debug', component: 'raw', event: 'region.received', context: {
      requestId: target.requestId, operation, viewGeneration: target.viewGeneration, revision: doc.revision,
      quality: target.quality, kind: target.identity.kind, geometryId: target.geometryId,
      fullWidth: meta.fullWidth, fullHeight: meta.fullHeight, window: meta.window, validRegion: meta.validRegion,
      payloadBytes: bytes.length,
      responseWaitMs: received - started, bodyReadMs: read - received, validationMs: performance.now() - read } }); } catch { /* Optional diagnostics. */ }
    return { operation: 'render', metadata: meta, blob: new Blob([bytes], { type: 'image/png' }) };
  } finally { await response.body?.cancel().catch(() => {}); }
}
export async function createRawWorkspace() {
  const value = await json('/workspaces', post({}));
  if (!opaque(value.workspaceId)) throw new RawApiError('raw_invalid_response');
  workspaceTransports.set(value.workspaceId,new AbortController());
  return value.workspaceId as string;
}
function document(value: RawDocument, workspaceId: string, assetId?: string) {
  if (!value || value.workspaceId !== workspaceId || !opaque(value.handle) || !opaque(value.documentToken)
    || !integer(value.generation) || !integer(value.revision) || typeof value.assetId !== 'string'
    || assetId !== undefined && value.assetId !== assetId
    || value.recipeRecoveryPending !== undefined && typeof value.recipeRecoveryPending !== 'boolean') throw new RawApiError('raw_invalid_response');
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
export async function discardRawWorkspace(doc: RawDocument | {workspaceId:string}) {
  await request(`/workspaces/${doc.workspaceId}/discard`, post('handle' in doc?{handle:doc.handle,generation:doc.generation,documentToken:doc.documentToken}:{scope:'workspace'}));
  workspaceTransports.delete(doc.workspaceId);
}
export async function releaseRawWorkspace(workspaceId: string) {
  await request(`/workspaces/${workspaceId}`, { method: 'DELETE' });
  workspaceTransports.delete(workspaceId);
}
export async function resetRawEdits(assetId: string, doc?: RawSettings) {
  const body = doc ? { workspaceId: doc.workspaceId, handle: doc.handle, generation: doc.generation,
    documentToken: doc.documentToken, documentRevision: doc.revision } : {};
  await request(`/assets/${encodeURIComponent(assetId)}/edits/reset`, post(body));
}
function settings(value: RawSettings, doc: RawDocument): RawSettings {
  document(value, doc.workspaceId, doc.assetId);
  if (value.crop !== undefined || value.orientation !== undefined) validateCropSettings(value);
  if (value.handle !== doc.handle || value.generation !== doc.generation || value.documentToken !== doc.documentToken
    || !fingerprint(value.settingsFingerprint) || !fingerprint(value.importDefaultsFingerprint)
    || value.recipeRecoveryPending !== undefined && typeof value.recipeRecoveryPending !== 'boolean'
    || value.beforeKey != null && !fingerprint(value.beforeKey) || !integer(value.recipeRevision)
    || value.recipeFingerprint !== null && !fingerprint(value.recipeFingerprint)
    || !integer(value.mutationAttempts) || value.mutationLimit !== 256 || value.regenerationThreshold !== 200
    || value.mutationAttempts > value.mutationLimit || !integer(value.process) || !value.wb || typeof value.wb.available !== 'boolean'
    || typeof value.wb.mode !== 'string' || value.wb.mode.length > 32 || typeof value.wb.scale !== 'string' || value.wb.scale.length > 32
    || value.wbAutoAvailable !== undefined && typeof value.wbAutoAvailable !== 'boolean'
    || !value.opticsFlags || typeof value.opticsFlags.remove_ca !== 'boolean' || typeof value.opticsFlags.lens_profile !== 'boolean'
    || typeof value.cameraLocalTone !== 'boolean'
    || !validRawLensProfileInfo(value.lensProfileInfo)
    || !RAW_VIGNETTE_STYLES.includes(value.vignetteStyle)
    || !value.sections || !RAW_SETTINGS_SECTION_IDS.every(section => typeof value.sections[section] === 'boolean')
    || !value.values || !RAW_SETTINGS_CONTROL_IDS.every(id => Number.isFinite(value.values[id]))
    || !validRawCurve(value.curve)
    || !Array.isArray(value.controls) || value.controls.length !== RAW_SETTINGS_CONTROL_IDS.length
    || new Set(value.controls.map(c => c.id)).size !== RAW_SETTINGS_CONTROL_IDS.length
    || value.controls.some(c => !RAW_SETTINGS_CONTROL_IDS.includes(c.id) || ![c.min, c.max, c.step, c.default].every(Number.isFinite)
      || c.min >= c.max || c.step <= 0 || !integer(c.precision) || c.precision > 4)) throw new RawApiError('raw_invalid_response');
  const info = value.lensProfileInfo;
  if (info.profileApplied === true && info.profileAvailable !== true
    || (!value.opticsFlags.lens_profile || !value.sections.optics || info.profileAvailable === false) && info.profileApplied !== false
    || value.opticsFlags.lens_profile && value.sections.optics && info.profileAvailable === null && info.profileApplied !== null)
    throw new RawApiError('raw_invalid_response');
  return value;
}
export function validRawCurve(value: unknown): value is Record<RawCurveChannel, RawCurvePoint[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const curve = value as Record<string, unknown>;
  if (Object.keys(curve).length !== RAW_CURVE_CHANNELS.length || !RAW_CURVE_CHANNELS.every(channel => channel in curve)) return false;
  return RAW_CURVE_CHANNELS.every(channel => {
    const points = curve[channel];
    return Array.isArray(points) && points.length <= RAW_CURVE_MAX_POINTS && points.every(point =>
      !!point && typeof point === 'object' && !Array.isArray(point)
      && Object.keys(point).length === 2 && 'x' in point && 'y' in point
      && Number.isFinite((point as RawCurvePoint).x) && Number.isFinite((point as RawCurvePoint).y)
      && (point as RawCurvePoint).x >= 0 && (point as RawCurvePoint).x <= 1
      && (point as RawCurvePoint).y >= 0 && (point as RawCurvePoint).y <= 1);
  });
}
export function validRawCurveInput(channel: unknown, points: unknown): points is RawCurveCommandPoint[] {
  return typeof channel === 'string' && RAW_CURVE_CHANNELS.includes(channel as RawCurveChannel)
    && Array.isArray(points) && points.length <= RAW_CURVE_MAX_POINTS
    && new TextEncoder().encode(JSON.stringify({ channel, points })).byteLength <= RAW_CURVE_MAX_BYTES
    && points.every(point => Array.isArray(point) && point.length === 2
      && point.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1));
}
function validRawLensProfileInfo(value: unknown): value is RawLensProfileInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Record<string, unknown>;
  const fields = ['cameraMake', 'cameraModel', 'lensMake', 'lensModel', 'lensId', 'profileName'];
  return fields.every(key => info[key] === null || typeof info[key] === 'string' && new TextEncoder().encode(info[key] as string).byteLength <= 512)
    && ['file', 'database', 'none', 'unknown'].includes(String(info.profileSource))
    && (info.profileAvailable === null || typeof info.profileAvailable === 'boolean')
    && (info.profileApplied === null || typeof info.profileApplied === 'boolean')
    && (info.profileSource === 'file' || info.profileSource === 'database' ? info.profileAvailable === true
      : info.profileSource === 'none' ? info.profileAvailable === false : info.profileAvailable === null);
}
const identityBody = (doc: RawDocument) => ({ workspaceId: doc.workspaceId, generation: doc.generation, documentToken: doc.documentToken });
export async function readRawSettings(doc: RawDocument): Promise<RawSettings> {
  return settings(await json(`/documents/${doc.handle}/settings`, post(identityBody(doc)), RAW_SETTINGS_RESPONSE_BYTES), doc);
}
export async function setRawControls(doc: RawDocument, values: RawControlValues): Promise<RawSettings> {
  const result = settings(await json(`/documents/${doc.handle}/controls`, post({ ...identityBody(doc), expectedRevision: doc.revision, values }), RAW_SETTINGS_RESPONSE_BYTES), doc);
  if (result.revision <= doc.revision) throw new RawApiError('raw_invalid_response');
  return result;
}
function validateCropSettings(value: RawSettings) {
  const c = value.crop, r = c?.geometry?.rect, a = c?.aspect;
  if (!c || !r || ![r.x0, r.y0, r.x1, r.y1, c.geometry.angle].every(Number.isFinite)
    || r.x0 >= r.x1 || r.y0 >= r.y1 || Math.abs(c.geometry.angle) > 45
    || typeof c.flip_h !== 'boolean' || typeof c.flip_v !== 'boolean'
    || !(a === null || Array.isArray(a) && a.length === 2 && a.every(n => Number.isInteger(n) && n > 0 && n <= 0xffffffff) && a[0] / a[1] >= 1 / 20 && a[0] / a[1] <= 20)
    || !['Normal', 'FlipH', 'Rotate180', 'FlipV', 'Transpose', 'Rotate90', 'Transverse', 'Rotate270'].includes(value.orientation ?? ''))
    throw new RawApiError('raw_invalid_response');
}
export type RawGeometryGesture = RawSettings & { gestureId: string; sequence: number };
export async function beginRawGeometry(doc: RawSettings, gestureId: string, operation: 'set' | 'drag' | 'straighten'): Promise<RawGeometryGesture> {
  return geometryGesture(doc, { gestureId, operation }, '/begin');
}
export async function updateRawGeometry(doc: RawSettings, gestureId: string, sequence: number, operation: RawGeometryOperation): Promise<RawGeometryGesture> {
  return geometryGesture(doc, { gestureId, sequence, operation }, '');
}
async function geometryGesture(doc: RawSettings, intent: { gestureId: string; sequence?: number; operation: string | RawGeometryOperation }, suffix: string): Promise<RawGeometryGesture> {
  // Retain this exact intent on reply loss; changing its revision/sequence is a new operation.
  const value = await json(`/documents/${doc.handle}/geometry${suffix}`, post({ ...identityBody(doc), expectedRevision: doc.revision,
    settingsFingerprint: doc.settingsFingerprint, ...intent }), RAW_SETTINGS_RESPONSE_BYTES);
  settings(value, doc); validateCropSettings(value);
  if (value.gestureId !== intent.gestureId || value.sequence !== (intent.sequence ?? -1)
    || (suffix ? value.revision !== doc.revision : value.revision <= doc.revision)) throw new RawApiError('raw_invalid_response');
  return value;
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
  const { doc, action, expectedRecipeRevision, saveId, control, targetStepId, operation, curveInteractionId } = request;
  if (action === 'operate' && operation?.kind === 'curve' && !validRawCurveInput(operation.metadata.channel, operation.points))
    throw new RawSaveError('raw_invalid_request', 'rejected', 422);
  let accepted = false;
  try {
    const value = await json(`/documents/${doc.handle}/history/${action}`, post({ ...identityBody(doc),
      documentRevision: doc.revision, settingsFingerprint: doc.settingsFingerprint, expectedRecipeRevision, saveId,
      ...(action === 'commit' ? request.geometryCommit ? { kind: 'geometry', metadata: { operation: request.geometryCommit.operation, ...(request.geometryCommit.action ? { action: request.geometryCommit.action } : {}) },
        gestureId: request.geometryCommit.gestureId } : { kind: 'control', metadata: { control } } : {}),
      ...(action === 'operate' && operation ? { kind: operation.kind, metadata: operation.metadata,
        ...(operation.kind === 'geometry' ? { geometry: operation.geometry } : {}),
        ...(operation.kind === 'curve' ? { curvePoints: operation.points, ...(curveInteractionId ? { curveInteractionId } : {}) } : {}),
        ...(operation.kind === 'wbPick' ? { frame: operation.frame } : {}) } : {}),
      ...(action === 'jump' ? { targetStepId } : {}) }), RAW_SETTINGS_RESPONSE_BYTES);
    accepted = true;
    settings(value, doc);
    const h = value.history, ack = value.ack;
    if (value.recipeRecoveryPending === true && ack === null) {
      if (!h || h.initialized !== false || h.cursor !== 0 || h.length !== 0 || h.selectedStepId !== null
        || value.recipeRevision !== expectedRecipeRevision || value.recipeFingerprint !== null
        || value.historyPending || value.nativeState !== 'synced' || !value.nativeMatchesRecipe
        || value.settingsFingerprint !== doc.settingsFingerprint || value.revision < doc.revision || value.replayed !== false)
        throw new RawApiError('raw_invalid_response');
      return value as RawHistoryResult;
    }
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
export async function readRawHistory(doc: RawDocument): Promise<RawHistoryData> {
  const value = await json(`/documents/${doc.handle}/history`, { headers: {
    'X-Raw-Workspace': doc.workspaceId, 'X-Raw-Generation': String(doc.generation), 'X-Raw-Token': doc.documentToken } }, 1024 * 1024);
  document(value, doc.workspaceId, doc.assetId);
  const h = value.history;
  if (value.handle !== doc.handle || value.generation !== doc.generation || value.documentToken !== doc.documentToken
    || value.revision !== doc.revision || !fingerprint(value.settingsFingerprint)
    || !integer(value.recipeRevision) || value.recipeFingerprint !== null && !fingerprint(value.recipeFingerprint)
    || !h || typeof h.initialized !== 'boolean' || !integer(h.cursor) || !integer(h.length) || h.length > 200 || h.cursor > h.length
    || (h.cursor === 0 ? h.selectedStepId !== null : !uuid(h.selectedStepId))
    || typeof value.historyPending !== 'boolean' || typeof value.nativeMatchesRecipe !== 'boolean'
    || !['synced', 'desynchronized'].includes(value.nativeState) || !Array.isArray(value.steps)
    || value.steps.length !== h.length) throw new RawApiError('raw_invalid_response');
  const ids = new Set<string>();
  for (const step of value.steps) {
    const m = step?.metadata;
    if (!step || !uuid(step.stepId) || ids.has(step.stepId) || typeof step.createdAt !== 'string' || !Number.isFinite(Date.parse(step.createdAt))
      || !m || typeof m !== 'object' || Array.isArray(m)
      || (step.kind === 'geometry' ? !validGeometryMetadata(m)
        : step.kind === 'control' || step.kind === 'controlReset' ? Object.keys(m).length !== 1 || !RAW_HISTORY_CONTROL_IDS.includes(m.control as RawHistoryControlId)
        : step.kind === 'opticsFlag' ? Object.keys(m).length !== 2 || !RAW_OPTICS_FLAG_IDS.includes(m.control as RawOpticsFlagId) || typeof m.enabled !== 'boolean'
        : step.kind === 'opticsFlagReset' ? Object.keys(m).length !== 1 || !RAW_OPTICS_FLAG_IDS.includes(m.control as RawOpticsFlagId)
        : step.kind === 'sectionToggle' ? Object.keys(m).length !== 2 || !RAW_SECTION_IDS.includes(m.section) || typeof m.enabled !== 'boolean'
        : step.kind === 'sectionReset' ? Object.keys(m).length !== 1 || !RAW_RESET_SECTION_IDS.includes(m.section)
        : step.kind === 'vignetteStyle' ? Object.keys(m).length !== 1 || !RAW_VIGNETTE_STYLES.includes(m.style)
        : step.kind === 'curve' ? Object.keys(m).length !== 1 || !RAW_CURVE_CHANNELS.includes(m.channel as RawCurveChannel)
        : step.kind === 'curveReset' ? Object.keys(m).length !== 1 || ![...RAW_CURVE_CHANNELS, 'point'].includes(m.channel as RawCurveResetChannel)
        : !['allReset', 'wbAuto', 'wbPick'].includes(step.kind) || Object.keys(m).length !== 0)
      || !(step.changes === null || Array.isArray(step.changes) && step.changes.length <= RAW_HISTORY_CONTROL_IDS.length
        && step.changes.every((change: unknown, index: number, changes: unknown[]) => {
          const item = change as { control?: unknown; before?: unknown; after?: unknown } | null;
          return !!item && RAW_HISTORY_CONTROL_IDS.includes(item.control as RawHistoryControlId)
            && typeof item.before === 'number' && Number.isFinite(item.before)
            && typeof item.after === 'number' && Number.isFinite(item.after)
            && changes.findIndex(other => (other as { control?: unknown } | null)?.control === item.control) === index;
        }))
      || step.flagChanges !== undefined && !(step.flagChanges === null || Array.isArray(step.flagChanges)
        && step.flagChanges.length <= RAW_OPTICS_FLAG_IDS.length
        && step.flagChanges.every((change: unknown, index: number, changes: unknown[]) => {
          const item = change as { control?: unknown; before?: unknown; after?: unknown } | null;
          return !!item && RAW_OPTICS_FLAG_IDS.includes(item.control as RawOpticsFlagId)
            && typeof item.before === 'boolean' && typeof item.after === 'boolean'
            && changes.findIndex(other => (other as { control?: unknown } | null)?.control === item.control) === index;
        }))
      || (step.kind === 'opticsFlag' || step.kind === 'opticsFlagReset') && !Array.isArray(step.flagChanges)
      || step.flagChanges !== undefined && step.kind !== 'opticsFlag' && step.kind !== 'opticsFlagReset'
        && step.kind !== 'allReset' && !(step.kind === 'sectionReset' && step.metadata.section === 'optics'))
      throw new RawApiError('raw_invalid_response');
    ids.add(step.stepId);
  }
  if (h.cursor > 0 && value.steps[h.cursor - 1].stepId !== h.selectedStepId)
    throw new RawApiError('raw_invalid_response');
  // Keep only the display contract, even if a server accidentally adds internal fields.
  return { workspaceId: value.workspaceId, handle: value.handle, assetId: value.assetId, generation: value.generation,
    documentToken: value.documentToken, revision: value.revision, settingsFingerprint: value.settingsFingerprint,
    recipeRevision: value.recipeRevision, recipeFingerprint: value.recipeFingerprint,
    history: { initialized: h.initialized, cursor: h.cursor, length: h.length, selectedStepId: h.selectedStepId },
    historyPending: value.historyPending, nativeState: value.nativeState, nativeMatchesRecipe: value.nativeMatchesRecipe,
    steps: value.steps.map((step: RawHistoryStep) => ({ stepId: step.stepId,
      kind: step.kind, metadata: { ...step.metadata }, createdAt: step.createdAt,
      changes: step.changes?.map(change => ({ ...change })) ?? null,
      ...(step.flagChanges !== undefined ? { flagChanges: step.flagChanges?.map(change => ({ ...change })) ?? null } : {}) })) };
}

export async function recoverRawGeometry(doc: RawSettings) {
  const value = await json(`/documents/${doc.handle}/history/recover`, post({ ...identityBody(doc), documentRevision: doc.revision,
    settingsFingerprint: doc.settingsFingerprint, expectedRecipeRevision: doc.recipeRevision }), RAW_SETTINGS_RESPONSE_BYTES);
  settings(value, doc);
  if (value.historyPending || value.nativeState !== 'synced' || !value.nativeMatchesRecipe || value.ack !== null)
    throw new RawApiError('raw_save_unconfirmed');
  return value as RawSettings;
}
export async function cancelRawPreview(doc: RawDocument, kind: 'before' | 'after', serial: number) {
  await request(`/documents/${doc.handle}/preview/cancel`, post({ ...identityBody(doc), kind, serial }));
}
export async function beginRawCurveInteraction(doc: RawSettings, channel: RawCurveChannel, mode: 'points' | 'targeted' = 'points'): Promise<string> {
  const value = await json(`/documents/${doc.handle}/curve-interaction/begin`, post({ ...identityBody(doc),
    documentRevision: doc.revision, channel, ...(mode === 'targeted' ? { mode } : {}) }));
  document(value, doc.workspaceId, doc.assetId);
  if (value.handle !== doc.handle || value.generation !== doc.generation || value.documentToken !== doc.documentToken
    || typeof value.interactionId !== 'string' || !/^[a-f0-9]{32}$/.test(value.interactionId)) throw new RawApiError('raw_invalid_response');
  return value.interactionId;
}
export async function cancelRawCurveInteraction(doc: RawSettings, interactionId: string) {
  await request(`/documents/${doc.handle}/curve-interaction/cancel`, post({ ...identityBody(doc),
    documentRevision: doc.revision, interactionId }));
}
export async function updateRawTargetedCurve(doc: RawDocument, serial: number, signal: AbortSignal, target: RawDisplayTarget,
  interaction: { id: string; target: { x: number; y: number }; steps: number[] }): Promise<{ sequence: number; points: RawCurvePoint[] }> {
  const response = await request(`/documents/${doc.handle}/curve-interaction/update`, { ...post({ ...identityBody(doc),
    documentRevision: doc.revision, interactionId: interaction.id, target: interaction.target, steps: interaction.steps,
    serial, maxSide: target.maxSide, viewGeneration: target.viewGeneration, geometryId: target.geometryId }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]) });
  if (response.status === 204) {
    const reason = response.headers.get('x-raw-superseded-reason');
    if (reason !== 'revision' && reason !== 'replaced' && reason !== 'cancelled') throw new RawApiError('raw_invalid_response');
    throw new RawSuperseded(reason);
  }
  if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new RawApiError('raw_invalid_response');
  let value: any;
  try { value = JSON.parse(new TextDecoder().decode(await readBounded(response, 512 * 1024))); }
  catch { throw new RawApiError('raw_invalid_response'); }
  if (!value || value.interactionId !== interaction.id || !Number.isSafeInteger(value.interactionSequence)
    || value.interactionSequence < 1 || !Array.isArray(value.curvePoints) || value.curvePoints.length > 4096
    || value.curvePoints.some((p: unknown) => !p || typeof p !== 'object' || !Number.isFinite((p as RawCurvePoint).x)
      || !Number.isFinite((p as RawCurvePoint).y) || (p as RawCurvePoint).x < 0 || (p as RawCurvePoint).x > 1
      || (p as RawCurvePoint).y < 0 || (p as RawCurvePoint).y > 1)) throw new RawApiError('raw_invalid_response');
  return { sequence: value.interactionSequence, points: value.curvePoints };
}
export async function rawPreview(doc: RawDocument, serial: number, signal: AbortSignal, kind: 'before' | 'after' = 'after', target?: RawDisplayTarget,
  interaction?: { id: string; points: RawCurveCommandPoint[] },
  targetedInteraction?: { id: string; target: { x: number; y: number }; steps: number[] } | { id: string; sequence: number }): Promise<RawFrame> {
  if (target && (!Number.isInteger(target.maxSide) || target.maxSide < 16 || target.maxSide > RAW_PREVIEW_MAX_SIDE))
    throw new RawApiError('raw_invalid_preview_request');
  if (targetedInteraction && 'steps' in targetedInteraction) {
    if (!target || kind !== 'after') throw new RawApiError('raw_invalid_preview_request');
    const readback = await updateRawTargetedCurve(doc, serial, signal, target, targetedInteraction);
    const frame = await rawPreview(doc, serial, signal, 'after', target, undefined,
      { id: targetedInteraction.id, sequence: readback.sequence });
    return { ...frame, curvePoints: readback.points };
  }
  const started = performance.now();
  const activeInteraction = targetedInteraction ?? interaction;
  const previewSequence = targetedInteraction && 'sequence' in targetedInteraction ? targetedInteraction.sequence : undefined;
  const response = await request(`/documents/${doc.handle}/${activeInteraction ? `curve-interaction/${previewSequence ? 'preview' : 'update'}` : 'preview'}`, { ...post({ workspaceId: doc.workspaceId,
    generation: doc.generation, documentToken: doc.documentToken,
    ...(activeInteraction ? { documentRevision: doc.revision, interactionId: activeInteraction.id,
      ...(previewSequence ? { interactionSequence: previewSequence } : { points: interaction!.points }),
      serial, maxSide: target?.maxSide ?? RAW_PREVIEW_MAX_SIDE, viewGeneration: target?.viewGeneration ?? 0,
      geometryId: target?.geometryId ?? null } : { revision: doc.revision, serial, ...target, ...(kind === 'before' ? { kind } : {}) }) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]) });
  try {
    const responseStarted = performance.now();
    if (response.status === 204) {
      const reason = response.headers.get('x-raw-superseded-reason');
      if (reason !== 'revision' && reason !== 'replaced' && reason !== 'cancelled') throw new RawApiError('raw_invalid_response');
      throw new RawSuperseded(reason);
    }
    let frame: RawGeometry | undefined, quality: 'draft' | 'full' | undefined, cropDisplay: RawCropDisplay | undefined;
    if (target) {
      const editing = target.mode === 'crop-edit';
      const contract = response.headers.get(editing ? 'x-raw-crop-edit-contract' : 'x-raw-preview-contract');
      if (editing && (kind !== 'after' || contract !== '1' || response.headers.has('x-raw-preview-contract'))
        || !editing && response.headers.has('x-raw-crop-edit-contract')) throw new RawApiError('raw_invalid_response');
      const actual = response.headers.get('x-raw-quality');
      // Full remains usable during a gesture when the engine has no Draft capability.
      if (response.headers.get('x-raw-mode') !== target.mode || response.headers.get('x-raw-view-generation') !== String(target.viewGeneration)
        || contract !== '0' && contract !== '1' || actual !== 'full' && actual !== 'draft'
        || (contract === '1' ? actual !== target.quality && !(kind === 'after' && target.quality === 'draft' && actual === 'full') : actual !== 'full')) throw new RawApiError('raw_invalid_response');
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
      if (editing) {
        try {
          const encoded = response.headers.get('x-raw-crop');
          if (!encoded || encoded.length > 16384) throw new Error();
          cropDisplay = JSON.parse(encoded);
          if (!cropDisplay || cropDisplay.settingsFingerprint !== doc.settingsFingerprint
            || cropDisplay.bitmapSpace !== 'oriented-warped-unstraightened-flipped') throw new Error();
          validateCropSettings(cropDisplay.canonicalGeometry as RawSettings);
        } catch { throw new RawApiError('raw_invalid_response'); }
      }
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
    let interactionSequence: number | undefined;
    let curvePoints: RawCurvePoint[] | undefined;
    if (activeInteraction) {
      const id = response.headers.get('x-raw-interaction-id'), sequenceText = response.headers.get('x-raw-interaction-sequence');
      if (id !== activeInteraction!.id || !sequenceText || !/^\d+$/.test(sequenceText) || !integer(Number(sequenceText)) || Number(sequenceText) < 1)
        throw new RawApiError('raw_invalid_response');
      interactionSequence = Number(sequenceText);
      const encodedPoints = response.headers.get('x-raw-curve-points');
      if (encodedPoints !== null) {
        try {
          const parsed: unknown = JSON.parse(encodedPoints);
          if (!Array.isArray(parsed) || parsed.some(p => !p || typeof p.x !== 'number' || typeof p.y !== 'number'
            || !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error();
          curvePoints = parsed;
        } catch { throw new RawApiError('raw_invalid_response'); }
      }
    }
    const width = numeric('width'), height = numeric('height'), epoch = numeric('epoch'), sequence = numeric('sequence');
    if (frame && (frame.fullWidth !== width || frame.fullHeight !== height)) throw new RawApiError('raw_invalid_response');
    if (!width || !height || Math.max(width, height) > (target?.maxSide ?? RAW_PREVIEW_MAX_SIDE) || width * height > RAW_PREVIEW_MAX_SIDE ** 2) throw new RawApiError('raw_invalid_response');
    const bytes = await readBounded(response, MAX_IMAGE_BYTES);
    try { frontendLogger.add({ level: 'debug', component: 'raw', event: 'preview.received', context: {
      generation: doc.generation, revision: doc.revision, renderSerial: serial, kind, quality: quality ?? 'full', requestedMaxSide: target?.maxSide ?? 1024,
      width, height, payloadBytes: bytes.length, responseWaitMs: responseStarted - started,
      bodyReadMs: performance.now() - responseStarted } }); } catch { /* Optional diagnostics. */ }
    check();
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw new RawApiError('raw_invalid_response');
    return { blob: new Blob([bytes], { type: 'image/png' }), width, height, epoch, sequence,
      kind, quality, frame, cropDisplay, ...(activeInteraction ? { interactionId: activeInteraction.id, interactionSequence } : {}), ...(curvePoints ? { curvePoints } : {}),
      ...(kind === 'before' ? { key: doc.beforeKey! } : {}) };
  } finally { await response.body?.cancel().catch(() => {}); }
}

/** A repeated DELETE can lose its ack; only an observed empty owner permits moving on. */
export async function rawWorkspaceEmpty(): Promise<boolean> {
  const value = await json('/capabilities');
  return value.workspaceState === 'empty' && value.cleanupPending === false;
}
