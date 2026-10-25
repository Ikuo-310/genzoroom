import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RawRegionAuto } from './rawRegionAuto';
import { RawRegionDelivery, type RegionDeliveryOwner } from './rawRegionDelivery';
import { RawRegionOverlay, RawPreviewUrls, type RawWholeSurface } from './rawRegionOverlay';
import { regionRequest, regionResponse } from './test/rawRegion';
import type { RawView } from './rawWholePreview';
import type { RegionRequest } from './rawRegionContract';

const tick = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
let url = 0;
beforeEach(() => { url = 0; vi.stubGlobal('URL', { createObjectURL: vi.fn(() => `blob:${++url}`), revokeObjectURL: vi.fn() }); });
afterEach(() => vi.unstubAllGlobals());
function harness(nativeWidth = 4000, nativeHeight = 3000) {
  const r = regionRequest(), urls = new RawPreviewUrls();
  let owner: RegionDeliveryOwner | undefined = { doc: { workspaceId: '1'.repeat(32), handle: '2'.repeat(32),
    ...r.identity, revision: r.documentRevision, beforeKey: 'e'.repeat(64) }, geometry: { nativeWidth, nativeHeight, geometryId: r.geometryId },
    sourceId: r.identity.sourceId, supported: true, blocked: false, wholeBusy: false };
  const whole = (): RawWholeSurface => ({ doc: { ...owner!.doc }, url: urls.create(new Blob(['whole'])), quality: 'full',
    frame: { ...owner!.geometry, aspect: nativeWidth/nativeHeight, fullWidth: 2048, fullHeight: Math.round(2048*nativeHeight/nativeWidth), window: null } });
  let after = whole(), before: RawWholeSurface | undefined, comparing = false, interacting = false;
  let auto: RawRegionAuto, overlay: RawRegionOverlay;
  let gate: (() => Promise<void>) | undefined;
  let inFlight = 0, maxInFlight = 0;
  const send = vi.fn(async (_owner, item, signal) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (gate) await gate();
      expect(signal.aborted).toBe(false);
      if ('desiredLongEdge' in item) return { operation: 'plan' as const, metadata: { ...item, kind: item.identity.kind,
        nativeWidth, nativeHeight, fullWidth: item.desiredLongEdge, fullHeight: Math.round(item.desiredLongEdge*nativeHeight/nativeWidth) } };
      return { operation: 'render' as const, metadata: regionResponse(item as RegionRequest), blob: new Blob(['region']) };
    } finally { inFlight--; }
  });
  const delivery = new RawRegionDelivery({ owner: () => owner, send,
    changed: () => queueMicrotask(() => auto?.evaluate()) });
  const decode = vi.fn(async () => {});
  overlay = new RawRegionOverlay({ urls, decode, current: c => delivery.isCurrent(c) && auto.accept(c),
    context: () => ({ owner, after, before, comparing, regionFull: auto.full }), changed: () => queueMicrotask(() => auto?.evaluate()) });
  delivery.subscribe(candidate => { if (candidate) overlay.offer(candidate); });
  const connect = vi.fn(async () => false);
  auto = new RawRegionAuto({ delivery, overlay, snapshot: () => ({ after, before, comparing, interacting }), connect, changed: vi.fn() });
  const view = (patch: Partial<RawView> = {}): RawView => ({ width: 1000, height: 750, dpr: 1, scale: 1,
    nativeWidth, nativeHeight, geometryId: r.geometryId, fit: false, panX: 0, panY: 0, ...patch });
  const update = (patch: Partial<RawView> = {}) => { auto.viewChanged(view(patch)); auto.evaluate(); };
  return { auto, overlay, delivery, send, decode, connect, urls, view, update, getOwner: () => owner!,
    setOwner: (value?: RegionDeliveryOwner) => { owner = value; }, getWhole: () => after,
    setWholeBitmap: (width: number, height: number) => { after = { ...after, frame: { ...after.frame, fullWidth: width, fullHeight: height } }; },
    setWhole: (quality: 'draft' | 'full') => { after = { ...after, quality, doc: { ...owner!.doc } }; if (before) before = { ...before, quality, doc: { ...owner!.doc } }; },
    compare: () => { comparing = true; before = whole(); }, gesture: (value: boolean) => { interacting = value; },
    gate: (value?: () => Promise<void>) => { gate = value; }, maxInFlight: () => maxInFlight };
}

