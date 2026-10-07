// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { useExportRuntime } from './useExportRuntime';
import type { ExportRuntimeState } from './exportQueueApi';
const api = vi.hoisted(() => ({ list: vi.fn(), stop: vi.fn(), start: vi.fn() }));
vi.mock('./exportQueueApi', async original => ({ ...await original<typeof import('./exportQueueApi')>(),
  listExportRuntime: api.list, stopExportRuntime: api.stop, startExportRuntime: api.start }));
const active: ExportRuntimeState = { runId: 'run', status: 'active', stopRequested: false, stopAllowed: true, currentAssetId: 'a' };
const idle: ExportRuntimeState = { runId: null, status: null, stopRequested: false, stopAllowed: false, currentAssetId: null };
let current: ReturnType<typeof useExportRuntime>, root: Root;
const refresh = vi.fn().mockResolvedValue(undefined);
function Probe() { current = useExportRuntime(refresh); return null; }
async function render() { await act(async () => root.render(<Probe />)); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.useFakeTimers();
  root = createRoot(document.createElement('div'));
  api.list.mockReset().mockResolvedValue(idle); api.stop.mockReset(); api.start.mockReset(); refresh.mockClear();
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('dispatches one Start, ignores stale idle polls and refreshes canonical Queue', async () => {
  await render();
  let finishPoll!: (value: ExportRuntimeState) => void;
  api.list.mockImplementation(() => new Promise(resolve => { finishPoll = resolve; }));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  let finishStart!: (value: ExportRuntimeState) => void;
  api.start.mockImplementation(() => new Promise(resolve => { finishStart = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = current.start(['b', 'a']); });
  expect(current.starting).toBe(true);
  await expect(current.start(['a'])).rejects.toMatchObject({ kind: 'locked' });
  await act(async () => { finishStart(active); await pending; finishPoll(idle); });
  expect(current.runtime).toEqual(active); expect(api.start).toHaveBeenCalledTimes(1);
  expect(api.start.mock.calls[0][0]).toEqual(['b', 'a']); expect(refresh).toHaveBeenCalledTimes(1);
});
it('requires a fresh poll after Start failure or a terminal Start acknowledgement', async () => {
  await render(); api.start.mockRejectedValue(new Error('private'));
  await act(async () => { await expect(current.start(['a'])).rejects.toThrow(); });
  expect(current.runtime).toBeNull();
  await expect(current.start(['a'])).rejects.toMatchObject({ kind: 'locked' });
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  api.start.mockResolvedValue({ ...active, status: 'completed', stopAllowed: false, currentAssetId: null });
  await act(async () => current.start(['a'])); expect(current.runtime).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(current.runtime).toEqual(idle);
});
it('does not authorize Cancel before an active runtime is recognized', async () => {
  await render(); expect(current.runtime).toEqual(idle);
  await expect(current.cancel()).rejects.toMatchObject({ kind: 'locked' });
  expect(api.stop).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
});
it('polls active status, persists Stop acknowledgement and refreshes Queue on completion', async () => {
  api.list.mockResolvedValue(active); await render(); expect(refresh).toHaveBeenCalledTimes(1);
  api.stop.mockResolvedValue({ ...active, stopRequested: true, stopAllowed: false });
  await act(async () => current.cancel());
  expect(current.runtime?.stopRequested).toBe(true);
  await expect(current.cancel()).rejects.toMatchObject({ kind: 'locked' });
  api.list.mockResolvedValue(idle);
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(current.runtime).toEqual(idle); expect(refresh).toHaveBeenCalledTimes(3);
});
it('rejects duplicate Cancel while the request is pending', async () => {
  api.list.mockResolvedValue(active); await render();
  let finish!: (state: ExportRuntimeState) => void;
  api.stop.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = current.cancel(); });
  expect(current.cancelling).toBe(true);
  await expect(current.cancel()).rejects.toMatchObject({ kind: 'locked' });
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(api.list).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ ...active, stopRequested: true, stopAllowed: false }); await pending; });
  expect(current.cancelling).toBe(false); expect(api.stop).toHaveBeenCalledTimes(1);
});
it('ignores a poll response that predates Stop commit', async () => {
  api.list.mockResolvedValue(active); await render();
  let finish!: (state: ExportRuntimeState) => void;
  api.list.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  api.stop.mockResolvedValue({ ...active, stopRequested: true, stopAllowed: false });
  await act(async () => current.cancel());
  await act(async () => finish(active));
  expect(current.runtime?.stopRequested).toBe(true); expect(current.runtime?.stopAllowed).toBe(false);
});
it('disables Cancel when runtime status cannot be verified and stops polling on unmount', async () => {
  api.list.mockResolvedValue(active); await render();
  api.list.mockRejectedValue(new Error('private upstream'));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(current.runtime).toBeNull();
  await expect(current.cancel()).rejects.toMatchObject({ kind: 'locked' });
  await act(async () => root.unmount());
  const calls = api.list.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4000); expect(api.list).toHaveBeenCalledTimes(calls);
});
