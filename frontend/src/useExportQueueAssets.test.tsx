// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { AssetDetail } from './assets';
import type { ExportQueueItem } from './exportQueueApi';
import { useExportQueueAssets } from './useExportQueueAssets';
const fetchDetail = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ fetchAssetDetail: fetchDetail }));
vi.mock('./frontendLogging', () => ({ frontendLogger: { add: vi.fn() } }));
const item = (assetId: string): ExportQueueItem => ({ assetId, status: 'queued', queuedAt: '', updatedAt: '' });
const detail = (id: string): AssetDetail => ({ id, filename: id, date: '', thumbnail_url: '', format: 'JPEG',
  is_raw: false, preview_url: '', exif: {}, stackId: 'stack', primaryAssetId: 'primary', stackAssetCount: 9 });
let root: Root, host: HTMLDivElement;
let snapshot: ReturnType<typeof useExportQueueAssets>;
let pending: { id: string; signal: AbortSignal; resolve: (value: AssetDetail) => void; reject: () => void }[];
function Probe({ items, loaded }: { items: ExportQueueItem[]; loaded: boolean }) { snapshot = useExportQueueAssets(items, loaded); return null; }
async function render(ids: string[], loaded = true, status: ExportQueueItem['status'] = 'queued') {
  await act(async () => root.render(<Probe items={ids.map(id => ({ ...item(id), status }))} loaded={loaded} />));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); pending = [];
  fetchDetail.mockReset().mockImplementation((id: string, signal: AbortSignal) => new Promise<AssetDetail>((resolve, reject) => {
    pending.push({ id, signal, resolve, reject: () => reject(new Error('failed')) });
  }));
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
it('never fetches for unloaded/empty Queue and deduplicates IDs', async () => {
  await render(['a'], false); expect(fetchDetail).not.toHaveBeenCalled();
  await render([]); expect(fetchDetail).not.toHaveBeenCalled();
  await render(['A', 'a']); expect(pending.map(p => p.id)).toEqual(['a']);
});
it('limits concurrency to four and restores Queue order after out-of-order responses', async () => {
  await render(['a', 'b', 'c', 'd', 'e', 'f']); expect(pending).toHaveLength(4);
  await act(async () => pending[2].resolve(detail('c'))); expect(pending).toHaveLength(5);
  await act(async () => pending[0].resolve(detail('a'))); expect(pending).toHaveLength(6);
  await act(async () => pending.forEach(p => p.resolve(detail(p.id))));
  expect(snapshot.status).toBe('ready'); expect(snapshot.assets.map(a => a.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  expect(snapshot.assets[0].stackAssetCount).toBe(9); expect(snapshot.assets[0]).not.toHaveProperty('exif');
  await render(['a', 'b', 'c', 'd', 'e', 'f'], true, 'failed');
  expect(fetchDetail).toHaveBeenCalledTimes(6); expect(snapshot.status).toBe('ready');
});
it.each([{ ids: ['b', 'a'] }, { ids: ['c'] }])('aborts changed order/membership and rejects late results for $ids', async ({ ids }) => {
  await render(['a', 'b']); const old = [...pending];
  await render(ids); expect(old.every(p => p.signal.aborted)).toBe(true);
  await act(async () => old.forEach(p => p.resolve(detail(p.id)))); expect(snapshot.status).toBe('loading');
  await act(async () => pending.slice(2).forEach(p => p.resolve(detail(p.id))));
  expect(snapshot.assets.map(a => a.id)).toEqual(ids);
});
it('aborts unmount and does not start remaining workers', async () => {
  await render(['a', 'b', 'c', 'd', 'e']); const requests = [...pending];
  await act(async () => root.unmount());
  expect(requests.every(p => p.signal.aborted)).toBe(true);
  await act(async () => requests.forEach(p => p.resolve(detail(p.id)))); expect(fetchDetail).toHaveBeenCalledTimes(4);
  root = createRoot(host);
});
it.each(['failure', 'mismatch'])('shows explicit metadata error for %s without silently dropping items', async kind => {
  await render(['a', 'b']);
  await act(async () => { if (kind === 'failure') pending[0].reject(); else pending[0].resolve(detail('wrong'));
    pending[1].resolve(detail('b')); });
  expect(snapshot.status).toBe('error'); expect(snapshot.assets).toEqual([]);
});
