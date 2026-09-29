// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceGpu } from './useWorkspaceGpu';
import { WebGpuControl } from './WebGpuControl';
import { WebGpuAdjustmentRenderer } from './webgpuAdjustmentRenderer';
import { WEBGPU_STORAGE_KEY } from './webgpuSettings';
import { deferred } from './webgpuTestDevice.testSupport';
import './i18n';

vi.mock('./webgpuAdjustmentRenderer', () => ({ WebGpuAdjustmentRenderer: { create: vi.fn() } }));

let host: HTMLDivElement, root: Root;
let state: ReturnType<typeof useWorkspaceGpu>;
function Harness({ source = 'photo:preview' }: { source?: string }) {
  state = useWorkspaceGpu(source);
  return <WebGpuControl {...state} onChange={state.setPreference} />;
}
function fakeRenderer() {
  let lost: ((error: Error) => void) | undefined;
  const renderer = { available: true, setSource: vi.fn(), render: vi.fn(),
    dispose: vi.fn(() => { renderer.available = false; }),
    onDeviceLost: vi.fn((listener: (error: Error) => void) => { lost = listener; return () => { lost = undefined; }; }),
  };
  return { renderer, lose: () => { renderer.available = false; lost?.(new Error('Device lost')); },
    value: renderer as unknown as WebGpuAdjustmentRenderer };
}
async function mount(source = 'photo:preview') { await act(async () => root.render(<Harness source={source} />)); }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { gpu: {} });
  localStorage.clear();
  vi.mocked(WebGpuAdjustmentRenderer.create).mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('workspace WebGPU ownership and UI with mocked initialization', () => {
  it('distinguishes checking, available, and an accepted GPU paint', async () => {
    const pending = deferred<WebGpuAdjustmentRenderer | null>(), gpu = fakeRenderer();
    vi.mocked(WebGpuAdjustmentRenderer.create).mockReturnValueOnce(pending.promise);
    await mount();
    expect(state.availability).toBe('checking');
    expect(host.querySelector('button')!.disabled).toBe(true);
    await act(async () => pending.resolve(gpu.value));
    expect(state.enabled).toBe(true);
    expect(state.renderer).toBe(gpu.renderer);
    expect(state.active).toBe(false);
    act(() => state.reportBackend('gpu'));
    expect(state.active).toBe(true);
    expect(host.querySelector('button')!.disabled).toBe(false);
    expect(host.querySelector('[role="status"]')!.textContent).toBe('GPU active');
  });
  it('reads OFF, releases its full initialization probe, and persists a switch to ON', async () => {
    localStorage.setItem(WEBGPU_STORAGE_KEY, 'false');
    const probe = fakeRenderer(), live = fakeRenderer();
    vi.mocked(WebGpuAdjustmentRenderer.create).mockResolvedValueOnce(probe.value).mockResolvedValueOnce(live.value);
    await mount();
    expect(state.enabled).toBe(false); expect(state.renderer).toBeNull();
    expect(state.availability).toBe('available'); expect(probe.renderer.dispose).toHaveBeenCalledOnce();
    await act(async () => host.querySelector('button')!.click());
    expect(localStorage.getItem(WEBGPU_STORAGE_KEY)).toBe('true');
    expect(state.renderer).toBe(live.renderer);
    expect(state.active).toBe(false);
  });
  it.each(['insecure', 'missing GPU', 'initialization failure'])('uses CPU with a saved ON preference when %s', async reason => {
    localStorage.setItem(WEBGPU_STORAGE_KEY, 'true');
    if (reason === 'insecure') vi.stubGlobal('isSecureContext', false);
    if (reason === 'missing GPU') vi.stubGlobal('navigator', {});
    vi.mocked(WebGpuAdjustmentRenderer.create).mockResolvedValue(null);
    await mount();
    expect(state.availability).toBe('unavailable'); expect(state.renderer).toBeNull(); expect(state.active).toBe(false);
    expect(state.enabled).toBe(true); expect(host.querySelector('button')!.disabled).toBe(true);
    if (reason !== 'initialization failure') expect(WebGpuAdjustmentRenderer.create).not.toHaveBeenCalled();
    expect(localStorage.getItem(WEBGPU_STORAGE_KEY)).toBe('true');
  });
  it.each(['render failure', 'idle device loss'])('releases the failed renderer after %s without changing preference', async reason => {
    const gpu = fakeRenderer(); vi.mocked(WebGpuAdjustmentRenderer.create).mockResolvedValue(gpu.value);
    await mount(); act(() => state.reportBackend('gpu'));
    act(() => { if (reason === 'render failure') state.fail(gpu.renderer); else gpu.lose(); });
    expect(state.availability).toBe('error'); expect(state.active).toBe(false); expect(state.renderer).toBeNull();
    expect(state.enabled).toBe(true); expect(gpu.renderer.dispose).toHaveBeenCalled();
    expect(host.querySelector('[role="status"]')!.textContent).toBe('GPU error · CPU');
  });
  it('releases each retired source and ignores callbacks from previous photos or routes', async () => {
    const first = fakeRenderer(), original = fakeRenderer(), second = fakeRenderer();
    vi.mocked(WebGpuAdjustmentRenderer.create).mockResolvedValueOnce(first.value).mockResolvedValueOnce(original.value).mockResolvedValueOnce(second.value);
    await mount(); const stale = state;
    await mount('photo:original');
    expect(first.renderer.dispose).toHaveBeenCalled(); expect(state.active).toBe(false);
    await mount('next:preview');
    expect(original.renderer.dispose).toHaveBeenCalled();
    act(() => { stale.reportBackend('gpu'); stale.fail(first.renderer); });
    expect(state.renderer).toBe(second.renderer); expect(state.active).toBe(false);
    act(() => root.unmount()); root = createRoot(host);
    expect(second.renderer.dispose).toHaveBeenCalled();
  });
  it('aborts initialization and disposes a late device after unmount', async () => {
    const pending = deferred<WebGpuAdjustmentRenderer | null>(), gpu = fakeRenderer();
    vi.mocked(WebGpuAdjustmentRenderer.create).mockReturnValueOnce(pending.promise);
    await mount();
    const signal = vi.mocked(WebGpuAdjustmentRenderer.create).mock.calls[0][2]!;
    act(() => root.unmount()); root = createRoot(host);
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(gpu.value));
    expect(gpu.renderer.dispose).toHaveBeenCalledOnce();
  });
  it('keeps only the current initialization under StrictMode effect replay', async () => {
    const first = fakeRenderer(), second = fakeRenderer();
    vi.mocked(WebGpuAdjustmentRenderer.create).mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value);
    await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
    expect(first.renderer.dispose).toHaveBeenCalledOnce();
    expect(state.renderer).toBe(second.renderer); expect(second.renderer.dispose).not.toHaveBeenCalled();
  });
  it('continues changing routes if localStorage cannot save the preference', async () => {
    const gpu = fakeRenderer(), probe = fakeRenderer();
    vi.mocked(WebGpuAdjustmentRenderer.create).mockResolvedValueOnce(gpu.value).mockResolvedValueOnce(probe.value);
    await mount();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    await act(async () => state.setPreference(false));
    expect(state.enabled).toBe(false); expect(state.renderer).toBeNull();
    expect(gpu.renderer.dispose).toHaveBeenCalled();
  });
});
