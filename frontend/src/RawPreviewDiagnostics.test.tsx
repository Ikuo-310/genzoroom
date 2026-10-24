// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RawPreviewDiagnostics, rawDiagnosticDependencies } from './RawPreviewDiagnostics';
import { rawTrialPlan, RawDiagnosticError } from './rawDiagnostics';
import { trialMetadata } from './test/rawDiagnostics';
import i18n from './i18n';

let root: Root, host: HTMLDivElement;
const revoke = vi.fn();
const deferred = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), get resolve() { return resolve; } }; };
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); await i18n.changeLanguage('en');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  revoke.mockClear();
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:diagnostic'), revokeObjectURL: revoke });
  vi.stubGlobal('Image', class { src = ''; naturalWidth = 16; naturalHeight = 12; decode = async () => {}; removeAttribute() {} });
});
afterEach(async () => { act(() => root.unmount()); await act(async () => {}); host.remove(); vi.unstubAllGlobals(); });
function dependencies(): typeof rawDiagnosticDependencies {
  return { start: vi.fn(async config => ({ runId: 'a'.repeat(32), plan: [rawTrialPlan(config)[0]] })),
    prepare: vi.fn(async () => {}), render: vi.fn(async (_owner, trial) => ({ metadata: trialMetadata(trial),
      blob: new Blob(['image']), responseWaitMs: 10, transferMs: 2, started: performance.now() - 12 })),
    stop: vi.fn(async () => true), closed: vi.fn(async () => true), leave: vi.fn() };
}
const button = (key: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === i18n.t(`rawDiagnostics.${key}`))!;
async function setAsset() {
  const input = host.querySelector<HTMLInputElement>('input:not([type])')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '11111111-1111-4111-8111-111111111111');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it.each(['en', 'ja'])('never starts on mount or tab activation and localizes controls in %s', async language => {
  await i18n.changeLanguage(language);
  const deps = dependencies();
  await act(async () => root.render(<RawPreviewDiagnostics active={false} dependencies={deps} />));
  await act(async () => root.render(<RawPreviewDiagnostics active dependencies={deps} />));
  expect(deps.start).not.toHaveBeenCalled(); expect(deps.prepare).not.toHaveBeenCalled();
  expect(host.textContent).toContain(i18n.t('rawDiagnostics.gpuNotes'));
  expect(host.textContent).not.toContain('rawDiagnostics.'); expect(button('start').disabled).toBe(true);
});
it('locks conditions during a run, measures/decode separately and releases the Blob URL and session', async () => {
  const deps = dependencies();
  await act(async () => root.render(<RawPreviewDiagnostics dependencies={deps} />));
  await setAsset(); await act(async () => button('start').click());
  expect(deps.start).toHaveBeenCalledOnce(); expect(deps.stop).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith('blob:diagnostic');
  expect(host.textContent).toContain('Success'); expect(host.textContent).toContain('Not collected');
  expect(host.textContent).toContain('10.00 ms'); expect(button('export').disabled).toBe(false);
});
it('Stop does not abort the sent request and rejects its late result for comparisons', async () => {
  const deps = dependencies(), gate = deferred<Awaited<ReturnType<typeof deps.render>>>();
  vi.mocked(deps.render).mockReturnValue(gate.promise);
  await act(async () => root.render(<RawPreviewDiagnostics dependencies={deps} />)); await setAsset();
  await act(async () => button('start').click());
  expect(button('start').disabled).toBe(true); expect(host.querySelector('fieldset')!.disabled).toBe(true);
  const call = vi.mocked(deps.render).mock.calls[0];
  await act(async () => button('stop').click());
  expect(call[2].aborted).toBe(false); expect(deps.stop).toHaveBeenCalled();
  await act(async () => gate.resolve({ metadata: trialMetadata(call[1]), blob: new Blob(['image']), responseWaitMs: 10, transferMs: 2, started: performance.now() }));
  expect(host.textContent).toContain('Stopped'); expect(host.textContent).toContain('Unverified');
  expect(button('start').disabled).toBe(false);
});
it('stops on tab departure and sends a keepalive stop on pagehide without publishing an old image', async () => {
  const deps = dependencies(), gate = deferred<Awaited<ReturnType<typeof deps.render>>>(); vi.mocked(deps.render).mockReturnValue(gate.promise);
  await act(async () => root.render(<RawPreviewDiagnostics dependencies={deps} />)); await setAsset();
  await act(async () => button('start').click());
  await act(async () => root.render(<RawPreviewDiagnostics active={false} dependencies={deps} />));
  expect(deps.stop).toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  expect(deps.leave).toHaveBeenCalledWith('a'.repeat(32));
  const trial = vi.mocked(deps.render).mock.calls[0][1];
  await act(async () => gate.resolve({ metadata: trialMetadata(trial), blob: new Blob(['old']), responseWaitMs: 10, transferMs: 2, started: performance.now() }));
  expect(revoke).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('Success');
});
it('reports unsupported execution without inventing zero-valued timings', async () => {
  const deps = dependencies(); vi.mocked(deps.prepare).mockRejectedValue(new RawDiagnosticError('raw_preview_unsupported'));
  await act(async () => root.render(<RawPreviewDiagnostics dependencies={deps} />)); await setAsset();
  await act(async () => button('start').click());
  expect(host.textContent).toContain('Unsupported'); expect(host.textContent).toContain('Not collected');
  expect(host.textContent).not.toContain('0.00 ms'); expect(deps.stop).toHaveBeenCalledOnce();
});
it('retains cleanup failure across tab changes and allows an explicit retry', async () => {
  const deps = dependencies(); vi.mocked(deps.stop).mockRejectedValue(new Error('offline'));
  await act(async () => root.render(<RawPreviewDiagnostics dependencies={deps} />)); await setAsset();
  await act(async () => button('start').click());
  expect(button('start').disabled).toBe(true); expect(button('retryCleanup')).toBeTruthy();
  await act(async () => root.render(<RawPreviewDiagnostics active={false} dependencies={deps} />));
  expect(button('retryCleanup')).toBeTruthy();
  vi.mocked(deps.stop).mockResolvedValue(true);
  await act(async () => button('retryCleanup').click());
  await act(async () => root.render(<RawPreviewDiagnostics dependencies={deps} />));
  expect(button('start').disabled).toBe(false);
});
it('rejects a response from a different configured backend', async () => {
  const deps = dependencies();
  vi.mocked(deps.render).mockImplementation(async (_owner, trial) => ({ metadata: {
    ...trialMetadata(trial), backend: { configured: 'gpu', execution: 'unconfirmed', gpuAvailable: true, fallbackReported: false } },
    blob: new Blob(['image']), responseWaitMs: 10, transferMs: 2, started: performance.now() }));
  await act(async () => root.render(<RawPreviewDiagnostics dependencies={deps} />)); await setAsset();
  await act(async () => button('start').click());
  expect(host.textContent).toContain('raw_invalid_response'); expect(revoke).not.toHaveBeenCalled();
});