it('uses Whole at Fit, starts a genuinely denser Native frame, keeps hysteresis, then removes only the overlay', async () => {
  const h = harness(); h.update({ scale: .4, fit: true }); await tick();
  expect(h.send).not.toHaveBeenCalled(); expect(h.auto.report.decision).toBe('whole_sufficient');
  h.update({ scale: .57 }); await tick(); expect(h.send).not.toHaveBeenCalled();
  h.update({ scale: .61 }); await tick(); expect(h.overlay.display).toBeDefined();
  expect(h.auto.report.regionDensity!).toBeGreaterThan(h.auto.report.wholeDensity!);
  h.update({ scale: .57 }); await tick(); expect(h.auto.report.active).toBe(true);
  const base = h.getWhole().url; h.update({ scale: .53 }); await tick();
  expect(h.overlay.display).toBeUndefined(); expect(h.auto.report.active).toBe(false); expect(h.urls.owns(base)).toBe(true);
});

it('keeps the C2-C 1:1 preflight request at the Native long edge without changing the planner contract', async () => {
  const h = harness(4064, 3056);
  h.setWholeBitmap(1472, 1107); h.update({ width: 1952, height: 1096, scale: .3586387434554974, fit: true }); await tick();
  expect(h.send).not.toHaveBeenCalled(); expect(h.auto.report.reason).toBe('whole_sufficient');
  h.setWholeBitmap(2048, 1540); h.update({ width: 1952, height: 1096, scale: 1 }); await tick();
  expect(h.send.mock.calls[0][1]).toMatchObject({ desiredLongEdge: 4064, quality: 'full' });
  expect(h.send.mock.calls[0][1].geometryId).toBe(h.getWhole().frame.geometryId);
  expect(h.auto.report.rho).toBeCloseTo(.5039267015706806);
  expect(h.overlay.display?.after.metadata).toMatchObject({ fullWidth: 4064, fullHeight: 3056 });
  expect(h.auto.report.regionDensity).toBeGreaterThan(h.auto.report.wholeDensity!);
});

it('rebinds Pan and Zoom inside cached validRegion without render, decode or new object URLs; F changes replan', async () => {
  const h = harness(); h.update(); await tick();
  expect(h.overlay.display!.after.metadata.fullWidth).toBe(4000);
  expect(h.getWhole().frame.fullWidth).toBe(2048);
  const calls = h.send.mock.calls.length, decodes = h.decode.mock.calls.length, cached = h.overlay.display!.after.url;
  h.update({ panX: 10 }); await tick();
  expect(h.auto.report.reason).toBe('cached_valid_region'); expect(h.overlay.display!.after.url).toBe(cached);
  h.update({ scale: 1.01, panX: 10 }); await tick();
  expect(h.send).toHaveBeenCalledTimes(calls); expect(h.decode).toHaveBeenCalledTimes(decodes);
  h.update({ scale: .8 }); await tick();
  expect(h.send.mock.calls.length).toBeGreaterThan(calls); expect(h.overlay.display!.after.metadata.fullWidth).toBe(3328);
});

it('keeps one transmitted call and one latest pending plan across 100 outside Pans, without preemption', async () => {
  const h = harness(); let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); h.gate(() => barrier);
  h.update(); await tick();
  for (let i = 1; i <= 100; i++) h.update({ panX: i * 5 });
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.delivery.state.pending?.items).toHaveLength(1);
  expect(h.delivery.state.pending!.items[0].viewGeneration).toBe(h.auto.report.viewGeneration);
  h.gate(undefined); release(); await tick();
  expect(h.maxInFlight()).toBe(1); expect(h.send).toHaveBeenCalledTimes(3);
  expect(h.overlay.display!.after.metadata.viewGeneration).toBe(h.auto.report.viewGeneration);
});

it('uses acknowledged Draft and converges to Full; mutation/generation invalidation cannot adopt stale output', async () => {
  const h = harness(); h.gesture(true); h.setWhole('draft'); h.update({ interacting: true }); await tick();
  expect(h.overlay.display!.after.metadata.quality).toBe('draft');
  h.gesture(false); h.setWhole('full'); h.update(); await tick();
  expect(h.overlay.display!.after.metadata.quality).toBe('full');
  h.setOwner({ ...h.getOwner(), blocked: true }); h.delivery.invalidate(); h.auto.reset(); h.auto.evaluate(); await tick();
  expect(h.overlay.display).toBeUndefined(); expect(h.auto.report.reason).toBe('whole_or_mutation_busy');
});

