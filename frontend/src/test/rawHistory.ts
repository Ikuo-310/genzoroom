import type { RawHistoryRequest, RawHistoryResult } from '../rawApi';

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
