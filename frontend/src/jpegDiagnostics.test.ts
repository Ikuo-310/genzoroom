// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JPEG_CASES, RealJpegRunner, recentJpegCandidates, type JpegDiagnosticsDependencies } from './jpegDiagnostics';
import { createJpegReport } from './jpegDiagnosticsReport';
import { ADJUSTMENT_IDS, defaultRecipe } from './editing';
import type { RecentAsset } from './assets';
import { createDiagnosticsReport, collectDiagnosticsEnvironment, createWebGpuReport } from './developerDiagnostics';
import { readJpegProfile } from './jpegProfile';
import { decodeEditSource } from './editImageSource';
import { renderAdjustments } from './adjustmentPipeline';
import { collectHistogram } from './histogram';
import { WebGpuAdjustmentRenderer } from './webgpuAdjustmentRenderer';

vi.mock('./jpegProfile', () => ({ readJpegProfile: vi.fn() }));
vi.mock('./editImageSource', () => ({ decodeEditSource: vi.fn() }));
vi.mock('./adjustmentPipeline', () => ({ renderAdjustments: vi.fn() }));
vi.mock('./histogram', () => ({ collectHistogram: vi.fn() }));
const asset = (id = 'private-id', overrides: Partial<RecentAsset> = {}): RecentAsset => ({
  id, filename: 'PRIVATE_FILENAME.JPG', date: 'PRIVATE_DATE', thumbnail_url: '/PRIVATE_THUMBNAIL', format: 'JPEG', is_raw: false, ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
function setup() {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const pixels = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);
  const image = { data: pixels, width: 2, height: 1 } as ImageData;
  const blob = new Blob(['jpeg content'], { type: 'image/jpeg' });
  const result = { pixels: pixels.slice(), width: 2, height: 1, sourceGeneration: 1, requestId: 1 };
  const renderer = {
    setSource: vi.fn(async () => { clock += 8; return 1; }),
    render: vi.fn(async () => { clock += 4; return result; }), dispose: vi.fn(),
  };
  const response = { ok: true, blob: vi.fn(async () => { clock += 3; return blob; }) } as unknown as Response;
  const dependencies: JpegDiagnosticsDependencies = {
    recent: vi.fn(async () => { clock += 2; return [asset('raw', { is_raw: true }), asset()]; }),
    fetch: vi.fn(async () => { clock += 2; return response; }),
    profile: vi.fn(async () => { clock += 4; return { status: 'embedded' as const, description: 'sRGB' }; }),
    decode: vi.fn(async () => { clock += 6; return image; }),
    cpu: vi.fn(() => { clock += 3; return pixels.slice(); }),
    histogram: vi.fn(() => { clock += 1; return { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), y: new Uint32Array(256) }; }),
    gpuAvailable: vi.fn(() => true),
    createRenderer: vi.fn(async () => { clock += 7; return renderer; }), yield: vi.fn(async () => {}),
  };
  const update = vi.fn(), onTarget = vi.fn();
  const runner = new RealJpegRunner(update, dependencies, onTarget);
  return { runner, dependencies, update, onTarget, renderer, response, blob, image, result, advance: (ms: number) => { clock += ms; } };
}
beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:private-jpeg') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL'); });

it('filters only non-RAW JPEGs in Recent order, takes at most ten from fifty, and supports an empty result', () => {
  const input = [asset('raw', { is_raw: true }), asset('png', { format: 'PNG' }), ...Array.from({ length: 15 }, (_, i) => asset(String(i)))];
  expect(recentJpegCandidates(input).map(row => row.id)).toEqual(Array.from({ length: 10 }, (_, i) => String(i)));
  expect(recentJpegCandidates(Array.from({ length: 50 }, () => asset('raw', { is_raw: true })).concat(asset('outside')))).toEqual([]);
});

it('defines exactly sixteen single-slider representative recipes and one combined recipe with defaults enabled', () => {
  expect(JPEG_CASES.map(row => row.id)).toEqual([...ADJUSTMENT_IDS, 'all_sliders_representative']);
  expect(JPEG_CASES).toHaveLength(17);
  for (const { id, recipe } of JPEG_CASES) {
    const expected = defaultRecipe();
    for (const slider of ADJUSTMENT_IDS) if (id === slider || id === 'all_sliders_representative') expected.adjustments[slider] = slider === 'exposure' ? 0.5 : 35;
    expect(recipe).toEqual(expected);
  }
});

