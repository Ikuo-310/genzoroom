import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RawPreviewUrls, RawRegionOverlay, regionLayerPlacement, rebindRegion, type RawWholeSurface } from './rawRegionOverlay';
import { checkRegionResponse, type RegionRequest } from './rawRegionContract';
import { planRawRegion, type RegionPlannerInput } from './rawRegionPlanner';
import type { RegionCandidate, RegionDeliveryOwner } from './rawRegionDelivery';
import { regionRequest, regionResponse } from './test/rawRegion';
import fixtures from './test-fixtures/raw-region-v1.json';

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let serial = 0;
const revoke = vi.fn();
beforeEach(() => { serial = 0; revoke.mockReset(); vi.stubGlobal('URL', { createObjectURL: () => `blob:${++serial}`, revokeObjectURL: revoke }); });
afterEach(() => vi.unstubAllGlobals());

function harness(comparing = false) {
  const r = regionRequest(), urls = new RawPreviewUrls();
  let owner: RegionDeliveryOwner | undefined = { doc: { workspaceId: '1'.repeat(32), handle: '2'.repeat(32), ...r.identity,
    revision: r.documentRevision, beforeKey: 'e'.repeat(64) }, sourceId: r.identity.sourceId, supported: true,
    blocked: false, wholeBusy: false, geometry: { nativeWidth: 4000, nativeHeight: 3000, geometryId: r.geometryId } };
  const whole = (quality: 'draft' | 'full' = 'full'): RawWholeSurface => ({ url: urls.create(new Blob(['whole'])),
    doc: { ...owner!.doc }, frame: { ...owner!.geometry, fullWidth: 4000, fullHeight: 3000, window: null, aspect: 4/3 }, quality });
  let after = whole(), before = comparing ? whole() : undefined, generation = 1;
  const decodes: { resolve: () => void; reject: () => void }[] = [];
  const decode = vi.fn((_url, _metadata, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
    decodes.push({ resolve, reject: () => reject(new Error('decode')) });
  }));
  const current = (c: RegionCandidate) => c.planGeneration === generation && !!owner && !owner.blocked
    && c.item.identity.assetId === owner.doc.assetId && c.item.identity.sourceId === owner.sourceId
    && c.item.identity.generation === owner.doc.generation && c.item.identity.documentToken === owner.doc.documentToken
    && c.item.documentRevision === owner.doc.revision && (c.item.mode === 'whole' ? c.result.operation === 'whole'
      : !('desiredLongEdge' in c.item) && c.result.operation === 'render' && c.item.geometryId === owner.geometry.geometryId
        && checkRegionResponse(c.item, c.result.metadata).status === 'accepted');
  const overlay = new RawRegionOverlay({ urls, context: () => ({ owner, after, before, comparing }), current, changed: vi.fn(), decode });
  const candidate = (kind: 'after' | 'before' = 'after', quality: 'draft' | 'full' = 'full', patch: Partial<RegionRequest> = {}): RegionCandidate => {
    const item = regionRequest({ quality, requestId: `${generation}${kind === 'after' ? 'a' : 'b'}`.padStart(32, '0'),
      ...(kind === 'before' ? { identity: { assetId: r.identity.assetId, sourceId: r.identity.sourceId,
        generation: r.identity.generation, documentToken: r.identity.documentToken, kind: 'before', beforeKey: owner!.doc.beforeKey! } } : {}), ...patch });
    return { planGeneration: generation, item, result: { operation: 'render', metadata: regionResponse(item), blob: new Blob(['region']) } };
  };
  return { overlay, urls, decode, decodes, candidate, whole, getOwner: () => owner!, setOwner: (o?: RegionDeliveryOwner) => { owner = o; },
    setGeneration: (g: number) => { generation = g; }, setComparing: (v: boolean) => { comparing = v; },
    setWhole: (a: RawWholeSurface, b?: RawWholeSurface) => { urls.release(after.url); if (before) urls.release(before.url); after = a; before = b; },
    bases: () => ({ after, before }) };
}

