import type { RawView } from './rawWholePreview';
import { RawRegionDelivery, type RegionCandidate } from './rawRegionDelivery';
import { RawRegionOverlay, rebindRegion, type RawWholeSurface } from './rawRegionOverlay';
import { confirmRegionFullFrame, validateRegionFrameRequest, validateRegionRequest, type RegionFrameRequest, type RegionRequest } from './rawRegionContract';
import { containsRegionRect, planRawRegion, rawWholeDensity, visibleNativeRegion, type RegionFullFrame, type RegionRect } from './rawRegionPlanner';
import { frontendLogger } from './frontendLogging';

// C2-C provisional values only. C3 must measure and accept product policy separately.
export const REGION_AUTO_PROVISIONAL = Object.freeze({ startRho: .85, stopRho: .95, aggregationMs: 180,
  context: 16, prefetch: 64, fullSideStep: 256 });
export type RegionAutoReport = { enabled: boolean; active: boolean; decision: string; reason: string; viewGeneration: number;
  wholeBitmap?: { width: number; height: number }; wholeF?: { width: number; height: number };
  regionBitmap?: { width: number; height: number }; regionF?: { width: number; height: number };
  dpr?: number; scale?: number; visible?: RegionRect; wholeDensity?: number; requiredDensity?: number; regionDensity?: number;
  rho?: number; quality?: 'draft' | 'full'; interacting?: boolean; revision?: number; limited?: boolean; lastPlan?: 'reuse' | 'replan' };
type Snapshot = { after?: RawWholeSurface; before?: RawWholeSurface; comparing: boolean; interacting: boolean };
const id = () => crypto.randomUUID().replaceAll('-', '');

