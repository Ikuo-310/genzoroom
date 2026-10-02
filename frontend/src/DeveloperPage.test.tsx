// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { App } from './App';
import { WebGpuDiagnostics } from './WebGpuDiagnostics';
import { SMOKE_CASES, type SmokeFactory } from './webgpuSmoke';
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
  const environment = { secureContext: true, gpu: { requestAdapter: vi.fn(async () => ({ info: { vendor: '<img src=x>', architecture: '' }, requestDevice: vi.fn(async () => device as never) })) } };
  const factory: SmokeFactory = async gpu => { const adapter = await gpu.requestAdapter(); await adapter!.requestDevice(); return renderer; };
  await act(async () => root.render(<WebGpuDiagnostics environment={environment} factory={factory} />));
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toContain(i18n.t('webgpuSmoke.codes.complete'));
  expect(host.textContent).toContain(i18n.t('webgpuSmoke.codes.shaderSuccess'));
  expect(host.textContent).toContain(i18n.t('webgpuSmoke.emptyInfo'));
  expect(host.textContent).toContain('<img src=x>'); expect(host.querySelector('img')).toBeNull();
  expect(host.textContent).not.toContain('webgpuSmoke.');
  expect(renderer.render).toHaveBeenCalledTimes(SMOKE_CASES.length);
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