it.each(fixtures.filter(f => 'contextWindow' in f.expected))('places C0 fixture $name in Native coordinates without DPR rounding', f => {
  const input = f.input as RegionPlannerInput, plan = planRawRegion(input);
  expect(plan.mode).toBe('region'); if (plan.mode !== 'region') return;
  const metadata = regionResponse(regionRequest({ ...input.full, geometryId: input.geometry.geometryId,
    window: plan.contextWindow, validRegion: plan.validRegion, context: input.context, prefetch: input.prefetch }));
  const placement = regionLayerPlacement(metadata, input.geometry);
  expect(placement.nativePlacement).toEqual(plan.nativePlacement);
  expect(placement.validNativeRect).toEqual(plan.validNativeRect);
  expect(placement.validNativeRect.x0).toBeGreaterThanOrEqual(placement.nativePlacement.x0);
  expect(placement.validNativeRect.y1).toBeLessThanOrEqual(placement.nativePlacement.y1);
});

it('retains the old overlay through decode failure and atomically revokes it only after successful replacement', async () => {
  const h = harness(); h.overlay.offer(h.candidate()); h.decodes[0].resolve(); await tick();
  const old = h.overlay.display!.after.url;
  h.setGeneration(2); h.overlay.offer(h.candidate()); expect(h.overlay.display!.after.url).toBe(old);
  h.decodes[1].reject(); await tick(); expect(h.overlay.display!.after.url).toBe(old); expect(revoke).not.toHaveBeenCalledWith(old);
  h.setGeneration(3); h.overlay.offer(h.candidate()); h.decodes[2].resolve(); await tick();
  expect(h.overlay.display!.after.url).not.toBe(old); expect(revoke.mock.calls.filter(([url]) => url === old)).toHaveLength(1);
});

it.each(['asset', 'source', 'revision', 'generation', 'token', 'geometry', 'plan', 'view', 'request', 'mutation'])(
  'rejects a decode after %s changes', async key => {
    const h = harness(), candidate = h.candidate(); h.overlay.offer(candidate);
    const o = structuredClone(h.getOwner());
    if (key === 'asset') o.doc.assetId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    if (key === 'source') o.sourceId = 'f'.repeat(64);
    if (key === 'revision') o.doc.revision++;
    if (key === 'generation') o.doc.generation++;
    if (key === 'token') o.doc.documentToken = 'f'.repeat(32);
    if (key === 'geometry') o.geometry = { ...o.geometry, geometryId: 'f'.repeat(64) };
    if (key === 'mutation') o.blocked = true;
    if (key === 'plan') h.setGeneration(2);
    if ((key === 'view' || key === 'request') && candidate.result.operation === 'render') {
      candidate.result.metadata = { ...candidate.result.metadata, ...(key === 'view' ? { viewGeneration: 99 } : { requestId: 'f'.repeat(32) }) };
    }
    h.setOwner(o); h.decodes[0].resolve(); await tick();
    expect(h.overlay.display).toBeUndefined(); expect(h.urls.size).toBe(1);
  });

it('keeps a Draft base and overlay until a complete Full pair is ready', async () => {
  const h = harness(true); h.setWhole(h.whole('draft'), h.whole('draft'));
  h.overlay.offer(h.candidate('after', 'draft')); h.overlay.offer(h.candidate('before', 'draft'));
  h.decodes[0].resolve(); await tick(); expect(h.overlay.display).toBeUndefined();
  h.decodes[1].resolve(); await tick(); const draft = h.overlay.display!;
  expect(draft.after.metadata.quality).toBe('draft');
  h.setWhole(h.whole('full'), h.whole('full')); h.overlay.refresh();
  expect(h.overlay.display).toBe(draft); expect(revoke).not.toHaveBeenCalledWith(draft.wholeAfter.url);
  h.setGeneration(2); h.overlay.offer(h.candidate('after')); h.overlay.offer(h.candidate('before'));
  h.decodes[2].resolve(); await tick(); expect(h.overlay.display).toBe(draft);
  h.decodes[3].resolve(); await tick();
  expect(h.overlay.display!.after.metadata.quality).toBe('full'); expect(h.overlay.display!.before!.metadata.quality).toBe('full');
  expect(revoke).toHaveBeenCalledWith(draft.wholeAfter.url); expect(revoke).toHaveBeenCalledWith(draft.wholeBefore!.url);
});

