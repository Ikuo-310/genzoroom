// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createRawDiagnosticReport, fetchRawTrial, parseRawTrial, rawComparisons, rawStatistics, rawTrialPlan, statistics,
  startRawDiagnostic, type RawTrialResult } from './rawDiagnostics';
import { diagnosticConfig, trialMetadata, trialRows } from './test/rawDiagnostics';

afterEach(() => vi.unstubAllGlobals());
it('defines bounded Cold groups and shared Warm groups without calling them cache hits', () => {
  const plan = rawTrialPlan({ ...diagnosticConfig, temperature: 'both', repeats: 5 });
  expect(plan).toHaveLength(20);
  const cold = plan.filter(r => r.temperature === 'cold' && r.quality === 'full');
  const warm = plan.filter(r => r.temperature === 'warm' && r.quality === 'full');
  expect(new Set(cold.map(r => r.group)).size).toBe(5); expect(new Set(warm.map(r => r.group)).size).toBe(1);
});
it('calculates medians/min/max and only compatible native ratios under matching conditions', () => {
  expect(statistics([])).toEqual({ count: 0, min: null, max: null, median: null });
  expect(statistics([4, 1, 3, 2])).toEqual({ count: 4, min: 1, max: 4, median: 2.5 });
  const rows = trialRows(), result = rawComparisons(rows);
  expect(result).toEqual([{ temperature: 'cold', ratio: 2 }]);
});
it.each(['source', 'settings', 'geometry', 'binary', 'backend', 'size'])('does not compare mismatched %s', field => {
  const rows = trialRows(), m = rows[1].metadata!;
  if (field === 'source') m.source.identity = '0'.repeat(64);
  if (field === 'settings') m.settingsFingerprint = '0'.repeat(64);
  if (field === 'geometry') m.frame.geometryId = '0'.repeat(64);
  if (field === 'binary') m.contract.binarySha256 = '0'.repeat(64);
  if (field === 'backend') m.backend.configured = 'gpu';
  if (field === 'size') { m.width = m.frame.fullWidth = 17; }
  expect(rawComparisons(rows)).toEqual([]);
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
  expect(report.limitations).toContain('backendIsConfiguredOnly');
});
it.each(['quality', 'frame', 'timing', 'path', 'hash'])('rejects malformed measured metadata: %s', field => {
  const trial = rawTrialPlan(diagnosticConfig)[1], m = trialMetadata(trial);
  if (field === 'quality') m.trial = { ...trial, quality: 'draft' };
  if (field === 'frame') m.frame.fullWidth = 10;
  if (field === 'timing') m.metrics.nativeMs = -1;
  if (field === 'path') Object.assign(m.source, { path: 'C:/private.dng' });
  if (field === 'hash') m.metrics.pngSha256 = null;
  expect(() => parseRawTrial(m, trial)).toThrow();
});
it('accepts the current Backend PNG response and its timing-only metadata through the real parser', async () => {
  // Captured from test_isolated_quality_cold_warm_and_no_persistence with fake Native.
  const metadata = {
    trial: { index: 4, quality: 'full', temperature: 'cold', repeat: 1, group: 'full:cold:0' },
    measuredAt: '2026-11-20T06:05:02.419992+00:00',
    contract: { lightcraftVersion: '0.20.0', engineCommit: '192ff72923c39e6623f2c7ff67ab3a119deb8071', previewContract: 1,
      binarySha256: 'b5d54c39e66671c9731b9f471e585d8262cd4f54963f0c93082d8dcf334d4c78' },
    source: { width: 4000, height: 3000, format: 'DNG', identity: 'fba06be9b32031e2948b569a8739583c7c26e015b1ccbb7cb5b99b1916d375e4' },
    settingsFingerprint: 'a89da28f38d78f2026b40399e5631ca175232c287ff1729dc29d60c14a6a1f69',
    frame: { geometryId: 'a'.repeat(64), nativeWidth: 6000, nativeHeight: 4500, aspect: 4 / 3, fullWidth: 16, fullHeight: 12, window: null },
    backend: { configured: 'cpu' }, width: 16, height: 12, payloadBytes: 91,
    metrics: { nativeMs: 2.695000000130676, validationMs: 0.6928000000243628,
      pngSha256: 'f3d9f1d782082fcc27efd63f3cde03d36e729f8eb46b9113f27e3fdced7d06e6' },
  };
  const trial = rawTrialPlan({ ...diagnosticConfig, temperature: 'both', repeats: 2 })[4];
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAYAAABr5z2BAAAAIklEQVR4nGOUMwr4z0ABYKJE86gBEMDEQCFgGjWAgeIwAAAS7QG3x+uUAQAAAABJRU5ErkJggg=='),
    byte => byte.charCodeAt(0));
  const fetch = vi.fn(async () => new Response(png, {
    headers: { 'Content-Type': 'image/png', 'X-Raw-Diagnostic': JSON.stringify(metadata) } }));
  vi.stubGlobal('fetch', fetch);
  const image = await fetchRawTrial('owner', trial, new AbortController().signal);
  expect(image.metadata).toEqual(metadata);
  expect(image.transferMs).toBeGreaterThanOrEqual(0);
  expect(image.blob.size).toBe(metadata.payloadBytes);
  expect(fetch.mock.calls).toHaveLength(1);
});
it('rejects an incompatible server plan', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runId: 'a'.repeat(32), maxSide: 1024, plan: [] }), {
    headers: { 'Content-Type': 'application/json' } })));
  await expect(startRawDiagnostic(diagnosticConfig, new AbortController().signal)).rejects.toThrow('raw_invalid_response');
});
