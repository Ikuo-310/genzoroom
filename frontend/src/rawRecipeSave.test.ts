import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from './rawApi';
import { RawRecipeSave, RAW_AUTOSAVE_MS } from './rawRecipeSave';
import { rawSettings } from './test/rawSettings';

vi.mock('./rawApi', async original => ({ ...await original<typeof import('./rawApi')>(), saveRawRecipe: vi.fn(), readRawRecipe: vi.fn() }));
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


it('can persist an unchanged initial baseline before session renewal without marking desired values saved', async () => {
  const c = saver();
  expect(c.dirty).toBe(false);
  await c.save(false, true);
  expect(api.saveRawRecipe).toHaveBeenCalledOnce(); expect(c.revision).toBe(1);
  expect(vi.mocked(api.saveRawRecipe).mock.calls[0][0].doc).toEqual(settings());
});
