import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from './rawApi';
import { RawRecipeSave, RAW_AUTOSAVE_MS } from './rawRecipeSave';
import { rawSettings } from './test/rawSettings';
import { rawHistoryResult } from './test/rawHistory';

vi.mock('./rawApi', async original => ({ ...await original<typeof import('./rawApi')>(), saveRawRecipe: vi.fn(), readRawRecipe: vi.fn(),
  saveRawHistory: vi.fn(), readRawHistory: vi.fn(), beginRawPointColorInteraction: vi.fn(), updateRawPointColorInteraction: vi.fn(),
  cancelRawPointColorInteraction: vi.fn(), readRawSettings: vi.fn(), rawPreview: vi.fn() }));
const fingerprint = (revision: number) => String(revision).padStart(64, '0');
const settings = (revision = 1) => rawSettings({ workspaceId: 'workspace', handle: 'handle', assetId: 'raw', generation: 1,
  documentToken: 'token', revision, settingsFingerprint: fingerprint(revision), recipeFingerprint: fingerprint(1), recipeRevision: 0 });
const ack = (request: api.RawRecipeRequest): api.RawRecipeAck => ({ documentRevision: request.doc.revision,
  settingsFingerprint: request.doc.settingsFingerprint, recipeRevision: request.expectedRecipeRevision + 1,
  saveId: request.saveId, updatedAt: '2026-10-22T00:00:00.000Z' });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
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

it.each(['delivered', 'superseded'])('coalesces Point Color updates and saves one History operation with a %s Preview', async delivery => {
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
  if (delivery === 'superseded') vi.mocked(api.rawPreview).mockRejectedValueOnce(new api.RawSuperseded('replaced'));
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
  await vi.advanceTimersByTimeAsync(49);
  expect(api.updateRawPointColorInteraction).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(api.updateRawPointColorInteraction).toHaveBeenCalledOnce();
  expect(vi.mocked(api.updateRawPointColorInteraction).mock.calls[0][4].value).toBe(25.5);
  expect(api.saveRawHistory).not.toHaveBeenCalled();
  await c.finishPointColorInteraction();
  expect(api.saveRawHistory).toHaveBeenCalledOnce();
  const request = vi.mocked(api.saveRawHistory).mock.calls[0][0];
  expect(request.operation).toEqual({ kind: 'pointColorControl', metadata: { control: 'pointColor.0.hueShift', value: 25.5 } });
  expect(request.pointColorInteractionId).toBe('a'.repeat(32));
  expect(api.cancelRawPointColorInteraction).not.toHaveBeenCalled();
  expect(c.pointColorInteracting).toBe(false);
});

it('does not leak a superseded Point Color Preview rejection or let it fail the newest draft', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const previewError = vi.fn();
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls,
    pointColorPreviewError: previewError });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockImplementation(async (_doc, _serial, _signal, _target, operation) => operation.sequence);
  const oldPreview = deferred<api.RawFrame>(), newPreview = deferred<api.RawFrame>();
  vi.mocked(api.rawPreview).mockReturnValueOnce(oldPreview.promise).mockReturnValueOnce(newPreview.promise);
  const save = vi.spyOn(c, 'save').mockResolvedValue();
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  await (c as any).pointColorGesture.started;
  save.mockClear();
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(12, target);
  await vi.advanceTimersByTimeAsync(50);
  expect(api.rawPreview).toHaveBeenCalledTimes(1);
  c.updatePointColorInteraction(25, target);
  await vi.advanceTimersByTimeAsync(50);
  expect(api.rawPreview).toHaveBeenCalledTimes(2);
  newPreview.resolve({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 2,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 2 } as api.RawFrame);
  await Promise.resolve();
  oldPreview.reject(new Error('superseded preview failed'));
  await Promise.resolve(); await Promise.resolve();

  expect(c.pointColorInteracting).toBe(true);
  expect(previewError).not.toHaveBeenCalled();
  expect(api.cancelRawPointColorInteraction).not.toHaveBeenCalled();
  await c.finishPointColorInteraction();
  expect(save).toHaveBeenCalledOnce();
});