it('measures lookup, Blob completion, profile, production decode and seventeen serial CPU/GPU/histogram cases', async () => {
  const fake = setup();
  let active = 0;
  fake.renderer.render.mockImplementation(async () => {
    expect(active++).toBe(0); await Promise.resolve(); fake.advance(4); active--; return fake.result;
  });
  await fake.runner.run();
  expect(fake.dependencies.recent).toHaveBeenCalledExactlyOnceWith(50, expect.any(AbortSignal));
  expect(fake.dependencies.fetch).toHaveBeenCalledExactlyOnceWith('/api/assets/private-id/original', { cache: 'no-store', signal: expect.any(AbortSignal) });
  expect(fake.dependencies.profile).toHaveBeenCalledExactlyOnceWith(fake.blob, expect.any(AbortSignal));
  expect(fake.dependencies.decode).toHaveBeenCalledExactlyOnceWith({ kind: 'jpeg-original', url: 'blob:private-jpeg' }, expect.any(AbortSignal));
  expect(fake.runner.state.report.source).toEqual({ compressedBytes: fake.blob.size, width: 2, height: 1, profile: { status: 'embedded', description: 'sRGB' } });
  expect(fake.runner.state.report.timing).toEqual({ totalMs: 186, assetLookupMs: 2, originalFetchMs: 5, profileReadMs: 4,
    decodeToSrgbImageDataMs: 6, sourceHistogramMs: 1, gpuInitializationMs: 7, gpuSourceUploadMs: 8 });
  expect(fake.renderer.setSource).toHaveBeenCalledExactlyOnceWith(fake.image.data, 2, 1);
  expect(fake.renderer.render.mock.calls).toHaveLength(17);
  expect(vi.mocked(fake.dependencies.cpu).mock.calls.map(call => call[1])).toEqual(JPEG_CASES.map(row => row.recipe));
  expect(fake.dependencies.histogram).toHaveBeenCalledTimes(35);
  const histCalls = vi.mocked(fake.dependencies.histogram).mock.invocationCallOrder;
  const cpuCalls = vi.mocked(fake.dependencies.cpu).mock.invocationCallOrder;
  const gpuCalls = fake.renderer.render.mock.invocationCallOrder;
  for (let index = 0; index < 17; index++) {
    expect(cpuCalls[index]).toBeLessThan(histCalls[1 + 2 * index]);
    expect(histCalls[1 + 2 * index]).toBeLessThan(gpuCalls[index]);
    expect(gpuCalls[index]).toBeLessThan(histCalls[2 + 2 * index]);
    if (index < 16) expect(histCalls[2 + 2 * index]).toBeLessThan(cpuCalls[index + 1]);
    expect(fake.runner.state.report.cases[index]).toMatchObject({ cpuRenderMs: 3, cpuHistogramMs: 1, gpuRenderMs: 4, gpuHistogramMs: 1, status: 'completed' });
  }
  expect(fake.renderer.dispose).toHaveBeenCalledOnce(); expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:private-jpeg');
  expect(fake.onTarget).toHaveBeenCalledWith(expect.objectContaining({ filename: 'PRIVATE_FILENAME.JPG' }));
});

it('uses the manual asset ahead of automatic selection on repeated runs, leaves lookup timing null, and does not retain filename in state/report', async () => {
  const fake = setup();
  for (let i = 0; i < 2; i++) await fake.runner.run(asset('manual/id'));
  expect(fake.dependencies.recent).not.toHaveBeenCalled();
  expect(fake.dependencies.fetch).toHaveBeenCalledWith('/api/assets/manual%2Fid/original', expect.objectContaining({ cache: 'no-store' }));
  expect(fake.runner.state.report.selectionMode).toBe('manual'); expect(fake.runner.state.report.timing.assetLookupMs).toBeNull();
  expect(fake.renderer.setSource).toHaveBeenCalledTimes(2); expect(fake.renderer.dispose).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(fake.runner.state)).not.toContain('PRIVATE_FILENAME');
  const report = createDiagnosticsReport(collectDiagnosticsEnvironment(), createWebGpuReport(false, null), new Date('2026-10-02T08:30:00Z'), fake.runner.state.report);
  expect(report.schemaVersion).toBe(1); expect(report.jpeg.cases).toHaveLength(17);
  const json = JSON.stringify(report);
  for (const privateText of ['manual/id', 'PRIVATE_FILENAME.JPG', 'PRIVATE_DATE', 'PRIVATE_THUMBNAIL', 'blob:private-jpeg', '/api/assets/']) expect(json).not.toContain(privateText);
  expect(json).not.toMatch(/"(assetId|filename|date|exif|pixels|recipe|thumbnail_url|originalUrl|bins)"/i);
});

