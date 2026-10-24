import spec from './rawRegionContract.json';
import schemas from './rawRegion.schema.json';
import { RAW_WHOLE_MAX_BYTES } from './rawWholePreview';
import { C1_REGION_BUDGET as B, containsRegionRect, regionInteger, regionNativeRect, validRegionGeometry,
  type RegionFullFrame, type RegionGeometry, type RegionRect, type RegionWindow } from './rawRegionPlanner';

export const RAW_REGION_CONTRACT = 1 as const;
export type RegionQuality = 'draft' | 'full';
export type RegionIdentity = Readonly<{ assetId: string; sourceId: string; generation: number; documentToken: string } &
  ({ kind: 'after'; revision: number } | { kind: 'before'; beforeKey: string })>;
export type RegionRequest = Readonly<{ contractVersion: 1; mode: 'region'; quality: RegionQuality; geometryId: string;
  fullWidth: number; fullHeight: number; window: RegionWindow; validRegion: RegionWindow; context: number; prefetch: number;
  identity: RegionIdentity; documentRevision: number; viewGeneration: number; requestId: string }>;
export type RegionResponse = RegionRequest & Readonly<{ width: number; height: number; kind: 'after' | 'before' }>;
export type RegionCapability = Readonly<{ regionContract: 1 }>;
// Preflight asks LC to round/fit once; its confirmed F is the only input to the coordinate planner.
export type RegionFrameRequest = Readonly<Pick<RegionRequest, 'contractVersion' | 'mode' | 'quality' | 'geometryId'
  | 'identity' | 'documentRevision' | 'viewGeneration' | 'requestId'> & { desiredLongEdge: number }>;
export type RegionFrameResponse = RegionFrameRequest & Readonly<{ nativeWidth: number; nativeHeight: number;
  fullWidth: number; fullHeight: number; kind: 'before' | 'after' }>;
