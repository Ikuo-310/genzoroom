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
import { frontendLogger } from './frontendLogging';
vi.mock('./GalleryPage', () => ({ GalleryPage: () => <p>Gallery route</p> }));
vi.mock('./AnshitsuPage', () => ({ AnshitsuPage: () => <p>Anshitsu route</p> }));
let host: HTMLDivElement, root: Root;
let originalLanguage: string, originalTitle: string;
const logsResponse = (url: string) => ({ ok: true, json: async () => url.endsWith('/level') ? { level: 'off' }
  : { schemaVersion: 1, generatedAt: '2026-10-03T16:00:00.000Z', source: 'backend', entries: [] } });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => logsResponse(url)));
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
      for (const key of ['environmentTitle', 'exportJson', 'jpegTab', 'webgpuTab', 'exportCurrentJson']) expect(host.textContent).toContain(i18n.t(`developer.${key}`));
      for (const key of ['totalMs', 'initializationMs', 'sourceUploadMs']) expect(host.textContent).toContain(i18n.t(`webgpuSmoke.timing.${key}`));
      expect(host.textContent).toContain(i18n.t('webgpuSmoke.timingNotes'));
      expect(host.textContent).not.toMatch(/webgpuSmoke\.|developer\.|codes\./);
      expect(host.querySelectorAll('section[aria-labelledby="webgpu-title"] tbody tr')).toHaveLength(SMOKE_CASES.length);
      expect(host.textContent).toContain(i18n.t('jpegDiagnostics.title'));
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
it('keeps both logging levels enabled while switching Developer Diagnostics tabs', async () => {
  const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => url.endsWith('/level')
    ? { ok: true, json: async () => ({ level: 'debug' }) }
    : logsResponse(url));
  vi.stubGlobal('fetch', fetchMock);
  frontendLogger.clear(); frontendLogger.setLevel('debug');
  frontendLogger.add({ level: 'debug', component: 'test', event: 'retained' });
  const { DeveloperPage } = await import('./DeveloperPage');
  await act(async () => root.render(<DeveloperPage />));
  await act(async () => host.querySelector<HTMLButtonElement>('#jpeg-tab')!.click());
  expect(frontendLogger.getLevel()).toBe('debug');
  await act(async () => host.querySelector<HTMLButtonElement>('#webgpu-tab')!.click());
  expect(frontendLogger.getLevel()).toBe('debug');
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
  act(() => root.unmount()); root = createRoot(host);
  expect(frontendLogger.getLevel()).toBe('off');
});

it.each(['unmount', 'pagehide'] as const)('turns both loggers off on DeveloperPage %s without clearing entries', async departure => {
  const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => url.endsWith('/level')
    ? { ok: true, json: async () => ({ level: 'debug' }) }
    : logsResponse(url));
  vi.stubGlobal('fetch', fetchMock);
  frontendLogger.clear(); frontendLogger.setLevel('debug');
  frontendLogger.add({ level: 'debug', component: 'test', event: 'keep-buffer' });
  const { DeveloperPage } = await import('./DeveloperPage');
  await act(async () => root.render(<DeveloperPage />));
  if (departure === 'pagehide') await act(async () => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  else act(() => root.unmount());
  expect(frontendLogger.getLevel()).toBe('off');
  expect(frontendLogger.getEntries().some(entry => entry.event === 'keep-buffer')).toBe(true);
  const offRequests = fetchMock.mock.calls.filter(([url, options]) => url.endsWith('/level') && options?.method === 'PUT');
  expect(offRequests).toHaveLength(1);
  expect(offRequests[0][1]).toMatchObject({ keepalive: true, cache: 'no-store', body: '{"level":"off"}' });
  if (departure === 'pagehide') {
    act(() => root.unmount()); root = createRoot(host);
    expect(fetchMock.mock.calls.filter(([url, options]) => url.endsWith('/level') && options?.method === 'PUT')).toHaveLength(1);
  } else root = createRoot(host);
});