it('routes the current Point Color Preview failure through interaction recovery once', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const previewError = vi.fn(), recovery = vi.fn(async () => {});
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls,
    pointColorPreviewError: previewError, curveRecovery: recovery });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockImplementation(async (_doc, _serial, _signal, _target, operation) => operation.sequence);
  vi.mocked(api.cancelRawPointColorInteraction).mockResolvedValueOnce();
  vi.mocked(api.readRawSettings).mockResolvedValueOnce(initial);
  const preview = deferred<api.RawFrame>(); vi.mocked(api.rawPreview).mockReturnValueOnce(preview.promise);
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner; await (c as any).pointColorGesture.started;
  c.updatePointColorInteraction(25, target);
  await vi.advanceTimersByTimeAsync(50);
  const finishing = c.finishPointColorInteraction();
  preview.reject(new Error('current preview failed'));
  await expect(finishing).rejects.toThrow('current preview failed');
  await vi.waitFor(() => expect(previewError).toHaveBeenCalledOnce());

  expect(api.cancelRawPointColorInteraction).toHaveBeenCalledOnce();
  expect(api.saveRawHistory).not.toHaveBeenCalled();
  expect(recovery).not.toHaveBeenCalled();
  expect(controls.endPreview).toHaveBeenCalledOnce();
  expect(controls.endPreview.mock.invocationCallOrder[0]).toBeLessThan(previewError.mock.invocationCallOrder[0]);
  expect(c.pointColorInteracting).toBe(false);
});

it('does not present an older Point Color Preview that completes after the latest one', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const pointColorPreview = vi.fn(), previewError = vi.fn();
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls,
    pointColorPreview, pointColorPreviewError: previewError });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockImplementation(async (_doc, _serial, _signal, _target, operation) => operation.sequence);
  vi.mocked(api.cancelRawPointColorInteraction).mockResolvedValueOnce();
  vi.mocked(api.readRawSettings).mockResolvedValueOnce(initial);
  const oldPreview = deferred<api.RawFrame>(), newPreview = deferred<api.RawFrame>();
  vi.mocked(api.rawPreview).mockReturnValueOnce(oldPreview.promise).mockReturnValueOnce(newPreview.promise);
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner; await (c as any).pointColorGesture.started;
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(12, target);
  await vi.advanceTimersByTimeAsync(50);
  c.updatePointColorInteraction(25, target);
  await vi.advanceTimersByTimeAsync(50);
  newPreview.resolve({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 2,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 2 } as api.RawFrame);
  await Promise.resolve(); await Promise.resolve();
  oldPreview.resolve({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 1 } as api.RawFrame);
  await Promise.resolve(); await Promise.resolve();

  expect(pointColorPreview).toHaveBeenCalledOnce();
  expect(pointColorPreview.mock.calls[0]![2]).toBe(2);
  expect(previewError).not.toHaveBeenCalled();
  await c.cancelPointColorInteraction();
});

it('observes a Point Color Preview rejection that arrives after Cancel released its owner', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const previewError = vi.fn();
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls,
    pointColorPreviewError: previewError });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockImplementation(async (_doc, _serial, _signal, _target, operation) => operation.sequence);
  vi.mocked(api.cancelRawPointColorInteraction).mockResolvedValueOnce();
  vi.mocked(api.readRawSettings).mockResolvedValueOnce(initial);
  const preview = deferred<api.RawFrame>(); vi.mocked(api.rawPreview).mockReturnValueOnce(preview.promise);
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner; await (c as any).pointColorGesture.started;
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(25, target);
  await vi.advanceTimersByTimeAsync(50);
  await c.cancelPointColorInteraction();
  preview.reject(new Error('late cancelled preview failed'));
  await Promise.resolve(); await Promise.resolve();

  expect(previewError).not.toHaveBeenCalled();
  expect(api.cancelRawPointColorInteraction).toHaveBeenCalledOnce();
  expect(api.saveRawHistory).not.toHaveBeenCalled();
  expect(c.pointColorInteracting).toBe(false);
});

