import { afterEach, expect, it, vi } from 'vitest';
import { createRawViewerReport, fetchRawViewerTrial, parseRawViewerMetadata, rawViewerPlan, rawViewerStatistics } from './rawViewerBenchmark';
import { viewerMetadata } from './test/rawViewerBenchmark';
afterEach(() => vi.unstubAllGlobals());

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
