// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetEditStatuses } from './editStatus';
import { useEditStatuses, useEditStatusesSnapshot } from './useEditStatuses';

const api = vi.hoisted(() => ({ statuses: vi.fn() }));
vi.mock('./editStateApi', () => ({ getAssetEditStatuses: api.statuses }));
let host: HTMLDivElement;
let root: Root;
function Harness({ ids }: { ids: string[] }) {
  const statuses = useEditStatuses(ids);
  return <output>{ids.map(id => statuses[id] === undefined ? 'unknown' : statuses[id] ? 'edited' : 'clean').join(',')}</output>;
}
function StateHarness({ ids }: { ids: string[] }) {
  const snapshot = useEditStatusesSnapshot(ids);
  return <output>{snapshot.state}</output>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function render(ids: string[]) {
  await act(async () => root.render(<Harness ids={ids} />));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.statuses.mockReset();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('useEditStatuses batches', () => {
  it('distinguishes pending, partial and failed edit snapshots', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `id-${index}`);
    api.statuses.mockImplementationOnce(async (batch: string[]) => Object.fromEntries(batch.map(id => [id, true])))
      .mockRejectedValueOnce(new Error('Unavailable'));
    await act(async () => root.render(<StateHarness ids={ids} />));
    expect(host.querySelector('output')!.textContent).toBe('partial');
    act(() => root.unmount());
    root = createRoot(host);
    api.statuses.mockRejectedValue(new Error('Unavailable'));
    await act(async () => root.render(<StateHarness ids={['failed']} />));
    expect(host.querySelector('output')!.textContent).toBe('error');
  });
  it('uses one request for 100 assets', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `id-${index}`);
    api.statuses.mockImplementation(async (batch: string[]) => Object.fromEntries(batch.map(id => [id, true])));
    await render(ids);
    expect(api.statuses.mock.calls.map(([batch]) => batch.length)).toEqual([100]);
    expect(host.querySelector('output')!.textContent!.split(',')).toEqual(Array(100).fill('edited'));
  });

  it('splits 150 assets into 100 and 50 and merges both results', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `id-${index}`);
    api.statuses.mockImplementation(async (batch: string[]) => Object.fromEntries(batch.map(id => [id, true])));
    await render(ids);
    expect(api.statuses.mock.calls.map(([batch]) => batch.length)).toEqual([100, 50]);
    expect(host.querySelector('output')!.textContent!.split(',')).toEqual(Array(150).fill('edited'));
  });

  it('splits 500 assets into five requests of 100', async () => {
    const ids = Array.from({ length: 500 }, (_, index) => `id-${index}`);
    api.statuses.mockImplementation(async (batch: string[]) => Object.fromEntries(batch.map(id => [id, true])));
    await render(ids);
    expect(api.statuses.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 100, 100, 100]);
    expect(host.querySelector('output')!.textContent!.split(',')).toEqual(Array(500).fill('edited'));
  });

  it('keeps successful batches while failed batch IDs remain unknown', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `id-${index}`);
    api.statuses.mockImplementationOnce(async (batch: string[]) => Object.fromEntries(batch.map(id => [id, true])))
      .mockRejectedValueOnce(new Error('Unavailable'));
    await render(ids);
    const states = host.querySelector('output')!.textContent!.split(',');
    expect(states.slice(0, 100)).toEqual(Array(100).fill('edited'));
    expect(states.slice(100)).toEqual(Array(50).fill('unknown'));
  });

  it('shares cancellation across all batches and ignores results from an old asset list', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `old-${index}`);
    const pending = [deferred<AssetEditStatuses>(), deferred<AssetEditStatuses>()];
    api.statuses.mockReturnValueOnce(pending[0].promise).mockReturnValueOnce(pending[1].promise)
      .mockImplementation(async (batch: string[]) => Object.fromEntries(batch.map(id => [id, false])));
    await render(ids);
    const signals = api.statuses.mock.calls.map(([, signal]) => signal as AbortSignal);
    expect(api.statuses.mock.calls.map(([batch]) => batch.length)).toEqual([100, 50]);
    expect(signals[0]).toBe(signals[1]);

    const newIds = ['new-1', 'new-2'];
    await render(newIds);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    await act(async () => {
      pending[0].resolve(Object.fromEntries(ids.slice(0, 100).map(id => [id, true])));
      pending[1].resolve(Object.fromEntries(ids.slice(100).map(id => [id, true])));
    });
    expect(host.querySelector('output')!.textContent).toBe('clean,clean');
  });

  it('aborts every pending batch on unmount', async () => {
    const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);
    api.statuses.mockImplementation(() => new Promise(() => {}));
    await render(ids);
    const signals = api.statuses.mock.calls.map(([, signal]) => signal as AbortSignal);
    expect(signals).toHaveLength(3);
    act(() => root.unmount());
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });
});