it('does not disable logging when the page only becomes hidden', async () => {
  frontendLogger.setLevel('debug');
  const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => logsResponse(url)); vi.stubGlobal('fetch', fetchMock);
  const { DeveloperPage } = await import('./DeveloperPage');
  await act(async () => root.render(<DeveloperPage />));
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(frontendLogger.getLevel()).toBe('debug');
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
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

it.each(['en', 'ja'])('exports environment and not-run/failed WebGPU data through the page in %s without photo or GPU requests', async language => {
  await i18n.changeLanguage(language);
  vi.stubGlobal('isSecureContext', false);
  const gpu = { requestAdapter: vi.fn() };
  vi.stubGlobal('navigator', { gpu, hardwareConcurrency: 8, userAgent: 'Test browser', platform: 'Test platform' });
  const fetch = vi.fn(async (url: string) => logsResponse(url)); vi.stubGlobal('fetch', fetch);
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
    expect(exportButton.closest('.developer-section')?.querySelector('h2')?.id).toBe('environment-title');
    expect(host.querySelector('#diagnostic-export-title')).toBeNull();
    const jpegPanel = host.querySelector<HTMLElement>('#jpeg-panel')!;
    const webgpuPanel = host.querySelector<HTMLElement>('#webgpu-panel')!;
    expect(jpegPanel.hidden).toBe(true); expect(webgpuPanel.hidden).toBe(true);
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe('logs-tab');
    expect(jpegPanel.getAttribute('aria-labelledby')).toBe('jpeg-tab');
    expect(host.querySelector('#environment-title')).not.toBeNull();
    const jpegSection = jpegPanel.querySelector('section'); const webgpuSection = webgpuPanel.querySelector('section');
    const webgpuTab = host.querySelector<HTMLButtonElement>('#webgpu-tab')!;
    await act(async () => webgpuTab.focus());
    await act(async () => webgpuTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement).toBe(host.querySelector('#logs-tab'));
    await act(async () => webgpuTab.click());
    expect(jpegPanel.hidden).toBe(true); expect(webgpuPanel.hidden).toBe(false);
    expect(webgpuTab.getAttribute('aria-selected')).toBe('true');
    await act(async () => host.querySelector<HTMLButtonElement>('#jpeg-tab')!.click());
    expect(jpegPanel.querySelector('section')).toBe(jpegSection);
    expect(webgpuPanel.querySelector('section')).toBe(webgpuSection);
    await act(async () => exportButton.click());
    const initial = await readReport(blobs[0]);
    expect(initial.schemaVersion).toBe(1); expect(initial.generatedAt).toMatch(/Z$/);
    expect(initial.environment.hardwareConcurrency).toBe(8); expect(initial.environment.deviceMemory).toBeNull();
    expect(initial.webgpu.smoke.status).toBe('not_run');
    expect(initial.jpeg.status).toBe('not_run');
    expect(gpu.requestAdapter).not.toHaveBeenCalled();
    await act(async () => webgpuTab.click());
    const runButton = [...host.querySelectorAll('button')].find(button => button.textContent === i18n.t('webgpuSmoke.run'))!;
    await act(async () => runButton.click());
    await act(async () => exportButton.click());
    const failed = await readReport(blobs[1]);
    expect(failed.webgpu.smoke.status).toBe('failed');
    expect(failed.webgpu.smoke.error).toEqual({ code: 'insecure_context', detail: null });
    expect(failed.webgpu.smoke.timing.totalMs).toEqual(expect.any(Number));
    expect(failed.webgpu.smoke.cases).toHaveLength(SMOKE_CASES.length);
    expect(JSON.stringify(failed)).not.toContain(i18n.t('webgpuSmoke.codes.insecure'));
    await act(async () => host.querySelector<HTMLButtonElement>('#jpeg-tab')!.click());
    expect(host.querySelector<HTMLElement>('#webgpu-panel')!.hidden).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('#webgpu-tab')!.click());
    expect(host.querySelector('#webgpu-panel')!.textContent).toContain(i18n.t('webgpuSmoke.codes.insecure'));
    expect(fetch.mock.calls.every(([url]) => url.startsWith('/api/developer/logs/'))).toBe(true);
    expect(gpu.requestAdapter).not.toHaveBeenCalled();
  } finally { vi.runAllTimers(); vi.useRealTimers(); Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL'); }
});

