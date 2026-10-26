// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RawViewerBenchmark, rawViewerDependencies } from './RawViewerBenchmarkPanel';
import { rawViewerPlan, type RawViewerReport } from './rawViewerBenchmark';
import { RawDiagnosticError } from './rawDiagnostics';
import { viewerMetadata } from './test/rawViewerBenchmark';
import i18n from './i18n';

let root: Root, host: HTMLDivElement;
const deferred = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), get resolve() { return resolve; } }; };
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); await i18n.changeLanguage('en');
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 16; naturalHeight = 12; decode = async () => {}; removeAttribute() {} });
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => `blob:${Math.random()}`), revokeObjectURL: vi.fn() });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); await act(async () => {}); host.remove(); vi.unstubAllGlobals(); });
function dependencies(): typeof rawViewerDependencies {
  return { start: vi.fn(async () => ({ runId: 'a'.repeat(32), plan: rawViewerPlan(3).filter(t => t.operation === 'open') })),
    prepare: vi.fn(async () => {}), render: vi.fn(async (_owner, trial) => ({ metadata: viewerMetadata(trial), blob: new Blob(['image']),
      started: performance.now(), responseWaitMs: 1, transferMs: 1 })), stop: vi.fn(async () => true),
    closed: vi.fn(async () => true), leave: vi.fn() };
}
async function enterAsset() {
  await act(async () => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '11111111-1111-4111-8111-111111111111');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const startButton = () => [...host.querySelectorAll('button')].find(b => b.textContent === i18n.t('rawViewerBenchmark.start'))!;
it('runs only explicitly, publishes actual layout adoption and excludes warm-up from the summary', async () => {
  const deps = dependencies(), reports: RawViewerReport[] = [];
  await act(async () => root.render(<RawViewerBenchmark active dependencies={deps} onReport={r => { reports.push(r); }} />));
  expect(deps.start).not.toHaveBeenCalled(); await enterAsset();
  await act(async () => startButton().click());
  expect(deps.render).toHaveBeenCalledTimes(4); expect(deps.stop).toHaveBeenCalledOnce();
  expect(reports.at(-1)?.status).toBe('complete');
  expect(reports.at(-1)?.statistics[0].adoptMs.count).toBe(3);
  expect(JSON.stringify(reports)).not.toContain('11111111-1111');
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(4);
});
it('collects a transmitted request after Stop without publishing its late decode or adoption', async () => {
  const deps = dependencies(), gate = deferred<Awaited<ReturnType<typeof deps.render>>>();
  vi.mocked(deps.render).mockReturnValue(gate.promise);
  await act(async () => root.render(<RawViewerBenchmark active dependencies={deps} />)); await enterAsset();
  await act(async () => startButton().click());
  const call = vi.mocked(deps.render).mock.calls[0];
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === i18n.t('rawDiagnostics.stop'))!.click());
  expect(call[2].aborted).toBe(false);
  await act(async () => gate.resolve({ metadata: viewerMetadata(call[1]), blob: new Blob(['image']),
    started: performance.now(), responseWaitMs: 1, transferMs: 1 }));
  expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(startButton().disabled).toBe(false);
});
it('composes Region over the Whole base, pans the Native view and returns through Before/After', async () => {
  const deps = dependencies();
  vi.mocked(deps.start).mockResolvedValue({ runId: 'a'.repeat(32), plan: rawViewerPlan(3).filter(t => t.repeat === 1) });
  vi.mocked(deps.render).mockImplementation(async (_owner, trial) => {
    const metadata = viewerMetadata(trial);
    if (['regionFull', 'pan'].includes(trial.operation)) metadata.region = {
      fullWidth: 4000, fullHeight: 3000, limited: false, window: { x: trial.operation === 'pan' ? 2700 : 1992, y: 1494, w: 16, h: 12 } };
    return { metadata, blob: new Blob(['image']), started: performance.now(), responseWaitMs: 1, transferMs: 1 };
  });
  const seen: string[] = [];
  vi.mocked(deps.prepare).mockImplementation(async (_owner, trial) => {
    if (['pan', 'before'].includes((trial as { operation?: string }).operation ?? '') && host.querySelector('.raw-region-overlay'))
      seen.push(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform);
  });
  await act(async () => root.render(<RawViewerBenchmark active dependencies={deps} />));
  await enterAsset(); await act(async () => startButton().click());
  expect(deps.render).toHaveBeenCalledTimes(10); expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(new Set(seen).size).toBeGreaterThan(1);
  expect(host.textContent).toContain(i18n.t('rawDiagnostics.phases.complete'));
});
it('stops on departure and retains a failed cleanup owner until explicit retry', async () => {
  const deps = dependencies(); vi.mocked(deps.stop).mockRejectedValue(new Error('PRIVATE'));
  await act(async () => root.render(<RawViewerBenchmark active dependencies={deps} />)); await enterAsset();
  await act(async () => startButton().click());
  expect(startButton().disabled).toBe(true); expect(host.textContent).not.toContain('PRIVATE');
  vi.mocked(deps.stop).mockResolvedValue(true);
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === i18n.t('rawDiagnostics.retryCleanup'))!.click());
  expect(startButton().disabled).toBe(false);
});
it('exports the failing operation without fabricated measurements or raw exception text', async () => {
  const deps = dependencies(), reports: RawViewerReport[] = [];
  vi.mocked(deps.start).mockResolvedValue({ runId: 'a'.repeat(32), plan: rawViewerPlan(3) });
  vi.mocked(deps.render).mockRejectedValue(new RawDiagnosticError('raw_region_unsupported'));
  await act(async () => root.render(<RawViewerBenchmark active dependencies={deps} onReport={r => { reports.push(r); }} />));
  await enterAsset(); await act(async () => startButton().click());
  expect(reports.at(-1)?.status).toBe('failed');
  expect(reports.at(-1)?.failure).toEqual({ operation: 'open', repeat: 0, code: 'raw_region_unsupported' });
  expect(reports.at(-1)?.trials).toEqual([]); expect(deps.stop).toHaveBeenCalledOnce();
});
