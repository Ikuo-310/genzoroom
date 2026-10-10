// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createExportEngineReport, exportEngineReport } from './exportEngineReport';
import { emptyDecodeComparison } from './decodeComparison';
import { emptyEncodeRoundTrip } from './encodeRoundTrip';
import type { ExportEngineMetadata } from './exportEngineApi';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('has a distinct schema and explicitly excludes private fields, arbitrary exceptions and binary buffers', () => {
  const comparison = emptyDecodeComparison();
  comparison.status = 'completed'; comparison.dimensions.frontend = { width: 1, height: 2 };
  Object.assign(comparison, { assetId: 'PRIVATE_ASSET', filename: 'PRIVATE.JPG', url: 'PRIVATE_URL', pixels: new Uint8Array([1,2,3]), recipe: { exposure: 'PRIVATE' } });
  Object.assign(comparison.timing, { path: 'PRIVATE_PATH', history: ['PRIVATE'] });
  const roundTrip = emptyEncodeRoundTrip(); roundTrip.status = 'completed';
  Object.assign(roundTrip, { assetId: 'PRIVATE_ASSET', filename: 'PRIVATE.JPG', jpeg: new Uint8Array([1,2,3]), recipe: 'PRIVATE_RECIPE' });
  const engine = { status: 'completed', error: null, metadata: { sourceWidth: 1, sourceHeight: 2, outputWidth: 1, outputHeight: 2,
    sourceIcc: 'embedded', outputColorSpace: 'sRGB', recipeVersion: 18, outputBytes: 4, decodeMs: 1, renderMs: 2, encodeMs: 3, totalMs: 6,
    quality: 95, subsampling: '4:4:4', filename: 'PRIVATE.JPG', recipe: { body: 'PRIVATE' }, original: new Uint8Array([1,2,3]) } as ExportEngineMetadata };
  const report = createExportEngineReport(engine, comparison, new Date('2026-10-07T00:01:02.000Z'), roundTrip);
  expect(Object.keys(report)).toEqual(['schemaVersion', 'generatedAt', 'engine', 'decodeComparison', 'encodeRoundTripComparison']);
  expect(report.schemaVersion).toBe(1); expect(report.engine.encoder).toEqual({ format: 'JPEG', quality: 95, subsampling: '4:4:4', outputColorSpace: 'sRGB' });
  expect(report.decodeComparison.deltaDirection).toBe('backend-minus-frontend');
  expect(report.encodeRoundTripComparison.deltaDirection).toBe('decoded-jpeg-minus-pre-encode-rgb');
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE|assetId|filename|pixelbuffer|recipe"|history|url"/i);
});
it('downloads the safe report with common metadata and releases its URL', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const create = vi.fn((_blob: Blob) => 'blob:diagnostic-report'), revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  const report = createExportEngineReport({ status: 'idle', error: null, metadata: null }, emptyDecodeComparison(), new Date('2026-10-07T00:01:02.000Z'));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: 'v3.2.4', build: null }) })));
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('genzoroom-export-engine-diagnostics-20261007T000102Z.json');
    expect(this.isConnected).toBe(true);
  });
  await exportEngineReport(report); expect(clicked).toHaveBeenCalledOnce(); expect(document.querySelector('a[download]')).toBeNull();
  const blob = create.mock.calls[0][0]; expect(blob.type).toBe('application/json');
  const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
  expect(JSON.parse(text)).toMatchObject({ ...report, schemaVersion: 2, application: { name: 'GenzoRoom' },
    browser: { name: 'unknown' },
    immich: { status: 'ok', version: 'v3.2.4', build: null, sourceRef: null, errorCode: null } });
  vi.runAllTimers(); expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:diagnostic-report');
});
