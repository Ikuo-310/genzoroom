import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from './rawApi';
import { RawControls } from './rawControls';
import { RawRecipeSave } from './rawRecipeSave';
import { rawSettings } from './test/rawSettings';
import { rawHistoryResult, rawHistoryPage } from './test/rawHistory';

vi.mock('./rawApi', async original => ({ ...await original<typeof import('./rawApi')>(),
  readRawHistory: vi.fn(), saveRawHistory: vi.fn(), saveRawRecipe: vi.fn(), setRawControls: vi.fn(), readRawSettings: vi.fn() }));
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
  vi.mocked(api.readRawHistory).mockReset().mockImplementation(async (doc, offset) => rawHistoryPage(doc, offset));
  vi.useFakeTimers(); vi.clearAllMocks(); queue = Promise.resolve();
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

function historyBackend(length = 3, cursor = length, sameSettings = false) {
  const entries = Array.from({ length }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    value: sameSettings ? 1 : i + 1 }));
  let position = cursor;
  const value = () => position ? entries[position - 1].value : 0;
  const settings = { ...initial(), recipeRevision: 10, revision: 5, settingsFingerprint: fp(1000 + value() * 100),
    recipeFingerprint: fp(1000 + value() * 100), values: { ...initial().values, 'light.exposure': value() } };
  const receipts = new Map<string, api.RawHistoryResult>();
  vi.mocked(api.saveRawHistory).mockImplementation(async request => {
    const replay = receipts.get(request.saveId);
    if (replay) return { ...replay, replayed: true };
    let moved = false;
    if (request.action === 'undo') { position = Math.max(0, position - 1); moved = true; }
    if (request.action === 'redo') { position = Math.min(entries.length, position + 1); moved = true; }
    if (request.action === 'jump') {
      const index = entries.findIndex(e => e.id === request.targetStepId);
      if (request.targetStepId !== null && index < 0) throw new api.RawSaveError('raw_history_target_missing', 'rejected', 409);
      position = request.targetStepId === null ? 0 : index + 1; moved = true;
    }
    if (request.action === 'commit' && request.doc.settingsFingerprint !== fp(1000 + value() * 100)) {
      entries.splice(position); entries.push({ id: request.saveId, value: request.doc.values['light.exposure'] }); position++;
      if (entries.length > 200) { entries.shift(); position--; }
    }
    const next = moved ? { ...request.doc, values: { ...request.doc.values, 'light.exposure': value() },
      settingsFingerprint: fp(1000 + value() * 100),
      revision: request.doc.revision + (request.doc.settingsFingerprint === fp(1000 + value() * 100) ? 0 : 1) } : request.doc;
    const result = rawHistoryResult({ ...request, doc: next }, { history: { initialized: true, cursor: position, length: entries.length,
      selectedStepId: position ? entries[position - 1].id : null } });
    receipts.set(request.saveId, result); return result;
  });
  vi.mocked(api.readRawHistory).mockImplementation(async (doc, offset) => ({ ...rawHistoryPage(doc, offset),
    steps: entries.slice(offset, offset + 20).map((e, index) => ({ stepId: e.id, kind: 'control', metadata: { control: 'light.exposure' },
      createdAt: '2026-10-23T00:00:00Z', changes: [{ control: 'light.exposure', before: index ? entries[offset + index - 1].value : 0, after: e.value }] })) }));
  return { settings, entries, position: () => position };
}

it('moves Undo/Redo/jump/baseline through Backend and updates controls without appending steps', async () => {
  const backend = historyBackend(), { saver, controls } = owner(backend.settings); await saver.save();
  await saver.move('undo'); expect(saver.history?.cursor).toBe(2); expect(controls.confirmed.values['light.exposure']).toBe(2);
  await saver.move('redo'); expect(saver.history?.cursor).toBe(3);
  await saver.move('jump', backend.entries[0].id); expect(saver.history?.cursor).toBe(1);
  await saver.move('jump', null); expect(saver.history?.cursor).toBe(0); expect(saver.canUndo).toBe(false);
  const count = vi.mocked(api.saveRawHistory).mock.calls.length;
  await saver.move('undo'); expect(api.saveRawHistory).toHaveBeenCalledTimes(count);
  expect(saver.canRedo).toBe(true); expect(controls.confirmed.values['light.exposure']).toBe(0);
  expect(backend.entries).toHaveLength(3); expect(saver.dirty).toBe(false);
  expect(vi.mocked(api.saveRawHistory).mock.calls.map(([r]) => r.action)).toEqual(['initialize', 'undo', 'redo', 'jump', 'jump']);
});

