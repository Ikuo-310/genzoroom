import { expect, it } from 'vitest';
import schemas from './rawRegion.schema.json';
import spec from './rawRegionContract.json';
import { C1_REGION_BUDGET, type RegionGeometry } from './rawRegionPlanner';
import { canReuseRegion, checkRegionResponse, regionCacheKey, regionCapability, regionEnvelopeWithinBudget,
  regionPairMatches, validateRegionRequest, validateRegionResponse, confirmRegionFullFrame, validateRegionFrameRequest,
  type RegionFrameRequest } from './rawRegionContract';
import { regionRequest as request, regionResponse as response } from './test/rawRegion';
const schemaRequest = schemas.$defs.request, schemaResponse = schemas.$defs.response;

const geometry: RegionGeometry = { geometryId: 'a'.repeat(64), nativeWidth: 4000, nativeHeight: 3000 };
function tools() { return { tools: [{ name: 'render_region_preview', inputSchema: { type: 'object', required: ['id', 'region_contract', 'operation', 'target'],
  properties: { id: { type: 'string' }, region_contract: { type: 'integer', enum: [1] }, operation: { type: 'string', enum: ['plan', 'render'] },
    target: { oneOf: [structuredClone(schemas.$defs.frameRequest), structuredClone(schemaRequest)] } } } }] }; }

