import type { DraftStack } from './stackCandidateDetection';
import { canReserveStackTrash, stackTrashSource } from './immichStackDraft';

export type StackWriteOperation = { operationId: string; type: 'create' | 'update' | 'delete'; stackId?: string; memberIds?: string[]; primaryAssetId?: string; trashAssetIds?: string[]; expectedMemberIds?: string[]; expectedPrimaryAssetId?: string };
export type StackWriteResult = { operationId: string; status: 'success' | 'failed' | 'unknown' | 'blocked'; stackId?: string; releasedStackId?: string; errorCode?: string; trashStatus?: 'success' | 'failed' | 'unknown' | 'blocked' };
export type StackWritePlan = { operations: StackWriteOperation[]; unchanged: string[]; operationGroupIds?: Record<string, string> };

export function buildStackWritePlan(groups: readonly DraftStack[], source: readonly DraftStack[]): StackWritePlan {
  const operations: StackWriteOperation[] = [], unchanged: string[] = [];
  const operationGroupIds: Record<string, string> = {};
  const members = new Set<string>(), lineages = new Set<string>();
  const reservedIds = new Set(groups.map(group => group.id));
  for (const original of source) if (original.origin === 'immich') reservedIds.add(`delete:${original.immichStackId}`);
  const usedOperationIds = new Set<string>();
  const allocateOperationId = (preferred: string, groupId?: string) => {
    let operationId = preferred;
    if (operationId.length > 200 || usedOperationIds.has(operationId)) {
      let suffix = operations.length;
      do { operationId = `stack-op-${suffix++}`; }
      while (reservedIds.has(operationId) || usedOperationIds.has(operationId));
      if (groupId !== undefined) operationGroupIds[operationId] = groupId;
    }
    usedOperationIds.add(operationId);
    return operationId;
  };
  for (const group of groups) {
    const trashAssetIds = [...(group.trashAssetIds ?? [])];
    if (new Set(trashAssetIds).size !== trashAssetIds.length || trashAssetIds.some(id => !canReserveStackTrash(group, id))) throw new Error('Invalid trash reservation');
    const trashSource = stackTrashSource(group);
    const memberIds = group.members.filter(asset => !trashAssetIds.includes(asset.id)).map(asset => asset.id);
    if (new Set(memberIds).size !== memberIds.length || memberIds.length < 1 || !memberIds.includes(group.coverAssetId)) throw new Error('Invalid draft membership');
    for (const id of [...memberIds, ...trashAssetIds]) {
      if (members.has(id)) throw new Error('Duplicate draft membership');
      members.add(id);
    }
    if (group.origin === 'immich') {
      if (lineages.has(group.immichStackId)) throw new Error('Duplicate lineage');
      lineages.add(group.immichStackId);
      const matches = source.filter(original => original.origin === 'immich' && original.immichStackId === group.immichStackId);
      if (matches.length !== 1) throw new Error('Ambiguous lineage');
      const snapshot = matches[0];
      if (!snapshot || snapshot.origin !== 'immich') throw new Error('Missing original Stack');
      if (!trashAssetIds.length && memberIds.length === snapshot.originalMemberIds.length && snapshot.originalMemberIds.every(id => memberIds.includes(id)) && group.coverAssetId === snapshot.originalPrimaryAssetId) {
        // A dissolve-only singleton must remain visible after sending, so it is not completed as unchanged.
        if (snapshot.originalMemberIds.length === 1) continue;
        unchanged.push(group.id); continue;
      }
      if (snapshot.originalMemberIds.length === 1) throw new Error('Singleton Stack is dissolve-only');
    }
    if (memberIds.length < 2 && !trashAssetIds.length) throw new Error('Invalid draft membership');
    operations.push({ operationId: allocateOperationId(group.id, group.id), type: group.origin === 'immich' ? 'update' : 'create',
      ...(group.origin === 'immich' ? { stackId: group.immichStackId } : {}), memberIds, primaryAssetId: group.coverAssetId,
      ...(trashAssetIds.length ? { trashAssetIds, expectedMemberIds: [...trashSource!.memberIds],
        expectedPrimaryAssetId: trashSource!.primaryAssetId } : {}) });
  }
  for (const original of source) {
    if (original.origin === 'immich' && !groups.some(group => group.origin === 'immich' && group.immichStackId === original.immichStackId)) {
      operations.push({ operationId: allocateOperationId(`delete:${original.immichStackId}`), type: 'delete', stackId: original.immichStackId });
    }
  }
  return { operations, unchanged, ...(Object.keys(operationGroupIds).length ? { operationGroupIds } : {}) };
}

export async function sendStackWritePlan(operations: readonly StackWriteOperation[], signal: AbortSignal): Promise<StackWriteResult[]> {
  if (!operations.length) return [];
  const response = await fetch('/api/stacks/apply', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operations }) });
  if ([400, 413, 422].includes(response.status)) return operations.map(operation => ({ operationId: operation.operationId, status: 'failed', errorCode: 'invalid_request' }));
  if (!response.ok) throw new Error('Stack write outcome unknown');
  const body: unknown = await response.json();
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== operations.length) throw new Error('Invalid Stack results');
  const seen = new Set<string>();
  for (const result of results) {
    const operation = operations.find(op => op.operationId === result?.operationId);
    if (!operation || seen.has(result.operationId) || !['success','failed','unknown','blocked'].includes(result.status)
      || (result.releasedStackId !== undefined && result.releasedStackId !== operation.stackId)
      || (result.status === 'success' && operation.type !== 'delete' && operation.memberIds?.length !== 1 && (typeof result.stackId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.stackId)))) throw new Error('Invalid Stack results');
    if (result.trashStatus !== undefined && (!operation.trashAssetIds?.length || !['success','failed','unknown','blocked'].includes(result.trashStatus))) throw new Error('Invalid trash results');
    if (operation.trashAssetIds?.length && result.status === 'success' && result.trashStatus === undefined) throw new Error('Missing trash results');
    seen.add(result.operationId);
  }
  return results;
}
