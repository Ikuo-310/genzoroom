import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from './rawApi';
import { RawRecipeSave, RAW_AUTOSAVE_MS } from './rawRecipeSave';
import { rawSettings } from './test/rawSettings';

vi.mock('./rawApi', async original => ({ ...await original<typeof import('./rawApi')>(), saveRawRecipe: vi.fn(), readRawRecipe: vi.fn(),
  saveRawHistory: vi.fn(), readRawHistory: vi.fn(), beginRawPointColorInteraction: vi.fn(), updateRawPointColorInteraction: vi.fn(),
  cancelRawPointColorInteraction: vi.fn(), rawPreview: vi.fn() }));
const fingerprint = (revision: number) => String(revision).padStart(64, '0');
const settings = (revision = 1) => rawSettings({ workspaceId: 'workspace', handle: 'handle', assetId: 'raw', generation: 1,
  documentToken: 'token', revision, settingsFingerprint: fingerprint(revision), recipeFingerprint: fingerprint(1), recipeRevision: 0 });
const ack = (request: api.RawRecipeRequest): api.RawRecipeAck => ({ documentRevision: request.doc.revision,
  settingsFingerprint: request.doc.settingsFingerprint, recipeRevision: request.expectedRecipeRevision + 1,
  saveId: request.saveId, updatedAt: '2026-10-22T00:00:00.000Z' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
let owner: Promise<void>;
const changed = vi.fn();
function saver() { return new RawRecipeSave(settings(), { schedule: action => { owner = owner.then(action); }, changed }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); owner = Promise.resolve();
  vi.mocked(api.saveRawRecipe).mockImplementation(async request => ack(request));
  vi.mocked(api.readRawRecipe).mockResolvedValue({ recipeRevision: 9, recipeFingerprint: fingerprint(9),
    lastSaveId: 'external', updatedAt: '2026-10-22T00:00:00.000Z' });
});
afterEach(() => vi.useRealTimers());

it('autosaves only settled confirmed readback after five seconds', async () => {
  const c = saver();
  c.observe(settings(), false);
  await vi.advanceTimersByTimeAsync(10000); expect(api.saveRawRecipe).not.toHaveBeenCalled();
  c.observe(settings(2), false);
  await vi.advanceTimersByTimeAsync(10000); expect(api.saveRawRecipe).not.toHaveBeenCalled();
  c.observe(settings(2), true);
  await vi.advanceTimersByTimeAsync(RAW_AUTOSAVE_MS - 1); expect(api.saveRawRecipe).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await owner;
  expect(api.saveRawRecipe).toHaveBeenCalledOnce(); expect(c.dirty).toBe(false); expect(c.revision).toBe(1);
});

it('keeps newer readback dirty while an older save finishes and follows with another save', async () => {
  const c = saver(), gate = deferred<api.RawRecipeAck>();
  vi.mocked(api.saveRawRecipe).mockReturnValueOnce(gate.promise);
  c.observe(settings(2), true);
  const saving = c.save(); await Promise.resolve();
  c.observe(settings(3), true);
  gate.resolve(ack(vi.mocked(api.saveRawRecipe).mock.calls[0][0])); await saving;
  expect(c.dirty).toBe(true); expect(c.savedFingerprint).toBe(fingerprint(2));
  await vi.advanceTimersByTimeAsync(RAW_AUTOSAVE_MS); await owner;
  expect(api.saveRawRecipe).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.saveRawRecipe).mock.calls[1][0].doc.revision).toBe(3);
  expect(c.dirty).toBe(false); expect(c.revision).toBe(2);
});

it('replays the exact unknown request before saving newer settings with a new saveId', async () => {
  const c = saver(); c.observe(settings(2), true);
  vi.mocked(api.saveRawRecipe).mockRejectedValueOnce(new api.RawSaveError('raw_connection_failed', 'unknown'));
  await expect(c.save()).rejects.toThrow('raw_connection_failed');
  const first = vi.mocked(api.saveRawRecipe).mock.calls[0][0];
  c.observe(settings(3), true);
  await vi.advanceTimersByTimeAsync(10000); expect(api.saveRawRecipe).toHaveBeenCalledOnce();
  await c.save(true);
  const calls = vi.mocked(api.saveRawRecipe).mock.calls;
  expect(calls[1][0]).toEqual(first);
  expect(calls[2][0].saveId).not.toBe(first.saveId);
  expect(calls[2][0].doc.revision).toBe(3); expect(calls[2][0].expectedRecipeRevision).toBe(1);
  expect(c.dirty).toBe(false);
});

it('resynchronizes conflicts but never overwrites until the user explicitly retries', async () => {
  const c = saver(); c.observe(settings(2), true);
  vi.mocked(api.saveRawRecipe).mockRejectedValueOnce(new api.RawSaveError('raw_recipe_revision_conflict', 'rejected', 409));
  await expect(c.save()).rejects.toThrow('raw_recipe_revision_conflict');
  expect(c.confirmed.settingsFingerprint).toBe(fingerprint(2)); expect(c.revision).toBe(9);
  await vi.advanceTimersByTimeAsync(10000); expect(api.saveRawRecipe).toHaveBeenCalledOnce();
  await expect(c.save()).rejects.toThrow('raw_recipe_revision_conflict');
  await c.save(true);
  expect(vi.mocked(api.saveRawRecipe).mock.calls[1][0].expectedRecipeRevision).toBe(9);
  expect(api.readRawRecipe).toHaveBeenCalledTimes(2); expect(c.dirty).toBe(false);
});

