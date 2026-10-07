// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportEngineDiagnostics, type ExportEngineDependencies } from './ExportEngineDiagnostics';
import { ExportEngineDiagnosticError } from './exportEngineApi';
import type { BackendDecodedImage } from './exportEngineApi';
import { defaultRecipe } from './editing';
import { createEditStateSnapshot } from './editState';
import { EditStateApiError } from './editStateApi';
import type { RecentAsset } from './assets';
import i18n from './i18n';
import { frontendLogger } from './frontendLogging';
import { createDiagnosticsReport, collectDiagnosticsEnvironment, createWebGpuReport } from './developerDiagnostics';

let host: HTMLDivElement, root: Root, originalLanguage: string;
const asset = (id: string): RecentAsset => ({ id, filename: `PRIVATE_${id}.JPG`, date: 'PRIVATE_DATE',
  thumbnail_url: `/private/${id}`, format: 'JPEG', is_raw: false });
const image = () => ({ width: 2, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]) }) as ImageData;
const metadata = { sourceWidth: 2, sourceHeight: 1, outputWidth: 2, outputHeight: 1, sourceIcc: 'embedded' as const,
  outputColorSpace: 'sRGB' as const, recipeVersion: 18 as const, outputBytes: 4, decodeMs: 1, renderMs: 2, encodeMs: 3,
  totalMs: 6, quality: 95 as const, subsampling: '4:4:4' as const };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function setup() {
  const current = defaultRecipe(); current.adjustments.exposure = 0.5;
  const snapshot = createEditStateSnapshot({ recipe: current, history: [], cursor: 0, pending: null },
    { provider: 'immich', assetId: 'first', inputKind: 'immich-preview' });
  if (!snapshot.ok) throw new Error('Invalid test snapshot');
  const state = snapshot.value;
  const saved = { state, revision: 3, updatedAt: '2026-10-07T00:00:00Z', lastSaveId: 'private-save' };
  const dependencies: ExportEngineDependencies = {
    recent: vi.fn(async () => [asset('first'), { ...asset('raw'), is_raw: true }, { ...asset('png'), format: 'PNG' },
      ...Array.from({ length: 12 }, (_, index) => asset(String(index)))]),
    saved: vi.fn(async () => saved), decode: vi.fn(async () => image()),
    render: vi.fn(source => source.slice()), backend: vi.fn(async () => ({ blob: new Blob(['jpeg']), metadata })),
  };
  return { dependencies, saved };
}
const click = async (button: HTMLElement) => { await act(async () => button.click()); };
const choose = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === i18n.t('jpegDiagnostics.choose'))!;
const run = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === i18n.t('exportEngine.run'))!;
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); };
const select = async () => { await click(choose()); await click(host.querySelector<HTMLButtonElement>('.developer-jpeg-candidates button')!); };
const decodeRun = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === i18n.t('decodeCompare.run'))!;
const decodeCancel = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === i18n.t('decodeCompare.cancel'))!;
const decoded = (): BackendDecodedImage => ({ pixels: new Uint8Array([1,2,3,4,5,6]), metadata: {
  width: 2, height: 1, sourceWidth: 2, sourceHeight: 1, pixelFormat: 'rgb8', sourceIcc: 'absent', orientationNormalized: true, backendDecodeMs: 1,
} });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); originalLanguage = i18n.language;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  let counter = 0;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:diagnostic-${++counter}`) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['original']) })));
});
afterEach(async () => {
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL');
  await i18n.changeLanguage(originalLanguage); frontendLogger.setLevel('off'); frontendLogger.clear();
});

it.each(['en', 'ja'])('compares the saved snapshot, shows safe values, and cleans up on selection/rerun in %s', async language => {
  await i18n.changeLanguage(language); const { dependencies, saved } = setup();
  frontendLogger.setLevel('debug'); frontendLogger.clear();
  await act(async () => root.render(<StrictMode><ExportEngineDiagnostics dependencies={dependencies} /></StrictMode>));
  expect(dependencies.recent).not.toHaveBeenCalled(); expect(run().disabled).toBe(true);
  await select();
  expect(host.querySelectorAll('.developer-jpeg-candidates button')).toHaveLength(10);
  expect([...host.querySelectorAll('.developer-jpeg-candidates button')].some(button => /PRIVATE_(raw|png)/.test(button.textContent!))).toBe(false);
  await click(run()); await settle();
  expect(dependencies.saved).toHaveBeenCalledExactlyOnceWith('first', expect.any(AbortSignal), { requireRecipeVersion: 18 });
  expect(dependencies.render).toHaveBeenCalledWith(image().data, saved.state.currentRecipe);
  expect(dependencies.backend).toHaveBeenCalledExactlyOnceWith('first', 3, expect.any(AbortSignal));
  expect(host.querySelector('.developer-export-comparison img')?.getAttribute('src')).toBe('blob:diagnostic-2');
  expect(host.querySelector('canvas')?.width).toBe(2);
  expect(host.querySelector('canvas')?.classList.contains('developer-export-image')).toBe(true);
  expect(host.querySelector('.developer-export-comparison img')?.classList.contains('developer-export-image')).toBe(true);
  expect(host.textContent).toContain(i18n.t('exportEngine.status.completed'));
  expect(host.textContent).not.toContain('exportEngine.');
  const diagnostic = host.querySelector('.developer-diagnostics')!.textContent;
  expect(diagnostic).not.toContain('PRIVATE'); expect(diagnostic).toContain('95');
  const report = JSON.stringify(createDiagnosticsReport(collectDiagnosticsEnvironment(), createWebGpuReport(false, null)));
  expect(report).not.toContain('PRIVATE'); expect(report).not.toContain('private-save');
  expect(frontendLogger.getEntries()).toEqual([]);
  await click(run()); await settle();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:diagnostic-2');
  await click(host.querySelectorAll<HTMLButtonElement>('.developer-jpeg-candidates button')[1]);
  expect(host.querySelector('.developer-export-comparison img')).toBeNull();
  expect(host.querySelector('canvas')?.width).toBe(0);
  expect(host.textContent).toContain(i18n.t('exportEngine.status.idle'));
});

it('guards concurrent run and asset selection and detaches Recipe before later saved edits', async () => {
  const { dependencies, saved } = setup(); const waiting = deferred<ImageData>();
  dependencies.decode = vi.fn(() => waiting.promise);
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} />)); await select();
  await click(run()); await click(run());
  expect(run().disabled).toBe(true); expect(choose().disabled).toBe(true);
  expect([...host.querySelectorAll<HTMLButtonElement>('.developer-jpeg-candidates button')].every(button => button.disabled)).toBe(true);
  const snapshot = structuredClone(saved.state.currentRecipe);
  saved.state.currentRecipe.adjustments.exposure = 4;
  await act(async () => waiting.resolve(image())); await settle();
  expect(dependencies.saved).toHaveBeenCalledTimes(1); expect(dependencies.backend).toHaveBeenCalledTimes(1);
  expect(dependencies.render).toHaveBeenCalledWith(image().data, snapshot);
});

it.each(['unmount', 'pagehide'] as const)('aborts pending backend on %s, drops late Blob, and clears canvas', async departure => {
  const { dependencies } = setup(); const waiting = deferred<Awaited<ReturnType<ExportEngineDependencies['backend']>>>();
  dependencies.backend = vi.fn(() => waiting.promise);
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} />)); await select(); await click(run()); await settle();
  const backing = host.querySelector('canvas')!;
  const signal = vi.mocked(dependencies.backend).mock.calls[0][2];
  if (departure === 'unmount') { act(() => root.unmount()); root = createRoot(host); }
  else act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  expect(signal.aborted).toBe(true); expect(backing.width).toBe(0); expect(backing.height).toBe(0);
  await act(async () => waiting.resolve({ blob: new Blob(['jpeg']), metadata }));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(host.querySelector('.developer-export-comparison img')).toBeNull();
});

it('releases displayed backend Blob URL on pagehide and resets on BFCache restoration', async () => {
  const { dependencies } = setup();
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} />)); await select(); await click(run()); await settle();
  act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:diagnostic-2');
  expect(host.querySelector('canvas')?.width).toBe(0);
  act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  expect(host.textContent).toContain(i18n.t('exportEngine.status.idle')); expect(run().disabled).toBe(true);
});

it('rejects late candidate results after unmount', async () => {
  const { dependencies } = setup(); const waiting = deferred<RecentAsset[]>(); dependencies.recent = vi.fn(() => waiting.promise);
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} />)); await click(choose());
  const signal = vi.mocked(dependencies.recent).mock.calls[0][1]!;
  act(() => root.unmount()); root = createRoot(host);
  expect(signal.aborted).toBe(true); await act(async () => waiting.resolve([asset('late')]));
  expect(host.textContent).toBe('');
});

it('ignores the old asset decoder after BFCache restoration without revoking the new run URL', async () => {
  const { dependencies } = setup(); const old = deferred<ImageData>(), next = deferred<ImageData>();
  dependencies.decode = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} />)); await select(); await click(run());
  const oldSignal = vi.mocked(dependencies.decode).mock.calls[0][1];
  act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await click(choose()); await click(host.querySelectorAll<HTMLButtonElement>('.developer-jpeg-candidates button')[1]); await click(run());
  expect(oldSignal.aborted).toBe(true);
  expect(dependencies.decode).toHaveBeenCalledTimes(2);
  await act(async () => old.resolve(image()));
  expect(dependencies.render).not.toHaveBeenCalled(); expect(dependencies.backend).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:diagnostic-2');
  expect(run().disabled).toBe(true);
  await act(async () => next.resolve(image())); await settle();
  expect(dependencies.render).toHaveBeenCalledTimes(1);
  expect(dependencies.backend).toHaveBeenCalledExactlyOnceWith('0', 3, expect.any(AbortSignal));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:diagnostic-2');
});

it.each(['saved_recipe_unavailable', 'unsupported_recipe_version', 'saved_recipe_changed', 'invalid_icc', 'render_failed', 'encode_failed'] as const)('shows localized safe error %s', async code => {
  const { dependencies } = setup(); dependencies.backend = vi.fn(async () => { throw new ExportEngineDiagnosticError(code); });
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} />)); await select(); await click(run()); await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(i18n.t(`exportEngine.error.${code}`));
  expect(host.querySelector('canvas')?.width).toBe(0); expect(host.querySelector('.developer-export-comparison img')).toBeNull();
});

it.each(['missing', 'legacy', 'original', 'decode', 'render', 'candidate'] as const)('maps %s failure and does not expose exception text', async failure => {
  const { dependencies } = setup(); let expected = 'saved_recipe_unavailable';
  if (failure === 'missing') dependencies.saved = vi.fn(async () => ({ state: null }));
  if (failure === 'legacy') { dependencies.saved = vi.fn(async () => { throw new EditStateApiError('invalid_state', undefined, 'unsupported_recipe_version'); }); expected = 'unsupported_recipe_version'; }
  if (failure === 'original') { vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }))); expected = 'original_fetch_failed'; }
  if (failure === 'decode') { dependencies.decode = vi.fn(async () => { throw new Error('PRIVATE_EXCEPTION'); }); expected = 'decode_failed'; }
  if (failure === 'render') { dependencies.render = vi.fn(() => { throw new Error('PRIVATE_EXCEPTION'); }); expected = 'render_failed'; }
  if (failure === 'candidate') { dependencies.recent = vi.fn(async () => { throw new Error('PRIVATE_EXCEPTION'); }); expected = 'candidate_load_failed'; }
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} />));
  if (failure === 'candidate') await click(choose()); else { await select(); await click(run()); await settle(); }
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(i18n.t(`exportEngine.error.${expected}`));
  expect(host.textContent).not.toContain('PRIVATE_EXCEPTION'); expect(dependencies.backend).not.toHaveBeenCalled();
});

it.each(['en', 'ja'])('shares selected Asset for Decode Compare without saved Recipe or renderer, preserves full comparison in %s', async language => {
  await i18n.changeLanguage(language); const { dependencies } = setup(); const backend = vi.fn(async () => decoded());
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} decodeDependencies={{ backend }} />));
  expect(decodeRun().disabled).toBe(true); await select(); await click(decodeRun()); await settle();
  expect(backend).toHaveBeenCalledExactlyOnceWith('first', expect.any(AbortSignal));
  expect(dependencies.decode).toHaveBeenCalledWith({ kind: 'jpeg-original', url: 'blob:diagnostic-1' }, expect.any(AbortSignal));
  expect(dependencies.saved).not.toHaveBeenCalled(); expect(dependencies.render).not.toHaveBeenCalled(); expect(dependencies.backend).not.toHaveBeenCalled();
  expect(host.textContent).toContain(i18n.t('decodeCompare.status.completed'));
  expect(host.textContent).toContain(i18n.t('decodeCompare.statistics')); expect(host.textContent).not.toContain('decodeCompare.');
  await click(run()); await settle(); expect(host.querySelector('.developer-export-comparison img')).not.toBeNull();
  expect(host.textContent).toContain(i18n.t('decodeCompare.statistics'));
  await click(host.querySelectorAll<HTMLButtonElement>('.developer-jpeg-candidates button')[1]);
  expect(host.textContent).toContain(i18n.t('decodeCompare.status.not_run'));
  expect(host.textContent).not.toContain(i18n.t('decodeCompare.statistics'));
});

it('shows dimension mismatch and clears previous statistics on rerun', async () => {
  const { dependencies } = setup(); const result = decoded(); const backend = vi.fn(async () => result);
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} decodeDependencies={{ backend }} />));
  await select(); await click(decodeRun()); await settle();
  expect(host.textContent).toContain(i18n.t('decodeCompare.statistics'));
  result.metadata.width = 1;
  await click(decodeRun()); await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('decodeCompare.error.dimension_mismatch'));
  expect(host.textContent).not.toContain(i18n.t('decodeCompare.statistics'));
});

it('guards both run modes and cancels a pending backend without publishing late pixels', async () => {
  const { dependencies } = setup(); const pending = deferred<BackendDecodedImage>(), backend = vi.fn((_assetId: string, _signal: AbortSignal) => pending.promise);
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} decodeDependencies={{ backend }} />));
  await select(); await click(decodeRun()); await settle();
  expect(run().disabled).toBe(true); expect(decodeRun().disabled).toBe(true); expect(choose().disabled).toBe(true);
  await click(run()); expect(dependencies.saved).not.toHaveBeenCalled();
  await click(decodeCancel()); expect(backend.mock.calls[0][1].aborted).toBe(true);
  await act(async () => pending.resolve(decoded())); await settle();
  expect(host.textContent).toContain(i18n.t('decodeCompare.status.cancelled'));
  expect(host.textContent).not.toContain(i18n.t('decodeCompare.statistics'));
  expect(run().disabled).toBe(false);
});

it.each(['unmount', 'pagehide'] as const)('releases Decode Compare original and ignores late decode on %s', async departure => {
  const { dependencies } = setup(); const pending = deferred<ImageData>(); dependencies.decode = vi.fn(() => pending.promise);
  const backend = vi.fn(async () => decoded());
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} decodeDependencies={{ backend }} />));
  await select(); await click(decodeRun());
  const signal = vi.mocked(dependencies.decode).mock.calls[0][1];
  if (departure === 'unmount') { act(() => root.unmount()); root = createRoot(host); }
  else act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  expect(signal.aborted).toBe(true); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:diagnostic-1');
  await act(async () => pending.resolve(image())); await settle();
  expect(backend).not.toHaveBeenCalled(); expect(host.textContent).not.toContain(i18n.t('decodeCompare.statistics'));
});

it('suppresses old Decode Compare results after BFCache restore and new Asset selection', async () => {
  const { dependencies } = setup(); const pending = deferred<BackendDecodedImage>();
  const backend = vi.fn().mockImplementationOnce(() => pending.promise).mockImplementationOnce(async () => decoded());
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} decodeDependencies={{ backend }} />));
  await select(); await click(decodeRun()); await settle();
  act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await click(choose()); await click(host.querySelectorAll<HTMLButtonElement>('.developer-jpeg-candidates button')[1]);
  await click(decodeRun()); await settle();
  const bad = decoded(); bad.metadata.width = 1;
  await act(async () => pending.resolve(bad)); await settle();
  expect(host.textContent).toContain(i18n.t('decodeCompare.status.completed'));
  expect(host.querySelector('[role="alert"]')).toBeNull(); expect(backend.mock.calls[1][0]).toBe('0');
});

it('exports Decode Compare results from this tab without private selection data or image buffers', async () => {
  const { dependencies } = setup();
  await act(async () => root.render(<ExportEngineDiagnostics dependencies={dependencies} decodeDependencies={{ backend: async () => decoded() }} />));
  await select(); await click(decodeRun()); await settle();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toMatch(/^genzoroom-export-engine-diagnostics-\d{8}T\d{6}Z\.json$/);
    });
    await click([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === i18n.t('decodeCompare.exportJson'))!);
    expect(anchor).toHaveBeenCalledOnce();
    const blob = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob;
    const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
    const json = JSON.parse(text); expect(json.schemaVersion).toBe(1); expect(json.decodeComparison.status).toBe('completed');
    expect(json.decodeComparison.statistics.exactMatchPixelPercent).toBe(100);
    expect(text).not.toMatch(/PRIVATE|assetId|filename|recipe"|pixels"|blob:/);
    vi.runAllTimers();
  } finally { vi.useRealTimers(); }
});
