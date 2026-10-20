// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecentAsset } from './assets';
import { useDevelopmentExclusions } from './useDevelopmentExclusions';
import { frontendLogger } from './frontendLogging';
import type { ExclusionStatus, ExclusionTarget } from './developmentExclusionsApi';

const api = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('./developmentExclusionsApi', async original => ({ ...await original<typeof import('./developmentExclusionsApi')>(),
  getExclusionStatuses: api.read, saveExclusion: api.save }));
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const member = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const stackId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const photo: RecentAsset = { id, filename: 'private.jpg', date: '2026-10-14', thumbnail_url: '/private', format: 'JPEG', is_raw: false };
const stack = { ...photo, stackId, primaryAssetId: id, stackMemberIds: [id, member], stackAssetCount: 2 };
let root: Root, host: HTMLDivElement, hook: ReturnType<typeof useDevelopmentExclusions>;
function Harness({ assets, source, context }: { assets: RecentAsset[]; source: RecentAsset[]; context: string }) {
  hook = useDevelopmentExclusions(assets, context, source);
  return null;
}
async function render(assets: RecentAsset[], source = assets, context = 'test') {
  await act(async () => root.render(<Harness assets={assets} source={source} context={context} />));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const events = (event: string) => frontendLogger.getEntries().filter(entry => entry.event === event);
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); root = createRoot(host);
  api.read.mockReset(); api.save.mockReset(); api.save.mockResolvedValue(undefined);
  api.read.mockImplementation(async (targets: ExclusionTarget[]) => targets.map(target => ({ kind: target.kind, id: target.id,
    excluded: false, configuration: target.kind === 'stack' ? 'confirmed' : 'single' })));
  frontendLogger.clear(); frontendLogger.setLevel('debug');
});
afterEach(() => { act(() => root.unmount()); frontendLogger.setLevel('off'); frontendLogger.clear(); vi.unstubAllGlobals(); });

it.each(['unknown', 'stacked', 'absent', 'confirmed'] as const)('separates Backend %s from Frontend confirmation', async configuration => {
  api.read.mockResolvedValue([{ kind: 'asset', id, excluded: true, configuration }]);
  await render([photo]);
  expect(events('status.received')[0].context).toMatchObject({ targetCount: 1, frontendConfirmedCount: 0,
    backendConfigurationCounts: { [configuration]: 1 }, unconfirmedCount: 1,
    unconfirmedReasonCounts: { [configuration === 'unknown' ? 'configuration_unknown' : 'configuration_mismatch']: 1 } });
  expect(events('status.unconfirmed')[0].context).toMatchObject({ targetId: id, kind: 'asset', backendConfiguration: configuration,
    backendExcluded: true, frontendKnown: false, requestId: 1, generation: 0 });
  expect(JSON.stringify(frontendLogger.getEntries())).not.toContain('private');
});

it.each(['unknown', 'absent'] as const)('keeps %s Stack actions guarded independently of load warnings', async configuration => {
  api.read.mockResolvedValue([{ kind: 'stack', id: stackId, excluded: false, configuration }]);
  await render([stack]);
  expect(hook.failure).toBe(configuration === 'unknown' ? 'loadFailed' : null);
  expect(hook.stateFor(stack).known).toBe(false);
  expect(hook.stateFor(stack).diagnostic.configuration).toBe(configuration);
});

