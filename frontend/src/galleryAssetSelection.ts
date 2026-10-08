import type { ImmichStack, RecentAsset } from './assets';
import type { AnshitsuInitialSelection } from './appSettings';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GalleryAssetSelection =
  | { status: 'unavailable'; selectedAssetIds: ReadonlySet<string>; assets: null }
  | { status: 'ready'; selectedAssetIds: ReadonlySet<string>; assets: readonly RecentAsset[] };

function unavailable(): GalleryAssetSelection {
  return { status: 'unavailable', selectedAssetIds: new Set(), assets: null };
}

/** Resolves one card's targets. Unstacked assets keep their existing direct-selection semantics. */
export function selectGalleryAssetTargets(
  card: RecentAsset,
  preset: AnshitsuInitialSelection,
  manualAssetIds?: ReadonlySet<string>,
): GalleryAssetSelection {
  if (card.stackId == null) {
    if (!UUID.test(card.id)) return unavailable();
    return { status: 'ready', selectedAssetIds: new Set([card.id.toLowerCase()]), assets: [card] };
  }

  const stackId = card.stackId.toLowerCase();
  const primaryId = card.primaryAssetId?.toLowerCase();
  const members = card.stackMembers;
  if (!UUID.test(stackId) || !primaryId || !UUID.test(primaryId) || !Array.isArray(members) || members.length === 0
    || !Number.isSafeInteger(card.stackAssetCount) || card.stackAssetCount !== members.length) return unavailable();

  const byId = new Map<string, RecentAsset>();
  for (const member of members) {
    if (!UUID.test(member.id) || member.stackId?.toLowerCase() !== stackId
      || member.primaryAssetId?.toLowerCase() !== primaryId || typeof member.filename !== 'string' || member.filename.length === 0
      || typeof member.format !== 'string' || member.format.length === 0
      || typeof member.is_raw !== 'boolean' || typeof member.isGenzoRoomExport !== 'boolean') return unavailable();
    const id = member.id.toLowerCase();
    if (byId.has(id)) return unavailable();
    byId.set(id, member);
  }
  if (card.id.toLowerCase() !== primaryId || !byId.has(primaryId)
    || (card.stackMemberIds != null && (card.stackMemberIds.length !== byId.size
      || new Set(card.stackMemberIds.map(id => id.toLowerCase())).size !== byId.size
      || card.stackMemberIds.some(id => !byId.has(id.toLowerCase()))))) return unavailable();

  const eligible = [...byId.values()].filter(member => member.isGenzoRoomExport === false);
  let selected: RecentAsset[];
  if (manualAssetIds !== undefined) {
    const manual = new Set([...manualAssetIds].map(id => id.toLowerCase()));
    selected = eligible.filter(member => manual.has(member.id.toLowerCase()));
  } else {
    const nonRaw = eligible.filter(member => !member.is_raw);
    const raw = eligible.filter(member => member.is_raw);
    switch (preset) {
      case 'both': selected = [...nonRaw, ...raw]; break;
      case 'raw': selected = raw.length > 0 ? raw : nonRaw; break;
      case 'nonRaw': selected = nonRaw.length > 0 ? nonRaw : raw; break;
      default: return unavailable();
    }
  }
  const ids = new Set(selected.map(member => member.id.toLowerCase()));
  return { status: 'ready', selectedAssetIds: ids, assets: selected };
}

/** Consumes the Phase 1 STACK-ID index without taking a dependency on Gallery components. */
export function selectGalleryStackTargets(
  stacksById: ReadonlyMap<string, ImmichStack>,
  stackId: string,
  preset: AnshitsuInitialSelection,
  manualAssetIds?: ReadonlySet<string>,
): GalleryAssetSelection {
  const stack = stacksById.get(stackId.toLowerCase());
  if (!stack || stack.id.toLowerCase() !== stackId.toLowerCase()) return unavailable();
  const primary = stack.assets.find(asset => asset.id.toLowerCase() === stack.primaryAssetId.toLowerCase());
  if (!primary) return unavailable();
  return selectGalleryAssetTargets({ ...primary, stackMemberIds: stack.assets.map(asset => asset.id),
    stackMembers: stack.assets }, preset, manualAssetIds);
}
