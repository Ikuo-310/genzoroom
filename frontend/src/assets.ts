export type RecentAsset = {
  id: string;
  filename: string;
  date: string;
  thumbnail_url: string;
  format: string;
  is_raw: boolean;
  isGenzoRoomExport?: boolean;
  stackId?: string | null;
  primaryAssetId?: string | null;
  stackAssetCount?: number | null;
  stackMemberIds?: string[] | null;
  stackFormats?: StackFormat[] | null;
  // Absent means unavailable, never an empty or partially resolved candidate set.
  stackMembers?: RecentAsset[] | null;
};

export type StackFormat = { format: string; isRaw: boolean };

export type ImmichStack = { id: string; primaryAssetId: string; assets: RecentAsset[] };

// Derive from one view's response rather than retaining a second, independently refreshed snapshot.
export function galleryStacksById(assets: readonly RecentAsset[]): ReadonlyMap<string, ImmichStack> {
  return new Map(assets.flatMap(asset => asset.stackId && asset.primaryAssetId && asset.stackMembers
    ? [[asset.stackId.toLowerCase(), { id: asset.stackId, primaryAssetId: asset.primaryAssetId, assets: asset.stackMembers }] as const]
    : []));
}

export type AssetExif = {
  date_time_original?: string;
  make?: string;
  model?: string;
  lens_model?: string;
  focal_length?: number;
  f_number?: number;
  exposure_time?: string;
  iso?: number;
  exposure_compensation?: number;
  width?: number;
  height?: number;
  latitude?: number;
  longitude?: number;
};

export type AssetDetail = RecentAsset & {
  preview_url: string;
  exif: AssetExif;
};

export type WorkspaceNavigationState = {
  homeReturn?: import('./homeReturn').HomeReturnContext;
  // Selection order is shared by single-photo and multi-photo workspace navigation.
  selectedAssets: RecentAsset[];
  activeAssetId: string;
};