it('still warns for unknown when another Stack is absent in the same response', async () => {
  const single = { ...photo, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
  api.read.mockResolvedValue([{ kind: 'stack', id: stackId, excluded: false, configuration: 'absent' },
    { kind: 'asset', id: single.id, excluded: false, configuration: 'unknown' }]);
  await render([stack, single]);
  expect(hook.failure).toBe('loadFailed');
  expect(hook.stateFor(stack).known).toBe(false);
  expect(hook.stateFor(single).known).toBe(false);
});

it.each(['target_unresolved', 'ownership_conflict'] as const)('reports local %s alongside normal Backend status', async reason => {
  const invalid = reason === 'target_unresolved' ? { ...stack, stackMemberIds: undefined } : stack;
  const assets = [invalid, { ...photo, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }];
  const source = reason === 'ownership_conflict' ? [...assets, { ...photo, id: member }] : assets;
  await render(assets, source);
  expect(events('status.unconfirmed')[0].context).toMatchObject({ targetId: stackId, reason, backendConfiguration: null,
    backendExcluded: null, requested: false });
  expect(events('status.received')[0].context).toMatchObject({ backendConfigurationCounts: { unknown: 0, single: 1 },
    frontendConfirmedCount: 1, unconfirmedReasonCounts: { [reason]: 1 } });
});

it('logs signature and generation mismatches while replacement reads are pending', async () => {
  const initial = [stack]; await render(initial);
  const read = deferred<ExclusionStatus[]>(); api.read.mockReturnValue(read.promise);
  const changed = [{ ...stack, primaryAssetId: member }]; await render(changed);
  expect(events('state.unconfirmed').at(-1)?.context).toMatchObject({ reason: 'signature_mismatch', signatureMatches: false });
  await render(initial, initial, 'reloaded');
  expect(events('state.unconfirmed').at(-1)?.context).toMatchObject({ reason: 'generation_mismatch' });
  await act(async () => read.resolve([{ kind: 'stack', id: stackId, excluded: false, configuration: 'confirmed' }]));
  expect(events('status.discarded').length).toBeGreaterThan(0);
});

it('observes pending mutations without changing the accepted Backend response', async () => {
  const assets = [photo]; await render(assets);
  const read = deferred<ExclusionStatus[]>(); api.read.mockReturnValueOnce(read.promise);
  await render(assets, assets, 'reload');
  const save = deferred<void>(); api.save.mockReturnValueOnce(save.promise);
  let mutation!: Promise<void>;
  await act(async () => { mutation = hook.setExcluded({ kind: 'asset', id, memberIds: [id], signature: id }, true); });
  await act(async () => read.resolve([{ kind: 'asset', id, excluded: false, configuration: 'single' }]));
  expect(events('status.unconfirmed').at(-1)?.context).toMatchObject({ reason: 'mutation_pending', backendConfiguration: 'single' });
  await act(async () => { save.resolve(); await mutation; });
});

it('caps per-response details at 100 unique targets and records omissions', async () => {
  const single = { ...photo, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
  const invalid = Array.from({ length: 105 }, (_, index) => ({ ...stack,
    stackId: `${index.toString(16).padStart(8, '0')}-cccc-4ccc-8ccc-cccccccccccc`, stackMemberIds: undefined }));
  await render([single, ...invalid]);
  expect(events('status.unconfirmed')).toHaveLength(100);
  expect(events('status.received')[0].context).toMatchObject({ unconfirmedCount: 105, unconfirmedLoggedCount: 100, unconfirmedOmittedCount: 5 });
  const count = events('state.unconfirmed').length;
  await render([single, ...invalid], [single, ...invalid]);
  // A new generation is new evidence; ordinary rerenders with the same snapshot are deduplicated.
  const stable = [single, ...invalid]; await render(stable); const stableCount = events('state.unconfirmed').length;
  await render(stable);
  expect(events('state.unconfirmed')).toHaveLength(stableCount);
  expect(count).toBeGreaterThan(0);
});

it('records snapshot targets missing from the authoritative source', async () => {
  await render([photo], []);
  expect(events('state.unconfirmed').at(-1)?.context).toMatchObject({ reason: 'snapshot_target_missing', requestId: null });
});

it('records loading, failed and uncertain mutation evidence using existing state reasons', async () => {
  const assets = [photo];
  const read = deferred<ExclusionStatus[]>(); api.read.mockReturnValueOnce(read.promise);
  await render(assets);
  expect(events('state.unconfirmed').at(-1)?.context).toMatchObject({ reason: 'loading' });
  await act(async () => read.resolve([{ kind: 'asset', id, excluded: false, configuration: 'single' }]));
  api.save.mockRejectedValueOnce(new Error('failed'));
  await act(async () => { await hook.setExcluded({ kind: 'asset', id, memberIds: [id], signature: id }, true).catch(() => {}); });
  expect(events('state.unconfirmed').at(-1)?.context).toMatchObject({ reason: 'mutation_uncertain' });
  api.read.mockRejectedValueOnce(new Error('failed'));
  await render([{ ...photo, id: member }]);
  expect(events('state.unconfirmed').at(-1)?.context).toMatchObject({ reason: 'load_failed' });
  expect(events('status.failed').at(-1)?.context).toMatchObject({ errorCode: 'request_failed' });
});

it('records timed out reads and their discarded late results', async () => {
  vi.useFakeTimers();
  try {
    const read = deferred<ExclusionStatus[]>(); api.read.mockReturnValueOnce(read.promise);
    await render([photo]);
    await act(async () => vi.advanceTimersByTime(15000));
    expect(events('state.unconfirmed').at(-1)?.context).toMatchObject({ reason: 'load_timeout' });
    await act(async () => read.resolve([{ kind: 'asset', id, excluded: false, configuration: 'single' }]));
    expect(events('status.discarded').at(-1)?.context).toMatchObject({ requestId: 1, errorCode: 'aborted' });
  } finally { vi.useRealTimers(); }
});

it('isolates logger failures from exclusion confirmation', async () => {
  const logger = vi.spyOn(frontendLogger, 'add').mockImplementation(() => { throw new Error('logger failed'); });
  try {
    await render([photo]);
    expect(hook.stateFor(photo).known).toBe(true);
    expect(hook.failure).toBeNull();
  } finally { logger.mockRestore(); }
});
