// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  captureAdapterInfo, captureGpuCapabilities, collectDiagnosticsEnvironment, createDiagnosticsReport,
  createJpegDiagnosticsReport, createWebGpuDiagnosticsReport, createWebGpuReport, exportDiagnosticsReport,
  exportJpegDiagnosticsReport, exportWebGpuDiagnosticsReport,
} from './developerDiagnostics';
import { emptyJpegReport } from './jpegDiagnosticsReport';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reads only passive allowlisted browser information without requesting GPU, storage or URLs', () => {
  const forbidden = vi.fn(() => { throw new Error('Must not be read'); });
  const gpu = { requestAdapter: vi.fn() };
  const browser = {
    isSecureContext: true, crossOriginIsolated: false, devicePixelRatio: 1.5, innerWidth: 1400, innerHeight: 900,
    get location() { return forbidden(); }, get localStorage() { return forbidden(); }, get sessionStorage() { return forbidden(); },
  };
  const agent = {
    gpu, hardwareConcurrency: 8, deviceMemory: 4, userAgent: 'Browser UA', platform: 'Browser platform',
    get cookie() { return forbidden(); },
  };
  const environment = collectDiagnosticsEnvironment(browser as unknown as Window, agent as unknown as Navigator);
  expect(environment).toEqual({
    secureContext: true, crossOriginIsolated: false, gpuApiAvailable: true, hardwareConcurrency: 8,
    deviceMemory: 4, devicePixelRatio: 1.5, viewport: { width: 1400, height: 900 }, userAgent: 'Browser UA', platform: 'Browser platform',
  });
  expect(gpu.requestAdapter).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled();
  const report = createDiagnosticsReport(environment, createWebGpuReport(true, null), new Date('2026-10-02T08:30:00.000Z'));
  expect(report.schemaVersion).toBe(1); expect(report.generatedAt).toBe('2026-10-02T08:30:00.000Z');
  expect(report.webgpu.smoke.status).toBe('not_run'); expect(report.webgpu.smoke.cases).toEqual([]);
  expect(Object.values(report.webgpu.smoke.timing)).toEqual([null, null, null, null, null]);
  expect(JSON.stringify(report)).not.toMatch(/localStorage|sessionStorage|cookie|location|hostname|assetId|albumId|recipe|history|clipboard|authorization|apiKey/i);
});

it('uses null for unavailable properties and safely handles throwing or non-finite optional getters', () => {
  const environment = collectDiagnosticsEnvironment({ devicePixelRatio: Infinity } as Window, {
    get deviceMemory() { throw new Error('Unavailable'); },
  } as unknown as Navigator);
  expect(environment).toEqual({
    secureContext: null, crossOriginIsolated: null, gpuApiAvailable: false, hardwareConcurrency: null,
    deviceMemory: null, devicePixelRatio: null, viewport: { width: null, height: null }, userAgent: null, platform: null,
  });
  expect(captureGpuCapabilities({ get features() { throw new Error('Restricted'); }, limits: { maxBufferSize: Infinity } })).toEqual({ features: null, limits: null });
  expect(captureAdapterInfo({ vendor: '', architecture: 'gcn-4', apiKey: 'secret' } as never)).toEqual({ vendor: '', architecture: 'gcn-4' });
});

it('exports exactly the report as a Blob with a safe filename, releases the URL and never sends a request', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const create = vi.fn((_blob: Blob) => 'blob:diagnostics'); const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  let download = '', href = '';
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    download = this.download; href = this.href; expect(this.isConnected).toBe(true);
  });
  const report = createDiagnosticsReport(collectDiagnosticsEnvironment(), createWebGpuReport(false, null), new Date('2026-10-02T08:30:00.000Z'));
  try {
    exportDiagnosticsReport(report);
    expect(download).toBe('genzoroom-diagnostics-20261002T083000Z.json'); expect(href).toBe('blob:diagnostics');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    const blob = create.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json');
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob);
    });
    expect(JSON.parse(text)).toEqual(report); expect(fetch).not.toHaveBeenCalled();
    vi.runAllTimers(); expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:diagnostics');
  } finally { Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL'); }
});

it('also releases the download URL when clicking the link fails', () => {
  vi.useFakeTimers();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:failed' });
  const revoke = vi.fn(); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('Download failed'); });
  try {
    expect(() => exportDiagnosticsReport(createDiagnosticsReport(collectDiagnosticsEnvironment(), createWebGpuReport(false, null)))).toThrow('Download failed');
    vi.runAllTimers(); expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:failed');
    expect(document.querySelector('a[download]')).toBeNull();
  } finally { Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL'); }
});

it('projects each diagnostic scope explicitly and uses a distinct download name', () => {
  const environment = collectDiagnosticsEnvironment(); const webgpu = createWebGpuReport(false, null);
  const jpeg = emptyJpegReport('manual');
  Object.assign(jpeg.source, { filename: 'PRIVATE.JPG', assetId: 'secret' });
  const full = createDiagnosticsReport(environment, webgpu, new Date('2026-10-02T08:30:00.000Z'), jpeg);
  const onlyJpeg = createJpegDiagnosticsReport(environment, jpeg, new Date('2026-10-02T08:30:00.000Z'));
  const onlyWebGpu = createWebGpuDiagnosticsReport(environment, webgpu, new Date('2026-10-02T08:30:00.000Z'));
  expect(Object.keys(full)).toEqual(['schemaVersion', 'generatedAt', 'environment', 'webgpu', 'jpeg']);
  expect(Object.keys(onlyJpeg)).toEqual(['schemaVersion', 'generatedAt', 'environment', 'jpeg']);
  expect(Object.keys(onlyWebGpu)).toEqual(['schemaVersion', 'generatedAt', 'environment', 'webgpu']);
  expect(JSON.stringify([full, onlyJpeg, onlyWebGpu])).not.toMatch(/PRIVATE\.JPG|assetId|secret/);

  const names: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:scoped' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  try {
    exportDiagnosticsReport(full); exportJpegDiagnosticsReport(onlyJpeg); exportWebGpuDiagnosticsReport(onlyWebGpu);
    expect(names).toEqual([
      'genzoroom-diagnostics-20261002T083000Z.json',
      'genzoroom-jpeg-diagnostics-20261002T083000Z.json',
      'genzoroom-webgpu-diagnostics-20261002T083000Z.json',
    ]);
  } finally { Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL'); }
});