it('ignores a Point Color Preview response that completes after the saver is disposed', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const pointColorPreview = vi.fn(), previewError = vi.fn();
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls,
    pointColorPreview, pointColorPreviewError: previewError });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockImplementation(async (_doc, _serial, _signal, _target, operation) => operation.sequence);
  vi.mocked(api.cancelRawPointColorInteraction).mockResolvedValueOnce();
  vi.mocked(api.readRawSettings).mockResolvedValueOnce(initial);
  const preview = deferred<api.RawFrame>(); vi.mocked(api.rawPreview).mockReturnValueOnce(preview.promise);
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner; await (c as any).pointColorGesture.started;
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(25, target);
  await vi.advanceTimersByTimeAsync(50);
  c.dispose();
  preview.resolve({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 1 } as api.RawFrame);
  await Promise.resolve(); await Promise.resolve();

  expect(pointColorPreview).not.toHaveBeenCalled();
  expect(previewError).not.toHaveBeenCalled();
  expect(api.saveRawHistory).not.toHaveBeenCalled();
  expect(api.cancelRawPointColorInteraction).toHaveBeenCalledOnce();
});

it('keeps Cancel ownership when Finish is requested afterward and deduplicates both requests', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.cancelRawPointColorInteraction).mockResolvedValueOnce();
  vi.mocked(api.readRawSettings).mockResolvedValueOnce(initial);
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  await (c as any).pointColorGesture.started;

  const cancel = c.cancelPointColorInteraction();
  expect(c.cancelPointColorInteraction()).toBe(cancel);
  expect(c.finishPointColorInteraction()).toBe(cancel);
  await cancel;

  expect(api.cancelRawPointColorInteraction).toHaveBeenCalledOnce();
  expect(api.saveRawHistory).not.toHaveBeenCalled();
  expect(controls.endPreview).toHaveBeenCalledOnce();
  expect(c.pointColorInteracting).toBe(false);
});

it('waits for an in-flight Native update ACK before the winning Cancel is sent', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  const nativeAck = deferred<number>(); vi.mocked(api.updateRawPointColorInteraction).mockReturnValueOnce(nativeAck.promise);
  vi.mocked(api.cancelRawPointColorInteraction).mockResolvedValueOnce();
  vi.mocked(api.readRawSettings).mockResolvedValueOnce(initial);
  vi.mocked(api.rawPreview).mockResolvedValue({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 1 } as api.RawFrame);
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  await (c as any).pointColorGesture.started;
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(38, target);
  await vi.advanceTimersByTimeAsync(50);
  expect(api.updateRawPointColorInteraction).toHaveBeenCalledOnce();

  const cancel = c.cancelPointColorInteraction();
  expect(c.finishPointColorInteraction()).toBe(cancel);
  expect(api.cancelRawPointColorInteraction).not.toHaveBeenCalled();
  expect(api.saveRawHistory).not.toHaveBeenCalled();
  nativeAck.resolve(1);
  await cancel;

  expect(api.cancelRawPointColorInteraction).toHaveBeenCalledOnce();
  expect(api.saveRawHistory).not.toHaveBeenCalled();
  expect(controls.endPreview).toHaveBeenCalledOnce();
  expect(c.pointColorInteracting).toBe(false);
});

