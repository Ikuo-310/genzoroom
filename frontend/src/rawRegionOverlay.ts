import type { RawDocument, RawGeometry } from './rawApi';
import type { RegionCandidate, RegionDeliveryOwner } from './rawRegionDelivery';
import { canReuseRegion, checkRegionResponse, regionPairMatches, type RegionRequest, type RegionResponse } from './rawRegionContract';
import { regionNativeRect, type RegionGeometry, type RegionRect, type RegionFullFrame } from './rawRegionPlanner';
import { frontendLogger } from './frontendLogging';

// Whole and overlay owners share references; a retained Draft base survives a pending Full pair.
export class RawPreviewUrls {
  private refs = new Map<string, number>();
  create(blob: Blob) { const url = URL.createObjectURL(blob); this.refs.set(url, 1); return url; }
  retain(url: string) { const n = this.refs.get(url); if (!n) throw new Error('raw_url_unowned'); this.refs.set(url, n + 1); }
  release(url: string) {
    const n = this.refs.get(url); if (!n) return;
    if (n > 1) this.refs.set(url, n - 1);
    else { this.refs.delete(url); URL.revokeObjectURL(url); }
  }
  get size() { return this.refs.size; }
  owns(url: string) { return this.refs.has(url); }
}
export type RawWholeSurface = { url: string; doc: RawDocument; frame: RawGeometry; quality: 'draft' | 'full'; maxSide?: number };
export type RawRegionLayer = { url: string; metadata: RegionResponse; planGeneration: number;
  nativePlacement: RegionRect; validNativeRect: RegionRect };
export type RawRegionDisplay = { after: RawRegionLayer; before?: RawRegionLayer;
  wholeAfter: RawWholeSurface; wholeBefore?: RawWholeSurface };
type Context = { owner?: RegionDeliveryOwner; after?: RawWholeSurface; before?: RawWholeSurface; comparing: boolean; regionFull?: RegionFullFrame };
type Options = { context: () => Context; current: (candidate: RegionCandidate) => boolean; changed: () => void;
  urls: RawPreviewUrls; failed?: (code: string) => void;
  decode?: (url: string, metadata: Pick<RegionResponse, 'width' | 'height'>, signal: AbortSignal) => Promise<void> };
type DecodedLayer = RawRegionLayer & { candidate: RegionCandidate; decodeStartedAt: number; decodedAt?: number };

export function regionLayerPlacement(metadata: RegionResponse, geometry: RegionGeometry) {
  return { nativePlacement: regionNativeRect(metadata.window, geometry, metadata),
    validNativeRect: regionNativeRect(metadata.validRegion, geometry, metadata) };
}
export function rebindRegion(cached: RegionResponse, wanted: RegionRequest, geometry: RegionGeometry, visible: RegionRect) {
  if (!canReuseRegion(cached, wanted, geometry, visible)) return undefined;
  // Keep the cached bitmap's exact placement; only delivery identity is rebound explicitly.
  const request: RegionRequest = { ...wanted, window: cached.window, validRegion: cached.validRegion,
    context: cached.context, prefetch: cached.prefetch };
  const response: RegionResponse = { ...cached, identity: wanted.identity, documentRevision: wanted.documentRevision,
    viewGeneration: wanted.viewGeneration, requestId: wanted.requestId };
  return checkRegionResponse(request, response).status === 'accepted' ? { request, response } : undefined;
}
const sameDocument = (a: RawDocument, b: RawDocument) => a.assetId === b.assetId && a.workspaceId === b.workspaceId
  && a.generation === b.generation && a.documentToken === b.documentToken && a.handle === b.handle && a.revision === b.revision;
const ownerTag = (owner: RegionDeliveryOwner) => JSON.stringify([owner.doc.assetId, owner.doc.workspaceId, owner.doc.handle,
  owner.sourceId, owner.doc.generation, owner.doc.documentToken, owner.doc.revision, owner.doc.beforeKey,
  owner.geometry.geometryId, owner.geometry.nativeWidth, owner.geometry.nativeHeight]);
