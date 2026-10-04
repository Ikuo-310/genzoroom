import type { ImmichStack, RecentAsset } from './assets';
import type { DraftStack, StackDetection } from './stackCandidateDetection';

export function isSingletonImmichStack(group: { origin?: string; originalMemberIds?: readonly string[] }) {
  return group.origin === 'immich' && group.originalMemberIds?.length === 1;
}

function sameMemberIds(current: readonly string[], original: readonly string[]) {
  const ids = new Set(current);
  return ids.size === current.length && new Set(original).size === original.length
    && current.length === original.length && original.every(id => ids.has(id));
}

export function reconcileImmichLineage(groups: readonly DraftStack[], source: readonly DraftStack[]): DraftStack[] {
  const snapshots = source.filter(group => group.origin === 'immich');
  const active = new Set(groups.flatMap(group => group.origin === 'immich' ? [group.immichStackId] : []));
  return groups.map(group => {
    let restored = group;
    if (group.origin !== 'immich') {
      const matches = snapshots.filter(snapshot => sameMemberIds(group.members.map(asset => asset.id), snapshot.originalMemberIds));
      // Ambiguous snapshots and active lineages must never acquire another editable owner.
      if (matches.length === 1 && !active.has(matches[0].immichStackId)) {
        const snapshot = matches[0];
        active.add(snapshot.immichStackId);
        restored = { ...group, origin: 'immich', immichStackId: snapshot.immichStackId,
          originalMemberIds: snapshot.originalMemberIds, originalPrimaryAssetId: snapshot.originalPrimaryAssetId };
      }
    }
    if (restored.origin !== 'immich') return restored;
    return { ...restored, modified: !sameMemberIds(restored.members.map(asset => asset.id), restored.originalMemberIds)
      || restored.coverAssetId !== restored.originalPrimaryAssetId };
  });
}

export function isStackDraftModified(groups: readonly DraftStack[], source: readonly DraftStack[]) {
  if (groups.length !== source.length) return true;
  return source.some(original => {
    const matches = groups.filter(group => original.origin === 'immich'
      ? group.origin === 'immich' && group.immichStackId === original.immichStackId
      : group.id === original.id && group.origin === original.origin);
    if (matches.length !== 1) return true;
    const current = matches[0];
    if (original.origin === 'immich') return current.modified === true;
    // Auto membership edits retain their MANUAL semantics even if members are later restored.
    return current.modified !== original.modified || current.coverAssetId !== original.coverAssetId
      || current.members.length !== original.members.length
      || current.members.some((asset, index) => asset.id !== original.members[index].id);
  });
}

export function mergeImmichStackSource(detection: StackDetection, stacks: readonly ImmichStack[], selected: readonly RecentAsset[]) {
  const immichGroups: DraftStack[] = stacks.map(stack => ({
    id: `draft:immich:${stack.id}`, origin: 'immich', immichStackId: stack.id,
    originalPrimaryAssetId: stack.primaryAssetId, originalMemberIds: Object.freeze(stack.assets.map(asset => asset.id)),
    members: [...stack.assets], coverAssetId: stack.primaryAssetId, modified: false,
    evidence: { name: 'unavailable', nameReason: 'exact', time: 'unavailable', camera: 'unavailable', gps: 'unavailable' },
  }));
  const memberIds = new Set(stacks.flatMap(stack => stack.assets.map(asset => asset.id.toLowerCase())));
  const overlapping = detection.groups.filter(group => group.members.some(asset => memberIds.has(asset.id.toLowerCase())));
  // A newly resolved full member can overlap the preceding detection generation during loading.
  const groups = [...immichGroups, ...detection.groups.filter(group => !overlapping.includes(group))];
  const assets = [...new Map([...selected, ...stacks.flatMap(stack => stack.assets)].map(asset => [asset.id.toLowerCase(), asset])).values()];
  const order = new Map(assets.map((asset, index) => [asset.id.toLowerCase(), index]));
  const unmatched = [...new Map([...detection.unmatched, ...overlapping.flatMap(group => group.members)]
    .filter(asset => asset.stackId == null && !memberIds.has(asset.id.toLowerCase()))
    .map(asset => [asset.id.toLowerCase(), asset])).values()].sort((a, b) => order.get(a.id.toLowerCase())! - order.get(b.id.toLowerCase())!);
  return { source: { groups, unmatched }, assets };
}
