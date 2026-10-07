import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compareRgbPixels } from './decodeComparison';
import { assessEncodeRoundTrip, runEncodeRoundTrip, type EncodeRoundTripDependencies } from './encodeRoundTrip';
import { fetchExportEngineRoundTrip, type EncodeRoundTripSource } from './exportEngineApi';

const metadata = { sourceWidth: 2, sourceHeight: 1, outputWidth: 2, outputHeight: 1, sourceIcc: 'embedded' as const,
  outputColorSpace: 'sRGB' as const, recipeVersion: 18 as const, outputBytes: 2, decodeMs: 1, renderMs: 2, encodeMs: 3,
  totalMs: 6, quality: 95 as const, subsampling: '4:4:4' as const, pixelFormat: 'rgb8' as const, rgbBytes: 6 };
const source: EncodeRoundTripSource = { jpeg: new Blob([new Uint8Array([255, 216])], { type: 'image/jpeg' }),
  pixels: new Uint8Array([10, 20, 30, 100, 110, 120]), metadata };

beforeEach(() => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:roundtrip'), revokeObjectURL: vi.fn() });
});

describe('encode round-trip', () => {
  it('reuses shared RGB statistics with decoded JPEG minus pre-encode direction', async () => {
    const signal = new AbortController().signal;
    const stats = await compareRgbPixels({ width: 2, height: 1, pixels: source.pixels, stride: 3 },
      { width: 2, height: 1, pixels: new Uint8ClampedArray([11,18,34,255, 92,111,128,255]), stride: 4 }, signal, async () => {});
    expect(stats).toMatchObject({ meanDeltaR: -3.5, meanDeltaG: -0.5, meanDeltaB: 6,
      meanAbsoluteDeltaR: 4.5, meanAbsoluteDeltaG: 1.5, meanAbsoluteDeltaB: 6,
      meanAbsoluteError: 4, rmse: 5, exactMatchPixelPercent: 0, pixelsAtLeast1Percent: 100,
      pixelsAtLeast2Percent: 100, pixelsAtLeast4Percent: 100, pixelsAtLeast8Percent: 50,
      greenBias: -1.75 });
    expect(stats.meanLumaDelta).toBeCloseTo(-0.6685, 10);
    expect(assessEncodeRoundTrip(stats)).toEqual({ brightnessDirection: 'darker', tintDirection: 'magenta', differenceLevel: 'small' });
  });

  it('validates and splits the binary response without accepting extra pixels', async () => {
    const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'X-GenzoRoom-Encode-Roundtrip': JSON.stringify(metadata) });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([255,216,10,20,30,100,110,120]), { status: 200, headers }));
    vi.stubGlobal('fetch', fetchMock);
    const value = await fetchExportEngineRoundTrip('asset', 4, new AbortController().signal);
    expect(value.jpeg.type).toBe('image/jpeg'); expect(value.jpeg.size).toBe(2);
    expect([...value.pixels]).toEqual([...source.pixels]);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ assetId: 'asset', expectedRevision: 4 });
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new Uint8Array([1,2,3]), { status: 200, headers })));
    await expect(fetchExportEngineRoundTrip('asset', 4, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_rgb_response' });
  });

  it('decodes the generated JPEG through the production decoder and releases its URL', async () => {
    const decoded = { width: 2, height: 1, data: new Uint8ClampedArray([11,18,34,255, 92,111,128,255]) } as ImageData;
    const dependencies: Partial<EncodeRoundTripDependencies> = { backend: vi.fn(async () => source),
      decode: vi.fn(async () => decoded), yield: async () => {} };
    const result = await runEncodeRoundTrip('asset', 3, new AbortController().signal, () => {}, dependencies);
    expect(result.status).toBe('completed'); expect(result.statistics?.meanDeltaR).toBe(-3.5);
    expect(dependencies.decode).toHaveBeenCalledWith({ kind: 'jpeg-original', url: 'blob:roundtrip' }, expect.any(AbortSignal));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:roundtrip');
  });

  it('reports a dimension mismatch without calculating statistics', async () => {
    const dependencies: Partial<EncodeRoundTripDependencies> = { backend: vi.fn(async () => source),
      decode: vi.fn(async () => ({ width: 1, height: 2, data: new Uint8ClampedArray(8) } as ImageData)), yield: async () => {} };
    const result = await runEncodeRoundTrip('asset', 3, new AbortController().signal, () => {}, dependencies);
    expect(result.status).toBe('failed'); expect(result.error).toBe('dimension_mismatch'); expect(result.statistics).toBeNull();
  });

  it('cancels cleanly while the browser decoder is pending and revokes the URL', async () => {
    const controller = new AbortController(); let finish!: (value: ImageData) => void;
    const dependencies: Partial<EncodeRoundTripDependencies> = { backend: vi.fn(async () => source),
      decode: vi.fn(() => new Promise<ImageData>(resolve => { finish = resolve; })), yield: async () => {} };
    const running = runEncodeRoundTrip('asset', 3, controller.signal, () => {}, dependencies);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.abort(); finish({ width: 2, height: 1, data: new Uint8ClampedArray(8) } as ImageData);
    const result = await running;
    expect(result.status).toBe('cancelled'); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:roundtrip');
  });
});