it.each(['en', 'ja'])('shows export failures beside the matching full, JPEG and WebGPU actions in %s', async language => {
  await i18n.changeLanguage(language);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:failed-export' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('Download failed'); });
  try {
    const { DeveloperPage } = await import('./DeveloperPage');
    await act(async () => root.render(<DeveloperPage />));
    const byText = (value: string, parent: ParentNode = host) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === value)!;
    await act(async () => byText(i18n.t('developer.exportJson')).click());
    expect(host.querySelector('#environment-title')?.parentElement?.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('developer.fullExportFailed'));
    const jpegPanel = host.querySelector('#jpeg-panel')!;
    await act(async () => byText(i18n.t('developer.exportCurrentJson'), jpegPanel).click());
    expect(jpegPanel.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('developer.jpegExportFailed'));
    await act(async () => host.querySelector<HTMLButtonElement>('#webgpu-tab')!.click());
    const webgpuPanel = host.querySelector('#webgpu-panel')!;
    await act(async () => byText(i18n.t('developer.exportCurrentJson'), webgpuPanel).click());
    expect(webgpuPanel.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('developer.webgpuExportFailed'));
  } finally {
    vi.runAllTimers(); vi.useRealTimers(); Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL');
  }
});

it('keeps the manually selected JPEG, filename and candidate list while switching tabs', async () => {
  const asset = { id: 'selected-id', filename: 'PRIVATE_selected.JPG', date: '2026-01-01T00:00:00Z', thumbnail_url: '/private-thumb', format: 'JPEG', is_raw: false };
  const fetch = vi.fn(async (url: string) => url.startsWith('/api/developer/logs/') ? logsResponse(url) : { ok: true, json: async () => [asset] }); vi.stubGlobal('fetch', fetch);
  const { DeveloperPage } = await import('./DeveloperPage');
  await act(async () => root.render(<DeveloperPage />));
  const jpegPanel = host.querySelector('#jpeg-panel')!;
  const button = (key: string) => [...jpegPanel.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === i18n.t(`jpegDiagnostics.${key}`))!;
  await act(async () => button('choose').click());
  await act(async () => { await Promise.resolve(); });
  await act(async () => jpegPanel.querySelector<HTMLButtonElement>('.developer-jpeg-candidates button')!.click());
  const candidate = jpegPanel.querySelector('.developer-jpeg-candidates');
  expect(jpegPanel.textContent).toContain('PRIVATE_selected.JPG');
  await act(async () => host.querySelector<HTMLButtonElement>('#webgpu-tab')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('#jpeg-tab')!.click());
  expect(jpegPanel.querySelector('.developer-jpeg-candidates')).toBe(candidate);
  expect(jpegPanel.textContent).toContain('PRIVATE_selected.JPG');
  expect(fetch.mock.calls.filter(([url]) => !url.startsWith('/api/developer/logs/'))).toHaveLength(1);
});

it('selects Logs initially and follows three-tab keyboard order while retaining every panel', async () => {
  const { DeveloperPage } = await import('./DeveloperPage');
  await act(async () => root.render(<DeveloperPage />));
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = [...host.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  expect(tabs.map(tab => tab.id)).toEqual(['logs-tab', 'jpeg-tab', 'webgpu-tab']);
  expect(panels.map(panel => panel.hidden)).toEqual([false, true, true]);
  const jpeg = host.querySelector('#jpeg-panel section'), webgpu = host.querySelector('#webgpu-panel section');
  const press = async (key: string, expected: number) => {
    const selected = tabs.find(tab => tab.getAttribute('aria-selected') === 'true')!;
    await act(async () => selected.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    expect(document.activeElement).toBe(tabs[expected]);
    expect(tabs.map(tab => tab.tabIndex)).toEqual(tabs.map((_, index) => index === expected ? 0 : -1));
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(tabs.map((_, index) => String(index === expected)));
  };
  await press('ArrowLeft', 2); await press('ArrowRight', 0); await press('ArrowRight', 1);
  await press('ArrowRight', 2); await press('Home', 0); await press('End', 2);
  expect(host.querySelector('#jpeg-panel section')).toBe(jpeg); expect(host.querySelector('#webgpu-panel section')).toBe(webgpu);
  expect(host.querySelector('#environment-title')?.closest('section')?.compareDocumentPosition(host.querySelector('[role="tablist"]')!)! & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