it('projects only approved JPEG fields even if runtime state contains assets, pixels, histogram bins or private error details', async () => {
  const fake = setup(); await fake.runner.run(asset());
  const dirty = Object.assign(fake.runner.state.report, { assetId: 'secret', filename: 'SECRET.JPG', recipe: defaultRecipe(), pixels: [1, 2, 3], exif: { date: 'secret' }, thumbnailUrl: '/private' });
  Object.assign(dirty.source, { filename: 'SOURCE_SECRET.JPG', originalUrl: '/private' });
  Object.assign(dirty.cases[0], { histogram: { r: [1, 2] }, recipe: defaultRecipe() });
  dirty.error = { code: 'original_fetch_failed', detail: 'SECRET.JPG http://private/assets/id' } as never;
  const projected = createJpegReport(dirty);
  expect(projected.error).toEqual({ code: 'original_fetch_failed', detail: null });
  expect(JSON.stringify(projected)).not.toMatch(/secret|private|filename|pixels|histogram"|recipe"|exif/i);
});

it('reports no JPEG candidate without requesting original, decode or GPU', async () => {
  const fake = setup(); vi.mocked(fake.dependencies.recent).mockResolvedValue([]);
  await fake.runner.run(); expect(fake.runner.state.report.status).toBe('no_jpeg_candidate');
  expect(fake.dependencies.fetch).not.toHaveBeenCalled(); expect(fake.dependencies.decode).not.toHaveBeenCalled(); expect(fake.dependencies.createRenderer).not.toHaveBeenCalled();
});

it.each(['asset_lookup_failed', 'original_fetch_failed', 'profile_failed', 'decode_failed'] as const)('records %s without exposing private technical errors', async code => {
  const fake = setup();
  const method = code === 'asset_lookup_failed' ? fake.dependencies.recent : code === 'original_fetch_failed' ? fake.dependencies.fetch : code === 'profile_failed' ? fake.dependencies.profile : fake.dependencies.decode;
  vi.mocked(method).mockRejectedValueOnce(new Error('PRIVATE_FILENAME.JPG /api/assets/private-id/original'));
  await fake.runner.run(); expect(fake.runner.state.report.status).toBe('failed');
  expect(fake.runner.state.report.error).toEqual({ code, detail: null });
  expect(JSON.stringify(fake.runner.state)).not.toContain('PRIVATE_FILENAME.JPG');
});
it('rejects HTTP failure before reading the Blob', async () => {
  const fake = setup(); vi.mocked(fake.dependencies.fetch).mockResolvedValue({ ...fake.response, ok: false } as Response);
  await fake.runner.run(asset()); expect(fake.runner.state.report.error?.code).toBe('original_fetch_failed');
  expect(fake.response.blob).not.toHaveBeenCalled();
});
it.each(['unavailable', 'null', 'initialization', 'upload', 'render'] as const)('preserves all CPU cases when GPU %s', async mode => {
  const fake = setup();
  if (mode === 'unavailable') vi.mocked(fake.dependencies.gpuAvailable).mockReturnValue(false);
  if (mode === 'null') vi.mocked(fake.dependencies.createRenderer).mockResolvedValue(null);
  if (mode === 'initialization') vi.mocked(fake.dependencies.createRenderer).mockImplementation(async onError => { onError(new Error('shader')); return null; });
  if (mode === 'upload') fake.renderer.setSource.mockRejectedValueOnce(new Error('upload'));
  if (mode === 'render') fake.renderer.render.mockRejectedValueOnce(new Error('device lost'));
  await fake.runner.run(asset());
  expect(fake.dependencies.cpu).toHaveBeenCalledTimes(17); expect(fake.runner.state.report.cases).toHaveLength(17);
  expect(fake.runner.state.report.status).toBe('completed_with_errors');
  expect(fake.runner.state.report.gpu.error?.code).toBe(mode === 'initialization' ? 'gpu_initialization_failed' : mode === 'upload' ? 'gpu_upload_failed' : mode === 'render' ? 'gpu_render_failed' : 'gpu_unavailable');
  expect(fake.renderer.render).toHaveBeenCalledTimes(mode === 'render' ? 1 : 0);
  if (mode === 'render') expect(fake.runner.state.report.cases[1].gpuStatus).toBe('skipped');
});

