import type { RawDocument, RawHistoryData, RawHistoryRequest, RawHistoryResult } from '../rawApi';
import { RawSaveError } from '../rawApi';
import { rawSettings } from './rawSettings';

export function rawHistoryResult(request: RawHistoryRequest, patch: Partial<RawHistoryResult> = {}): RawHistoryResult {
  const length = request.action === 'commit' ? 1 : 0;
  const history = patch.history ?? { initialized: true, cursor: length, length, selectedStepId: length ? request.saveId : null };
  return { ...request.doc, recipeRevision: request.expectedRecipeRevision + 1,
    recipeFingerprint: request.doc.settingsFingerprint, historyPending: false, nativeState: 'synced', nativeMatchesRecipe: true,
    history, replayed: false,
    ack: { saveId: request.saveId, revision: request.expectedRecipeRevision + 1,
      settingsFingerprint: request.doc.settingsFingerprint, updatedAt: '2026-10-23T00:00:00Z',
      historyCursor: history.cursor, historyLength: history.length, stepId: history.selectedStepId }, ...patch };
}

export function rawHistoryData(doc: RawDocument): RawHistoryData {
  const value = doc as RawHistoryResult;
  const history = value.history ?? { initialized: false, cursor: 0, length: 0, selectedStepId: null };
  return { ...doc, recipeRevision: doc.recipeRevision ?? 0, recipeFingerprint: doc.recipeFingerprint ?? null,
    history, historyPending: false, nativeState: 'synced', nativeMatchesRecipe: true,
    steps: Array.from({ length: history.length }, (_, i) => ({
      stepId: i + 1 === history.cursor && history.selectedStepId ? history.selectedStepId
        : `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      kind: 'control', metadata: { control: 'light.exposure' }, createdAt: '2026-10-23T00:00:00Z',
      changes: [{ control: 'light.exposure', before: i, after: i + 1 }] })) };
}

/** Test transport model: metadata/snapshots belong to this fake Backend, never the hook. */
export function fakeRawHistory(count = 2, initialCursor = count, attempts = 0) {
  const entries = Array.from({ length: count }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    exposure: count > 5 ? (i + 1) / 100 : i + 1 }));
  let cursor = initialCursor, revision = 8;
  const receipts = new Map<string, RawHistoryResult>();
  const value = () => cursor ? entries[cursor - 1].exposure : 0;
  const fingerprint = (n: number) => String(Math.round(n * 100) + 1000).padStart(64, '0');
  const metadata = () => ({ initialized: true, cursor, length: entries.length, selectedStepId: cursor ? entries[cursor - 1].id : null });
  return { entries, cursor: () => cursor,
    settings: (doc: RawDocument) => ({ ...rawSettings(doc), recipeRevision: revision, settingsFingerprint: fingerprint(value()),
      recipeFingerprint: fingerprint(value()), mutationAttempts: doc.generation === 1 ? attempts : 1,
      values: { ...rawSettings(doc).values, 'light.exposure': value() } }),
    save: (request: RawHistoryRequest): RawHistoryResult => {
      const replay = receipts.get(request.saveId); if (replay) return { ...replay, replayed: true };
      const moving = ['undo', 'redo', 'jump'].includes(request.action);
      if (request.action === 'undo') cursor = Math.max(0, cursor - 1);
      if (request.action === 'redo') cursor = Math.min(entries.length, cursor + 1);
      if (request.action === 'jump') {
        const index = entries.findIndex(e => e.id === request.targetStepId);
        if (request.targetStepId !== null && index < 0) throw new RawSaveError('raw_history_target_missing', 'rejected', 409);
        cursor = request.targetStepId === null ? 0 : index + 1;
      }
      if (request.action === 'commit' && value() !== request.doc.values['light.exposure']) {
        entries.splice(cursor); entries.push({ id: request.saveId, exposure: request.doc.values['light.exposure'] }); cursor++;
      }
      const next = moving ? { ...request.doc, revision: request.doc.revision + 1,
        settingsFingerprint: fingerprint(value()), values: { ...request.doc.values, 'light.exposure': value() }, mutationAttempts: ++attempts } : request.doc;
      const result = rawHistoryResult({ ...request, doc: next }, { history: metadata() });
      revision = result.recipeRevision; receipts.set(request.saveId, result); return result;
    },
    history: (doc: RawDocument): RawHistoryData => ({ ...rawHistoryData(doc), recipeRevision: revision,
      history: metadata(), steps: entries.map((entry, index) => ({ stepId: entry.id,
        kind: 'control', metadata: { control: 'light.exposure' }, createdAt: '2026-10-23T00:00:00Z',
        changes: [{ control: 'light.exposure', before: index ? entries[index - 1].exposure : 0,
          after: entry.exposure }] })) }),
  };
}
