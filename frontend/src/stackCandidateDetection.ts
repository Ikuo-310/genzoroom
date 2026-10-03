import type { AssetExif, RecentAsset } from './assets';

export type MatchState = 'matched' | 'mismatch' | 'unavailable' | 'error';
export type NameReason = 'exact' | 'pixel-normalized';
export type DraftStack = {
  id: string;
  members: RecentAsset[];
  coverAssetId: string;
  origin: 'auto' | 'manual';
  evidence: { name: MatchState; nameReason: NameReason; time: MatchState; camera: MatchState; gps: MatchState };
};
export type StackDetection = { groups: DraftStack[]; unmatched: RecentAsset[] };

export function filenameFamily(filename: string): { key: string; reason: NameReason } | null {
  const pixel = /^(PXL_\d{8}_\d{9})\.RAW-\d+\.(?:COVER|ORIGINAL)\.[A-Za-z0-9]+$/.exec(filename);
  if (pixel) return { key: pixel[1], reason: 'pixel-normalized' };
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return null;
  // Case-sensitive stems avoid merging distinct filenames on case-sensitive sources.
  return { key: filename.slice(0, dot), reason: 'exact' };
}

// Zone-less EXIF is a wall clock. Use UTC consistently, never the client timezone,
// and reject calendar rollover rather than accepting Date's normalization.
export function parseStackDate(value: unknown, allowDateOnly = false): number | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T');
  const dateOnly = allowDateOnly && /^\d{4}-\d{2}-\d{2}$/.test(normalized);
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(dateOnly ? `${normalized}T00:00:00` : normalized);
  if (!match) return null;
  const [, y, m, d, h, min, sec, fraction, zone] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
  date.setUTCHours(Number(h), Number(min), Number(sec), Number((fraction ?? '').padEnd(3, '0').slice(0, 3)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1
    || date.getUTCDate() !== Number(d) || date.getUTCHours() !== Number(h)
    || date.getUTCMinutes() !== Number(min) || date.getUTCSeconds() !== Number(sec)) return null;
  let offset = 0;
  if (zone && zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2)), minutes = Number(digits.slice(2));
    if (hours > 23 || minutes > 59) return null;
    offset = (hours * 60 + minutes) * 60000 * (zone[0] === '+' ? 1 : -1);
  }
  return date.getTime() - offset;
}

export function chooseStackCover(members: readonly RecentAsset[]): string {
  const jpegs = members.filter(asset => !asset.is_raw && /^(?:JPEG|JPG)$/i.test(asset.format));
  const nonRaw = members.filter(asset => !asset.is_raw);
  const pool = jpegs.length ? jpegs : nonRaw.length ? nonRaw : members;
  // Valid dates outrank unavailable dates; ties retain Home selection order.
  return pool.reduce<RecentAsset | null>((best, asset) => {
    if (!best) return asset;
    return (parseStackDate(asset.date, true) ?? -Infinity) > (parseStackDate(best.date, true) ?? -Infinity) ? asset : best;
  }, null)?.id ?? '';
}

function evidenceFor(members: readonly RecentAsset[], details: ReadonlyMap<string, AssetExif>, failures: ReadonlySet<string>) {
  // A failed member prevents safe group-level comparison, even if other members have EXIF.
  if (members.some(asset => failures.has(asset.id))) return { time: 'error', camera: 'error', gps: 'error' } as const;
  const exifs = members.map(asset => details.get(asset.id));
  const missing = (value: unknown) => value == null || (typeof value === 'string' && !value.trim());
  const times = exifs.map(exif => parseStackDate(exif?.date_time_original));
  const time: MatchState = exifs.some((exif, index) => !missing(exif?.date_time_original) && times[index] === null) ? 'error'
    : times.includes(null) ? 'unavailable'
    : Math.max(...times as number[]) - Math.min(...times as number[]) <= 2000 ? 'matched' : 'mismatch';
  const cameras = exifs.map(exif => {
    const make = typeof exif?.make === 'string' ? exif.make.trim().toLowerCase() : '';
    const model = typeof exif?.model === 'string' ? exif.model.trim().toLowerCase() : '';
    return make && model ? JSON.stringify([make, model]) : null;
  });
  const camera: MatchState = exifs.some(exif => [exif?.make, exif?.model].some(value => !missing(value) && typeof value !== 'string')) ? 'error'
    : cameras.includes(null) ? 'unavailable' : new Set(cameras).size === 1 ? 'matched' : 'mismatch';
  const validCoordinate = (value: unknown, limit: number) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
  const gpsError = exifs.some(exif => (!missing(exif?.latitude) && !validCoordinate(exif?.latitude, 90))
    || (!missing(exif?.longitude) && !validCoordinate(exif?.longitude, 180)));
  const positions = exifs.map(exif => exif?.latitude != null && exif.longitude != null ? { latitude: exif.latitude, longitude: exif.longitude } : null);
  const spread = (key: 'latitude' | 'longitude') => {
    const values = positions.map(position => position![key]);
    return Math.max(...values) - Math.min(...values);
  };
  const gps: MatchState = gpsError ? 'error' : positions.includes(null) ? 'unavailable'
    : spread('latitude') <= 1e-5 && spread('longitude') <= 1e-5 ? 'matched' : 'mismatch';
  return { time, camera, gps };
}

export function detectStackCandidates(assets: readonly RecentAsset[], details: ReadonlyMap<string, AssetExif> = new Map(), failures: ReadonlySet<string> = new Set()): StackDetection {
  const uniqueAssets = [...new Map(assets.map(asset => [asset.id, asset])).values()];
  const families = new Map<string, { members: RecentAsset[]; reason: NameReason }>();
  for (const asset of uniqueAssets) {
    if (asset.stackId != null) continue;
    const family = filenameFamily(asset.filename);
    if (!family) continue;
    const group = families.get(family.key) ?? { members: [], reason: family.reason };
    group.members.push(asset);
    if (family.reason === 'pixel-normalized') group.reason = family.reason;
    families.set(family.key, group);
  }
  const groups: DraftStack[] = [];
  const grouped = new Set<string>();
  for (const [key, family] of families) {
    const { members } = family;
    if (members.length < 2 || !members.some(asset => asset.is_raw) || !members.some(asset => !asset.is_raw)) continue;
    members.forEach(asset => grouped.add(asset.id));
    groups.push({ id: `draft:auto:${key}`, members, coverAssetId: chooseStackCover(members), origin: 'auto',
      evidence: { name: 'matched', nameReason: family.reason, ...evidenceFor(members, details, failures) } });
  }
  return { groups, unmatched: uniqueAssets.filter(asset => !grouped.has(asset.id)) };
}