it('keeps Finish ownership while Preview is pending and makes later Cancel await the single save', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockResolvedValueOnce(1);
  const preview = deferred<api.RawFrame>(); vi.mocked(api.rawPreview).mockReturnValueOnce(preview.promise);
  const saved = vi.mocked(api.saveRawHistory).mockImplementationOnce(async request => rawHistoryResult(request,
    { history: { initialized: true, cursor: 1, length: 1, selectedStepId: 'b'.repeat(32) } }));
  vi.mocked(api.readRawHistory).mockResolvedValueOnce({ ...rawHistoryResult({ doc: initial, action: 'operate',
    operation: { kind: 'pointColorControl', metadata: { control: 'pointColor.0.hueShift', value: 38 } },
    expectedRecipeRevision: 0, saveId: 'c'.repeat(36) },
    { history: { initialized: true, cursor: 1, length: 1, selectedStepId: 'b'.repeat(32) } }), steps: [] } as api.RawHistoryData);
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  await (c as any).pointColorGesture.started;
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(38, target);
  await vi.advanceTimersByTimeAsync(50);

  const finish = c.finishPointColorInteraction();
  expect(c.finishPointColorInteraction()).toBe(finish);
  expect(c.cancelPointColorInteraction()).toBe(finish);
  expect(api.cancelRawPointColorInteraction).not.toHaveBeenCalled();
  expect(saved).not.toHaveBeenCalled();
  preview.resolve({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 1 } as api.RawFrame);
  await finish;

  expect(saved).toHaveBeenCalledOnce();
  expect(saved.mock.calls[0]![0].operation).toEqual({ kind: 'pointColorControl',
    metadata: { control: 'pointColor.0.hueShift', value: 38 } });
  expect(api.cancelRawPointColorInteraction).not.toHaveBeenCalled();
  expect(controls.endPreview).toHaveBeenCalledOnce();
  expect(c.pointColorInteracting).toBe(false);
});

it('makes a Cancel during History save await Finish without cancelling the committed interaction', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockResolvedValueOnce(1);
  vi.mocked(api.rawPreview).mockResolvedValueOnce({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 1 } as api.RawFrame);
  const saveGate = deferred<api.RawHistoryResult>();
  vi.mocked(api.saveRawHistory).mockReturnValueOnce(saveGate.promise);
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  await (c as any).pointColorGesture.started;
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(38, target);
  await vi.advanceTimersByTimeAsync(50);
  const finish = c.finishPointColorInteraction();
  for (let i = 0; i < 20 && !vi.mocked(api.saveRawHistory).mock.calls.length; i++) await Promise.resolve();
  expect(api.saveRawHistory).toHaveBeenCalledOnce();
  expect(c.cancelPointColorInteraction()).toBe(finish);
  expect(api.cancelRawPointColorInteraction).not.toHaveBeenCalled();

  const request = vi.mocked(api.saveRawHistory).mock.calls[0]![0];
  const result = rawHistoryResult(request, { history: { initialized: true, cursor: 1, length: 1, selectedStepId: 'b'.repeat(32) } });
  vi.mocked(api.readRawHistory).mockResolvedValueOnce({ ...result, steps: [] } as api.RawHistoryData);
  saveGate.resolve(result);
  await finish;
  expect(api.saveRawHistory).toHaveBeenCalledOnce();
  expect(api.cancelRawPointColorInteraction).not.toHaveBeenCalled();
  expect(controls.endPreview).toHaveBeenCalledOnce();
  expect(c.pointColorInteracting).toBe(false);
});

it('holds departure on unknown History outcome and retries only the existing save ID', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockResolvedValueOnce(1);
  vi.mocked(api.rawPreview).mockResolvedValue({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 1 } as api.RawFrame);
  vi.mocked(api.saveRawHistory).mockRejectedValueOnce(new api.RawSaveError('raw_connection_failed', 'unknown'));
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  await (c as any).pointColorGesture.started;
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(38, target);
  await vi.advanceTimersByTimeAsync(50);
  await expect(c.finishPointColorInteraction()).rejects.toMatchObject({ outcome: 'unknown' });
  await expect(c.preparePointColorForDeparture()).rejects.toMatchObject({ outcome: 'unknown' });
  expect(c.pointColorInteracting).toBe(true);
  expect(api.cancelRawPointColorInteraction).not.toHaveBeenCalled();

  const second = vi.mocked(api.saveRawHistory).mock.calls[0]![0];
  const result = rawHistoryResult(second, { history: { initialized: true, cursor: 1, length: 1, selectedStepId: 'b'.repeat(32) } });
  vi.mocked(api.saveRawHistory).mockResolvedValueOnce(result);
  vi.mocked(api.readRawHistory).mockResolvedValueOnce({ ...result, steps: [] } as api.RawHistoryData);
  await c.preparePointColorForDeparture(true);
  expect(api.saveRawHistory).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.saveRawHistory).mock.calls[1]![0]).toEqual(second);
  expect(api.cancelRawPointColorInteraction).not.toHaveBeenCalled();
  expect(c.pointColorInteracting).toBe(false);
});

