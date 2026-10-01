import { resolveDateLocale } from './appSettings';

export type AlbumSummary = {
  id: string;
  albumName: string;
  albumThumbnailAssetId: string | null;
  assetCount: number;
  startDate: string | null;
  endDate: string | null;
};

export function formatAlbumMonth(value: string | null, locale = resolveDateLocale(), compactJapanese = false): string | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  // Immich's album bounds represent local calendar dates, so format the month without timezone conversion.
  const formattingLocale = compactJapanese ? 'ja-JP' : locale;
  return new Intl.DateTimeFormat(formattingLocale, {
    year: 'numeric', month: compactJapanese ? '2-digit' : 'short', timeZone: 'UTC',
  })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}
