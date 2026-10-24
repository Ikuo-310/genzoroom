import { cancelRawRegion, rawRegion, rawPreview, RawApiError, RawSuperseded, type RawDocument, type RawRegionResult, type RawFrame } from './rawApi';
import { EMPTY_PREVIEW_PLAN, replacePreviewPlan, takePreviewItem, finishPreviewItem, invalidatePreviewPlan,
  type PreviewPlan, type PreviewPlanItem, type PreviewPlanState } from './rawRegionSchedule';
import type { RegionGeometry } from './rawRegionPlanner';
import { frontendLogger } from './frontendLogging';

export type RegionDeliveryOwner = { doc: RawDocument; sourceId: string; supported: boolean;
  geometry: RegionGeometry; blocked: boolean; wholeBusy: boolean };
export type RegionCandidate = { planGeneration: number; item: PreviewPlanItem;
  result: RawRegionResult | { operation: 'whole'; frame: RawFrame } };
type Options = { owner: () => RegionDeliveryOwner | undefined; changed?: () => void;
  replan?: (candidate: RegionCandidate) => PreviewPlan | undefined;
  send?: (owner: RegionDeliveryOwner, item: PreviewPlanItem, signal: AbortSignal) => Promise<RegionCandidate['result']> };

// A document-scoped delivery owner holds one promise and one finite latest plan, never a task per view.
export class RawRegionDelivery {
  state: PreviewPlanState = EMPTY_PREVIEW_PLAN;
  candidate?: RegionCandidate;
  preflight?: RegionCandidate;
  private controller?: AbortController;
  private sentDocument?: RawDocument;
  private closed = false;
  private queuedAt = 0;
  private serial = 0;
  private latestView = -1;
  constructor(private readonly options: Options) {}
  get owner() { const owner = this.options.owner(); return owner ? structuredClone(owner) : undefined; }
  resetDocument() { this.invalidate(); this.latestView = -1; }
  private current(item: PreviewPlanItem, owner = this.options.owner()) {
    const i = item.identity, d = owner?.doc;
    return !!owner && !owner.blocked && owner.supported && !!d && d.assetId === i.assetId
      && d.generation === i.generation && d.documentToken === i.documentToken && d.revision === item.documentRevision
      && owner.sourceId === i.sourceId && (i.kind !== 'before' || i.beforeKey === d.beforeKey)
      && (item.mode !== 'region' || item.geometryId === owner.geometry.geometryId);
  }
  private diagnostic(item: PreviewPlanItem, disposition: string, planGeneration: number) {
    try { frontendLogger.add({ level: disposition === 'failed' ? 'warn' : 'debug', component: 'raw', event: 'region.delivery', context: {
      planGeneration, requestId: item.requestId, operation: item.mode === 'whole' ? 'whole' : 'desiredLongEdge' in item ? 'plan' : 'render',
      viewGeneration: item.viewGeneration, revision: item.documentRevision, quality: item.quality, kind: item.identity.kind,
      geometryId: item.mode === 'region' ? item.geometryId : null, disposition } }); } catch { /* Optional diagnostics. */ }
  }
  submit(plan: PreviewPlan) {
    if (this.closed) return false;
    if (!this.options.owner()?.supported) {
      this.diagnostic(plan.items[0], 'capability_missing', plan.planGeneration); return false;
    }
    if (!plan.items.every(item => this.current(item))) return false;
    if (plan.items[0].viewGeneration < this.latestView) return false;
    const next = replacePreviewPlan(this.state, plan);
    if (next === this.state) return false;
    this.state = next;
    this.latestView = plan.items[0].viewGeneration;
    this.candidate = this.preflight = undefined;
    this.queuedAt = performance.now();
    this.options.changed?.();
    this.pump(); return true;
  }
  invalidate() {
    const hadWork = !!(this.state.pending || this.state.running || this.candidate || this.preflight);
    this.state = invalidatePreviewPlan(this.state, this.state.latestPlanGeneration + 1);
    this.candidate = this.preflight = undefined;
    const running = this.state.running;
    // HTTP abort detaches the waiter. The Backend worker still joins readback and validation.
    if (running?.item.mode === 'region' && this.sentDocument) void cancelRawRegion(this.sentDocument, running.item.requestId).catch(() => {});
    this.controller?.abort();
    if (hadWork) this.options.changed?.();
  }
  refresh() {
    if (this.state.running && !this.current(this.state.running.item)
      || this.state.pending && !this.state.pending.items.every(item => this.current(item))
      || this.candidate && !this.current(this.candidate.item)
      || this.preflight && !this.current(this.preflight.item)) this.invalidate();
    this.pump();
  }
  dispose() { this.closed = true; this.invalidate(); }
  private pump() {
    const owner = this.options.owner();
    if (this.closed || !owner || owner.blocked || owner.wholeBusy || this.state.running || !this.state.pending) return;
    this.state = takePreviewItem(this.state);
    const running = this.state.running!;
    const { item, planGeneration } = running;
    if (!this.current(item, owner)) { this.invalidate(); this.state = finishPreviewItem(this.state, planGeneration, item.requestId); return; }
    const controller = new AbortController(); this.controller = controller;
    this.sentDocument = { ...owner.doc };
    try { frontendLogger.add({ level: 'debug', component: 'raw', event: 'region.started', context: {
      planGeneration, requestId: item.requestId, queueWaitMs: performance.now() - this.queuedAt } }); } catch { /* Optional diagnostics. */ }
    const send = this.options.send ?? (async (o, i, signal) => i.mode === 'region'
      ? rawRegion(o.doc, i, o.geometry, o.supported, signal)
      : { operation: 'whole' as const, frame: await rawPreview(o.doc, ++this.serial, signal, i.identity.kind,
        { mode: 'whole', maxSide: i.maxSide, quality: i.quality, viewGeneration: i.viewGeneration, geometryId: o.geometry.geometryId }) });
    void send(owner, item, controller.signal).then(result => {
      if (this.closed || controller.signal.aborted || this.state.latestPlanGeneration !== planGeneration || !this.current(item)) {
        this.diagnostic(item, 'stale', planGeneration); return;
      }
      const candidate = { item, planGeneration, result };
      if (result.operation === 'plan') {
        this.preflight = candidate;
        // Preflight replaces its entire unsent tail; only an explicit new plan may use confirmed F.
        this.state = { ...this.state, pending: undefined };
        this.diagnostic(item, 'geometry_replan', planGeneration);
        const next = this.options.replan?.(candidate);
        if (next) this.submit(next);
      } else { this.candidate = candidate; this.diagnostic(item, 'accepted', planGeneration); }
    }).catch(error => this.diagnostic(item, controller.signal.aborted ? 'cancelled'
      : error instanceof RawSuperseded ? 'superseded'
      : error instanceof RawApiError && error.code === 'raw_region_unsupported' ? 'capability_missing'
      : error instanceof RawApiError && error.code === 'raw_region_geometry_mismatch' ? 'whole_fallback' : 'failed', planGeneration))
      .finally(() => {
        this.state = finishPreviewItem(this.state, planGeneration, item.requestId);
        if (this.controller === controller) { this.controller = undefined; this.sentDocument = undefined; }
        this.options.changed?.(); this.pump();
      });
  }
}