it('flushes a pending Point Color value immediately when Pointer Up arrives before the 50ms pump', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  const ack = deferred<number>();
  vi.mocked(api.updateRawPointColorInteraction).mockReturnValueOnce(ack.promise);
  vi.mocked(api.rawPreview).mockResolvedValue({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 1 } as api.RawFrame);
  const save = vi.spyOn(c, 'save').mockResolvedValue();

  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  await (c as any).pointColorGesture.started;
  save.mockClear();
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(38, target);
  const finishing = c.finishPointColorInteraction();
  await vi.advanceTimersByTimeAsync(10);

  expect(api.updateRawPointColorInteraction).toHaveBeenCalledOnce();
  expect(vi.mocked(api.updateRawPointColorInteraction).mock.calls[0]![4].value).toBe(38);
  expect(save).not.toHaveBeenCalled();
  ack.resolve(1);
  await finishing;

  expect(save).toHaveBeenCalledOnce();
  expect((c as any).moveIntent.operation.metadata.value).toBe(38);
  expect((c as any).pointColorGesture.appliedValue).toBe(38);
  expect((c as any).pointColorGesture.appliedSequence).toBe(1);
  expect(api.cancelRawPointColorInteraction).not.toHaveBeenCalled();
});

it('settles twenty short Point Color gestures independently without waiting for their throttle timers', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  const committed: number[] = [];
  for (let index = 0; index < 20; index++) {
    const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
    const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
    c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
    vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
    vi.mocked(api.updateRawPointColorInteraction).mockImplementationOnce(async (_doc, _serial, _signal, _target, operation) => operation.sequence);
    vi.mocked(api.rawPreview).mockResolvedValueOnce({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
      kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 1 } as api.RawFrame);
    const save = vi.spyOn(c, 'save').mockImplementation(async () => {
      if ((c as any).moveIntent?.operation) committed.push((c as any).moveIntent.operation.metadata.value);
    });
    expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
    await owner;
    await (c as any).pointColorGesture.started;
    save.mockClear();
    c.updatePointColorInteraction(index + 1, target);
    await c.finishPointColorInteraction();
    expect(save).toHaveBeenCalledOnce();
  }
  expect(committed).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  expect(api.updateRawPointColorInteraction).toHaveBeenCalledTimes(20);
});

it('cancels a Point Color gesture returned to its initial value without a History save', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockImplementation(async (_doc, _serial, _signal, _target, operation) => operation.sequence);
  vi.mocked(api.rawPreview).mockResolvedValue({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 1 } as api.RawFrame);
  vi.mocked(api.cancelRawPointColorInteraction).mockResolvedValueOnce(undefined as any);
  vi.mocked(api.readRawSettings).mockResolvedValueOnce(initial);
  const save = vi.spyOn(c, 'save').mockResolvedValue();
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  await (c as any).pointColorGesture.started;
  save.mockClear();
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(38, target);
  c.updatePointColorInteraction(0, target);
  await c.finishPointColorInteraction();
  expect(api.updateRawPointColorInteraction).toHaveBeenCalledOnce();
  expect(vi.mocked(api.updateRawPointColorInteraction).mock.calls[0]![4].value).toBe(0);
  expect(save).not.toHaveBeenCalled();
  expect(api.cancelRawPointColorInteraction).toHaveBeenCalledOnce();
});

