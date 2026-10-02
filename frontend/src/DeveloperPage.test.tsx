// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { App } from './App';
import { WebGpuDiagnostics } from './WebGpuDiagnostics';
import { SMOKE_CASES, type SmokeFactory } from './webgpuSmoke';
import type { DiagnosticsReport } from './developerDiagnostics';
vi.mock('./GalleryPage', () => ({ GalleryPage: () => <p>Gallery route</p> }));
vi.mock('./AnshitsuPage', () => ({ AnshitsuPage: () => <p>Anshitsu route</p> }));
let host: HTMLDivElement, root: Root;
let originalLanguage: string, originalTitle: string;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  originalLanguage = i18n.language; originalTitle = document.title;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  await i18n.changeLanguage(originalLanguage); document.title = originalTitle;
});
it.each([['/', 'Gallery route'], ['/anshitsu/test', 'Anshitsu route'], ['/developer', 'Developer Diagnostics']])('renders %s through App', async (path, text) => {
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>));
  if (path === '/developer') {
    expect(host.textContent).toContain('Loading…');
    await act(async () => { await import('./DeveloperPage'); });
  }
  expect(host.textContent).toContain(text);
});
it('translates both languages, follows changes, never probes on mount and restores the title', async () => {
  const gpu = { requestAdapter: vi.fn() };
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: gpu });
  try {
    await act(async () => root.render(<StrictMode><MemoryRouter initialEntries={['/developer']}><App /></MemoryRouter></StrictMode>));
    await act(async () => { await import('./DeveloperPage'); });
    for (const language of ['en', 'ja']) {
      await act(async () => i18n.changeLanguage(language));
      expect(document.title).toBe(`${i18n.t('developer.title')} — GenzoRoom`);
      for (const key of ['title', 'imageDescription', 'numericNotes', 'recipeCase', 'run', 'comparison', 'adapter', 'execution', 'maximumDifference', 'differingChannels', 'alphaMatches', 'error']) expect(host.textContent).toContain(i18n.t(`webgpuSmoke.${key}`));
    for (const key of ['environmentTitle', 'exportJson']) expect(host.textContent).toContain(i18n.t(`developer.${key}`));
      for (const key of ['totalMs', 'initializationMs', 'sourceUploadMs']) expect(host.textContent).toContain(i18n.t(`webgpuSmoke.timing.${key}`));
      expect(host.textContent).toContain(i18n.t('webgpuSmoke.timingNotes'));
      expect(host.textContent).not.toMatch(/webgpuSmoke\.|developer\.|codes\./);
      expect(host.querySelectorAll('tbody tr')).toHaveLength(SMOKE_CASES.length);
    }
    expect(gpu.requestAdapter).not.toHaveBeenCalled();
    act(() => root.unmount()); root = createRoot(host);
    expect(document.title).toBe(originalTitle);
  } finally { Reflect.deleteProperty(navigator, 'gpu'); }
});
it.each(['en', 'ja'])('escapes raw GPU errors and translates failure state in %s', async language => {
  await i18n.changeLanguage(language);
  const factory = vi.fn<SmokeFactory>(async (_gpu, onError) => { onError(new Error('<img src=x onerror=alert(1)> WGSL')); return null; });
  await act(async () => root.render(<WebGpuDiagnostics environment={{ secureContext: true, gpu: { requestAdapter: vi.fn() } }} factory={factory} />));
  expect(factory).not.toHaveBeenCalled();
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toContain('<img src=x onerror=alert(1)> WGSL');
  expect(host.querySelector('img')).toBeNull();
  expect(host.textContent).toContain(i18n.t('webgpuSmoke.codes.failed'));
  expect(host.textContent).not.toContain('webgpuSmoke.');
});
it.each(['en', 'ja'])('translates preflight failure codes in %s', async language => {
  await i18n.changeLanguage(language);
  await act(async () => root.render(<WebGpuDiagnostics environment={{ secureContext: false }} />));
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toContain(i18n.t('webgpuSmoke.codes.insecure'));
  expect(host.textContent).not.toContain('webgpuSmoke.');
});