it('waits for both Full Whole bases when Full Region arrives first', async () => {
  const h = harness(true); h.setWhole(h.whole('draft'), h.whole('draft'));
  h.overlay.offer(h.candidate('after', 'draft')); h.overlay.offer(h.candidate('before', 'draft'));
  h.decodes[0].resolve(); await tick(); h.decodes[1].resolve(); await tick(); const draft = h.overlay.display!;
  h.setGeneration(2); h.overlay.offer(h.candidate()); h.overlay.offer(h.candidate('before'));
  h.decodes[2].resolve(); await tick(); h.decodes[3].resolve(); await tick(); expect(h.overlay.display).toBe(draft);
  const fullAfter = h.whole(), draftBefore = h.whole('draft');
  h.setWhole(fullAfter, draftBefore); h.overlay.refresh(); expect(h.overlay.display).toBe(draft);
  // The hook owns each base reference independently of the overlay's retained Draft references.
  h.urls.retain(fullAfter.url); h.setWhole(fullAfter, h.whole()); h.overlay.refresh();
  expect(h.overlay.display!.after.metadata.quality).toBe('full'); expect(h.overlay.display!.wholeBefore!.quality).toBe('full');
});

it('does not resurrect a decoded stage when a later Whole arrives after plan supersession', async () => {
  const h = harness(); h.setWhole(h.whole('draft'));
  h.overlay.offer(h.candidate()); h.decodes[0].resolve(); await tick(); expect(h.overlay.display).toBeUndefined();
  h.setGeneration(2); h.setWhole(h.whole()); h.overlay.refresh(); expect(h.overlay.display).toBeUndefined();
  h.overlay.clear(); expect(h.urls.size).toBe(1);
});

it('does not retain a retired Whole URL while its retry is pending', async () => {
  const h = harness(); h.urls.release(h.bases().after.url);
  h.overlay.offer(h.candidate()); h.decodes[0].resolve(); await tick();
  expect(h.overlay.display).toBeUndefined(); expect(h.urls.size).toBe(1);
  h.overlay.clear(); expect(h.urls.size).toBe(0);
});

it('keeps both latest pair candidates while a superseded decode settles', async () => {
  const h = harness(true); h.overlay.offer(h.candidate());
  h.setGeneration(2); h.overlay.offer(h.candidate()); h.overlay.offer(h.candidate('before'));
  h.decodes[0].resolve(); await tick(); h.decodes[1].resolve(); await tick(); h.decodes[2].resolve(); await tick();
  expect(h.overlay.display!.after.planGeneration).toBe(2); expect(h.overlay.display!.before!.planGeneration).toBe(2);
});

it('decodes an explicit Whole descriptor through the same bounded display queue before adopting its Region', async () => {
  const h = harness(), region = h.candidate('after', 'draft', { fullWidth: 2000, fullHeight: 1500,
    window: { x: 100, y: 100, w: 500, h: 400 }, validRegion: { x: 116, y: 116, w: 468, h: 368 } });
  const request = region.item as RegionRequest;
  h.overlay.offer({ planGeneration: 1, item: { mode: 'whole', quality: 'draft', identity: request.identity,
    documentRevision: request.documentRevision, viewGeneration: request.viewGeneration, requestId: 'f'.repeat(32), maxSide: 2000 },
    result: { operation: 'whole', frame: { blob: new Blob(['whole']), width: 2000, height: 1500, epoch: 1, sequence: 1,
      kind: 'after', quality: 'draft', frame: { ...h.getOwner().geometry, fullWidth: 2000, fullHeight: 1500, aspect: 4/3, window: null } } } });
  h.overlay.offer(region);
  expect(h.decode).toHaveBeenCalledTimes(1); h.decodes[0].resolve(); await tick();
  expect(h.overlay.display).toBeUndefined(); h.decodes[1].resolve(); await tick();
  expect(h.overlay.display!.wholeAfter.quality).toBe('draft');
  expect(h.overlay.display!.wholeAfter.frame.fullWidth).toBe(2000);
  expect(h.overlay.display!.wholeAfter.url).not.toBe(h.bases().after.url);
  h.overlay.clear(); expect(h.urls.size).toBe(1);
});

