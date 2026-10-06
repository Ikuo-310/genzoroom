// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssetDetail, RecentAsset } from './assets';
import { useStackCandidateDetection } from './useStackCandidateDetection';
const fetchDetail = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ fetchAssetDetail: fetchDetail }));
const photos: RecentAsset[] = Array.from({ length: 9 }, (_, i) => ({ id: `${i}`, filename: i % 2 ? `IMG_${Math.floor(i / 2)}.jpg` : `IMG_${Math.floor(i / 2)}.dng`, date: '2026-10-01', format: i % 2 ? 'JPEG' : 'DNG', is_raw: i % 2 === 0, thumbnail_url: '/thumb' }));
let host: HTMLDivElement, root: Root, current: ReturnType<typeof useStackCandidateDetection>;
let pending: Array<{ id: string; signal: AbortSignal; resolve: (detail: AssetDetail) => void }>;
function Probe({ assets }: { assets: RecentAsset[] }) { current = useStackCandidateDetection(assets); return null; }
const detail = (id: string, model = 'Same'): AssetDetail => ({ ...photos.find(a => a.id === id)!, id, preview_url: '/preview', exif: { make: 'Camera', model, date_time_original: '2026:10:01 08:25:49', latitude: 35, longitude: 139 } });
async function render(assets: RecentAsset[], strict = false) { await act(async () => root.render(strict ? <StrictMode><Probe assets={assets} /></StrictMode> : <Probe assets={assets} />)); }
async function finish(batch: typeof pending, model?: string) { await act(async () => batch.forEach(p => p.resolve(detail(p.id, model)))); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); pending = [];
  fetchDetail.mockReset().mockImplementation((id: string, signal: AbortSignal) => new Promise<AssetDetail>(resolve => pending.push({ id, signal, resolve })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('limits in-flight detail requests to four and ignores duplicate redetect clicks', async () => {
  await render(photos); expect(fetchDetail).toHaveBeenCalledTimes(4); expect(current.loading).toBe(true);
  await act(async () => { current.redetect(); current.redetect(); }); expect(fetchDetail).toHaveBeenCalledTimes(4);
  await finish(pending.splice(0)); expect(fetchDetail).toHaveBeenCalledTimes(8); expect(pending).toHaveLength(4);
  await finish(pending.splice(0)); expect(fetchDetail).toHaveBeenCalledTimes(8);
  expect(current.loading).toBe(false); expect(current.groups).toHaveLength(4); expect(current.failureCount).toBe(0);
  await act(async () => current.redetect()); expect(fetchDetail).toHaveBeenCalledTimes(12);
});
it('aborts previous generations and prevents late results from overwriting fresh evidence', async () => {
  const first = photos.slice(0, 2); await render(first); const old = pending.splice(0);
  await render([...first]); expect(old.every(p => p.signal.aborted)).toBe(true);
  const fresh = pending.splice(0); await finish(fresh); expect(current.groups[0].evidence.camera).toBe('matched');
  await act(async () => { old[0].resolve(detail(old[0].id, 'Different')); old[1].resolve(detail(old[1].id)); });
  expect(current.groups[0].evidence.camera).toBe('matched'); expect(current.failureCount).toBe(0); expect(current.loading).toBe(false);
});
it('aborts on page exit and never starts queued requests afterwards', async () => {
  await render(photos); const old = pending.splice(0); await act(async () => root.render(null));
  expect(old.every(p => p.signal.aborted)).toBe(true); await finish(old); expect(fetchDetail).toHaveBeenCalledTimes(4);
});
it('survives StrictMode effect cleanup without stale results or duplicate active workers', async () => {
  await render(photos.slice(0, 2), true); expect(pending.filter(p => !p.signal.aborted)).toHaveLength(2);
  await finish(pending.splice(0)); expect(current.loading).toBe(false); expect(current.groups[0].evidence.time).toBe('matched');
});

it('requests NAME members and skips singleton fallback pools and existing stacks', async () => {
 const excluded = [photos[8], ...photos.slice(2,4).map(a => ({...a, stackId: 'existing'}))];
 await render([...photos.slice(0,2), ...excluded]);
 expect(fetchDetail.mock.calls.map(call => call[0])).toEqual(['0','1']);
 await finish(pending.splice(0)); expect(current.unmatched).toHaveLength(3);
 await render(excluded); expect(fetchDetail).toHaveBeenCalledTimes(2); expect(current.loading).toBe(false);
});
it.each([true, false])('fetches same-format fallback details for raw=%s', async raw => {
 const members = photos.slice(0,3).map((a, i) => ({ ...a, filename: 'unique-' + i + '.jpg', is_raw: raw }));
 await render(members); expect(fetchDetail.mock.calls.map(call => call[0])).toEqual(['0', '1', '2']);
 expect(current.detailCount).toBe(3); await finish(pending.splice(0));
 expect(current.groups).toHaveLength(1); expect(current.groups[0].members).toEqual(members);
 expect(current.groups[0].evidence.nameReason).toBe('exif-fallback');
});
it('does not form fallback groups from failed details', async () => {
 fetchDetail.mockRejectedValue(new Error('offline'));
 await render(photos.slice(0,2).map((a, i) => ({ ...a, filename: 'unique-' + i + '.jpg' })));
 expect(current.groups).toEqual([]); expect(current.failureCount).toBe(2); expect(current.loading).toBe(false);
});
it('requests NAME members and only the remaining fallback pool, never existing Stacks', async () => {
 const namePair = photos.slice(0, 2);
 const raw = { ...photos[0], id: 'fallback-raw', filename: 'capture.dng' };
 const jpeg = { ...photos[1], id: 'fallback-jpeg', filename: 'export.jpg' };
 const stackedRaw = { ...raw, id: 'stacked-raw', stackId: 'existing' };
 const stackedJpeg = { ...jpeg, id: 'stacked-jpeg', stackId: 'existing' };
 await render([...namePair, raw, jpeg, stackedRaw, stackedJpeg]);
 expect(fetchDetail.mock.calls.map(call => call[0]).sort()).toEqual(['0', '1', 'fallback-jpeg', 'fallback-raw'].sort());
 await finish(pending.splice(0));
 expect(current.groups.map(group => group.evidence.nameReason)).toEqual(['filename-family', 'exif-fallback']);
});
it('keeps NAME groups and marks failed detail evidence as errors', async () => {
 fetchDetail.mockRejectedValue(new Error('offline'));
 await render(photos.slice(0,2));
 expect(current.groups).toHaveLength(1); expect(current.groups[0].evidence).toMatchObject({name:'matched',time:'error',camera:'error',gps:'error'});
 expect(current.failureCount).toBe(2); expect(current.loading).toBe(false);
 await act(async () => current.redetect()); expect(fetchDetail).toHaveBeenCalledTimes(4);
});

it('treats unusable detail as error and retains successful groups', async () => {
 fetchDetail.mockImplementation(async (id:string) => id==='0' ? {...detail(id), exif:null} : detail(id));
 await render(photos.slice(0,4));
 expect(current.failureCount).toBe(1); expect(current.groups).toHaveLength(2);
 expect(current.groups[0].evidence).toMatchObject({time:'error',camera:'error',gps:'error'});
 expect(current.groups[1].evidence.camera).toBe('matched');
});
