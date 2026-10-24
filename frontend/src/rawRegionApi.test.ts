import { afterEach, expect, it, vi } from 'vitest';
import { rawRegion, rawRegionOwner, type RawDocument } from './rawApi';
import { regionRequest, regionResponse } from './test/rawRegion';

const r = regionRequest();
const doc: RawDocument = { workspaceId: '1'.repeat(32), handle: '2'.repeat(32), ...r.identity, revision: r.documentRevision };
const geometry = { geometryId: r.geometryId, nativeWidth: 4000, nativeHeight: 3000 };
const signal = () => new AbortController().signal;
function png(width = r.window.w, height = r.window.h) {
  const bytes = new Uint8Array(33); bytes.set([137,80,78,71,13,10,26,10]);
  const view = new DataView(bytes.buffer); view.setUint32(8, 13); view.setUint32(12, 0x49484452);
  view.setUint32(16, width); view.setUint32(20, height); return bytes;
}
function response(meta: unknown = regionResponse(), bytes = png()) {
  return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'X-Raw-Region': JSON.stringify(meta) } });
}
afterEach(() => vi.unstubAllGlobals());
it('sends the fixed C0 descriptor and returns metadata separately from the bounded PNG blob', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response()); vi.stubGlobal('fetch', fetch);
  const result = await rawRegion(doc, r, geometry, true, signal());
  expect(result.operation).toBe('render'); expect(result.metadata).toEqual(regionResponse());
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ workspaceId: doc.workspaceId, operation: 'render', target: r });
});
it.each(['requestId', 'viewGeneration', 'documentRevision', 'quality', 'kind', 'geometryId', 'identity'])(
  'rejects stale or invalid %s before producing a candidate', async key => {
    const meta = { ...regionResponse(), [key]: key === 'identity' ? { ...r.identity, sourceId: '0'.repeat(64) }
      : key === 'viewGeneration' || key === 'documentRevision' ? 999 : key === 'quality' ? 'draft' : key === 'kind' ? 'before' : '0'.repeat(key === 'geometryId' ? 64 : 32) };
    vi.stubGlobal('fetch', vi.fn(async () => response(meta)));
    await expect(rawRegion(doc, r, geometry, true, signal())).rejects.toThrow('raw_invalid_response');
  });
it('rejects PNG dimension mismatch and independent 9 MiB body overflow', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(regionResponse(), png(1))));
  await expect(rawRegion(doc, r, geometry, true, signal())).rejects.toThrow('raw_invalid_response');
  vi.stubGlobal('fetch', vi.fn(async () => response(regionResponse(), new Uint8Array(9*1024**2+1))));
  await expect(rawRegion(doc, r, geometry, true, signal())).rejects.toThrow('raw_response_too_large');
});
it('confirms preflight using C0 native geometry validation', async () => {
  const { fullWidth: _fw, fullHeight: _fh, window: _w, validRegion: _v, context: _c, prefetch: _p, ...base } = r;
  const query = { ...base, desiredLongEdge: 4000 };
  const meta = { ...query, kind: 'after', nativeWidth: 4000, nativeHeight: 3000, fullWidth: 4000, fullHeight: 3000 };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } })));
  expect((await rawRegion(doc, query, geometry, true, signal())).metadata).toEqual(meta);
});
it('rejects unsupported and malformed requests before fetch; reads legacy owner without disabling Whole', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ sourceId: r.identity.sourceId, regionContract: null }),
    { headers: { 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
  await expect(rawRegion(doc, r, geometry, false, signal())).rejects.toThrow('raw_region_unsupported');
  await expect(rawRegion(doc, { ...r, context: -1 }, geometry, true, signal())).rejects.toThrow('raw_invalid_region_request');
  expect(fetch).not.toHaveBeenCalled();
  expect(await rawRegionOwner(doc, signal())).toEqual({ sourceId: r.identity.sourceId, supported: false });
});
