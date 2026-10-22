// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rawCapability, rawPreview, readRawSettings, setRawControls, type RawDocument } from './rawApi';
import { rawSettings } from './test/rawSettings';

const doc: RawDocument = { workspaceId: 'a'.repeat(32), handle: 'b'.repeat(32), documentToken: 'c'.repeat(32),
  assetId: 'asset', generation: 1, revision: 2 };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function response(patch: Record<string, string> = {}, bytes = png) {
  return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'X-Raw-Generation': '1',
    'X-Raw-Token': doc.documentToken, 'X-Raw-Revision': '2', 'X-Raw-Serial': '3',
    'X-Raw-Epoch': '1', 'X-Raw-Sequence': '1', 'X-Raw-Width': '16', 'X-Raw-Height': '12', ...patch } });
}
afterEach(() => vi.unstubAllGlobals());
describe('bounded RAW binary contract', () => {
  it('resynchronizes settings and sends allowlisted changes with the confirmed expectedRevision', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ...rawSettings(doc), revision: doc.revision + 1 }),
      { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const result = await setRawControls(doc, { 'light.exposure': 1 });
    expect(result.revision).toBe(doc.revision + 1);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ workspaceId: doc.workspaceId, generation: doc.generation,
      documentToken: doc.documentToken, expectedRevision: doc.revision, values: { 'light.exposure': 1 } });
    expect((await readRawSettings(doc)).revision).toBe(result.revision);
    expect(fetch.mock.calls[1][0]).toBe(`/api/raw/documents/${doc.handle}/settings`);
  });
  it('rejects stale identity and malformed control metadata in settings responses', async () => {
    for (const patch of [{ generation: doc.generation + 1 }, { documentToken: 'other' }, { controls: [] }, { values: {} }, { wb: { available: 'yes' } }]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...rawSettings(doc), ...patch }),
        { headers: { 'Content-Type': 'application/json' } })));
      await expect(readRawSettings(doc)).rejects.toThrow('raw_invalid_response');
    }
  });
  it('accepts an engine-identified PNG without exposing paths or JPEG requests', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response()); vi.stubGlobal('fetch', fetch);
    const frame = await rawPreview(doc, 3, new AbortController().signal);
    expect(frame.blob.type).toBe('image/png'); expect(frame.width).toBe(16);
    expect(fetch.mock.calls[0][0]).toBe(`/api/raw/documents/${doc.handle}/preview`);
  });
  it.each(['generation', 'token', 'revision', 'serial', 'epoch', 'sequence', 'width', 'height'])('rejects invalid %s', async key => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ [`X-Raw-${key}`]: 'invalid' })));
    await expect(rawPreview(doc, 3, new AbortController().signal)).rejects.toThrow();
  });
  it('rejects HTML, invalid PNG bytes and oversized binary responses', async () => {
    for (const res of [response({ 'Content-Type': 'text/html' }), response({}, new Uint8Array([1])),
      response({}, new Uint8Array(5 * 1024 * 1024 + 1))]) {
      vi.stubGlobal('fetch', vi.fn(async () => res));
      await expect(rawPreview(doc, 3, new AbortController().signal)).rejects.toThrow();
    }
  });
  it('treats a missing Docker API as unsupported', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404 })));
    await expect(rawCapability()).rejects.toThrow('raw_unsupported');
  });
});