it('handles equal settings at different cursors without relying on native revision changes', async () => {
  const backend = historyBackend(3, 3, true), { saver } = owner(backend.settings); await saver.save();
  const revision = saver.confirmed.revision, fingerprint = saver.savedFingerprint;
  await saver.move('undo');
  expect(saver.history?.cursor).toBe(2); expect(saver.confirmed.revision).toBe(revision); expect(saver.savedFingerprint).toBe(fingerprint);
  expect(saver.revision).toBe(12);
});

it('commits the open gesture before Undo and cuts redo only on a new effective commit', async () => {
  const backend = historyBackend(), { saver } = owner(backend.settings); await saver.save();
  saver.change('light.exposure', 4); await saver.move('undo');
  expect(vi.mocked(api.saveRawHistory).mock.calls.map(([r]) => r.action)).toEqual(['initialize', 'commit', 'undo']);
  expect(backend.entries).toHaveLength(4); expect(saver.history?.cursor).toBe(3); expect(saver.canRedo).toBe(true);
  saver.change('light.exposure', 5); saver.end(); await drain();
  expect(saver.history?.length).toBe(4); expect(saver.canRedo).toBe(false); expect(backend.entries.at(-1)?.value).toBe(5);
});

it('does not retarget a removed redo UUID and keeps the preceding gesture saved', async () => {
  const backend = historyBackend(3, 1), { saver } = owner(backend.settings); await saver.save();
  saver.change('light.exposure', 9); await saver.move('jump', backend.entries[2].id);
  expect(vi.mocked(api.saveRawHistory).mock.calls.map(([r]) => r.action)).toEqual(['initialize', 'commit', 'jump']);
  expect(saver.error).toBeUndefined(); expect(saver.historyError).toBe('raw_history_target_missing');
  expect(saver.history?.length).toBe(2); expect(saver.dirty).toBe(false);
  saver.loadMoreHistory(true); await drain(); expect(saver.historyError).toBeUndefined();
});

it('uses the stable requested UUID even when a valid older target leaves the refreshed display page', async () => {
  const backend = historyBackend(200), { saver } = owner(backend.settings); await saver.save();
  for (let i = 0; i < 5; i++) { saver.loadMoreHistory(); await drain(); }
  const target = backend.entries[100].id;
  saver.change('light.exposure', 201); await saver.move('jump', target);
  expect(vi.mocked(api.saveRawHistory).mock.calls.at(-1)?.[0]).toMatchObject({ action: 'jump', targetStepId: target });
  expect(saver.history?.selectedStepId).toBe(target); expect(saver.history?.cursor).toBe(100);
  expect(saver.confirmed.values['light.exposure']).toBe(101); expect(saver.historyError).toBeUndefined();
});

it('bounds History fetches to pages of 20, handles 200 entries and finds selection after baseline/redo', async () => {
  const backend = historyBackend(200), { saver } = owner(backend.settings); await saver.save();
  expect(saver.steps).toHaveLength(20); expect(saver.historyOffset).toBe(180);
  expect(api.readRawHistory).toHaveBeenCalledOnce();
  for (let i = 0; i < 9; i++) { saver.loadMoreHistory(); await drain(); }
  expect(saver.steps).toHaveLength(200); expect(saver.historyOffset).toBe(0);
  expect(vi.mocked(api.readRawHistory).mock.calls.map(([, offset]) => offset)).toEqual([180, 160, 140, 120, 100, 80, 60, 40, 20, 0]);
  const fresh = owner(backend.settings); await fresh.saver.save();
  await fresh.saver.move('jump', null); await fresh.saver.move('redo');
  expect(fresh.saver.historyOffset).toBe(0); expect(fresh.saver.steps[0].stepId).toBe(backend.entries[0].id);
  fresh.saver.loadMoreHistory(false, true); await drain(); expect(fresh.saver.steps).toHaveLength(40);
});