it('does not lose an unknown request when its replay is rejected as busy', async () => {
  const c = saver(); c.observe(settings(2), true);
  vi.mocked(api.saveRawRecipe).mockRejectedValueOnce(new api.RawSaveError('raw_connection_failed', 'unknown'))
    .mockRejectedValueOnce(new api.RawSaveError('raw_busy', 'rejected', 409));
  await expect(c.save()).rejects.toThrow();
  await expect(c.save(true)).rejects.toThrow('raw_busy');
  await c.save(true);
  const calls = vi.mocked(api.saveRawRecipe).mock.calls;
  expect(calls[1][0]).toEqual(calls[0][0]); expect(calls[2][0]).toEqual(calls[0][0]);
});

it('does not accept an acknowledgement for a disposed document', async () => {
  const c = saver(), gate = deferred<api.RawRecipeAck>();
  vi.mocked(api.saveRawRecipe).mockReturnValueOnce(gate.promise); c.observe(settings(2), true);
  const saving = c.save().catch(error => error); await Promise.resolve();
  c.dispose(); changed.mockClear(); gate.resolve(ack(vi.mocked(api.saveRawRecipe).mock.calls[0][0]));
  expect(await saving).toBeInstanceOf(api.RawApiError);
  expect(changed).not.toHaveBeenCalled(); expect(c.savedFingerprint).toBe(fingerprint(1));
});

it('coalesces Point Color interaction updates and saves one final History operation', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockImplementation(async (_doc, _serial, _signal, _target, operation) => operation.sequence);
  vi.mocked(api.rawPreview).mockResolvedValue({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 2 } as api.RawFrame);
  vi.mocked(api.saveRawHistory).mockImplementation(async request => {
    const stepId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', saved = { ...initial, settingsFingerprint: fingerprint(2), recipeFingerprint: fingerprint(2),
      recipeRevision: request.expectedRecipeRevision + 1, history: { initialized: true, cursor: 1, length: 1, selectedStepId: stepId },
      historyPending: false, nativeState: 'synced', nativeMatchesRecipe: true, replayed: false,
      ack: { saveId: request.saveId, revision: request.expectedRecipeRevision + 1, settingsFingerprint: fingerprint(2),
        updatedAt: '2026-10-22T00:00:00.000Z', historyCursor: 1, historyLength: 1, stepId } };
    return saved as api.RawHistoryResult;
  });
  vi.mocked(api.readRawHistory).mockResolvedValue({ ...initial, recipeRevision: 1, recipeFingerprint: fingerprint(2),
    history: { initialized: true, cursor: 1, length: 1, selectedStepId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, historyPending: false,
    nativeState: 'synced', nativeMatchesRecipe: true, steps: [] } as api.RawHistoryData);

  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(12, target);
  c.updatePointColorInteraction(25.5, target);
  await vi.advanceTimersByTimeAsync(50);
  expect(api.updateRawPointColorInteraction).toHaveBeenCalledOnce();
  expect(vi.mocked(api.updateRawPointColorInteraction).mock.calls[0][4].value).toBe(25.5);
  expect(api.saveRawHistory).not.toHaveBeenCalled();
  await c.finishPointColorInteraction();
  expect(api.saveRawHistory).toHaveBeenCalledOnce();
  const request = vi.mocked(api.saveRawHistory).mock.calls[0][0];
  expect(request.operation).toEqual({ kind: 'pointColorControl', metadata: { control: 'pointColor.0.hueShift', value: 25.5 } });
  expect(request.pointColorInteractionId).toBe('a'.repeat(32));
  expect(c.pointColorInteracting).toBe(false);
});

it('releases Preview presentation and starts workspace recovery when Point Color cancel fails', async () => {
  const controls = { confirmed: settings(), beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const curveRecovery = vi.fn(async () => {}), pointColorSettled = vi.fn();
  const c = new RawRecipeSave(settings(), { schedule: action => { owner = owner.then(action); }, changed, controls,
    curveRecovery, pointColorSettled });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.cancelRawPointColorInteraction).mockRejectedValueOnce(new api.RawApiError('raw_point_color_interaction_stale'));

  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  await expect(c.cancelPointColorInteraction()).rejects.toThrow('raw_point_color_interaction_stale');
  await Promise.resolve();

  expect(controls.beginPreview).toHaveBeenCalledOnce();
  expect(controls.endPreview).toHaveBeenCalledOnce();
  expect(pointColorSettled).toHaveBeenCalledWith(true);
  expect(curveRecovery).toHaveBeenCalledOnce();
  expect(c.pointColorInteracting).toBe(false);
});


it('can persist an unchanged initial baseline before session renewal without marking desired values saved', async () => {
  const c = saver();
  expect(c.dirty).toBe(false);
  await c.save(false, true);
  expect(api.saveRawRecipe).toHaveBeenCalledOnce(); expect(c.revision).toBe(1);
  expect(vi.mocked(api.saveRawRecipe).mock.calls[0][0].doc).toEqual(settings());
});
