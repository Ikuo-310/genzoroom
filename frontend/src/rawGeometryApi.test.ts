// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { beginRawGeometry, updateRawGeometry, saveRawHistory, readRawHistory, type RawCrop, type RawHistoryRequest, type RawHistoryOperation, type RawGeometryOperation, type RawGeometryAction } from './rawApi';
import { rawSettings } from './test/rawSettings';
import { rawHistoryData, rawHistoryResult } from './test/rawHistory';
import { RawControls } from './rawControls';
import { RawRecipeSave } from './rawRecipeSave';

const crop: RawCrop = { geometry: { rect: { x0: -.01, y0: .2, x1: 1.01, y1: .8 }, angle: 12 },
  aspect: null, flip_h: false, flip_v: true };
const doc = { ...rawSettings({ workspaceId: 'a'.repeat(32), handle: 'b'.repeat(32), assetId: 'asset', generation: 1,
  documentToken: 'c'.repeat(32), revision: 2 }), crop, orientation: 'Rotate90' };
const gestureId = 'd'.repeat(32);
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

const discrete: { name: string; geometry: RawGeometryOperation; action?: RawGeometryAction }[] = [
  { name: 'lock', geometry: { type: 'aspect', params: { aspect: 'current' } }, action: 'lock' },
  { name: 'unlock', geometry: { type: 'aspect', params: { aspect: 'free' } }, action: 'unlock' },
  ...(['free', 'original', '1x1', '4x5', '8.5x11', '5x7', '2x3', '4x3', '16x9', '16x10'] as const)
    .map(aspect => ({ name: aspect, geometry: { type: 'aspect' as const, params: { aspect, orientation: 'crop' as const } } })),
  ...(['swap', 'rotateLeft', 'rotateRight', 'flipHorizontal', 'flipVertical', 'reset'] as const)
    .map(type => ({ name: type, geometry: { type, params: {} } })),
  { name: 'set', geometry: { type: 'set', params: { rect: [.1, .2, .9, .8] } } },
  { name: 'diagnostic straighten', geometry: { type: 'straighten', params: { angle: 12 } } },
];

it.each(discrete)('sends the complete strict History body for $name', async ({ geometry, action }) => {
  const operation = { kind: 'geometry' as const, metadata: { operation: geometry.type, ...(action ? { action } : {}) }, geometry };
  const request: RawHistoryRequest = { doc, action: 'operate', expectedRecipeRevision: 0,
    saveId: '00000000-0000-4000-8000-000000000001', operation };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => reply(rawHistoryResult(request)));
  vi.stubGlobal('fetch', fetch);
  await saveRawHistory(request);
  expect(fetch.mock.calls[0][0]).toBe(`/api/raw/documents/${doc.handle}/history/operate`);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
    workspaceId: doc.workspaceId, generation: doc.generation, documentToken: doc.documentToken,
    documentRevision: doc.revision, settingsFingerprint: doc.settingsFingerprint,
    expectedRecipeRevision: 0, saveId: request.saveId, ...operation,
  });
});

it.each(['drag', 'straighten'] as const)('keeps %s on begin/update and commits only the existing gesture identity', async type => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => reply({ ...doc, gestureId, sequence: -1 }));
  vi.stubGlobal('fetch', fetch);
  await beginRawGeometry(doc, gestureId, type);
  const operation: RawGeometryOperation = type === 'drag'
    ? { type, params: { handle: 'move', from: [.5, .5], to: [.6, .5], start: [.1, .2, .9, .8] } }
    : { type, params: { angle: 12 } };
  fetch.mockImplementation(async () => reply({ ...doc, revision: 3, gestureId, sequence: 0 }));
  const updated = await updateRawGeometry(doc, gestureId, 0, operation);
  const request: RawHistoryRequest = { doc: updated, action: 'commit', expectedRecipeRevision: 0,
    saveId: '00000000-0000-4000-8000-000000000001', geometryCommit: { gestureId, operation: type,
      ...(type === 'drag' ? { action: 'move' } : {}) } };
  fetch.mockImplementation(async () => reply(rawHistoryResult(request)));
  await saveRawHistory(request);
  const identity = { workspaceId: doc.workspaceId, generation: doc.generation, documentToken: doc.documentToken };
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    `/api/raw/documents/${doc.handle}/geometry/begin`, `/api/raw/documents/${doc.handle}/geometry`,
    `/api/raw/documents/${doc.handle}/history/commit`,
  ]);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ ...identity,
    expectedRevision: 2, settingsFingerprint: doc.settingsFingerprint, gestureId, operation: type });
  expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ ...identity,
    expectedRevision: 2, settingsFingerprint: doc.settingsFingerprint, gestureId, sequence: 0, operation });
  expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toEqual({ ...identity,
    documentRevision: 3, settingsFingerprint: doc.settingsFingerprint, expectedRecipeRevision: 0,
    saveId: request.saveId, kind: 'geometry', metadata: { operation: type, ...(type === 'drag' ? { action: 'move' } : {}) }, gestureId });
});