function matchesWhole(layer: RawRegionLayer, whole: RawWholeSurface | undefined, owner: RegionDeliveryOwner, full?: RegionFullFrame) {
  const r = layer.metadata, i = r.identity;
  return !!whole && sameDocument(whole.doc, owner.doc) && i.assetId === owner.doc.assetId && i.sourceId === owner.sourceId
    && i.generation === owner.doc.generation && i.documentToken === owner.doc.documentToken && r.documentRevision === owner.doc.revision
    && r.geometryId === whole.frame.geometryId && r.geometryId === owner.geometry.geometryId && r.quality === whole.quality
    && whole.frame.nativeWidth === owner.geometry.nativeWidth && whole.frame.nativeHeight === owner.geometry.nativeHeight
    // C2-C can overlay a denser F only after Native preflight confirms that separate frame.
    && r.fullWidth === (full?.fullWidth ?? whole.frame.fullWidth) && r.fullHeight === (full?.fullHeight ?? whole.frame.fullHeight)
    && (!full || full.geometryId === whole.frame.geometryId)
    && (i.kind === 'after' ? i.revision === owner.doc.revision
      : i.beforeKey === owner.doc.beforeKey && whole.doc.beforeKey === owner.doc.beforeKey);
}
async function decode(url: string, metadata: Pick<RegionResponse, 'width' | 'height'>, signal: AbortSignal) {
  const image = new Image(); let remove = () => {};
  try {
    image.src = url;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    await Promise.race([image.decode(), new Promise<never>((_, reject) => {
      const abort = () => reject(new Error('raw_region_decode_cancelled'));
      bounded.addEventListener('abort', abort, { once: true }); remove = () => bounded.removeEventListener('abort', abort);
      if (bounded.aborted) abort();
    })]);
    bounded.throwIfAborted();
    if (image.naturalWidth !== metadata.width || image.naturalHeight !== metadata.height) throw new Error('raw_region_decode_dimensions');
  } finally { remove(); image.removeAttribute('src'); }
}