type RecordValue = Record<string, unknown>;
const object = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: RecordValue, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const opaque = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const count = (v: unknown, min = 0): v is number => typeof v === 'number' && regionInteger(v, min);
const equalWindow = (a: RegionWindow, b: RegionWindow) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
export function validRegionIdentity(v: unknown): v is RegionIdentity {
  if (!object(v) || typeof v.assetId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.assetId)
    || !hash(v.sourceId) || !count(v.generation) || !opaque(v.documentToken)) return false;
  const keys = ['assetId', 'sourceId', 'generation', 'documentToken', 'kind'];
  return v.kind === 'after' ? exact(v, [...keys, 'revision']) && count(v.revision)
    : v.kind === 'before' && exact(v, [...keys, 'beforeKey']) && hash(v.beforeKey);
}
function boundedWindow(v: unknown, fw: number, fh: number): v is RegionWindow {
  return object(v) && exact(v, ['x', 'y', 'w', 'h']) && count(v.x) && count(v.y) && count(v.w, 1) && count(v.h, 1)
    && v.x <= fw - v.w && v.y <= fh - v.h;
}
function target(v: RecordValue): boolean {
  if (v.contractVersion !== RAW_REGION_CONTRACT || v.mode !== 'region' || !['draft', 'full'].includes(v.quality as string)
    || !hash(v.geometryId) || !count(v.fullWidth, 1) || !count(v.fullHeight, 1)
    || Math.max(v.fullWidth, v.fullHeight) > B.maxFullSide
    || !count(v.context) || v.context > B.maxFullSide || !count(v.prefetch) || v.prefetch > B.maxFullSide
    || !boundedWindow(v.window, v.fullWidth, v.fullHeight) || !boundedWindow(v.validRegion, v.fullWidth, v.fullHeight)
    || v.window.w > B.maxSide || v.window.h > B.maxSide || v.window.w * v.window.h > B.maxPixels
    || !validRegionIdentity(v.identity) || !count(v.documentRevision) || !count(v.viewGeneration) || !opaque(v.requestId)
    || v.identity.kind === 'after' && v.identity.revision !== v.documentRevision) return false;
  const w = v.window, valid = v.validRegion, context = v.context;
  // The same global-coordinate inner rect is transmitted; no receiver invents a second inset.
  const x = w.x + (w.x === 0 ? 0 : context), y = w.y + (w.y === 0 ? 0 : context);
  const right = w.x + w.w - (w.x + w.w === v.fullWidth ? 0 : context);
  const bottom = w.y + w.h - (w.y + w.h === v.fullHeight ? 0 : context);
  return equalWindow(valid, { x, y, w: right - x, h: bottom - y });
}
export function validateRegionRequest(v: unknown): v is RegionRequest {
  return object(v) && exact(v, spec.requestFields) && target(v);
}
export function validateRegionResponse(v: unknown): v is RegionResponse {
  return object(v) && exact(v, spec.responseFields) && target(v) && object(v.window) && object(v.identity)
    && count(v.width, 1) && count(v.height, 1) && v.width === v.window.w && v.height === v.window.h && v.kind === v.identity.kind;
}
export function validateRegionFrameRequest(v: unknown): v is RegionFrameRequest {
  return object(v) && exact(v, Object.keys(schemas.$defs.frameRequest.properties)) && v.contractVersion === 1 && v.mode === 'region'
    && ['draft', 'full'].includes(v.quality as string) && hash(v.geometryId) && validRegionIdentity(v.identity)
    && count(v.documentRevision) && (v.identity.kind !== 'after' || v.identity.revision === v.documentRevision)
    && count(v.viewGeneration) && opaque(v.requestId) && typeof v.desiredLongEdge === 'number'
    && Number.isFinite(v.desiredLongEdge) && v.desiredLongEdge > 0 && v.desiredLongEdge <= B.maxFullSide;
}
export function confirmRegionFullFrame(query: RegionFrameRequest, value: unknown, geometry: RegionGeometry): RegionFullFrame | undefined {
  if (!validateRegionFrameRequest(query) || !object(value) || !validRegionGeometry(geometry)
    || !exact(value, Object.keys(schemas.$defs.frameResponse.properties))) return undefined;
  const echo = Object.fromEntries(Object.keys(query).map(k => [k, value[k]]));
  if (!validateRegionFrameRequest(echo) || canonical(echo) !== canonical(query)
    || value.geometryId !== geometry.geometryId || value.nativeWidth !== geometry.nativeWidth || value.nativeHeight !== geometry.nativeHeight
    || value.kind !== query.identity.kind || !count(value.fullWidth, 1) || !count(value.fullHeight, 1)
    || value.fullWidth > geometry.nativeWidth || value.fullHeight > geometry.nativeHeight
    || Math.max(value.fullWidth, value.fullHeight, geometry.nativeWidth, geometry.nativeHeight) > B.maxFullSide) return undefined;
  return { geometryId: geometry.geometryId, fullWidth: value.fullWidth, fullHeight: value.fullHeight };
}
// This is a pure tools/list recognizer. Nothing calls a Region tool or changes B1 availability in C0.
export function regionCapability(toolsList: unknown): RegionCapability | undefined {
  if (!object(toolsList) || !Array.isArray(toolsList.tools)) return undefined;
  const matches = toolsList.tools.filter(t => object(t) && t.name === spec.capability.tool);
  if (matches.length !== 1 || !object(matches[0]) || !object(matches[0].inputSchema)) return undefined;
  const schema = matches[0].inputSchema;
  const required = schema.required;
  if (!object(schema.properties) || !Array.isArray(required)
    || ![spec.capability.marker, 'target', 'id', 'operation'].every(k => required.includes(k))) return undefined;
  const marker = schema.properties[spec.capability.marker], request = schema.properties.target, operation = schema.properties.operation;
  if (schema.type !== 'object' || !object(schema.properties.id) || schema.properties.id.type !== 'string'
    || !object(marker) || marker.type !== 'integer' || !Array.isArray(marker.enum) || marker.enum.length !== 1
    || marker.enum[0] !== RAW_REGION_CONTRACT || !object(request)
    || canonical(operation) !== canonical({ type: 'string', enum: ['plan', 'render'] })
    || canonical(request) !== canonical({ oneOf: [schemas.$defs.frameRequest, schemas.$defs.request] })) return undefined;
  return { regionContract: RAW_REGION_CONTRACT };
}
export function regionEnvelopeWithinBudget(mode: 'whole' | 'region', pngBytes: number, lineBytes: number): boolean {
  if (mode !== 'whole' && mode !== 'region') return false;
  // Whole keeps its existing independent envelope; this helper cannot widen either transport.
  const pngLimit = mode === 'region' ? B.maxPngBytes : RAW_WHOLE_MAX_BYTES;
  const lineLimit = mode === 'region' ? B.maxMcpLineBytes : 24 * 1024 ** 2;
  return regionInteger(pngBytes, 1) && regionInteger(lineBytes, 1) && pngBytes <= pngLimit && lineBytes <= lineLimit;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function ownerKey(i: RegionIdentity) { return [i.assetId, i.sourceId, i.generation, i.documentToken]; }
function contentOwnerKey(r: RegionRequest) { return [...ownerKey(r.identity), r.identity.kind,
  r.identity.kind === 'after' ? r.identity.revision : r.identity.beforeKey, r.contractVersion, r.mode, r.quality,
  r.geometryId, r.fullWidth, r.fullHeight, spec.outputProfile]; }
export function regionCacheKey(r: RegionRequest): string {
  return JSON.stringify([...contentOwnerKey(r), r.window.x, r.window.y, r.window.w, r.window.h,
    r.validRegion.x, r.validRegion.y, r.validRegion.w, r.validRegion.h]);
}
export function canReuseRegion(cached: RegionResponse, wanted: RegionRequest, geometry: RegionGeometry, visible: RegionRect): boolean {
  if (!validateRegionResponse(cached) || !validateRegionRequest(wanted) || !validRegionGeometry(geometry)
    || geometry.geometryId !== wanted.geometryId || cached.fullWidth > geometry.nativeWidth || cached.fullHeight > geometry.nativeHeight
    || JSON.stringify(contentOwnerKey(cached)) !== JSON.stringify(contentOwnerKey(wanted))) return false;
  return containsRegionRect(regionNativeRect(cached.validRegion, geometry, cached), visible);
}
export function regionPairMatches(after: RegionResponse, before: RegionResponse): boolean {
  return validateRegionResponse(after) && validateRegionResponse(before) && after.kind === 'after' && before.kind === 'before'
    && JSON.stringify(ownerKey(after.identity)) === JSON.stringify(ownerKey(before.identity))
    && after.documentRevision === before.documentRevision && after.geometryId === before.geometryId && after.quality === before.quality
    && after.fullWidth === before.fullWidth && after.fullHeight === before.fullHeight
    && equalWindow(after.window, before.window) && equalWindow(after.validRegion, before.validRegion)
    && after.width === before.width && after.height === before.height;
}
export type RegionAcceptance = { status: 'accepted'; response: RegionResponse } | { status: 'stale' | 'invalid' }
  | { status: 'replan'; full: RegionFullFrame } | { status: 'whole'; reason: 'geometry_mismatch' };
export function checkRegionResponse(request: RegionRequest, response: unknown, replanCount = 0): RegionAcceptance {
  if (!validateRegionRequest(request) || !validateRegionResponse(response)) return { status: 'invalid' };
  if (response.requestId !== request.requestId || response.viewGeneration !== request.viewGeneration
    || response.documentRevision !== request.documentRevision || JSON.stringify(contentOwnerKey({ ...response,
      geometryId: request.geometryId, fullWidth: request.fullWidth, fullHeight: request.fullHeight }))
      !== JSON.stringify(contentOwnerKey(request))) return { status: 'stale' };
  if (response.geometryId !== request.geometryId) return { status: 'whole', reason: 'geometry_mismatch' };
  if (response.fullWidth !== request.fullWidth || response.fullHeight !== request.fullHeight)
    return replanCount === 0 ? { status: 'replan', full: { geometryId: response.geometryId,
      fullWidth: response.fullWidth, fullHeight: response.fullHeight } } : { status: 'whole', reason: 'geometry_mismatch' };
  if (regionCacheKey(response) !== regionCacheKey(request) || response.context !== request.context || response.prefetch !== request.prefetch)
    return { status: 'invalid' };
  return { status: 'accepted', response };
}
