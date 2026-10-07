import { afterEach, expect, it, vi } from 'vitest';
import { fetchBackendDecode } from './exportEngineApi';

const meta = { width: 1, height: 2, sourceWidth: 2, sourceHeight: 1, pixelFormat: 'rgb8', sourceIcc: 'absent', orientationNormalized: true, backendDecodeMs: 1.25 };
const response = (metadata: unknown = meta, bytes = 6, type = 'application/octet-stream') => new Response(new Uint8Array(bytes),
  { headers: { 'Content-Type': type, 'X-GenzoRoom-Decode': JSON.stringify(metadata) } });
afterEach(() => vi.unstubAllGlobals());

it('requests Asset ID alone and validates packed RGB8 without a second image decode', async () => {
  const fetcher = vi.fn(async () => response({ ...meta, assetId: 'PRIVATE', filename: 'PRIVATE.JPG' })); vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  const result = await fetchBackendDecode('PRIVATE_ASSET', signal);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/developer/export-engine/decode', expect.objectContaining({ method: 'POST', cache: 'no-store', signal,
    body: JSON.stringify({ assetId: 'PRIVATE_ASSET' }) }));
  expect(result.metadata).toEqual(meta); expect(result.pixels.length).toBe(6);
  expect(JSON.stringify(result.metadata)).not.toContain('PRIVATE');
});

it.each([null, { ...meta, width: 0 }, { ...meta, height: 1.5 }, { ...meta, pixelFormat: 'rgba8' },
  { ...meta, sourceIcc: 'PRIVATE' }, { ...meta, backendDecodeMs: -1 }, { ...meta, orientationNormalized: false },
  { ...meta, width: Number.MAX_SAFE_INTEGER }, { ...meta, backendDecodeMs: 'PRIVATE' }])('rejects malformed binary metadata', async metadata => {
  vi.stubGlobal('fetch', vi.fn(async () => response(metadata)));
  await expect(fetchBackendDecode('a', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_binary_response' });
});
it.each([['image/jpeg', 6], ['image/png', 6], ['application/octet-stream', 5], ['application/octet-stream', 7]] as const)('rejects content type %s or wrong byte length %i', async (type, bytes) => {
  vi.stubGlobal('fetch', vi.fn(async () => response(meta, bytes, type)));
  await expect(fetchBackendDecode('a', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_binary_response' });
});
it.each(['backend_decode_failed', 'original_fetch_failed'])('maps safe backend failure %s', async code => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: { code, message: 'PRIVATE_PATH' } }), { status: 422 })));
  await expect(fetchBackendDecode('a', new AbortController().signal)).rejects.toMatchObject({ code, message: code });
});
it('sanitizes proxy errors and suppresses late aborted binary responses', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('PRIVATE_URL token', { status: 502 })));
  await expect(fetchBackendDecode('a', new AbortController().signal)).rejects.toMatchObject({ code: 'backend_unavailable' });
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); return response(); }));
  await expect(fetchBackendDecode('a', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
