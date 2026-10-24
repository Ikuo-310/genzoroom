import { expect, it } from 'vitest';
import { regionRequest } from './test/rawRegion';
import { EMPTY_PREVIEW_PLAN, finishPreviewItem, invalidatePreviewPlan, replacePreviewPlan, takePreviewItem,
  type PreviewPlan, type PreviewPlanItem, type PreviewPlanState } from './rawRegionSchedule';
const item = (n: number) => regionRequest({ requestId: n.toString(16).padStart(32, '0'), viewGeneration: n });
const plan = (n: number): PreviewPlan => ({ planGeneration: n, items: [item(n)] });

it('keeps one running item and replaces all unsent work during 1000 view updates', () => {
  let state = takePreviewItem(replacePreviewPlan(EMPTY_PREVIEW_PLAN, plan(1)));
  for (let n = 2; n <= 1000; n++) {
    state = takePreviewItem(replacePreviewPlan(state, plan(n)));
    expect(state.running?.item.requestId).toBe(item(1).requestId);
    expect(state.pending?.items).toHaveLength(1);
  }
  expect(state.pending?.planGeneration).toBe(1000);
  expect(finishPreviewItem(state, 1, 'unknown')).toBe(state);
  state = takePreviewItem(finishPreviewItem(state, 1, item(1).requestId));
  expect(state.running?.item.requestId).toBe(item(1000).requestId);
  expect(state.pending).toBeUndefined();
});
it('supports a finite four-item plan and never preempts a sent item on invalidation', () => {
  const after = regionRequest(), before = regionRequest({ identity: { assetId: after.identity.assetId,
    sourceId: after.identity.sourceId, generation: 1, documentToken: after.identity.documentToken, kind: 'before', beforeKey: 'e'.repeat(64) }, requestId: 'e'.repeat(32) });
  const whole = (r = after): PreviewPlanItem => ({ mode: 'whole', maxSide: 2048, quality: r.quality,
    identity: r.identity, documentRevision: r.documentRevision, viewGeneration: r.viewGeneration,
    requestId: r.identity.kind === 'after' ? '1'.repeat(32) : '2'.repeat(32) });
  const p: PreviewPlan = { planGeneration: 1, items: [whole(), after, whole(before), before] };
  let state = takePreviewItem(replacePreviewPlan(EMPTY_PREVIEW_PLAN, p));
  expect(state.pending?.items).toHaveLength(3);
  const running = state.running!;
  state = invalidatePreviewPlan(state, 2);
  expect(state.pending).toBeUndefined(); expect(state.running).toBe(running);
  expect(takePreviewItem(state)).toBe(state);
  expect(replacePreviewPlan(state, p)).toBe(state);
  expect(finishPreviewItem(state, running.planGeneration, running.item.requestId).running).toBeUndefined();
});
it('replaces the tail of a partially sent plan and drains each item once', () => {
  const r = item(1), whole: PreviewPlanItem = { mode: 'whole', maxSide: 2048, quality: 'full', identity: r.identity,
    documentRevision: r.documentRevision, viewGeneration: r.viewGeneration, requestId: 'f'.repeat(32) };
  let state: PreviewPlanState = takePreviewItem(replacePreviewPlan(EMPTY_PREVIEW_PLAN, { planGeneration: 1, items: [r, whole] }));
  state = replacePreviewPlan(state, plan(2));
  state = takePreviewItem(finishPreviewItem(state, 1, r.requestId));
  expect(state.running?.item.requestId).toBe(item(2).requestId);
  state = takePreviewItem(finishPreviewItem(state, 2, item(2).requestId));
  expect(state.running).toBeUndefined(); expect(state.pending).toBeUndefined();
});
it('counts native preflight in the same running slot and bounds six distinct descriptors', () => {
  const r = regionRequest(), { window: _w, validRegion: _v, context: _c, prefetch: _p, fullWidth: _fw, fullHeight: _fh, ...echo } = r;
  const query = { ...echo, desiredLongEdge: 1999.25, requestId: '3'.repeat(32) };
  const before = { assetId: r.identity.assetId, sourceId: r.identity.sourceId, generation: 1,
    documentToken: r.identity.documentToken, kind: 'before' as const, beforeKey: 'f'.repeat(64) };
  const whole: PreviewPlanItem = { mode: 'whole', maxSide: 2048, quality: r.quality, identity: r.identity,
    documentRevision: r.documentRevision, viewGeneration: r.viewGeneration, requestId: '4'.repeat(32) };
  const p: PreviewPlan = { planGeneration: 1, items: [query, r, whole,
    { ...query, identity: before, requestId: '5'.repeat(32) }, { ...r, identity: before, requestId: '6'.repeat(32) },
    { ...whole, identity: before, requestId: '7'.repeat(32) }] };
  const state = takePreviewItem(replacePreviewPlan(EMPTY_PREVIEW_PLAN, p));
  expect(state.running?.item).toEqual(query); expect(state.pending?.items).toHaveLength(5);
  expect(takePreviewItem(state)).toBe(state);
  const changedBaseline: PreviewPlan = { planGeneration: 2, items: [p.items[3]!,
    { ...r, identity: { ...before, beforeKey: 'e'.repeat(64) }, requestId: '8'.repeat(32) }] };
  expect(() => replacePreviewPlan(state, changedBaseline)).toThrow('invalid_preview_plan');
  const changedGeometry: PreviewPlan = { planGeneration: 2, items: [query,
    { ...r, geometryId: 'e'.repeat(64), requestId: '8'.repeat(32) }] };
  expect(() => replacePreviewPlan(state, changedGeometry)).toThrow('invalid_preview_plan');
});
it('snapshots caller-owned inputs and rejects unbounded or incoherent plans', () => {
  const p = plan(1), state = replacePreviewPlan(EMPTY_PREVIEW_PLAN, p);
  (p.items[0] as { requestId: string }).requestId = 'e'.repeat(32);
  expect(state.pending?.items[0].requestId).toBe(item(1).requestId);
  for (const p of [{ planGeneration: NaN, items: [item(1)] }, { planGeneration: 1, items: [] },
    { planGeneration: 1, items: Array(7).fill(item(1)) }, { planGeneration: 1, items: [item(1), item(1)] },
    { planGeneration: 1, items: [item(1), { ...item(2), quality: 'draft' }] },
    { planGeneration: 1, items: [{ ...item(1), mode: 'unknown', maxSide: 2048 }] }])
    expect(() => replacePreviewPlan(EMPTY_PREVIEW_PLAN, p as unknown as PreviewPlan)).toThrow('invalid_preview_plan');
});