it('retries the same uncertain cursor move and blocks duplicate moves/new gestures until ack', async () => {
  const backend = historyBackend(), { saver } = owner(backend.settings); await saver.save();
  const write = vi.mocked(api.saveRawHistory).getMockImplementation()!;
  vi.mocked(api.saveRawHistory).mockImplementationOnce(async request => {
    await write(request); throw new api.RawSaveError('raw_history_save_failed', 'unknown');
  });
  await expect(saver.move('undo')).rejects.toThrow();
  const request = vi.mocked(api.saveRawHistory).mock.calls[1][0];
  expect(saver.history?.cursor).toBe(3); expect(saver.confirmed.values['light.exposure']).toBe(3);
  saver.change('light.exposure', 9); await saver.move('redo');
  expect(api.saveRawHistory).toHaveBeenCalledTimes(2);
  await saver.save(true); expect(vi.mocked(api.saveRawHistory).mock.calls[2][0]).toEqual(request);
  expect(saver.history?.cursor).toBe(2); expect(saver.confirmed.values['light.exposure']).toBe(2); expect(saver.dirty).toBe(false);
});

it('accepts only one in-flight move and rejects late results after disposal', async () => {
  const backend = historyBackend(), { saver } = owner(backend.settings); await saver.save();
  const pending = gate<api.RawHistoryResult>(), write = vi.mocked(api.saveRawHistory).getMockImplementation()!;
  vi.mocked(api.saveRawHistory).mockReturnValueOnce(pending.promise);
  const moving = saver.move('undo'); await drain();
  await saver.move('undo'); await saver.move('jump', null); expect(api.saveRawHistory).toHaveBeenCalledTimes(2);
  const request = vi.mocked(api.saveRawHistory).mock.calls[1][0]; saver.dispose(); pending.resolve(await write(request));
  await expect(moving).rejects.toThrow('raw_document_closed'); expect(saver.history?.cursor).toBe(3);
});

it('retains the requested Undo behind an uncertain gesture commit and completes both on Retry', async () => {
  const backend = historyBackend(), { saver } = owner(backend.settings); await saver.save();
  vi.mocked(api.saveRawHistory).mockRejectedValueOnce(new api.RawSaveError('raw_connection_failed', 'unknown'));
  saver.change('light.exposure', 4); await expect(saver.move('undo')).rejects.toThrow();
  expect(saver.history?.cursor).toBe(3); const request = vi.mocked(api.saveRawHistory).mock.calls[1][0];
  await saver.save(true);
  expect(vi.mocked(api.saveRawHistory).mock.calls[2][0]).toEqual(request);
  expect(vi.mocked(api.saveRawHistory).mock.calls[3][0].action).toBe('undo');
  expect(saver.history?.cursor).toBe(3); expect(saver.history?.length).toBe(4); expect(saver.dirty).toBe(false);
});

it('loads the selected page on reopen and retains aligned pages for 21 entries', async () => {
  const backend = historyBackend(200, 41), { saver } = owner(backend.settings); await saver.save();
  expect(saver.historyOffset).toBe(40); expect(saver.steps[0].stepId).toBe(backend.entries[40].id);
  const other = historyBackend(21), fresh = owner(other.settings); await fresh.saver.save();
  expect(fresh.saver.historyOffset).toBe(20); expect(fresh.saver.steps).toHaveLength(1);
  fresh.saver.loadMoreHistory(); await drain(); expect(fresh.saver.steps).toHaveLength(21);
});

it('retries metadata loading without another save or move and refuses unverified pages', async () => {
  const backend = historyBackend(), { saver } = owner(backend.settings);
  vi.mocked(api.readRawHistory).mockRejectedValueOnce(new api.RawApiError('raw_history_unavailable'));
  await saver.save(); expect(saver.historyError).toBe('raw_history_unavailable'); expect(saver.dirty).toBe(false);
  await saver.move('undo'); expect(api.saveRawHistory).toHaveBeenCalledOnce();
  saver.loadMoreHistory(true); await drain(); expect(saver.historyError).toBeUndefined();
  vi.mocked(api.readRawHistory).mockImplementationOnce(async (doc, offset) => ({ ...rawHistoryPage(doc, offset), recipeRevision: 99 }));
  saver.loadMoreHistory(true); await drain(); expect(saver.historyError).toBe('raw_history_revision_conflict');
  expect(saver.steps).toHaveLength(3); expect(saver.revision).toBe(11);
});
