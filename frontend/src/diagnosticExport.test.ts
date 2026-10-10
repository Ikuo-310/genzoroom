// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { downloadDiagnosticJson } from './diagnosticExport';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const readBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob);
});

it.each([
  [{ error_code: 'authentication_failed' }, 'authentication_failed'],
  [{ error_code: 'immich_api_key_missing' }, 'immich_api_key_missing'],
  [{ version: 'v3.2.4' }, null],
])('normalizes safe Immich fields and failures without adding a second request', async (body, errorCode) => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => body })); vi.stubGlobal('fetch', fetch);
  const blobs: Blob[] = [];
  vi.stubGlobal('URL', { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:report'; }), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await downloadDiagnosticJson({ generatedAt: '2026-10-10T00:00:00.000Z', entries: [] }, 'logs');
  expect(fetch).toHaveBeenCalledOnce();
  const text = await readBlob(blobs[0]); const report = JSON.parse(text);
  expect(report.immich.errorCode).toBe(errorCode);
  expect(JSON.stringify(report)).not.toMatch(/apiKey|authorization|PRIVATE|host(name)?|http:\/\//i);
  if (errorCode) expect(report.immich).toMatchObject({ status: 'error', version: null, build: null, sourceRef: null });
  else expect(report.immich).toMatchObject({ status: 'ok', version: 'v3.2.4', build: null, sourceRef: null });
});

it('records local API failures distinctly and still downloads the report', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('PRIVATE_URL private key')); vi.stubGlobal('fetch', fetch);
  const blobs: Blob[] = [];
  vi.stubGlobal('URL', { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:report'; }), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await downloadDiagnosticJson({ generatedAt: '2026-10-10T00:00:00.000Z' }, 'logs');
  expect(JSON.parse(await readBlob(blobs[0])).immich.errorCode).toBe('backend_unreachable');
});

it('allows cancellation without downloading and ignores repeated clicks while one export is pending', async () => {
  let resolve!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
  const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<{ ok: boolean; json: () => Promise<unknown> }>((done, reject) => {
    resolve = done;
    options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  vi.stubGlobal('fetch', fetch);
  const blobs: Blob[] = [];
  vi.stubGlobal('URL', { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:report'; }), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const report = { generatedAt: '2026-10-10T00:00:00.000Z' };
  const first = downloadDiagnosticJson(report, 'logs');
  await downloadDiagnosticJson(report, 'logs');
  expect(fetch).toHaveBeenCalledOnce();
  resolve({ ok: true, json: async () => ({ error_code: 'authentication_failed' }) });
  await first;
  expect(blobs).toHaveLength(1);

  const controller = new AbortController();
  const cancelled = downloadDiagnosticJson(report, 'logs', controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toThrow('Diagnostic export cancelled');
  expect(blobs).toHaveLength(1);
});

it('converts the bounded local API timeout into a diagnostic failure and still downloads', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  vi.stubGlobal('fetch', fetch);
  const blobs: Blob[] = [];
  vi.stubGlobal('URL', { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:timeout'; }), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const pending = downloadDiagnosticJson({ generatedAt: '2026-10-10T00:00:00.000Z' }, 'logs');
  await vi.advanceTimersByTimeAsync(8500);
  await pending;
  vi.useRealTimers();
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(await readBlob(blobs[0])).immich.errorCode).toBe('backend_unreachable');
});
