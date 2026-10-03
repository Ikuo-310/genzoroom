import type { ImmichStack, RecentAsset } from './assets';
import type { DraftStack, StackDetection } from './stackCandidateDetection';

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