it.each(['window', 'validRegion', 'quality', 'geometry', 'dimensions'])(
  'rejects an inconsistent Before pair: %s', async key => {
    const h = harness(true), after = h.candidate(), before = h.candidate('before');
    if (before.result.operation !== 'render') throw new Error();
    // Invalid response shapes are rejected by the candidate guard before URL allocation.
    if (key === 'dimensions') before.result.metadata = { ...before.result.metadata, width: 1 };
    else {
      const r = before.item as RegionRequest;
      const patch: Partial<RegionRequest> = key === 'window' ? { window: { ...r.window, x: r.window.x+1 }, validRegion: { ...r.validRegion, x: r.validRegion.x+1 } }
        : key === 'validRegion' ? { context: 8, validRegion: { x: r.window.x+8, y: r.window.y+8, w: r.window.w-16, h: r.window.h-16 } }
        : key === 'quality' ? { quality: 'draft' } : { geometryId: 'f'.repeat(64) };
      before.item = { ...r, ...patch }; before.result.metadata = regionResponse(before.item as RegionRequest);
    }
    h.overlay.offer(after); h.overlay.offer(before); h.decodes[0].resolve(); await tick();
    h.decodes[1]?.resolve(); await tick(); expect(h.overlay.display).toBeUndefined();
  });

it.each(['revision', 'geometry', 'asset', 'close', 'beforeEnd'])(
  'reclaims adopted and decoding URLs on %s', async boundary => {
    const h = harness(); h.overlay.offer(h.candidate()); h.decodes[0].resolve(); await tick();
    h.setGeneration(2); h.overlay.offer(h.candidate());
    const o = structuredClone(h.getOwner());
    if (boundary === 'revision') o.doc.revision++;
    if (boundary === 'geometry') o.geometry = { ...o.geometry, geometryId: 'f'.repeat(64) };
    if (boundary === 'asset') o.doc.assetId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    if (boundary === 'close') h.overlay.dispose();
    else if (boundary === 'beforeEnd') h.overlay.clear();
    else { h.setOwner(o); h.overlay.refresh(); }
    await tick(); expect(h.overlay.display).toBeUndefined(); expect(h.urls.size).toBe(1);
    expect(new Set(revoke.mock.calls.map(([url]) => url)).size).toBe(revoke.mock.calls.length);
  });

it('keeps URL ownership bounded over 100 replacements and drops all overlays at comparison end', async () => {
  const h = harness();
  for (let n = 1; n <= 100; n++) {
    h.setGeneration(n); h.overlay.offer(h.candidate()); expect(h.urls.size).toBeLessThanOrEqual(3);
    h.decodes[n-1].resolve(); await tick(); expect(h.urls.size).toBe(2);
  }
  h.overlay.clear(); expect(h.urls.size).toBe(1); expect(revoke).toHaveBeenCalledTimes(100);
});

it('rebinds content reuse explicitly and rejects an uncovered viewport or different quality', () => {
  const cached = regionResponse(), wanted = regionRequest({ requestId: 'f'.repeat(32), viewGeneration: 100 });
  const geometry = { geometryId: cached.geometryId, nativeWidth: 4000, nativeHeight: 3000 };
  const visible = { x0: 1100, y0: 900, x1: 1200, y1: 1000 };
  const result = rebindRegion(cached, wanted, geometry, visible)!;
  expect(result.response.viewGeneration).toBe(100); expect(result.response.requestId).toBe(wanted.requestId);
  expect(cached.viewGeneration).toBe(3); expect(checkRegionResponse(result.request, result.response).status).toBe('accepted');
  expect(rebindRegion(cached, wanted, geometry, { ...visible, x0: 0 })).toBeUndefined();
  expect(rebindRegion(cached, { ...wanted, quality: 'draft' }, geometry, visible)).toBeUndefined();
});