/** View intent only: the existing delivery, overlay and Native worker retain all image ownership. */
export class RawRegionAuto {
  enabled = true;
  full?: RegionFullFrame;
  report: RegionAutoReport = { enabled: true, active: false, decision: 'region_hold', reason: 'no_view', viewGeneration: 0 };
  private view?: RawView;
  private generation = 0;
  private active = false;
  private fullKey?: string;
  private intent?: string;
  private connecting = false;
  private connectionEpoch = 0;
  private attempted = false;
  private closed = false;
  private evaluating = false;
  private query?: RegionFrameRequest;
  private lastReport = '';
  private unsubscribe: () => void;
  constructor(private options: { delivery: RawRegionDelivery; overlay: RawRegionOverlay; snapshot: () => Snapshot;
    connect: () => Promise<boolean>; changed: () => void }) {
    this.unsubscribe = options.delivery.subscribe((candidate, error) => {
      if (error && this.enabled) { this.record('region_hold', 'request_failed'); return; }
      if (!candidate || candidate.result.operation !== 'plan' || candidate.item.requestId !== this.query?.requestId) return;
      if (!this.accept(candidate)) return;
      const owner = options.delivery.owner;
      const full = owner && confirmRegionFullFrame(this.query, candidate.result.metadata, owner.geometry);
      if (!full) { this.record('region_hold', 'geometry_mismatch'); return; }
      this.full = full; this.query = undefined; this.intent = undefined; this.evaluate();
    });
  }
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled; this.intent = undefined; this.attempted = false;
    this.connectionEpoch++; this.connecting = false;
    if (!enabled) this.disable('diagnostic_whole_only');
    else {
      this.generation = Math.max(this.generation + 1, this.options.delivery.nextViewGeneration);
      this.full = undefined; this.fullKey = undefined;
      this.options.delivery.invalidate(); this.options.overlay.clear(); this.evaluate();
    }
  }
  reset() {
    this.generation = Math.max(this.generation + 1, this.options.delivery.nextViewGeneration);
    this.active = false; this.full = undefined; this.fullKey = this.intent = undefined;
    this.query = undefined; this.attempted = false;
    this.connectionEpoch++; this.connecting = false;
    this.options.overlay.clear(); this.record('region_disable', 'lifecycle', { regionBitmap: undefined, regionF: undefined, regionDensity: undefined });
  }
  dispose() { this.closed = true; this.unsubscribe(); this.reset(); }
  viewChanged(view: RawView) {
    if (JSON.stringify(view) === JSON.stringify(this.view)) return;
    this.view = { ...view }; this.generation++;
    const s = this.options.snapshot(), d = this.options.overlay.display;
    const visible = visibleNativeRegion(view, this.regionView(view));
    // An outside view must not keep an obsolete overlay while aggregation/render/decode catches up.
    if (d && (typeof visible === 'string' || !containsRegionRect(d.after.validNativeRect, visible)
      || d.after.metadata.quality !== (s.interacting ? 'draft' : 'full')
      || Math.max(d.after.metadata.fullWidth, d.after.metadata.fullHeight) !== this.desiredSide(view)
      || d.after.metadata.geometryId !== view.geometryId)) this.options.overlay.clear();
  }
  accept(candidate: RegionCandidate) {
    return !this.closed && (!this.enabled || !this.view || candidate.item.viewGeneration === this.generation
      && candidate.item.quality === (this.options.snapshot().interacting ? 'draft' : 'full'));
  }
  private regionView(v: RawView) { return { width: v.width, height: v.height, dpr: v.dpr, scale: v.scale, panX: v.panX ?? 0, panY: v.panY ?? 0 }; }
  private desiredSide(v: RawView) {
    const native = Math.max(v.nativeWidth, v.nativeHeight), step = REGION_AUTO_PROVISIONAL.fullSideStep;
    return Math.min(native, Math.max(16, Math.ceil(native * Math.min(1, v.scale * v.dpr) / step) * step));
  }
  private record(decision: string, reason: string, extra: Partial<RegionAutoReport> = {}) {
    this.report = { ...this.report, ...extra, enabled: this.enabled, active: this.active, decision, reason, viewGeneration: this.generation };
    if (decision === 'region_reuse') this.report.lastPlan = 'reuse';
    if (decision === 'region_replan' || decision === 'region_start') this.report.lastPlan = 'replan';
    const serialized = JSON.stringify(this.report);
    if (serialized === this.lastReport) return;
    this.lastReport = serialized;
    try { frontendLogger.add({ level: 'debug', component: 'raw', event: 'region.auto.evaluate', context: {
      ...JSON.parse(serialized) } }); } catch { /* Optional diagnostics. */ }
    this.options.changed();
  }
  private disable(reason: string) {
    if (this.active || this.intent || this.full) this.options.delivery.invalidate();
    this.active = false; this.intent = this.fullKey = undefined; this.full = undefined; this.query = undefined;
    this.options.overlay.clear(); this.record('region_disable', reason, { regionBitmap: undefined, regionF: undefined, regionDensity: undefined });
  }
  evaluate() {
    if (this.closed || this.evaluating) return;
    this.evaluating = true;
    try { this.evaluateCurrent(); } finally { this.evaluating = false; }
  }
  private evaluateCurrent() {
    if (!this.enabled) return;
    const v = this.view, s = this.options.snapshot(), whole = s.after, { delivery, overlay } = this.options;
    if (!v || !whole || whole.frame.geometryId !== v.geometryId) { this.record('region_hold', 'no_view'); return; }
    const visible = visibleNativeRegion(whole.frame, this.regionView(v));
    if (typeof visible === 'string') { this.disable(visible); return; }
    const density = rawWholeDensity(whole.frame, v.scale, v.dpr, { width: whole.frame.fullWidth, height: whole.frame.fullHeight }, visible);
    if (!density) { this.disable('invalid_density'); return; }
    // C0 names required/bitmap as rho; the UI contract here explicitly uses its reciprocal, bitmap/required.
    const rho = 1 / density.rho, requiredDensity = v.scale * v.dpr;
    const metadata = overlay.display?.after.metadata;
    this.report = { ...this.report, wholeBitmap: { width: whole.frame.fullWidth, height: whole.frame.fullHeight },
      wholeF: { width: whole.frame.fullWidth, height: whole.frame.fullHeight }, dpr: v.dpr, scale: v.scale,
      visible, wholeDensity: Math.min(whole.frame.fullWidth / v.nativeWidth, whole.frame.fullHeight / v.nativeHeight), requiredDensity, rho,
      quality: s.interacting ? 'draft' : 'full', interacting: s.interacting, revision: whole.doc.revision,
      regionBitmap: metadata ? { width: metadata.width, height: metadata.height } : undefined,
      regionF: metadata ? { width: metadata.fullWidth, height: metadata.fullHeight } : undefined,
      regionDensity: metadata ? Math.min(metadata.fullWidth / v.nativeWidth, metadata.fullHeight / v.nativeHeight) : undefined };
    if (rho >= (this.active ? REGION_AUTO_PROVISIONAL.stopRho : REGION_AUTO_PROVISIONAL.startRho)) {
      if (this.active) this.disable('whole_sufficient'); else this.record('whole_sufficient', 'whole_sufficient'); return;
    }
    const starting = !this.fullKey;
    let owner = delivery.owner;
    if (!owner) {
      if (!this.connecting && !this.attempted) {
        this.connecting = this.attempted = true;
        const epoch = this.connectionEpoch;
        void this.options.connect().catch(() => false).finally(() => {
          if (this.closed || epoch !== this.connectionEpoch) return;
          this.connecting = false; this.evaluate();
        });
      }
      this.record('region_hold', this.connecting ? 'capability_checking' : 'owner_failed'); return;
    }
    if (!owner.supported) { this.disable('unsupported'); return; }
    this.active = true;
    if (owner.blocked || owner.wholeBusy || whole.doc.revision !== owner.doc.revision
      || whole.doc.documentToken !== owner.doc.documentToken || whole.quality !== this.report.quality) { this.record('region_hold', 'whole_or_mutation_busy'); return; }
    if (s.comparing && (!s.before || s.before.quality !== whole.quality || s.before.doc.revision !== whole.doc.revision
      || s.before.frame.geometryId !== whole.frame.geometryId)) { overlay.clear(); this.record('region_hold', 'before_waiting'); return; }
    const desiredLongEdge = this.desiredSide(v);
    const key = JSON.stringify([owner.doc.assetId, owner.doc.generation, owner.doc.documentToken, owner.doc.revision,
      owner.doc.beforeKey, owner.sourceId, v.geometryId, whole.quality, whole.frame.fullWidth, whole.frame.fullHeight, desiredLongEdge, s.comparing]);
    const intent = `${key}:${this.generation}`;
    if (key === this.fullKey && this.full && Math.min(this.full.fullWidth / v.nativeWidth, this.full.fullHeight / v.nativeHeight) <= this.report.wholeDensity!) {
      this.active = false; overlay.clear(); this.record('region_disable', 'no_density_gain'); return;
    }
    if (intent === this.intent) {
      if (this.report.decision !== 'region_reuse' && !['request_failed', 'geometry_mismatch'].includes(this.report.reason))
        this.record('region_hold', overlay.display ? 'displaying' : 'in_flight');
      return;
    }
    this.intent = intent;
    if (key !== this.fullKey) { this.full = undefined; this.fullKey = key; }
    const identity = { assetId: owner.doc.assetId, sourceId: owner.sourceId, generation: owner.doc.generation,
      documentToken: owner.doc.documentToken, kind: 'after' as const, revision: owner.doc.revision };
    const base = { contractVersion: 1 as const, mode: 'region' as const, identity, quality: whole.quality,
      geometryId: v.geometryId, documentRevision: owner.doc.revision, viewGeneration: this.generation };
    if (!this.full) {
      this.query = { ...base, requestId: id(), desiredLongEdge };
      if (!validateRegionFrameRequest(this.query)) { this.record('region_hold', 'invalid_owner'); return; }
      delivery.submit({ planGeneration: delivery.state.latestPlanGeneration + 1, items: [this.query] });
      this.record(starting ? 'region_start' : 'region_replan', 'native_preflight'); return;
    }
    const plan = planRawRegion({ geometry: owner.geometry, full: this.full, view: this.regionView(v),
      context: REGION_AUTO_PROVISIONAL.context, prefetch: REGION_AUTO_PROVISIONAL.prefetch });
    if (plan.mode !== 'region') { this.record('region_hold', plan.reason); return; }
    const after: RegionRequest = { ...base, ...this.full, requestId: id(), window: plan.contextWindow, validRegion: plan.validRegion,
      context: REGION_AUTO_PROVISIONAL.context, prefetch: REGION_AUTO_PROVISIONAL.prefetch };
    const before: RegionRequest | undefined = s.comparing && owner.doc.beforeKey ? { ...after, requestId: id(), identity: {
      assetId: identity.assetId, sourceId: identity.sourceId, generation: identity.generation, documentToken: identity.documentToken,
      kind: 'before', beforeKey: owner.doc.beforeKey } } : undefined;
    if (!validateRegionRequest(after) || before && !validateRegionRequest(before)) { this.record('region_hold', 'invalid_owner'); return; }
    if (s.comparing && !before) { this.record('region_hold', 'before_waiting'); return; }
    const a = overlay.display && rebindRegion(overlay.display.after.metadata, after, owner.geometry, visible);
    const b = before && overlay.display?.before && rebindRegion(overlay.display.before.metadata, before, owner.geometry, visible);
    const generation = delivery.state.latestPlanGeneration + 1;
    if (a && (!s.comparing || b) && delivery.adoptReuse({ planGeneration: generation, items: b ? [a.request, b.request] : [a.request] })
      && overlay.rebind(generation, a.request, b?.request, visible)) { this.record('region_reuse', 'cached_valid_region', { limited: plan.limited }); return; }
    delivery.submit({ planGeneration: delivery.state.latestPlanGeneration + 1, items: before ? [after, before] : [after] });
    this.record(starting ? 'region_start' : 'region_replan', 'render', { limited: plan.limited });
  }
}
