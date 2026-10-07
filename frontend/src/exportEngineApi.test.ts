import { afterEach, expect, it, vi } from 'vitest';
import { fetchExportEngineJpeg } from './exportEngineApi';

const metadata = { sourceWidth: 11, sourceHeight: 7, outputWidth: 7, outputHeight: 11, sourceIcc: 'embedded',
  outputColorSpace: 'sRGB', recipeVersion: 18, outputBytes: 4, decodeMs: 1, renderMs: 2, encodeMs: 3,
  totalMs: 6, quality: 95, subsampling: '4:4:4' };
const response = (value = metadata) => new Response('jpeg', { headers: { 'Content-Type': 'image/jpeg',
  'X-GenzoRoom-Export-Engine': JSON.stringify(value) } });
afterEach(() => vi.unstubAllGlobals());

it('sends only identity and revision, accepts raw JPEG, and allowlists metadata', async () => {
  const fetcher = vi.fn(async () => response({ ...metadata, filename: 'PRIVATE_FILE', assetId: 'PRIVATE_ASSET', recipe: { exposure: 3 } } as typeof metadata));
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  const result = await fetchExportEngineJpeg('PRIVATE_ASSET', 3, controller.signal);
  expect(fetcher).toHaveBeenCalledWith('/api/developer/export-engine', expect.objectContaining({ method: 'POST', cache: 'no-store',
    signal: controller.signal, body: JSON.stringify({ assetId: 'PRIVATE_ASSET', expectedRevision: 3 }) }));
  expect(result.metadata).toEqual(metadata); expect(result.blob.size).toBe(4);
  expect(JSON.stringify(result.metadata)).not.toContain('PRIVATE');
});

it.each(['invalid_icc', 'saved_recipe_unavailable', 'unsupported_recipe_version', 'saved_recipe_changed', 'decode_failed', 'render_failed', 'encode_failed'])('accepts only safe error %s', async code => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: { code, message: 'PRIVATE_EXCEPTION' } }), { status: 422 })));
  await expect(fetchExportEngineJpeg('a', 1, new AbortController().signal)).rejects.toMatchObject({ code, message: code });
});

it.each([
  { ...metadata, outputBytes: 5 }, { ...metadata, decodeMs: -1 }, { ...metadata, sourceIcc: 'PRIVATE_PROFILE' },
  { ...metadata, sourceWidth: 0 }, { ...metadata, recipeVersion: 17 }, { ...metadata, quality: 80 },
  { ...metadata, subsampling: '4:2:0' }, { ...metadata, outputColorSpace: 'PRIVATE_SPACE' },
])('rejects invalid or incomplete technical metadata', async value => {
  vi.stubGlobal('fetch', vi.fn(async () => response(value as typeof metadata)));
  await expect(fetchExportEngineJpeg('a', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'backend_unavailable' });
});

it('never exposes proxy text, unknown exception codes, or fetch rejection detail', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response('PRIVATE_PROXY_ERROR', { status: 502 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ detail: { code: 'PRIVATE_CODE' } }), { status: 500 }))
    .mockRejectedValueOnce(new Error('PRIVATE_URL password')));
  for (let index = 0; index < 3; index++) {
    await expect(fetchExportEngineJpeg('a', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'backend_unavailable', message: 'backend_unavailable' });
  }
});

it('honors abort even when a fetch dependency resolves late', async () => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); return response(); }));
  await expect(fetchExportEngineJpeg('a', 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
