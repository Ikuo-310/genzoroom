import { afterEach, expect, it, vi } from 'vitest';
import { createRawViewerReport, fetchRawViewerTrial, parseRawViewerMetadata, rawViewerPlan, rawViewerStatistics } from './rawViewerBenchmark';
import { LIGHTCRAFT_ENGINE } from './lightcraftEngine';
import { viewerMetadata } from './test/rawViewerBenchmark';
afterEach(() => vi.unstubAllGlobals());

it('exports a bounded native plan partition and rejects inconsistent or private timing fields', () => {
  const trial = rawViewerPlan(3).find(t => t.operation === 'regionPlan')!, metadata = viewerMetadata(trial);
  const regionPlan = { sourceKind: 'file', sourcePreparationMs: 1, sourceAcquisitionMs: 650,
    imageSelectionMs: 0, plannerMs: 1, geometryMs: 1, sourceRetentionMs: 1, otherMs: 1 };
  const timing = { ...metadata.timing, nativeMs: 655, regionPlan };
  expect(parseRawViewerMetadata({ ...metadata, timing }, trial).timing.regionPlan).toEqual(regionPlan);
  for (const bad of [{ ...regionPlan, sourceKind: 'PRIVATE' }, { ...regionPlan, sourceKind: ['file'] }, { ...regionPlan, sourceAcquisitionMs: -1 },
    { ...regionPlan, plannerMs: NaN }, { ...regionPlan, geometryMs: 2 }, { ...regionPlan, path: 'PRIVATE' }]) {
    expect(() => parseRawViewerMetadata({ ...metadata, timing: { ...timing, regionPlan: bad } }, trial)).toThrow();
  }
});

it('bounds the plan to one warm-up and three measured representative sequences', () => {
  const plan = rawViewerPlan(3);
  expect(plan).toHaveLength(40); expect(plan.filter(t => t.warmup)).toHaveLength(10);
  expect(plan.filter(t => t.operation === 'pan' && !t.warmup)).toHaveLength(3);
});
it('excludes warm-up from min/median/max and never turns slow measurements into a verdict', () => {
  const rows = rawViewerPlan(3).filter(t => t.operation === 'open').map((t, i) => ({ metadata: viewerMetadata(t),
    responseWaitMs: 0, transferMs: 0, decodeMs: 0, adoptMs: 0, totalMs: [999999, 3000000, 1000000, 2000000][i] }));
  expect(rawViewerStatistics(rows)[0].totalMs).toEqual({ count: 3, min: 1000000, median: 2000000, max: 3000000 });
  const report = createRawViewerReport(rows, 'complete', 'gpu', 3);
  expect(report.status).toBe('complete'); expect(JSON.stringify(report)).not.toContain('assetId');
});
it('rejects private extras, invalid boundaries and foreign contracts before export', () => {
  const trial = rawViewerPlan(3)[0], metadata = viewerMetadata(trial);
  expect(parseRawViewerMetadata(metadata, trial)).toEqual(metadata);
  for (const bad of [{ ...metadata, rawPath: 'PRIVATE' }, { ...metadata, geometry: { ...metadata.geometry, AssetId: 'PRIVATE' } },
    { ...metadata, engine: { ...metadata.engine, geometryDescriptor: 1 } }, { ...metadata, viewGeneration: -1 },
    { ...metadata, timing: { ...metadata.timing, nativeMs: NaN } }]) expect(() => parseRawViewerMetadata(bad, trial)).toThrow('raw_invalid_response');
});
it('accepts the current Backend Viewer response through the real parser and response reader', async () => {
  // Captured from test_viewer_sequence_uses_isolated_native_owner_and_safe_metadata.
  const trial = rawViewerPlan(1)[1];
  const backendResponse = {
    operation: 'wholeDraft', repeat: 0, warmup: true, revision: 1, viewGeneration: trial.index + 1,
    quality: 'draft',
    geometry: { geometryId: 'a'.repeat(64), nativeWidth: 6000, nativeHeight: 4500, aspect: 4 / 3,
      fullWidth: 16, fullHeight: 12, window: null },
    bitmap: { width: 16, height: 12 }, region: null, wholeRequestedSide: 1024, payloadBytes: 91,
    timing: { backendOperationMs: 3.397200000108569, openMs: null,
      nativeMs: 1.8867000003410794, validationMs: 0.4401000001053035 },
    engine: { version: LIGHTCRAFT_ENGINE.version, commit: LIGHTCRAFT_ENGINE.commit,
      binarySha256: 'b5d54c39e66671c9731b9f471e585d8262cd4f54963f0c93082d8dcf334d4c78',
      previewContract: 1, regionContract: 1, geometryDescriptor: 2, gpuBackend: 'off', gpuAdapter: null },
  };
  const png = new Uint8Array(91); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(png, { headers: {
    'Content-Type': 'image/png', 'X-Raw-Diagnostic': JSON.stringify(backendResponse),
  } })));
  const result = await fetchRawViewerTrial('a'.repeat(32), trial, new AbortController().signal);
  expect(result.metadata).toEqual(backendResponse);
  expect(result.metadata.timing.nativeMs).toBe(1.8867000003410794);
  expect(result.blob?.size).toBe(91);
});
it('reads Region plan as bounded JSON without inventing image decode or adopt work', async () => {
  const trial = rawViewerPlan(3).find(t => t.operation === 'regionPlan')!, metadata = viewerMetadata(trial);
  const encoded = JSON.stringify(metadata);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(encoded, { headers: {
    'Content-Type': 'application/json', 'X-Raw-Diagnostic': encoded } })));
  const result = await fetchRawViewerTrial('a'.repeat(32), trial, new AbortController().signal);
  expect(result.blob).toBeNull(); expect(result.metadata.payloadBytes).toBe(0);
  const report = createRawViewerReport([{ metadata, responseWaitMs: result.responseWaitMs, transferMs: result.transferMs,
    decodeMs: null, adoptMs: null, totalMs: 1 }], 'running', 'gpu', 3);
  expect(report.statistics.find(s => s.operation === 'regionPlan')!.adoptMs.count).toBe(0);
});
