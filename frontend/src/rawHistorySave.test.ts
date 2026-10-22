import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from './rawApi';
import { RawControls } from './rawControls';
import { RawRecipeSave } from './rawRecipeSave';
import { rawSettings } from './test/rawSettings';
import { rawHistoryResult } from './test/rawHistory';

vi.mock('./rawApi', async original => ({ ...await original<typeof import('./rawApi')>(),
  saveRawHistory: vi.fn(), saveRawRecipe: vi.fn(), setRawControls: vi.fn(), readRawSettings: vi.fn() }));
let queue: Promise<void>;
const schedule = (action: () => Promise<void>) => { queue = queue.then(action); };
const fp = (value: number) => String(value).padStart(64, '0');
const initial = () => rawSettings({ workspaceId: 'workspace', handle: 'doc', assetId: 'raw', generation: 1,
  documentToken: 'token', revision: 0, settingsFingerprint: fp(1000) });
function owner(settings = initial()) {
  let saver: RawRecipeSave;
  const controls = new RawControls(settings, { schedule, changed: () => saver?.observe(controls.confirmed, !controls.unsettled),
    preview: async () => {} });
  saver = new RawRecipeSave(settings, { schedule, changed: () => {}, controls });
  return { saver, controls };
}
async function drain() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function gate<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), get resolve() { return resolve; } }; }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); queue = Promise.resolve();
  vi.mocked(api.saveRawHistory).mockImplementation(async request => rawHistoryResult(request));
  vi.mocked(api.setRawControls).mockImplementation(async (doc, patch) => {
    const previous = doc as api.RawSettings, values = { ...previous.values, ...patch };
    return { ...previous, values, revision: previous.revision + 1,
      settingsFingerprint: fp(1000 + values['light.exposure'] * 100 + values['light.contrast'] * 10000) };
  });
});
afterEach(() => vi.useRealTimers());

it.each(['unsaved', 'recipe', 'history'])('initializes %s before controls and only once per document', async mode => {
  const settings = initial();
  if (mode !== 'unsaved') Object.assign(settings, { recipeRevision: 7, recipeFingerprint: settings.settingsFingerprint });
  if (mode === 'history') vi.mocked(api.saveRawHistory).mockImplementation(async request => rawHistoryResult(request, {
    history: { initialized: true, cursor: 1, length: 2, selectedStepId: '00000000-0000-4000-8000-000000000001' } }));
  const { saver } = owner(settings);
  saver.begin('light.exposure'); saver.change('light.exposure', 1);
  expect(api.setRawControls).not.toHaveBeenCalled(); expect(saver.locked).toBe(true);
  await saver.save(); await saver.save();
  expect(api.saveRawHistory).toHaveBeenCalledOnce(); expect(saver.initialized).toBe(true);
  expect(saver.revision).toBe(settings.recipeRevision + 1); expect(saver.dirty).toBe(false);
  expect(vi.mocked(api.saveRawHistory).mock.calls[0][0].action).toBe('initialize');
});

it('locks failed initialization and retries exactly the same request', async () => {
  const { saver } = owner();
  vi.mocked(api.saveRawHistory).mockRejectedValueOnce(new api.RawSaveError('raw_history_save_failed', 'unknown', 503));
  await expect(saver.save()).rejects.toThrow();
  saver.change('light.exposure', 1); saver.begin('light.contrast');
  await vi.advanceTimersByTimeAsync(10000);
  expect(api.setRawControls).not.toHaveBeenCalled(); expect(saver.initialized).toBe(false);
  await saver.save(true);
  expect(vi.mocked(api.saveRawHistory).mock.calls[1][0]).toEqual(vi.mocked(api.saveRawHistory).mock.calls[0][0]);
  expect(saver.locked).toBe(false);
});

it('coalesces repeated begins and many intermediate readbacks into one gesture commit', async () => {
  const { saver, controls } = owner(); await saver.save();
  saver.begin('light.exposure');
  for (let i = 1; i <= 20; i++) {
    saver.begin('light.exposure'); saver.change('light.exposure', i / 10);
    await vi.advanceTimersByTimeAsync(150); await drain();
  }
  expect(api.setRawControls).toHaveBeenCalledTimes(20);
  expect(api.saveRawHistory).toHaveBeenCalledOnce(); expect(saver.dirty).toBe(true);
  saver.end('light.exposure'); saver.end('light.exposure'); await drain();
  expect(api.saveRawHistory).toHaveBeenCalledTimes(2); expect(saver.dirty).toBe(false);
  const request = vi.mocked(api.saveRawHistory).mock.calls[1][0];
  expect(request.control).toBe('light.exposure'); expect(request.doc.values['light.exposure']).toBe(2);
  expect(controls.confirmed.recipeRevision).toBe(saver.revision);
  expect(saver.savedFingerprint).toBe(controls.confirmed.settingsFingerprint);
  expect(api.saveRawRecipe).not.toHaveBeenCalled();
});

it('never autosaves an open gesture even after five seconds', async () => {
  const { saver } = owner(); await saver.save();
  saver.change('light.exposure', 1);
  await vi.advanceTimersByTimeAsync(6000); await drain();
  expect(saver.dirty).toBe(true); expect(api.saveRawHistory).toHaveBeenCalledOnce(); expect(api.saveRawRecipe).not.toHaveBeenCalled();
  await saver.save(); expect(saver.dirty).toBe(false);
});

