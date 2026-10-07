import { afterEach, expect, it, vi } from 'vitest';
import { assessDecodeDifference, compareDecodedPixels, COMPARISON_CHUNK_PIXELS, runDecodeComparison } from './decodeComparison';
import type { BackendDecodedImage } from './exportEngineApi';

const frontend = { width: 4, height: 1, data: new Uint8ClampedArray([100,100,100,0, 100,100,100,64, 100,100,100,128, 100,100,100,255]) };
const backend = (): BackendDecodedImage => ({ pixels: new Uint8Array([100,100,100, 101,98,104, 108,100,100, 100,102,99]),
  metadata: { width: 4, height: 1, sourceWidth: 4, sourceHeight: 1, pixelFormat: 'rgb8', sourceIcc: 'embedded', orientationNormalized: true, backendDecodeMs: 2 } });
afterEach(() => vi.unstubAllGlobals());

it('computes manually derived signed/absolute RGB statistics, pixel thresholds, luma and green bias without mutation', async () => {
  const source = frontend.data.slice(), decoded = backend(), rgb = decoded.pixels.slice();
  const stats = await compareDecodedPixels(frontend, decoded, new AbortController().signal);
  expect(stats).toMatchObject({ meanDeltaR: 2.25, meanDeltaG: 0, meanDeltaB: 0.75,
    meanAbsoluteDeltaR: 2.25, meanAbsoluteDeltaG: 1, meanAbsoluteDeltaB: 1.25,
    maxAbsoluteDeltaR: 8, maxAbsoluteDeltaG: 2, maxAbsoluteDeltaB: 4,
    meanAbsoluteError: 1.5, exactMatchPixelPercent: 25,
    pixelsAtLeast1Percent: 75, pixelsAtLeast2Percent: 75, pixelsAtLeast4Percent: 50, pixelsAtLeast8Percent: 25, greenBias: -1.5 });
  expect(stats.rmse).toBeCloseTo(Math.sqrt(90 / 12), 12); expect(stats.meanLumaDelta).toBeCloseTo(0.5325, 12);
  expect(assessDecodeDifference(stats)).toEqual({ brightnessDirection: 'brighter', tintDirection: 'magenta', differenceLevel: 'small' });
  expect(frontend.data).toEqual(source); expect(decoded.pixels).toEqual(rgb);
});

it('ignores alpha and assesses exact equality as neutral/minimal', async () => {
  const decoded = backend(); decoded.pixels.fill(100);
  const stats = await compareDecodedPixels(frontend, decoded, new AbortController().signal);
  expect(stats.meanAbsoluteError).toBe(0); expect(stats.rmse).toBe(0); expect(stats.exactMatchPixelPercent).toBe(100);
  expect(assessDecodeDifference(stats)).toEqual({ brightnessDirection: 'neutral', tintDirection: 'neutral', differenceLevel: 'minimal' });
});

it('uses the Backend minus Frontend direction for darker/green tendencies and marks larger differences as descriptive', async () => {
  const decoded = backend(); decoded.pixels = new Uint8Array([90,100,90, 90,100,90, 90,100,90, 90,100,90]);
  const stats = await compareDecodedPixels(frontend, decoded, new AbortController().signal);
  expect(stats.meanDeltaR).toBe(-10); expect(stats.greenBias).toBe(10);
  expect(assessDecodeDifference(stats)).toEqual({ brightnessDirection: 'darker', tintDirection: 'green', differenceLevel: 'noticeable' });
});

it('checks dimensions and byte lengths before comparing pixels', async () => {
  const mismatch = backend(); mismatch.metadata.height = 2;
  await expect(compareDecodedPixels(frontend, mismatch, new AbortController().signal)).rejects.toMatchObject({ code: 'dimension_mismatch' });
  const truncated = backend(); truncated.pixels = truncated.pixels.subarray(1);
  await expect(compareDecodedPixels(frontend, truncated, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_binary_response' });
});

it('yields between chunks and cancels before reading the next chunk', async () => {
  const count = COMPARISON_CHUNK_PIXELS + 1, controller = new AbortController();
  const decoded = backend(); decoded.metadata.width = count; decoded.pixels = new Uint8Array(count * 3);
  const yieldControl = vi.fn(async () => controller.abort());
  await expect(compareDecodedPixels({ width: count, height: 1, data: new Uint8ClampedArray(count * 4) }, decoded, controller.signal, yieldControl)).rejects.toMatchObject({ name: 'AbortError' });
  expect(yieldControl).toHaveBeenCalledOnce();
});

it('reuses the production decoder entry point, releases original URL, and returns only numeric results', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:PRIVATE'), revokeObjectURL: vi.fn() });
  const decode = vi.fn(async () => frontend as ImageData), getBackend = vi.fn(async () => backend());
  const getOriginal = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['jpeg']) }) as Response);
  const signal = new AbortController().signal, phase = vi.fn();
  const report = await runDecodeComparison('PRIVATE_ASSET', signal, phase, { decode, backend: getBackend, fetch: getOriginal, yield: async () => {} });
  expect(decode).toHaveBeenCalledExactlyOnceWith({ kind: 'jpeg-original', url: 'blob:PRIVATE' }, signal);
  expect(getOriginal).toHaveBeenCalledWith('/api/assets/PRIVATE_ASSET/original', { signal, cache: 'no-store' });
  expect(getBackend).toHaveBeenCalledExactlyOnceWith('PRIVATE_ASSET', signal);
  expect(report.status).toBe('completed'); expect(report.timing.backendDecodeMs).toBe(2);
  expect(report.timing.backendRequestMs).toBeGreaterThanOrEqual(0); expect(JSON.stringify(report)).not.toContain('PRIVATE');
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:PRIVATE');
});

it('returns mismatched dimensions without statistics and cancels/cleans a pending production decode immediately', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:PRIVATE'), revokeObjectURL: vi.fn() });
  const deps = { fetch: vi.fn(async () => ({ ok: true, blob: async () => new Blob(['jpeg']) }) as Response), yield: async () => {} };
  const mismatch = backend(); mismatch.metadata.width = 1;
  const report = await runDecodeComparison('a', new AbortController().signal, () => {}, { ...deps, decode: async () => frontend as ImageData, backend: async () => mismatch });
  expect(report.error).toBe('dimension_mismatch'); expect(report.statistics).toBeNull(); expect(report.dimensions.backend?.width).toBe(1);
  let finish!: (data: ImageData) => void;
  const pending = new Promise<ImageData>(resolve => { finish = resolve; });
  const controller = new AbortController(); let notifyStarted!: () => void;
  const ready = new Promise<void>(resolve => { notifyStarted = resolve; });
  const running = runDecodeComparison('a', controller.signal, () => {}, { ...deps, decode: async () => { notifyStarted(); return pending; } });
  await ready; controller.abort(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  finish(frontend as ImageData);
  const cancelled = await running;
  expect(cancelled.status).toBe('cancelled'); expect(cancelled.error).toBe('cancelled'); expect(cancelled.statistics).toBeNull();
});