export class RawRegionOverlay {
  display?: RawRegionDisplay;
  private staged: Partial<Record<'after' | 'before', DecodedLayer>> = {};
  private wholes: Partial<Record<'after' | 'before', RawWholeSurface>> = {};
  private running?: AbortController;
  private pending: Partial<Record<'after' | 'before' | 'wholeAfter' | 'wholeBefore', RegionCandidate>> = {};
  private epoch = 0;
  private closed = false;
  private ownerTag?: string;
  constructor(private options: Options) {}
  rebind(planGeneration: number, afterRequest: RegionRequest, beforeRequest: RegionRequest | undefined, visible: RegionRect) {
    const d = this.display, c = this.options.context();
    if (!d || !c.owner || c.owner.blocked || c.comparing && (!d.before || !beforeRequest)) return false;
    const a = rebindRegion(d.after.metadata, afterRequest, c.owner.geometry, visible);
    const b = beforeRequest && d.before ? rebindRegion(d.before.metadata, beforeRequest, c.owner.geometry, visible) : undefined;
    if (!a || c.comparing && !b) return false;
    const layer = (old: RawRegionLayer, rebound: NonNullable<typeof a>) => ({ ...old, metadata: rebound.response, planGeneration,
      candidate: { ...(old as DecodedLayer).candidate, item: rebound.request, planGeneration,
        result: { ...(old as DecodedLayer).candidate.result, metadata: rebound.response } } as RegionCandidate });
    const after = layer(d.after, a), before = b && d.before ? layer(d.before, b) : undefined;
    if (!this.options.current(after.candidate) || before && !this.options.current(before.candidate)
      || !matchesWhole(after, c.after, c.owner, c.regionFull)
      || c.comparing && (!matchesWhole(before!, c.before, c.owner, c.regionFull) || !regionPairMatches(after.metadata, before!.metadata))) return false;
    // The same URLs and their retained bases keep their existing references during an identity-only rebind.
    this.display = { ...d, after, ...(before ? { before } : {}) };
    this.log('rebound', after); this.options.changed(); return true;
  }
  private log(event: string, layer?: RawRegionLayer) {
    const r = layer?.metadata;
    try { frontendLogger.add({ level: event === 'decodeFailed' || event === 'pairRejected' || event === 'geometryMismatch' ? 'warn' : 'debug',
      component: 'raw', event: `region.overlay.${event}`, context: r ? { revision: r.documentRevision, quality: r.quality,
        kind: r.kind, geometryId: r.geometryId, planGeneration: layer!.planGeneration, viewGeneration: r.viewGeneration,
        requestId: r.requestId, fullWidth: r.fullWidth, fullHeight: r.fullHeight, window: r.window, validRegion: r.validRegion,
        nativePlacement: layer!.nativePlacement, validNativeRect: layer!.validNativeRect,
        ...((layer as DecodedLayer).decodeStartedAt === undefined ? {} : { decodeMs: ((layer as DecodedLayer).decodedAt ?? performance.now()) - (layer as DecodedLayer).decodeStartedAt,
          adoptWaitMs: (layer as DecodedLayer).decodedAt === undefined ? 0 : performance.now() - (layer as DecodedLayer).decodedAt! }),
        wholeQuality: this.display?.wholeAfter.quality ?? this.options.context().after?.quality ?? null } : {} }); } catch { /* Optional diagnostics. */ }
  }
  offer(candidate: RegionCandidate) {
    if (this.closed || candidate.result.operation === 'plan' || !this.options.current(candidate)) return;
    const owner = this.options.context().owner;
    if (!owner || owner.blocked) return;
    if (this.ownerTag && this.ownerTag !== ownerTag(owner)) this.clear();
    this.ownerTag = ownerTag(owner);
    const kind = candidate.item.identity.kind;
    this.pending[candidate.result.operation === 'whole' ? kind === 'after' ? 'wholeAfter' : 'wholeBefore' : kind] = candidate; this.pump();
  }
  clear() {
    const hadWork = !!(this.running || this.display || Object.values(this.staged).some(Boolean) || Object.values(this.wholes).some(Boolean) || Object.values(this.pending).some(Boolean));
    this.epoch++; this.pending = {}; this.running?.abort();
    this.ownerTag = undefined;
    for (const layer of Object.values(this.staged)) if (layer) this.drop(layer);
    for (const whole of Object.values(this.wholes)) if (whole) this.options.urls.release(whole.url);
    this.wholes = {};
    this.staged = {}; this.dropDisplay(); if (hadWork) this.options.changed();
  }
  dispose() { this.closed = true; this.clear(); }
  private drop(layer: RawRegionLayer) { this.options.urls.release(layer.url); this.log('revoked', layer); }
  private dropDisplay() {
    const d = this.display; this.display = undefined;
    if (!d) return;
    this.drop(d.after); if (d.before) this.drop(d.before);
    this.options.urls.release(d.wholeAfter.url); if (d.wholeBefore) this.options.urls.release(d.wholeBefore.url);
  }
  refresh() {
    const c = this.options.context(), owner = c.owner, d = this.display;
    if (!owner || owner.blocked || d && (!sameDocument(d.wholeAfter.doc, owner.doc)
      || d.after.metadata.geometryId !== owner.geometry.geometryId || d.after.metadata.identity.sourceId !== owner.sourceId)
      || this.ownerTag && this.ownerTag !== ownerTag(owner)) {
      if (owner && d && d.after.metadata.geometryId !== owner.geometry.geometryId) {
        this.log('geometryMismatch', d.after); this.options.failed?.('raw_region_geometry_mismatch');
      }
      this.clear(); return;
    }
    for (const key of ['after', 'before'] as const) {
      const stage = this.staged[key];
      if (stage && !this.options.current(stage.candidate)) { this.log('stale', stage); this.drop(stage); delete this.staged[key]; }
    }
    // Turning comparison on hides an unpaired After immediately; both sides use Whole until paired.
    if (d && c.comparing && !d.before) { this.dropDisplay(); this.options.changed(); }
    const after = this.staged.after, before = this.staged.before;
    const wholeAfter = after && matchesWhole(after, this.wholes.after, owner, c.regionFull) ? this.wholes.after : c.after;
    const wholeBefore = before && matchesWhole(before, this.wholes.before, owner, c.regionFull) ? this.wholes.before : c.before;
    if (!after || !this.options.current(after.candidate) || !matchesWhole(after, wholeAfter, owner, c.regionFull)) return;
    if (c.comparing && (!before || !this.options.current(before.candidate) || !matchesWhole(before, wholeBefore, owner, c.regionFull))) { this.log('pairWaiting', after); return; }
    if (c.comparing && (after.planGeneration !== before!.planGeneration || after.metadata.viewGeneration !== before!.metadata.viewGeneration
      || !regionPairMatches(after.metadata, before!.metadata))) {
      this.log('pairRejected', after); this.options.failed?.('raw_region_pair_mismatch'); return;
    }
    const next: RawRegionDisplay = { after, wholeAfter: wholeAfter!,
      ...(c.comparing ? { before, wholeBefore: wholeBefore! } : {}) };
    // A retry can retire its UI reference before a replacement base is available.
    if (!this.options.urls.owns(next.wholeAfter.url) || next.wholeBefore && !this.options.urls.owns(next.wholeBefore.url)) {
      this.log('pairWaiting', after); return;
    }
    this.options.urls.retain(next.wholeAfter.url); if (next.wholeBefore) this.options.urls.retain(next.wholeBefore.url);
    for (const key of ['after', 'before'] as const) {
      const whole = this.wholes[key], adopted = key === 'after' ? next.wholeAfter : next.wholeBefore;
      if (whole && whole === adopted) { this.options.urls.release(whole.url); delete this.wholes[key]; }
    }
    this.staged.after = undefined;
    if (c.comparing) this.staged.before = undefined;
    const replacing = !!this.display;
    this.dropDisplay(); this.display = next;
    this.log(replacing ? 'replaced' : 'adopted', after); if (c.comparing) this.log('pairAdopted', after);
    this.options.changed();
  }
  private pump() {
    if (this.closed || this.running) return;
    const kind = (['wholeAfter', 'wholeBefore', 'after', 'before'] as const).find(k => this.pending[k]);
    if (!kind) return;
    const candidate = this.pending[kind]; if (!candidate) return;
    delete this.pending[kind];
    if (candidate.result.operation === 'plan' || !this.options.current(candidate)) { this.pump(); return; }
    const c = this.options.context(); if (!c.owner || c.owner.blocked) return;
    if (candidate.result.operation === 'whole') {
      const frame = candidate.result.frame;
      if (!frame.frame || !frame.quality || candidate.item.mode !== 'whole') return;
      const whole: RawWholeSurface = { url: this.options.urls.create(frame.blob), doc: { ...c.owner.doc }, frame: frame.frame, quality: frame.quality, maxSide: candidate.item.maxSide };
      const controller = new AbortController(), epoch = this.epoch; this.running = controller;
      void (this.options.decode ?? decode)(whole.url, frame, controller.signal).then(() => {
        if (controller.signal.aborted || epoch !== this.epoch || !this.options.current(candidate)) { this.options.urls.release(whole.url); return; }
        const key = candidate.item.identity.kind, previous = this.wholes[key];
        this.wholes[key] = whole; if (previous) this.options.urls.release(previous.url);
        this.refresh();
      }).catch(() => this.options.urls.release(whole.url)).finally(() => {
        if (this.running === controller) this.running = undefined; this.pump();
      });
      return;
    }
    const metadata = candidate.result.metadata;
    const staged = this.staged[metadata.kind]; if (staged) { this.drop(staged); delete this.staged[metadata.kind]; }
    const layer: DecodedLayer = { url: this.options.urls.create(candidate.result.blob), metadata, candidate,
      planGeneration: candidate.planGeneration, decodeStartedAt: performance.now(), ...regionLayerPlacement(metadata, c.owner.geometry) };
    const controller = new AbortController(), epoch = this.epoch; this.running = controller;
    this.log('candidateCreated', layer); this.log('decodeStarted', layer);
    void (this.options.decode ?? decode)(layer.url, metadata, controller.signal).then(() => {
      layer.decodedAt = performance.now();
      this.log('decodeCompleted', layer);
      if (controller.signal.aborted || epoch !== this.epoch || !this.options.current(candidate)) {
        this.log('stale', layer); this.drop(layer); return;
      }
      const previous = this.staged[metadata.kind]; if (previous) this.drop(previous);
      this.staged[metadata.kind] = layer; this.refresh();
    }).catch(() => {
      if (controller.signal.aborted) this.log('stale', layer);
      else { this.log('decodeFailed', layer); this.options.failed?.('raw_region_decode_failed'); }
      this.drop(layer);
    })
      .finally(() => { if (this.running === controller) this.running = undefined; this.pump(); });
  }
}