it.each(['original', 'decode', 'initialization', 'upload', 'render'] as const)('prevents duplicate runs, aborts %s, releases resources and suppresses late publications', async stage => {
  const fake = setup(); const pending = deferred<unknown>(), entered = deferred<void>();
  const wait = () => { entered.resolve(); return pending.promise as Promise<never>; };
  if (stage === 'original') vi.mocked(fake.dependencies.fetch).mockImplementationOnce(wait);
  if (stage === 'decode') vi.mocked(fake.dependencies.decode).mockImplementationOnce(wait);
  if (stage === 'initialization') vi.mocked(fake.dependencies.createRenderer).mockImplementationOnce(wait);
  if (stage === 'upload') fake.renderer.setSource.mockImplementationOnce(wait);
  if (stage === 'render') fake.renderer.render.mockImplementationOnce(wait);
  const work = fake.runner.run(asset()); await entered.promise;
  const fetchCalls = vi.mocked(fake.dependencies.fetch).mock.calls.length;
  await fake.runner.run(asset('duplicate')); expect(fake.dependencies.fetch).toHaveBeenCalledTimes(fetchCalls);
  const signal = vi.mocked(fake.dependencies.fetch).mock.calls[0][1]!.signal!;
  fake.runner.dispose(); expect(signal.aborted).toBe(true);
  const updates = fake.update.mock.calls.length;
  pending.resolve(stage === 'original' ? fake.response : stage === 'decode' ? fake.image : stage === 'initialization' ? fake.renderer : stage === 'upload' ? 1 : fake.result);
  await work;
  expect(fake.runner.state.report.status).toBe('cancelled'); expect(fake.update).toHaveBeenCalledTimes(updates);
  expect(fake.runner.state.report.cases).toHaveLength(0);
  if (stage !== 'original') expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-jpeg');
  if (['initialization', 'upload', 'render'].includes(stage)) expect(fake.renderer.dispose).toHaveBeenCalledOnce();
});

it('wires the default run to the existing production helpers and renderer without changing settings', async () => {
  const fake = setup();
  vi.mocked(readJpegProfile).mockResolvedValue({ status: 'none' }); vi.mocked(decodeEditSource).mockResolvedValue(fake.image);
  vi.mocked(renderAdjustments).mockImplementation(pixels => pixels.slice());
  vi.mocked(collectHistogram).mockReturnValue({ r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), y: new Uint32Array(256) });
  vi.stubGlobal('fetch', fake.dependencies.fetch); vi.stubGlobal('isSecureContext', true); vi.stubGlobal('navigator', { gpu: {} });
  const create = vi.spyOn(WebGpuAdjustmentRenderer, 'create').mockResolvedValue(fake.renderer as unknown as WebGpuAdjustmentRenderer);
  const runner = new RealJpegRunner(vi.fn()); await runner.run(asset());
  expect(readJpegProfile).toHaveBeenCalledWith(fake.blob, expect.any(AbortSignal));
  expect(decodeEditSource).toHaveBeenCalledWith({ kind: 'jpeg-original', url: 'blob:private-jpeg' }, expect.any(AbortSignal));
  expect(renderAdjustments).toHaveBeenCalledTimes(17); expect(collectHistogram).toHaveBeenCalledTimes(35);
  expect(create).toHaveBeenCalledExactlyOnceWith(undefined, expect.any(Function), expect.any(AbortSignal));
});
