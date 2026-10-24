import { expect, it, vi } from 'vitest';
import { RawRegionDelivery, type RegionDeliveryOwner, type RegionCandidate } from './rawRegionDelivery';
import { regionRequest, regionResponse } from './test/rawRegion';
import type { PreviewPlan } from './rawRegionSchedule';

const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function harness() {
  const r = regionRequest();
  let owner: RegionDeliveryOwner | undefined = { doc: { workspaceId: 'f'.repeat(32), handle: 'e'.repeat(32),
    ...r.identity, revision: r.documentRevision }, sourceId: r.identity.sourceId, supported: true,
    geometry: { geometryId: r.geometryId, nativeWidth: 4000, nativeHeight: 3000 }, blocked: false, wholeBusy: false };
  let finish!: (value: RegionCandidate['result']) => void;
  let running = 0, maxRunning = 0;
  const send = vi.fn((_owner, _item, _signal) => {
    running++; maxRunning = Math.max(maxRunning, running);
    return new Promise<RegionCandidate['result']>(yes => { finish = value => { running--; yes(value); }; });
  });
  const delivery = new RawRegionDelivery({ owner: () => owner, send });
  const plan = (n: number): PreviewPlan => ({ planGeneration: n, items: [regionRequest({
    viewGeneration: n, requestId: n.toString(16).padStart(32, '0') })] });
  const resolve = () => {
    const item = delivery.state.running!.item;
    finish({ operation: 'render', metadata: regionResponse(item as ReturnType<typeof regionRequest>), blob: new Blob(['png']) });
  };
  return { delivery, send, plan, resolve, maxRunning: () => maxRunning,
    owner: () => owner!, setOwner: (o?: RegionDeliveryOwner) => { owner = o; } };
}

it('keeps one promise and latest pending through 100 updates; stale view is never adopted', async () => {
  const h = harness(); h.delivery.submit(h.plan(1));
  for (let n = 2; n <= 101; n++) h.delivery.submit(h.plan(n));
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.delivery.state.pending?.items).toHaveLength(1);
  expect(h.delivery.state.pending?.planGeneration).toBe(101);
  h.resolve(); await tick();
  expect(h.delivery.candidate).toBeUndefined(); expect(h.send).toHaveBeenCalledTimes(2);
  expect(h.delivery.state.running?.item.viewGeneration).toBe(101);
  h.resolve(); await tick();
  expect(h.delivery.candidate?.item.viewGeneration).toBe(101);
  expect(h.maxRunning()).toBe(1);
  expect(h.delivery.submit({ ...h.plan(1), planGeneration: 102 })).toBe(false);
});

it.each(['revision', 'generation', 'token', 'asset', 'source', 'geometry', 'mutating', 'close'])(
  'rejects a result after %s changes and clears candidates', async change => {
    const h = harness(); h.delivery.submit(h.plan(1));
    const o = structuredClone(h.owner());
    if (change === 'revision') o.doc.revision++;
    if (change === 'generation') o.doc.generation++;
    if (change === 'token') o.doc.documentToken = '1'.repeat(32);
    if (change === 'asset') o.doc.assetId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    if (change === 'source') o.sourceId = '1'.repeat(64);
    if (change === 'geometry') o.geometry = { ...o.geometry, geometryId: '1'.repeat(64) };
    if (change === 'mutating') o.blocked = true;
    h.setOwner(change === 'close' ? undefined : o);
    h.resolve(); await tick();
    expect(h.delivery.candidate).toBeUndefined();
    expect(h.delivery.state.running).toBeUndefined();
  });

it('aborts only its HTTP waiter and clears pending/candidate/preflight on disposal', async () => {
  const h = harness(); h.delivery.submit(h.plan(1)); h.delivery.submit(h.plan(2));
  const signal = h.send.mock.calls[0][2] as AbortSignal;
  h.delivery.dispose(); expect(signal.aborted).toBe(true);
  expect(h.delivery.state.pending).toBeUndefined();
  h.resolve(); await tick();
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.delivery.candidate).toBeUndefined(); expect(h.delivery.preflight).toBeUndefined();
  expect(h.delivery.submit(h.plan(3))).toBe(false);
});

it('cancels with the transmitted document owner across generation changes', async () => {
  const h = harness();
  const original = structuredClone(h.owner().doc);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  try {
    h.delivery.submit(h.plan(1));
    h.setOwner({ ...h.owner(), doc: { ...original, generation: original.generation + 1, documentToken: '1'.repeat(32) } });
    h.delivery.refresh();
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      generation: original.generation, documentToken: original.documentToken });
    h.resolve(); await tick(); expect(h.delivery.candidate).toBeUndefined();
  } finally { fetch.mockRestore(); }
});

it('does not start without capability or while Whole/P1 owns delivery', async () => {
  const h = harness(); h.setOwner({ ...h.owner(), supported: false });
  expect(h.delivery.submit(h.plan(1))).toBe(false); expect(h.send).not.toHaveBeenCalled();
  h.setOwner({ ...h.owner(), supported: true, wholeBusy: true });
  h.delivery.submit(h.plan(2)); expect(h.send).not.toHaveBeenCalled();
  h.setOwner({ ...h.owner(), wholeBusy: false }); h.delivery.refresh();
  expect(h.send).toHaveBeenCalledTimes(1); h.resolve(); await tick();
  h.setOwner({ ...h.owner(), blocked: true }); h.delivery.refresh();
  expect(h.delivery.candidate).toBeUndefined();
});

it('preflight discards the unsent tail and explicitly rebuilds a new finite plan', async () => {
  const r = regionRequest();
  const { fullWidth: _fw, fullHeight: _fh, window: _w, validRegion: _v, context: _c, prefetch: _p, ...base } = r;
  const query = { ...base, desiredLongEdge: 4000 };
  let delivery!: RawRegionDelivery;
  const send = vi.fn(async (_owner, item): Promise<RegionCandidate['result']> => 'desiredLongEdge' in item
    ? { operation: 'plan', metadata: { ...item, kind: item.identity.kind, nativeWidth: 4000, nativeHeight: 3000, fullWidth: 4000, fullHeight: 3000 } }
    : { operation: 'render', metadata: regionResponse(item), blob: new Blob(['png']) });
  const h = harness();
  const replan = vi.fn(() => ({ planGeneration: 2, items: [{ ...r, requestId: '1'.repeat(32) }] } as PreviewPlan));
  delivery = new RawRegionDelivery({ owner: h.owner, send, replan });
  delivery.submit({ planGeneration: 1, items: [query, { ...r, requestId: '2'.repeat(32) }] });
  await tick();
  expect(replan).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][1].requestId).toBe('1'.repeat(32));
  expect(delivery.candidate?.planGeneration).toBe(2);
});