it('keeps the JSON schemas, typed validator fields, capability and initial budgets aligned', () => {
  expect(spec.contractVersion).toBe(1);
  expect(Object.keys(schemaRequest.properties)).toEqual(spec.requestFields);
  expect(Object.keys(schemaResponse.properties)).toEqual(spec.responseFields);
  expect(schemaRequest.additionalProperties).toBe(false);
  expect(schemaResponse.additionalProperties).toBe(false);
  expect(schemaRequest.properties.fullWidth.maximum).toBe(C1_REGION_BUDGET.maxFullSide);
  expect(schemaRequest.properties.window.properties.w.maximum).toBe(C1_REGION_BUDGET.maxSide);
  for (const quality of ['draft', 'full'] as const) {
    const r = request({ quality });
    expect(validateRegionRequest(r)).toBe(true);
    expect(validateRegionResponse(response(r))).toBe(true);
    expect(checkRegionResponse(r, response(r)).status).toBe('accepted');
  }
});
it('uses a separate capability with exact contract schema, never adaptive preview alone', () => {
  expect(regionCapability(tools())).toEqual({ regionContract: 1 });
  for (const value of [undefined, {}, { tools: [] }, { tools: [{ name: 'render_preview', inputSchema: { properties: { preview_contract: { enum: [1] } } } }] }])
    expect(regionCapability(value)).toBeUndefined();
  const unsupported = tools(); unsupported.tools[0].inputSchema.properties.region_contract.enum = [2];
  expect(regionCapability(unsupported)).toBeUndefined();
  const partial = tools(); partial.tools[0].inputSchema.properties.target.oneOf[1].required.pop();
  expect(regionCapability(partial)).toBeUndefined();
  const permissive = tools(); permissive.tools[0].inputSchema.properties.target.oneOf[1].additionalProperties = true;
  expect(regionCapability(permissive)).toBeUndefined();
  const duplicate = tools(); duplicate.tools.push(duplicate.tools[0]);
  expect(regionCapability(duplicate)).toBeUndefined();
});
it('obtains F from an explicit native preflight instead of implementing LC aspect rounding', () => {
  const r = request();
  const query: RegionFrameRequest = { contractVersion: 1, mode: 'region', quality: 'full', geometryId: r.geometryId,
    identity: r.identity, documentRevision: 2, viewGeneration: 3, requestId: r.requestId, desiredLongEdge: 1999.25 };
  const result = { ...query, nativeWidth: 4000, nativeHeight: 3000, fullWidth: 1999, fullHeight: 1499, kind: 'after' };
  expect(validateRegionFrameRequest(query)).toBe(true);
  expect(confirmRegionFullFrame(query, result, geometry)).toEqual({ geometryId: r.geometryId, fullWidth: 1999, fullHeight: 1499 });
  for (const patch of [{ desiredLongEdge: NaN }, { desiredLongEdge: 0 }, { desiredLongEdge: 65537 }, { quality: 'fast' }])
    expect(validateRegionFrameRequest({ ...query, ...patch })).toBe(false);
  for (const patch of [{ fullWidth: 0 }, { fullHeight: 3001 }, { fullWidth: 1.5 }, { nativeWidth: 3999 },
    { geometryId: 'e'.repeat(64) }, { viewGeneration: 4 }, { requestId: 'e'.repeat(32) }, { kind: 'before' }, { extra: true }])
    expect(confirmRegionFullFrame(query, { ...result, ...patch }, geometry)).toBeUndefined();
});
it.each([
  { mode: 'whole' }, { quality: 'fast' }, { contractVersion: 2 }, { fullWidth: 65537 }, { fullHeight: 0 },
  { fullWidth: 1.5 }, { viewGeneration: Number.MAX_SAFE_INTEGER + 1 }, { viewGeneration: NaN }, { requestId: 'unbounded' },
  { geometryId: 'unknown' }, { context: -1 }, { prefetch: .5 }, { documentRevision: 3 }, { arbitrary: true },
  { window: { x: 3999, y: 0, w: 2, h: 2 } }, { window: { x: 1000, y: 0, w: 2049, h: 1 } },
  { window: { x: 0, y: 0, w: 2048, h: 2048 } }, { window: { x: 2 ** 53, y: 0, w: 1, h: 1 } },
  { validRegion: { x: 1015, y: 816, w: 968, h: 768 } }, { identity: { kind: 'after' } },
])('rejects malformed request %j', patch => {
  expect(validateRegionRequest({ ...request(), ...patch })).toBe(false);
});
it('rejects incomplete, extra and invalid actual response metadata', () => {
  const missing = { ...response() } as Record<string, unknown>; delete missing.width;
  expect(validateRegionResponse(missing)).toBe(false);
  for (const patch of [{ width: 999 }, { height: 0 }, { kind: 'before' }, { width: Infinity }, { extra: 1 }])
    expect(validateRegionResponse({ ...response(), ...patch })).toBe(false);
  expect(validateRegionRequest(null)).toBe(false);
  expect(validateRegionResponse([])).toBe(false);
});
it('never places a bitmap using requested F when actual Native F changes', () => {
  const r = request(), actual = response({ ...r, fullWidth: 3999 });
  expect(checkRegionResponse(r, actual)).toEqual({ status: 'replan', full: { geometryId: r.geometryId, fullWidth: 3999, fullHeight: 3000 } });
  expect(checkRegionResponse(r, actual, 1)).toEqual({ status: 'whole', reason: 'geometry_mismatch' });
  expect(checkRegionResponse(r, { ...response(), geometryId: 'e'.repeat(64) })).toEqual({ status: 'whole', reason: 'geometry_mismatch' });
  for (const patch of [{ viewGeneration: 4 }, { requestId: 'e'.repeat(32) }, { quality: 'draft' },
    { identity: { ...r.identity, generation: 2 } }]) expect(checkRegionResponse(r, { ...response(), ...patch }).status).toBe('stale');
  expect(checkRegionResponse(r, response(request({ prefetch: 9 }))).status).toBe('invalid');
});
it('separates delivery from pixel identity and requires valid coverage for explicit Pan reuse', () => {
  const r = request(), delivered = response(r), moved = request({ viewGeneration: 9, requestId: 'e'.repeat(32) });
  expect(regionCacheKey(r)).toBe(regionCacheKey(moved));
  expect(checkRegionResponse(moved, delivered).status).toBe('stale');
  expect(canReuseRegion(delivered, moved, geometry, { x0: 1100, y0: 900, x1: 1900, y1: 1500 })).toBe(true);
  expect(canReuseRegion(delivered, moved, geometry, { x0: 1000, y0: 900, x1: 1900, y1: 1500 })).toBe(false);
  for (const patch of [{ quality: 'draft' as const }, { geometryId: 'e'.repeat(64) }, { fullWidth: 3999 },
    { identity: { ...r.identity, sourceId: 'e'.repeat(64) } }]) {
    const wanted = request(patch);
    expect(regionCacheKey(wanted)).not.toBe(regionCacheKey(r));
    expect(canReuseRegion(delivered, wanted, geometry, { x0: 1100, y0: 900, x1: 1900, y1: 1500 })).toBe(false);
  }
});
it('includes every owner/content boundary in the cache identity', () => {
  const r = request();
  for (const identity of [
    { ...r.identity, assetId: '22345678-1234-4234-9234-123456789abc' }, { ...r.identity, sourceId: 'e'.repeat(64) },
    { ...r.identity, generation: 2 }, { ...r.identity, documentToken: 'e'.repeat(32) },
    { ...r.identity, kind: 'after' as const, revision: 3 },
  ]) expect(regionCacheKey({ ...r, identity })).not.toBe(regionCacheKey(r));
  expect(regionCacheKey({ ...r, window: { ...r.window, x: 1001 } })).not.toBe(regionCacheKey(r));
  expect(regionCacheKey({ ...r, validRegion: { ...r.validRegion, x: 1017 } })).not.toBe(regionCacheKey(r));
});
it('reuses Before by beforeKey, but pairs only the same geometry, F/W/interior/quality/actual size', () => {
  const after = response(), r = request(), i = r.identity;
  const beforeRequest = request({ identity: { assetId: i.assetId, sourceId: i.sourceId, generation: i.generation,
    documentToken: i.documentToken, kind: 'before', beforeKey: 'f'.repeat(64) } });
  const before = response(beforeRequest);
  expect(regionPairMatches(after, before)).toBe(true);
  expect(regionCacheKey({ ...beforeRequest, documentRevision: 3, viewGeneration: 8 })).toBe(regionCacheKey(beforeRequest));
  for (const patch of [{ geometryId: 'e'.repeat(64) }, { fullWidth: 3999 }, { quality: 'draft' as const },
    { width: 999 }, { documentRevision: 3 }, { validRegion: { ...r.validRegion, x: 1017 } },
    { window: { ...r.window, x: 1001 } }]) expect(regionPairMatches(after, { ...before, ...patch })).toBe(false);
});
it('keeps Region and Whole byte budgets separate at exact boundaries', () => {
  const b = C1_REGION_BUDGET;
  expect(regionEnvelopeWithinBudget('region', b.maxPngBytes, b.maxMcpLineBytes)).toBe(true);
  expect(regionEnvelopeWithinBudget('region', b.maxPngBytes + 1, b.maxMcpLineBytes)).toBe(false);
  expect(regionEnvelopeWithinBudget('region', b.maxPngBytes, b.maxMcpLineBytes + 1)).toBe(false);
  expect(regionEnvelopeWithinBudget('whole', 17 * 1024 ** 2, 24 * 1024 ** 2)).toBe(true);
  expect(regionEnvelopeWithinBudget('whole', 17 * 1024 ** 2 + 1, 24 * 1024 ** 2)).toBe(false);
  expect(regionEnvelopeWithinBudget('region', 0, Infinity)).toBe(false);
  expect(4 * Math.ceil(b.maxPngBytes / 3) + b.maxMetadataBytes + 4096).toBeLessThan(b.maxMcpLineBytes);
});