it.each(['en', 'ja'])('translates successful execution and safely shows optional adapter info in %s', async language => {
  await i18n.changeLanguage(language);
  const renderer = { setSource: vi.fn(async () => 1), render: vi.fn(async () => ({ pixels: new Uint8ClampedArray(2048), width: 32, height: 16, sourceGeneration: 1, requestId: 1 })), dispose: vi.fn() };
  const device = { destroy: vi.fn() };
  const environment = { secureContext: true, gpu: { requestAdapter: vi.fn(async () => ({ info: { vendor: 'amd', architecture: 'gcn-4', device: '', description: '' }, requestDevice: vi.fn(async () => device as never) })) } };
  const factory: SmokeFactory = async gpu => { const adapter = await gpu.requestAdapter(); await adapter!.requestDevice(); return renderer; };
  await act(async () => root.render(<WebGpuDiagnostics environment={environment} factory={factory} />));
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toContain(i18n.t('webgpuSmoke.codes.complete'));
  expect(host.textContent).toContain(i18n.t('webgpuSmoke.codes.shaderSuccess'));
  expect(host.textContent.match(/Blank/g)).toHaveLength(2);
  expect(host.textContent).toContain('amd');
  expect(host.textContent).toContain('gcn-4');
  expect(host.textContent).not.toContain('空文字');
  expect(host.textContent).not.toContain('webgpuSmoke.');
  expect(renderer.render).toHaveBeenCalledTimes(SMOKE_CASES.length);
  expect(host.querySelector('tbody tr')!.textContent).toMatch(/\d+\.\d{2} ms/);
});
it.each(['unmount', 'pagehide'])('releases a pending diagnostic on %s and ignores its late result', async departure => {
  let resolve!: (value: never) => void;
  const pending = new Promise<never>(done => { resolve = done; });
  const renderer = { setSource: vi.fn(async () => 1), render: vi.fn(() => pending), dispose: vi.fn() };
  const factory = vi.fn<SmokeFactory>(async () => renderer);
  await act(async () => root.render(<WebGpuDiagnostics environment={{ secureContext: true, gpu: { requestAdapter: vi.fn() } }} factory={factory} />));
  await act(async () => host.querySelector('button')!.click());
  expect(host.querySelector('button')!.disabled).toBe(true);
  if (departure === 'unmount') { act(() => root.unmount()); root = createRoot(host); }
  else act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  expect(renderer.dispose).toHaveBeenCalled();
  await act(async () => resolve({ pixels: new Uint8ClampedArray(2048), width: 32, height: 16, sourceGeneration: 1, requestId: 1 } as never));
  expect(renderer.render).toHaveBeenCalledOnce();
  if (departure === 'pagehide') {
    await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    expect(host.querySelector('button')!.disabled).toBe(false);
    expect(host.textContent).toContain(i18n.t('webgpuSmoke.codes.idle'));
    expect(factory).toHaveBeenCalledOnce();
  }
});

it.each(['en', 'ja'])('exports environment and not-run/failed WebGPU data through the page in %s without requests', async language => {
  await i18n.changeLanguage(language);
  vi.stubGlobal('isSecureContext', false);
  const gpu = { requestAdapter: vi.fn() };
  vi.stubGlobal('navigator', { gpu, hardwareConcurrency: 8, userAgent: 'Test browser', platform: 'Test platform' });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const blobs: Blob[] = [];
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (blob: Blob) => { blobs.push(blob); return 'blob:page'; } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const readReport = (blob: Blob) => new Promise<DiagnosticsReport>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(JSON.parse(String(reader.result))); reader.onerror = () => reject(reader.error); reader.readAsText(blob);
  });
  try {
    const { DeveloperPage } = await import('./DeveloperPage');
    await act(async () => root.render(<DeveloperPage />));
    expect(host.textContent).toContain('Test browser'); expect(host.textContent).toContain('Test platform');
    expect(host.textContent).toContain(i18n.t('developer.environmentTitle'));
    expect(host.textContent).toContain(i18n.t('developer.notAvailable'));
    expect(host.textContent).not.toMatch(/developer\.|webgpuSmoke\./);
    const exportButton = [...host.querySelectorAll('button')].find(button => button.textContent === i18n.t('developer.exportJson'))!;
    expect(exportButton.closest('.developer-actions')).not.toBeNull();
    expect(exportButton.previousElementSibling?.textContent).toBe(i18n.t('webgpuSmoke.run'));
    expect(host.querySelector('#diagnostic-export-title')).toBeNull();
    await act(async () => exportButton.click());
    const initial = await readReport(blobs[0]);
    expect(initial.schemaVersion).toBe(1); expect(initial.generatedAt).toMatch(/Z$/);
    expect(initial.environment.hardwareConcurrency).toBe(8); expect(initial.environment.deviceMemory).toBeNull();
    expect(initial.webgpu.smoke.status).toBe('not_run');
    expect(gpu.requestAdapter).not.toHaveBeenCalled();
    const runButton = [...host.querySelectorAll('button')].find(button => button.textContent === i18n.t('webgpuSmoke.run'))!;
    await act(async () => runButton.click());
    await act(async () => exportButton.click());
    const failed = await readReport(blobs[1]);
    expect(failed.webgpu.smoke.status).toBe('failed');
    expect(failed.webgpu.smoke.error).toEqual({ code: 'insecure_context', detail: null });
    expect(failed.webgpu.smoke.timing.totalMs).toEqual(expect.any(Number));
    expect(failed.webgpu.smoke.cases).toHaveLength(SMOKE_CASES.length);
    expect(JSON.stringify(failed)).not.toContain(i18n.t('webgpuSmoke.codes.insecure'));
    expect(fetch).not.toHaveBeenCalled(); expect(gpu.requestAdapter).not.toHaveBeenCalled();
  } finally { vi.runAllTimers(); vi.useRealTimers(); Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL'); }
});
