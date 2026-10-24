// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createRawDiagnosticReport, fetchRawTrial, parseRawTrial, rawComparisons, rawStatistics, rawTrialPlan, statistics,
  startRawDiagnostic, type RawTrialResult } from './rawDiagnostics';
import { diagnosticConfig, trialMetadata, trialRows } from './test/rawDiagnostics';

afterEach(() => vi.unstubAllGlobals());
it('defines bounded Cold groups and shared Warm groups without calling them cache hits', () => {
  const plan = rawTrialPlan({ ...diagnosticConfig, temperature: 'both', repeats: 5 });
  expect(plan).toHaveLength(40);
  const cold = plan.filter(r => r.temperature === 'cold' && r.quality === 'full' && r.stageCache === 'on');
  const warm = plan.filter(r => r.temperature === 'warm' && r.quality === 'full' && r.stageCache === 'on');
  expect(new Set(cold.map(r => r.group)).size).toBe(5); expect(new Set(warm.map(r => r.group)).size).toBe(1);
});
it('calculates medians/min/max and only compatible native ratios and Full matches', () => {
  expect(statistics([])).toEqual({ count: 0, min: null, max: null, median: null });
  expect(statistics([4, 1, 3, 2])).toEqual({ count: 4, min: 1, max: 4, median: 2.5 });
  const rows = trialRows(), result = rawComparisons(rows);
  expect(result.ratios.filter(r => r.comparison === 'draftFull').map(r => r.ratio)).toEqual([2, 2]);
  expect(result.matches[0].result).toBe('equal');
  rows[3].metadata!.metrics.pngSha256 = 'a'.repeat(64);
  expect(rawComparisons(rows).matches[0].result).toBe('different');
});
it.each(['source', 'settings', 'geometry', 'binary', 'backend', 'fallback', 'size', 'cache'])('does not compare mismatched %s', field => {
  const rows = trialRows(), m = rows[3].metadata!;
  if (field === 'source') m.source.identity = '0'.repeat(64);
  if (field === 'settings') m.settingsFingerprint = '0'.repeat(64);
  if (field === 'geometry') m.frame.geometryId = '0'.repeat(64);
  if (field === 'binary') m.contract.binarySha256 = '0'.repeat(64);
  if (field === 'backend') m.backend.execution = 'unconfirmed';
  if (field === 'fallback') m.backend.fallbackReported = true;
  if (field === 'size') { m.width = m.frame.fullWidth = 17; }
  if (field === 'cache') m.metrics.stageCache.applied = false;
  expect(rawComparisons(rows).matches[0].result).toBe('unverified');
  expect(rawComparisons(rows).ratios.some(r => r.comparison === 'cache' && r.fixed === 'full')).toBe(false);
});
it('keeps unknown durations null and separates distinct actual geometry in statistics', () => {
  const row = trialRows()[0], changed = structuredClone(row);
  changed.metadata!.frame.geometryId = '1'.repeat(64);
  const failed: RawTrialResult = { ...row, result: 'failed', metadata: null, transferMs: null, decodeMs: null, totalMs: null };
  const groups = rawStatistics([row, changed, failed]);
  expect(groups).toHaveLength(3); expect(groups[2].nativeMs.median).toBeNull(); expect(groups[2].totalMs.count).toBe(0);
});
it('exports a RAW-only allowlisted report without image, asset UUID, paths, settings or credentials', () => {
  const rows = trialRows();
  Object.assign(rows[0], { apiKey: 'PRIVATE_KEY', localPath: 'C:/private.dng', pixels: 'PRIVATE_PIXELS' });
  const report = createRawDiagnosticReport({ ...diagnosticConfig, apiKey: 'PRIVATE_KEY' } as never, rows);
  const text = JSON.stringify(report);
  expect(report.reportType).toBe('raw-preview'); expect(report.schemaVersion).toBe(1);
  expect(text).not.toMatch(/PRIVATE|C:\/|11111111|localPath|pixels|apiKey/);
  expect(report.limitations).toContain('rssAndVramNotCollected');
});
it.each(['quality', 'frame', 'memory', 'path', 'hash'])('rejects malformed measured metadata: %s', field => {
  const trial = rawTrialPlan(diagnosticConfig)[1], m = trialMetadata(trial);
  if (field === 'quality') m.trial = { ...trial, quality: 'draft' };
  if (field === 'frame') m.frame.fullWidth = 10;
  if (field === 'memory') m.metrics.stageCache.retainedBytes = Number.MAX_SAFE_INTEGER;
  if (field === 'path') Object.assign(m.source, { path: 'C:/private.dng' });
  if (field === 'hash') m.metrics.pngSha256 = null;
  expect(() => parseRawTrial(m, trial)).toThrow();
});
it('validates binary metadata and measures body reads independently of native timings', async () => {
  const trial = rawTrialPlan(diagnosticConfig)[1], metadata = trialMetadata(trial);
  const fetch = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
    headers: { 'Content-Type': 'image/png', 'X-Raw-Diagnostic': JSON.stringify(metadata) } }));
  vi.stubGlobal('fetch', fetch);
  const image = await fetchRawTrial('owner', trial, new AbortController().signal);
  expect(image.metadata.metrics.nativeMs).toBe(20); expect(image.transferMs).toBeGreaterThanOrEqual(0);
  expect(image.blob.size).toBe(8); expect(fetch.mock.calls).toHaveLength(1);
});
it('rejects an incompatible server plan', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runId: 'a'.repeat(32), maxSide: 1024, plan: [] }), {
    headers: { 'Content-Type': 'application/json' } })));
  await expect(startRawDiagnostic(diagnosticConfig, new AbortController().signal)).rejects.toThrow('raw_invalid_response');
});