it('flushes a change without begin and serializes an adjacent control after the previous ack', async () => {
  const { saver } = owner(); await saver.save();
  const pending = gate<api.RawHistoryResult>();
  vi.mocked(api.saveRawHistory).mockReturnValueOnce(pending.promise);
  saver.change('light.exposure', 1);
  saver.begin('light.contrast'); saver.change('light.contrast', 10); saver.end('light.contrast');
  await drain();
  expect(api.setRawControls).toHaveBeenCalledOnce();
  const request = vi.mocked(api.saveRawHistory).mock.calls[1][0];
  expect(request.control).toBe('light.exposure'); expect(request.doc.values['light.contrast']).toBe(0);
  pending.resolve(rawHistoryResult(request)); await drain();
  expect(api.setRawControls).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.saveRawHistory).mock.calls[2][0].control).toBe('light.contrast');
  expect(saver.dirty).toBe(false);
});

it('retains an adjacent unsent intent across save failure and drains it after explicit retry', async () => {
  const { saver, controls } = owner(); await saver.save();
  vi.mocked(api.saveRawHistory).mockRejectedValueOnce(new api.RawSaveError('raw_history_save_failed', 'unknown'));
  saver.change('light.exposure', 1); saver.change('light.contrast', 20); saver.end('light.contrast'); await drain();
  expect(saver.locked).toBe(true); expect(controls.confirmed.values['light.contrast']).toBe(0);
  saver.pause(); await saver.save(true); await drain();
  expect(controls.confirmed.values['light.contrast']).toBe(20); expect(saver.dirty).toBe(false);
  expect(vi.mocked(api.saveRawHistory).mock.calls[3][0].control).toBe('light.contrast');
});

it.each(api.RAW_CONTROL_IDS)('records the control identity for %s', async control => {
  const { saver } = owner(); await saver.save();
  saver.change(control, control === 'wb.temp' ? 7000 : 1); saver.end(control); await drain();
  expect(vi.mocked(api.saveRawHistory).mock.calls[1][0].control).toBe(control);
});

it('sends no-op confirmed intent without inventing a step or rewriting the redo branch', async () => {
  const { saver } = owner(); await saver.save();
  const retained = { initialized: true, cursor: 0, length: 2, selectedStepId: null };
  vi.mocked(api.saveRawHistory).mockImplementation(async request => rawHistoryResult(request, { history: retained }));
  saver.change('light.exposure', 1); await vi.advanceTimersByTimeAsync(150); await drain();
  saver.change('light.exposure', 0); saver.end(); await drain();
  expect(saver.dirty).toBe(false); expect(saver.confirmed.settingsFingerprint).toBe(initial().settingsFingerprint);
  expect((saver.confirmed as api.RawHistoryResult).history).toEqual(retained);
});

it('keeps the immutable unknown request and native edit, rejects new edits, then resumes after retry', async () => {
  const { saver, controls } = owner(); await saver.save();
  vi.mocked(api.saveRawHistory).mockRejectedValueOnce(new api.RawSaveError('raw_connection_failed', 'unknown'));
  saver.change('light.exposure', 2); saver.end(); await drain();
  const request = structuredClone(vi.mocked(api.saveRawHistory).mock.calls[1][0]);
  expect(saver.error).toBe('raw_connection_failed'); expect(saver.dirty).toBe(true);
  saver.change('light.exposure', 4); saver.begin('light.contrast');
  expect(controls.confirmed.values['light.exposure']).toBe(2);
  vi.mocked(api.saveRawHistory).mockRejectedValueOnce(new api.RawSaveError('raw_busy', 'rejected', 409));
  await expect(saver.save(true)).rejects.toThrow('raw_busy'); await saver.save(true);
  expect(vi.mocked(api.saveRawHistory).mock.calls.slice(1).map(call => call[0])).toEqual([request, request, request]);
  saver.change('light.exposure', 3); saver.end(); await drain();
  expect(saver.error).toBeUndefined(); expect(controls.confirmed.values['light.exposure']).toBe(3);
});

it.each([{ historyPending: true }, { nativeState: 'desynchronized' }, { nativeMatchesRecipe: false },
  { recipeFingerprint: 'f'.repeat(64) }, { recipeRevision: 99 }, { generation: 2 }])(
  'does not mark an old or uncertain ack clean: %j', async patch => {
    const { saver } = owner(); await saver.save();
    vi.mocked(api.saveRawHistory).mockImplementationOnce(async request => rawHistoryResult(request, { replayed: true, ...patch }));
    saver.change('light.exposure', 1); saver.end(); await drain();
    expect(saver.dirty).toBe(true); expect(saver.locked).toBe(true); expect(saver.revision).toBe(1);
    await saver.save(true); expect(saver.dirty).toBe(false); expect(saver.revision).toBe(2);
  });

it('rejects a save after disposal without applying its late acknowledgement', async () => {
  const { saver } = owner(); await saver.save();
  const pending = gate<api.RawHistoryResult>(); vi.mocked(api.saveRawHistory).mockReturnValueOnce(pending.promise);
  saver.change('light.exposure', 1);
  const saving = saver.save(); await drain(); const request = vi.mocked(api.saveRawHistory).mock.calls[1][0];
  saver.dispose(); pending.resolve(rawHistoryResult(request));
  await expect(saving).rejects.toThrow('raw_document_closed'); expect(saver.revision).toBe(1);
});

it('rejects current cursor metadata that differs from the acknowledged checkpoint', async () => {
  const { saver } = owner(); await saver.save();
  vi.mocked(api.saveRawHistory).mockImplementationOnce(async request => ({ ...rawHistoryResult(request),
    history: { initialized: true, cursor: 0, length: 1, selectedStepId: null } }));
  saver.change('light.exposure', 1); saver.end(); await drain();
  expect(saver.dirty).toBe(true); expect(saver.revision).toBe(1); expect(saver.error).toBe('raw_save_unconfirmed');
});