it('flushes the last Point Color value when Pointer Up runs between pump settlement and cleanup', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  const nativeAck = deferred<number>(), sent: number[] = [];
  vi.mocked(api.updateRawPointColorInteraction).mockImplementation((_doc, _serial, _signal, _target, operation) => {
    sent.push(operation.value);
    return sent.length === 1 ? nativeAck.promise : Promise.resolve(operation.sequence);
  });
  vi.mocked(api.rawPreview).mockResolvedValue({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 1 } as api.RawFrame);
  const save = vi.spyOn(c, 'save').mockResolvedValue();

  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  save.mockClear();
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  let finishing!: Promise<void>;
  const originalPump = (c as any).pumpPointColorInteraction.bind(c);
  vi.spyOn(c as any, 'pumpPointColorInteraction').mockImplementation(async (gesture: any) => {
    await originalPump(gesture);
    // Model Pointer Up from the ACK continuation before the separate catch/finally chain clears pump.
    if (!gesture.ending) {
      gesture.value = 25;
      gesture.pending = 25;
      gesture.display = { ...target, quality: 'draft', mode: 'whole', maxSide: 512 };
      finishing = c.finishPointColorInteraction();
    }
  });
  c.updatePointColorInteraction(12, target);
  await vi.advanceTimersByTimeAsync(50);
  expect(api.updateRawPointColorInteraction).toHaveBeenCalledOnce();
  nativeAck.resolve(1);
  await vi.waitFor(() => expect(finishing).toBeDefined());
  await finishing;

  expect(sent).toEqual([12, 25]);
  expect(save).toHaveBeenCalledOnce();
  expect((c as any).moveIntent.operation.metadata.value).toBe(25);
  expect((c as any).pointColorGesture.pending).toBeUndefined();
});

it('serializes rapid Point Color drafts and commits only the last acknowledged value', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  const acks = [deferred<number>(), deferred<number>()], sent: number[] = [];
  vi.mocked(api.updateRawPointColorInteraction).mockImplementation((_doc, _serial, _signal, _target, operation) => {
    sent.push(operation.value);
    return acks[sent.length - 1].promise;
  });
  vi.mocked(api.rawPreview).mockResolvedValue({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 2 } as api.RawFrame);
  const save = vi.spyOn(c, 'save').mockResolvedValue();
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  save.mockClear();
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(12, { ...target, pointColorRangeIndex: 0 });
  await vi.advanceTimersByTimeAsync(50);
  for (let value = 13; value <= 32; value++) c.updatePointColorInteraction(value, target);
  const finishing = c.finishPointColorInteraction();
  acks[0].resolve(1);
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  expect(sent).toEqual([12, 32]);
  expect(vi.mocked(api.rawPreview).mock.calls[0]?.[4]?.pointColorRangeIndex).toBe(0);
  expect(save).not.toHaveBeenCalled();
  acks[1].resolve(2);
  await finishing;
  expect(vi.mocked(api.rawPreview).mock.calls[1]?.[4]?.pointColorRangeIndex).toBeUndefined();
  expect(save).toHaveBeenCalledOnce();
  expect((c as any).moveIntent.operation.metadata.value).toBe(32);
});

it('cancels an uncommitted Point Color draft after a definitive interaction conflict', async () => {
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockImplementation(async (_doc, _serial, _signal, _target, operation) => operation.sequence);
  vi.mocked(api.cancelRawPointColorInteraction).mockResolvedValueOnce(undefined as any);
  vi.mocked(api.readRawSettings).mockResolvedValueOnce(initial);
  vi.mocked(api.rawPreview).mockResolvedValue({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 1 } as api.RawFrame);
  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  vi.spyOn(c, 'save').mockRejectedValue(new api.RawSaveError('raw_point_color_interaction_conflict', 'rejected', 409));
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(25, target);
  await vi.advanceTimersByTimeAsync(50);
  await expect(c.finishPointColorInteraction()).rejects.toMatchObject({ code: 'raw_point_color_interaction_conflict' });
  expect(api.cancelRawPointColorInteraction).toHaveBeenCalledOnce();
  expect(c.pointColorInteracting).toBe(false);
  expect(controls.endPreview).toHaveBeenCalledOnce();
  expect((c as any).retryRequest).toBeUndefined();
});

