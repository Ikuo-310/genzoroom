// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useExportManagement, type ExportManagementQueue, type ExportManagementState } from './useExportManagement';
import type { ExportQueueItem } from './exportQueueApi';
const api = vi.hoisted(() => ({ detail: vi.fn(), stacks: vi.fn() }));
vi.mock('./api', () => ({ fetchAssetDetail: api.detail, refreshSelectedImmichStacks: api.stacks }));
vi.mock('./frontendLogging', () => ({ frontendLogger: { add: vi.fn() } }));
const item = (assetId: string, status: ExportQueueItem['status'] = 'queued'): ExportQueueItem => ({ assetId, status, queuedAt: '', updatedAt: '' });
let current: ExportManagementState, root: Root, host: HTMLDivElement;
let queue: ExportManagementQueue;
function Probe({ active }: { active: boolean }) { current = useExportManagement(queue, active); return null; }
async function render(items = queue.items, active = true) {
  queue = { ...queue, items };
  await act(async () => root.render(<Probe active={active} />));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.detail.mockReset().mockImplementation(async (id: string) => ({ id, filename: id, date: '', thumbnail_url: '', format: 'JPEG', is_raw: false, preview_url: '', exif: {} }));
  api.stacks.mockReset().mockResolvedValue([]);
  queue = { items: [], loaded: true, loading: false, error: null, dequeue: vi.fn(), refresh: vi.fn(), mutationFor: () => ({ operation: null }) };
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
it('preserves selection and armed across status-only refresh and tab changes, but prunes deleted IDs and range anchors', async () => {
  await render([item('A'), item('b')]);
  await act(async () => { current.selectOnly('A'); });
  await act(async () => current.toggleArmed());
  expect([...current.armedIds]).toEqual(['a']);
  await render([item('a', 'failed'), item('b')]);
  expect(current.selectedIds).toEqual(['a']); expect([...current.armedIds]).toEqual(['a']);
  expect(api.detail).toHaveBeenCalledTimes(2); expect(api.stacks).toHaveBeenCalledTimes(1);
  await render([item('a'), item('b')]); expect([...current.armedIds]).toEqual(['a']);
  await render(queue.items, false); await render(queue.items, true);
  expect([...current.armedIds]).toEqual(['a']);
  await render([item('b')]); expect(current.selectedIds).toEqual([]); expect([...current.armedIds]).toEqual([]);
  await act(async () => current.extendRange('b')); expect(current.selectedIds).toEqual([]);
});
it.each(['waiting', 'encoding', 'registering'] as const)('prunes armed/selection and rejects manual actions when status becomes %s', async status => {
  await render([item('a')]); await act(async () => current.selectOnly('a')); await act(async () => current.toggleArmed());
  await render([item('a', status)]);
  expect(current.selectedIds).toEqual([]); expect([...current.armedIds]).toEqual([]);
  await act(async () => { current.selectOnly('a'); current.toggleSelection('a'); current.extendRange('a'); });
  expect(current.selectAll()).toBe(false); expect(current.toggleArmed()).toBe(false); expect(current.removeSelected()).toBe(false);
  expect(current.selectedIds).toEqual([]); expect(queue.dequeue).not.toHaveBeenCalled();
});
it('uses canonical visual order for ranges without changing Queue order', async () => {
  const original = [item('a'), item('b'), item('c')];
  api.stacks.mockResolvedValue([{ id: 'stack-x', primaryAssetId: 'a', assets: ['a', 'c', 'outside'].map(id => ({ id })) }]);
  await render(original); await act(async () => current.selectOnly('a')); await act(async () => current.extendRange('b'));
  expect(current.selectedIds).toEqual(['a', 'c', 'b']); expect(queue.items).toEqual(original);
});
it('snapshots removal targets and stops issuing further DELETEs after Home unmount', async () => {
  let finish!: () => void;
  queue.dequeue = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  await render([item('a'), item('b')]); await act(async () => current.selectAll()); await act(async () => current.removeSelected());
  expect(queue.dequeue).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount()); await act(async () => finish()); expect(queue.dequeue).toHaveBeenCalledTimes(1);
  root = createRoot(host);
});
it('starts a new Home mount with no selection or armed IDs', async () => {
  await render([item('a')]); await act(async () => current.selectOnly('a')); await act(async () => current.toggleArmed());
  await act(async () => root.unmount()); root = createRoot(host); await render([item('a')]);
  expect(current.selectedIds).toEqual([]); expect([...current.armedIds]).toEqual([]);
});
