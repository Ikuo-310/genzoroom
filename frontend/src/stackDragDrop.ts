import { isSingletonImmichStack } from './immichStackDraft';

export const STACK_DRAG_TYPE = 'application/x-genzoroom-stack-photo+json';
export type StackDragPayload = { assetId: string; sourceGroupId: string | null };

export function parseStackDragPayload(raw: string): StackDragPayload | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    const item = value as Record<string, unknown>;
    if (keys.length !== 2 || !keys.includes('assetId') || !keys.includes('sourceGroupId')
      || typeof item.assetId !== 'string' || !item.assetId || item.assetId.length > 500
      || !(item.sourceGroupId === null || (typeof item.sourceGroupId === 'string' && !!item.sourceGroupId && item.sourceGroupId.length <= 500))) return null;
    return { assetId: item.assetId, sourceGroupId: item.sourceGroupId };
  } catch { return null; }
}

export function isStackDrag(transfer: Pick<DataTransfer, 'types' | 'files'> | null | undefined) {
  if (!transfer || transfer.files.length > 0) return false;
  return Array.from(transfer.types).some(type => type.toLowerCase() === STACK_DRAG_TYPE);
}

export function readStackDragPayload(transfer: Pick<DataTransfer, 'types' | 'files' | 'getData'> | null | undefined): StackDragPayload | null {
  if (!isStackDrag(transfer) || !transfer) return null;
  try { return parseStackDragPayload(transfer.getData(STACK_DRAG_TYPE)); } catch { return null; }
}

export function canDropStackPayload(payload: StackDragPayload, targetGroupId: string | null,
  groups: readonly { id: string; members: readonly { id: string }[]; origin?: string; originalMemberIds?: readonly string[]; trashAssetIds?: readonly string[] }[], unmatched: readonly { id: string }[]) {
  const source = payload.sourceGroupId === null ? null : groups.find(group => group.id === payload.sourceGroupId);
  if (payload.sourceGroupId !== null && (!source || isSingletonImmichStack(source) || source.trashAssetIds?.length)) return false;
  if (targetGroupId === null) {
    return source != null && source.members.some(member => member.id === payload.assetId);
  }
  const target = groups.find(group => group.id === targetGroupId);
  if (!target || isSingletonImmichStack(target) || target.members.some(member => member.id === payload.assetId)
    || payload.sourceGroupId !== null && target.trashAssetIds?.length) return false;
  if (payload.sourceGroupId === null) {
    return unmatched.some(asset => asset.id === payload.assetId)
      && !groups.some(group => group.members.some(member => member.id === payload.assetId));
  }
  return payload.sourceGroupId !== targetGroupId
    && !!source?.members.some(member => member.id === payload.assetId)
    && !groups.some(group => group.id !== payload.sourceGroupId && group.members.some(member => member.id === payload.assetId))
    && !unmatched.some(asset => asset.id === payload.assetId);
}

export function canCreateStackFromUnmatchedDrop(payload: StackDragPayload, targetAssetId: string,
  groups: readonly { members: readonly { id: string }[] }[], unmatched: readonly { id: string }[]) {
  const { assetId, sourceGroupId } = payload;
  if (sourceGroupId !== null || !assetId || assetId.length > 500 || !targetAssetId || targetAssetId.length > 500 || assetId === targetAssetId) return false;
  const occursOnceUnmatched = (id: string) => unmatched.filter(asset => asset.id === id).length === 1;
  const belongsToGroup = (id: string) => groups.some(group => group.members.some(member => member.id === id));
  return occursOnceUnmatched(assetId) && occursOnceUnmatched(targetAssetId)
    && !belongsToGroup(assetId) && !belongsToGroup(targetAssetId);
}
