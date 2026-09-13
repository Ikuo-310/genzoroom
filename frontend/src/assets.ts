export type RecentAsset = {
  id: string;
  filename: string;
  date: string;
  thumbnail_url: string;
  format: string;
  is_raw: boolean;
};

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
};

export type AssetDetail = RecentAsset & {
  preview_url: string;
  exif: AssetExif;
};

export type WorkspaceNavigationState = {
  // Selection order is shared by single-photo and multi-photo workspace navigation.
  selectedAssets: RecentAsset[];
  activeAssetId: string;
};
