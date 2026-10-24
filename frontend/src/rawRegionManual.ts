import type { RawRegionDelivery, RegionCandidate } from './rawRegionDelivery';
import type { RawWholeSurface } from './rawRegionOverlay';
import { planRawRegion, type RegionRect } from './rawRegionPlanner';
import { confirmRegionFullFrame, type RegionFrameRequest, type RegionIdentity, type RegionRequest } from './rawRegionContract';

export type ManualRegionInput = { visible: RegionRect; context: number; prefetch: number; compare?: boolean };
const requestId = () => crypto.randomUUID().replaceAll('-', '');
// A single explicit diagnostic action uses the production finite plan; no Pan/Zoom listeners exist here.
export async function requestManualRegion(delivery: RawRegionDelivery, whole: RawWholeSurface,
  before: RawWholeSurface | undefined, input: ManualRegionInput) {
  const owner = delivery.owner;
  if (!owner?.supported || owner.blocked || owner.wholeBusy) throw new Error('raw_region_unavailable');
  const matches = (surface: RawWholeSurface) => surface.doc.assetId === owner.doc.assetId
    && surface.doc.workspaceId === owner.doc.workspaceId && surface.doc.handle === owner.doc.handle
    && surface.doc.generation === owner.doc.generation && surface.doc.documentToken === owner.doc.documentToken
    && surface.doc.revision === owner.doc.revision && surface.frame.geometryId === owner.geometry.geometryId;
  if (!matches(whole)) throw new Error('raw_region_whole_waiting');
  if (input.compare && (!before || before.quality !== whole.quality || before.frame.geometryId !== whole.frame.geometryId
    || !matches(before) || before.doc.beforeKey !== owner.doc.beforeKey
    || before.frame.fullWidth !== whole.frame.fullWidth || before.frame.fullHeight !== whole.frame.fullHeight)) throw new Error('raw_region_pair_waiting');
  const { doc, geometry } = owner, quality = whole.quality;
  const identity: RegionIdentity = { assetId: doc.assetId, sourceId: owner.sourceId, generation: doc.generation,
    documentToken: doc.documentToken, kind: 'after', revision: doc.revision };
  const planGeneration = delivery.state.latestPlanGeneration + 1, viewGeneration = planGeneration;
  const query: RegionFrameRequest = { contractVersion: 1, mode: 'region', identity, quality,
    geometryId: geometry.geometryId, documentRevision: doc.revision, viewGeneration, requestId: requestId(),
    desiredLongEdge: Math.max(whole.frame.fullWidth, whole.frame.fullHeight) };
  let unsubscribe = () => {}, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const preflight = new Promise<RegionCandidate>((resolve, reject) => {
      unsubscribe = delivery.subscribe((candidate, error) => {
        if (error) reject(error);
        else if (!candidate) reject(new Error('raw_region_cancelled'));
        else if (candidate.result.operation === 'plan' && candidate.item.requestId === query.requestId) resolve(candidate);
      });
      timer = setTimeout(() => reject(new Error('raw_region_timeout')), 90_000);
    });
    if (!delivery.submit({ planGeneration, items: [query] })) throw new Error('raw_region_rejected');
    const result = await preflight;
    const full = result.result.operation === 'plan' ? confirmRegionFullFrame(query, result.result.metadata, geometry) : undefined;
    if (!full || delivery.state.latestPlanGeneration !== planGeneration
      || full.fullWidth !== whole.frame.fullWidth || full.fullHeight !== whole.frame.fullHeight) throw new Error('raw_region_geometry_mismatch');
    const v = input.visible, width = v.x1 - v.x0, height = v.y1 - v.y0;
    const plan = planRawRegion({ geometry, full, context: input.context, prefetch: input.prefetch,
      view: { width, height, dpr: 1, scale: 1, panX: geometry.nativeWidth/2 - (v.x0+v.x1)/2,
        panY: geometry.nativeHeight/2 - (v.y0+v.y1)/2 } });
    if (plan.mode !== 'region') throw new Error('raw_region_whole_fallback');
    const after: RegionRequest = { contractVersion: 1, mode: 'region', quality, identity,
      ...full, window: plan.contextWindow, validRegion: plan.validRegion, context: input.context, prefetch: input.prefetch,
      documentRevision: doc.revision, viewGeneration, requestId: requestId() };
    if (input.compare) {
      if (!doc.beforeKey) throw new Error('raw_region_pair_waiting');
      const beforeRequest: RegionRequest = { ...after, requestId: requestId(), identity: {
        assetId: identity.assetId, sourceId: identity.sourceId, generation: identity.generation,
        documentToken: identity.documentToken, kind: 'before', beforeKey: doc.beforeKey } };
      return delivery.submit({ planGeneration: planGeneration + 1, items: [after, beforeRequest] });
    }
    return delivery.submit({ planGeneration: planGeneration + 1, items: [after] });
  } finally { unsubscribe(); clearTimeout(timer); }
}

declare global {
  interface Window { genzoroomRegion?: { request: (input: ManualRegionInput) => Promise<boolean>;
    clear: () => void; status: () => unknown } }
}