it('confirms Geometry History through HTTP and admits subsequent Geometry and development operations', async () => {
  let current = doc as ReturnType<typeof rawSettings>;
  let count = 0;
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (!init?.body) return reply(rawHistoryData(current));
    const body = JSON.parse(String(init.body)); bodies.push(body);
    const action = String(url).endsWith('/initialize') ? 'initialize' : 'operate';
    if (action === 'operate') {
      // This fake owns receipts only; Native geometry algorithms are outside this transport regression.
      if (body.kind === 'geometry' && body.geometry?.type !== body.metadata.operation)
        return new Response(JSON.stringify({ code: 'raw_invalid_request' }), { status: 422 });
      count++;
      current = { ...current, revision: current.revision + 1, settingsFingerprint: String(count).padStart(64, '0') };
    }
    current = rawHistoryResult({ doc: current, action, expectedRecipeRevision: body.expectedRecipeRevision, saveId: body.saveId },
      { history: { initialized: true, cursor: count, length: count, selectedStepId: count ? body.saveId : null } });
    return reply(current);
  });
  vi.stubGlobal('fetch', fetch);
  let queue = Promise.resolve();
  const schedule = (work: () => Promise<void>) => { queue = queue.then(work); };
  const controls = new RawControls(doc, { schedule, changed: () => {}, preview: () => {} });
  const saver = new RawRecipeSave(doc, { schedule, changed: () => {}, controls });
  try {
    await saver.save();
    const operations: RawHistoryOperation[] = [
      { kind: 'geometry' as const, metadata: { operation: 'aspect' as const, action: 'lock' as const }, geometry: { type: 'aspect' as const, params: { aspect: 'current' as const } } },
      { kind: 'geometry' as const, metadata: { operation: 'rotateRight' as const }, geometry: { type: 'rotateRight' as const, params: {} } },
      { kind: 'controlReset' as const, metadata: { control: 'light.exposure' as const } },
    ];
    for (const operation of operations) {
      await saver.operate(operation);
      expect(saver.error).toBeUndefined(); expect(saver.locked).toBe(false);
      expect(saver.history?.cursor).toBe(count); expect(saver.savedFingerprint).toBe(current.settingsFingerprint);
    }
    expect(count).toBe(3);
    expect(bodies.slice(1).map(body => body.kind)).toEqual(['geometry', 'geometry', 'controlReset']);
    expect(bodies[3]).not.toHaveProperty('geometry');
    expect(bodies[2].expectedRecipeRevision).toBe(2);
    expect(bodies[3].expectedRecipeRevision).toBe(3);
  } finally { saver.dispose(); controls.dispose(); }
});

it('keeps the immutable gesture identity and normalized coordinates outside the unit rectangle', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => reply({ ...doc, gestureId, sequence: -1 }));
  vi.stubGlobal('fetch', fetch);
  expect((await beginRawGeometry(doc, gestureId, 'drag')).crop).toEqual(crop);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ expectedRevision: 2,
    settingsFingerprint: doc.settingsFingerprint, gestureId, operation: 'drag' });
  fetch.mockImplementation(async () => reply({ ...doc, revision: 3, gestureId, sequence: 0 }));
  const operation = { type: 'set' as const, params: { rect: [-.01, .2, 1.01, .8] as [number, number, number, number] } };
  await updateRawGeometry(doc, gestureId, 0, operation);
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ operation, sequence: 0, gestureId });
});

it.each([{ sequence: 5 }, { gestureId: 'e'.repeat(32) }, { revision: 2 }, { orientation: 'unknown' },
  { crop: { ...crop, flip_h: 1 } }, { crop: { ...crop, geometry: { ...crop.geometry, angle: 46 } } }])
('rejects mismatched gesture receipts or invalid native geometry %j', async patch => {
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => reply({ ...doc, revision: 3, gestureId, sequence: 0, ...patch })));
  await expect(updateRawGeometry(doc, gestureId, 0, { type: 'straighten', params: { angle: 5 } })).rejects.toThrow();
});

it('sends typed discrete operations and a separate gesture commit through the existing History receipt', async () => {
  const request: RawHistoryRequest = { doc, action: 'operate', expectedRecipeRevision: 0, saveId: '00000000-0000-4000-8000-000000000001',
    operation: { kind: 'geometry', metadata: { operation: 'rotateRight' }, geometry: { type: 'rotateRight', params: {} } } };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => reply(rawHistoryResult(request)));
  vi.stubGlobal('fetch', fetch);
  await saveRawHistory(request);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject(request.operation!);
  const commit: RawHistoryRequest = { ...request, action: 'commit', geometryCommit: { gestureId, operation: 'drag' } };
  fetch.mockImplementation(async () => reply(rawHistoryResult(commit)));
  await saveRawHistory(commit);
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ kind: 'geometry', metadata: { operation: 'drag' }, gestureId });
});

it('accepts minimal geometry History metadata and rejects persisted pointer inputs', async () => {
  const value = rawHistoryData(doc);
  value.history = { initialized: true, cursor: 1, length: 1, selectedStepId: '00000000-0000-4000-8000-000000000001' };
  value.steps = [{ stepId: value.history.selectedStepId!, kind: 'geometry', metadata: { operation: 'drag' },
    createdAt: '2026-11-03T00:00:00Z', changes: [] }];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => reply(value)); vi.stubGlobal('fetch', fetch);
  expect((await readRawHistory(doc)).steps[0].metadata).toEqual({ operation: 'drag' });
  fetch.mockImplementation(async () => reply({ ...value, steps: [{ ...value.steps[0], metadata: { operation: 'drag', from: [0, 0] } }] }));
  await expect(readRawHistory(doc)).rejects.toThrow();
});
