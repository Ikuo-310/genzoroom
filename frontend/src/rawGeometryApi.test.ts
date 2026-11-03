// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { beginRawGeometry, updateRawGeometry, saveRawHistory, readRawHistory, type RawCrop, type RawHistoryRequest } from './rawApi';
import { rawSettings } from './test/rawSettings';
import { rawHistoryData, rawHistoryResult } from './test/rawHistory';

const crop: RawCrop = { geometry: { rect: { x0: -.01, y0: .2, x1: 1.01, y1: .8 }, angle: 12 },
  aspect: null, flip_h: false, flip_v: true };
const doc = { ...rawSettings({ workspaceId: 'a'.repeat(32), handle: 'b'.repeat(32), assetId: 'asset', generation: 1,
  documentToken: 'c'.repeat(32), revision: 2 }), crop, orientation: 'Rotate90' };
const gestureId = 'd'.repeat(32);
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

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
