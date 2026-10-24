import { C1_REGION_BUDGET } from './rawRegionPlanner';
import { validRegionIdentity, validateRegionRequest, validateRegionFrameRequest,
  type RegionIdentity, type RegionQuality, type RegionRequest, type RegionFrameRequest } from './rawRegionContract';
import { RAW_WHOLE_MAX_SIDE } from './rawWholePreview';

export type WholePlanItem = Readonly<{ mode: 'whole'; quality: RegionQuality; identity: RegionIdentity;
  documentRevision: number; viewGeneration: number; requestId: string; maxSide: number }>;
export type PreviewPlanItem = WholePlanItem | RegionRequest | RegionFrameRequest;
export type PreviewPlanItems = readonly [PreviewPlanItem] | readonly [PreviewPlanItem, PreviewPlanItem]
  | readonly [PreviewPlanItem, PreviewPlanItem, PreviewPlanItem]
  | readonly [PreviewPlanItem, PreviewPlanItem, PreviewPlanItem, PreviewPlanItem]
  | readonly [PreviewPlanItem, PreviewPlanItem, PreviewPlanItem, PreviewPlanItem, PreviewPlanItem]
  | readonly [PreviewPlanItem, PreviewPlanItem, PreviewPlanItem, PreviewPlanItem, PreviewPlanItem, PreviewPlanItem];
export type PreviewPlan = Readonly<{ planGeneration: number; items: PreviewPlanItems }>;
export type PreviewPlanState = Readonly<{ latestPlanGeneration: number;
  running?: Readonly<{ planGeneration: number; item: PreviewPlanItem }>; pending?: PreviewPlan }>;
export const EMPTY_PREVIEW_PLAN: PreviewPlanState = Object.freeze({ latestPlanGeneration: -1 });
const counter = (n: number) => Number.isSafeInteger(n) && n >= 0;

function assertPlan(plan: PreviewPlan) {
  const items = plan.items;
  if (!counter(plan.planGeneration) || items.length < 1 || items.length > C1_REGION_BUDGET.maxPlanItems) throw new Error('invalid_preview_plan');
  const first = items[0], owner = (item: PreviewPlanItem) => JSON.stringify([item.identity.assetId, item.identity.sourceId,
    item.identity.generation, item.identity.documentToken, item.documentRevision, item.viewGeneration, item.quality]);
  if (items.some(item => item.mode === 'region' ? 'desiredLongEdge' in item ? !validateRegionFrameRequest(item) : !validateRegionRequest(item)
    : item.mode !== 'whole' || !validRegionIdentity(item.identity) || !counter(item.maxSide) || item.maxSide < 16 || item.maxSide > RAW_WHOLE_MAX_SIDE || !counter(item.documentRevision)
      || !counter(item.viewGeneration) || !/^[a-f0-9]{32}$/.test(item.requestId)
      || !['draft', 'full'].includes(item.quality)
      || item.identity.kind === 'after' && item.identity.revision !== item.documentRevision)
    || items.some(item => owner(item) !== owner(first))
    // A preflight and its render must refer to the same Before baseline within a plan.
    || new Set(items.map(item => item.identity).filter(i => i.kind === 'before').map(i => i.beforeKey)).size > 1
    || new Set(items.filter(item => item.mode === 'region').map(item => item.geometryId)).size > 1
    || new Set(items.map(item => `${item.identity.kind}:${item.mode}:${'desiredLongEdge' in item ? 'plan' : 'render'}`)).size !== items.length
    || new Set(items.map(item => item.requestId)).size !== items.length) throw new Error('invalid_preview_plan');
}
export function replacePreviewPlan(state: PreviewPlanState, plan: PreviewPlan): PreviewPlanState {
  assertPlan(plan);
  if (plan.planGeneration <= state.latestPlanGeneration) return state;
  // Replace every unsent item, but the running native call keeps its owner until completion.
  return { latestPlanGeneration: plan.planGeneration, running: state.running,
    pending: { ...plan, items: plan.items.map(item => structuredClone(item)) as unknown as PreviewPlanItems } };
}
export function invalidatePreviewPlan(state: PreviewPlanState, generation: number): PreviewPlanState {
  if (!counter(generation)) throw new Error('invalid_preview_plan');
  return generation > state.latestPlanGeneration ? { latestPlanGeneration: generation, running: state.running } : state;
}
export function takePreviewItem(state: PreviewPlanState): PreviewPlanState {
  if (state.running || !state.pending) return state;
  const { planGeneration, items } = state.pending;
  return { ...state, running: { planGeneration, item: items[0] }, pending: items.length > 1
    ? { planGeneration, items: items.slice(1) as unknown as PreviewPlanItems } : undefined };
}
export function finishPreviewItem(state: PreviewPlanState, planGeneration: number, requestId: string): PreviewPlanState {
  if (state.running?.planGeneration !== planGeneration || state.running.item.requestId !== requestId) return state;
  return { ...state, running: undefined };
}
