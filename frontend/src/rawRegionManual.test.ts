import { afterEach, expect, it, vi } from 'vitest';
import { requestManualRegion } from './rawRegionManual';
import { RawRegionDelivery, type RegionDeliveryOwner, type RegionCandidate } from './rawRegionDelivery';
import { regionRequest, regionResponse } from './test/rawRegion';
import type { RawWholeSurface } from './rawRegionOverlay';
import { regionPairMatches } from './rawRegionContract';

const tick = async () => { for (let n = 0; n < 25; n++) await Promise.resolve(); };
const input = { visible: { x0: 1600, y0: 1200, x1: 2400, y1: 1800 }, context: 16, prefetch: 8 };
function harness() {
  const r = regionRequest();
  const owner: RegionDeliveryOwner = { doc: { ...r.identity, revision: r.documentRevision, beforeKey: 'e'.repeat(64),
    handle: '1'.repeat(32), workspaceId: '2'.repeat(32) }, sourceId: r.identity.sourceId, supported: true,
    blocked: false, wholeBusy: false, geometry: { geometryId: r.geometryId, nativeWidth: 4000, nativeHeight: 3000 } };
  const whole: RawWholeSurface = { url: 'blob:whole', doc: owner.doc, quality: 'full', frame: { ...owner.geometry,
    fullWidth: 2000, fullHeight: 1500, aspect: 4/3, window: null } };
  const send = vi.fn(async (_owner, item): Promise<RegionCandidate['result']> => 'desiredLongEdge' in item
    ? { operation: 'plan', metadata: { ...item, kind: item.identity.kind, nativeWidth: 4000, nativeHeight: 3000, fullWidth: 2000, fullHeight: 1500 } }
    : { operation: 'render', metadata: regionResponse(item), blob: new Blob(['png']) });
  const delivery = new RawRegionDelivery({ owner: () => owner, send });
  return { owner, whole, send, delivery };
}
afterEach(() => vi.useRealTimers());

it('is explicit and uses preflight then a new finite pair plan with caller-supplied diagnostic margins', async () => {
  const h = harness(), accepted: RegionCandidate[] = [];
  h.delivery.subscribe(c => { if (c) accepted.push(c); });
  expect(h.send).not.toHaveBeenCalled();
  expect(await requestManualRegion(h.delivery, h.whole, h.whole, { ...input, compare: true })).toBe(true);
  await tick(); expect(h.send).toHaveBeenCalledTimes(3);
  const after = accepted[1], before = accepted[2];
  expect(after.planGeneration).toBeGreaterThan(accepted[0].planGeneration);
  if (after.result.operation !== 'render' || before.result.operation !== 'render') throw new Error();
  expect(regionPairMatches(after.result.metadata, before.result.metadata)).toBe(true);
  expect(after.result.metadata.context).toBe(16); expect(after.result.metadata.prefetch).toBe(8);
  expect(after.result.metadata.fullWidth).toBe(h.whole.frame.fullWidth);
});
it('stops without capability, while Whole is busy, or without a matching Before Whole', async () => {
  const h = harness(); h.owner.supported = false;
  await expect(requestManualRegion(h.delivery, h.whole, undefined, input)).rejects.toThrow('raw_region_unavailable');
  h.owner.supported = true; h.owner.wholeBusy = true;
  await expect(requestManualRegion(h.delivery, h.whole, undefined, input)).rejects.toThrow('raw_region_unavailable');
  h.owner.wholeBusy = false;
  await expect(requestManualRegion(h.delivery, h.whole, undefined, { ...input, compare: true })).rejects.toThrow('raw_region_pair_waiting');
  expect(h.send).not.toHaveBeenCalled();
});
it('settles failed preflight immediately and removes timer/subscription', async () => {
  vi.useFakeTimers(); const h = harness();
  h.send.mockRejectedValueOnce(new Error('raw_region_geometry_mismatch'));
  await expect(requestManualRegion(h.delivery, h.whole, undefined, input)).rejects.toThrow('raw_region_geometry_mismatch');
  expect(vi.getTimerCount()).toBe(0); expect(h.send).toHaveBeenCalledTimes(1);
});
it('rejects preflight dimensions inconsistent with the retained Whole base', async () => {
  const h = harness(); h.whole.frame.fullWidth = 1999;
  await expect(requestManualRegion(h.delivery, h.whole, undefined, input)).rejects.toThrow('raw_region_geometry_mismatch');
  expect(h.send).toHaveBeenCalledTimes(1);
});