it('cancels the Point Color draft when the actual History HTTP response is a definite conflict', async () => {
  const actualApi = await vi.importActual<typeof import('./rawApi')>('./rawApi');
  const point = { lum: .5, chroma: .1, hue: 20, hue_shift: 0, sat_shift: 0, lum_shift: 0, variance: 0,
    range: 50, hue_range: 50, sat_range: 50, lum_range: 50 };
  const initial = { ...settings(), point_colors: [point] };
  const controls = { confirmed: initial, beginPreview: vi.fn(), endPreview: vi.fn(), refreshPreview: vi.fn(), flush: vi.fn(), unsettled: false } as any;
  const c = new RawRecipeSave(initial, { schedule: action => { owner = owner.then(action); }, changed, controls });
  c.initialized = true; c.history = { initialized: true, cursor: 0, length: 0, selectedStepId: null };
  vi.mocked(api.beginRawPointColorInteraction).mockResolvedValueOnce('a'.repeat(32));
  vi.mocked(api.updateRawPointColorInteraction).mockImplementation(async (_doc, _serial, _signal, _target, operation) => operation.sequence);
  vi.mocked(api.rawPreview).mockResolvedValue({ blob: new Blob(), width: 10, height: 10, epoch: 1, sequence: 1,
    kind: 'after', quality: 'draft', interactionId: 'a'.repeat(32), interactionSequence: 1 } as api.RawFrame);
  vi.mocked(api.cancelRawPointColorInteraction).mockResolvedValueOnce(undefined as any);
  vi.mocked(api.readRawSettings).mockResolvedValueOnce(initial);
  vi.mocked(api.saveRawHistory).mockImplementation(actualApi.saveRawHistory);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'raw_point_color_interaction_conflict' }),
    { status: 409, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);

  expect(c.beginPointColorInteraction('pointColor.0.hueShift', 0)).toBe(true);
  await owner;
  await (c as any).pointColorGesture.started;
  const target: api.RawDisplayTarget = { quality: 'draft', mode: 'whole', maxSide: 512, viewGeneration: 0, geometryId: null };
  c.updatePointColorInteraction(25, target);
  await vi.advanceTimersByTimeAsync(50);
  await expect(c.finishPointColorInteraction()).rejects.toMatchObject({
    code: 'raw_point_color_interaction_conflict', outcome: 'rejected', status: 409 });

  expect(fetch).toHaveBeenCalledOnce();
  expect(api.cancelRawPointColorInteraction).toHaveBeenCalledOnce();
  expect(controls.endPreview).toHaveBeenCalledOnce();
  expect(c.pointColorInteracting).toBe(false);
  expect((c as any).retryRequest).toBeUndefined();
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
  expect(c.dirty).toBe(true);
  expect(c.locked).toBe(true);
  await expect(c.preparePointColorForDeparture()).rejects.toMatchObject({ code: 'raw_save_unconfirmed' });
  await expect(c.cancelPointColorInteraction()).rejects.toMatchObject({ code: 'raw_save_unconfirmed' });
  expect(api.cancelRawPointColorInteraction).toHaveBeenCalledOnce();
});


it('can persist an unchanged initial baseline before session renewal without marking desired values saved', async () => {
  const c = saver();
  expect(c.dirty).toBe(false);
  await c.save(false, true);
  expect(api.saveRawRecipe).toHaveBeenCalledOnce(); expect(c.revision).toBe(1);
  expect(vi.mocked(api.saveRawRecipe).mock.calls[0][0].doc).toEqual(settings());
});