it('adopts and reuses only a complete Before/After pair at identical view/F/W/quality', async () => {
  const h = harness(); h.compare(); h.update(); await tick();
  const d = h.overlay.display!; expect(d.before).toBeDefined();
  expect(d.before!.metadata.window).toEqual(d.after.metadata.window);
  const calls = h.send.mock.calls.length; h.update({ panX: 5 }); await tick();
  expect(h.send).toHaveBeenCalledTimes(calls);
  expect(h.overlay.display!.before!.metadata.viewGeneration).toBe(h.overlay.display!.after.metadata.viewGeneration);
});

it('preserves Whole for unsupported capability and owner failure, and supports same-view Whole-only comparison', async () => {
  const h = harness(); h.setOwner({ ...h.getOwner(), supported: false }); h.update(); await tick();
  expect(h.send).not.toHaveBeenCalled(); expect(h.auto.report.reason).toBe('unsupported');
  h.setOwner(undefined); h.auto.reset(); h.update(); await tick(); expect(h.connect).toHaveBeenCalledTimes(1);
  expect(h.auto.report.reason).toBe('owner_failed'); expect(h.urls.owns(h.getWhole().url)).toBe(true);
  const j = harness(); j.update(); await tick(); const view = j.auto.report.visible;
  j.auto.setEnabled(false); expect(j.overlay.display).toBeUndefined(); expect(j.auto.report.visible).toEqual(view);
  j.auto.setEnabled(true); await tick(); expect(j.overlay.display).toBeDefined(); expect(j.auto.report.visible).toEqual(view);
});

it('can resume automatic view generations after a higher-generation manual diagnostic plan', async () => {
  const h = harness(); h.update(); await tick(); h.auto.setEnabled(false);
  const item = regionRequest({ viewGeneration: 1000 });
  expect(h.delivery.adoptReuse({ planGeneration: 1000, items: [item] })).toBe(true);
  h.auto.setEnabled(true); await tick();
  expect(h.overlay.display!.after.metadata.viewGeneration).toBeGreaterThan(1000);
});

it('does not equate an accepted Region with higher density when Native preflight cannot improve Whole', async () => {
  const h = harness();
  h.send.mockImplementationOnce(async (_owner, item) => ({ operation: 'plan', metadata: { ...item, kind: item.identity.kind,
    nativeWidth: 4000, nativeHeight: 3000, fullWidth: 2048, fullHeight: 1536 } }));
  h.update(); await tick();
  expect(h.overlay.display).toBeUndefined(); expect(h.auto.report.reason).toBe('no_density_gain');
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.auto.report.active).toBe(false);
});

it('rejects a decoded result from a former view and adopts only the latest outside-Pan result', async () => {
  const h = harness(); let release!: () => void;
  h.decode.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  h.update(); await tick(); expect(h.overlay.display).toBeUndefined();
  h.update({ panX: 500 }); await tick(); release(); await tick();
  expect(h.overlay.display!.after.metadata.viewGeneration).toBe(h.auto.report.viewGeneration);
});

it('keeps Whole and the failure reason without a retry loop until a newer view arrives', async () => {
  const h = harness(); h.send.mockRejectedValueOnce(new Error('render failed'));
  h.update(); await tick(); h.auto.evaluate(); await tick();
  expect(h.auto.report.reason).toBe('request_failed'); expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.urls.owns(h.getWhole().url)).toBe(true);
  h.update({ panX: 10 }); await tick(); expect(h.overlay.display).toBeDefined();
});

it('starts a successor capability lookup without allowing a former lifecycle to settle its connection state', async () => {
  const h = harness(); h.setOwner(undefined);
  let oldResolve!: (value: boolean) => void, nextResolve!: (value: boolean) => void;
  h.connect.mockReturnValueOnce(new Promise(resolve => { oldResolve = resolve; }))
    .mockReturnValueOnce(new Promise(resolve => { nextResolve = resolve; }));
  h.update(); h.auto.reset(); h.auto.evaluate();
  expect(h.connect).toHaveBeenCalledTimes(2);
  oldResolve(false); await tick(); expect(h.auto.report.reason).toBe('capability_checking');
  nextResolve(false); await tick(); expect(h.auto.report.reason).toBe('owner_failed');
});
