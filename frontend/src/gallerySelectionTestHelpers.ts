import type { RecentAsset } from './assets';

export function makeGalleryStack(index: number, formats: string[], exported: number[] = []): RecentAsset {
  const stackId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const memberIds = formats.map((_, member) => `00000000-0000-4000-8000-${String(index * 100 + member).padStart(12, '0')}`);
  const members = formats.map((format, member): RecentAsset => ({
    id: memberIds[member], filename: `stack-${index}-${member}.${format === 'JPEG' ? 'jpg' : format.toLowerCase()}`,
    date: '2026-09-01', thumbnail_url: `/thumb/${memberIds[member]}`, format, is_raw: format === 'DNG',
    isGenzoRoomExport: exported.includes(member), stackId, primaryAssetId: memberIds[0], stackAssetCount: formats.length,
  }));
  return { ...members[0], stackMembers: members, stackMemberIds: memberIds };
}
