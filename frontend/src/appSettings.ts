import { useSyncExternalStore } from 'react';
import i18n from 'i18next';

export const DATE_LOCALE_KEY = 'genzoroom.dateLocale';
export const WEEK_START_KEY = 'genzoroom.weekStart';
export const INITIAL_IMAGE_KEY = 'genzoroom.initialImage';
export const HOME_THUMBNAIL_COLUMNS_KEY = 'genzoroom.homeThumbnailColumns';
export const RECENT_PHOTO_COUNT_KEY = 'genzoroom.recentPhotoCount';
export const SHOW_KEYBOARD_SHORTCUTS_KEY = 'genzoroom.showKeyboardShortcuts';
export const ANSHITSU_INITIAL_SELECTION_KEY = 'genzoroom.anshitsuInitialSelection';
export const ANSHITSU_INITIAL_SELECTIONS = ['nonRaw', 'raw', 'both'] as const;
export type AnshitsuInitialSelection = typeof ANSHITSU_INITIAL_SELECTIONS[number];
export const ANSHITSU_RAW_PRESETS_ENABLED = false;
export const DATE_LOCALES = ['ja-JP', 'en-US', 'en-GB', 'de-DE', 'fr-FR', 'zh-CN', 'ko-KR'] as const;
// Keep the legacy Auto value as browser-region mode; saved preferences must not switch to language sync.
export const DATE_LOCALE_CHOICES = ['auto', 'auto-language', ...DATE_LOCALES] as const;
export type DateLocale = typeof DATE_LOCALE_CHOICES[number];
const LANGUAGE_DATE_LOCALES: Record<string, string> = { ja: 'ja-JP', en: 'en-US' };
export type WeekStart = 'auto' | 'sunday' | 'monday';
export type InitialImage = 'auto' | 'original' | 'preview';
export const HOME_THUMBNAIL_COLUMNS = [3, 4, 5, 6, 7, 8, 9, 10] as const;
export type HomeThumbnailColumns = typeof HOME_THUMBNAIL_COLUMNS[number];
export const RECENT_PHOTO_COUNTS = [50, 100, 150, 200, 250, 300, 350, 400, 450, 500] as const;
export type RecentPhotoCount = typeof RECENT_PHOTO_COUNTS[number];
export type Settings = { dateLocale: DateLocale; weekStart: WeekStart; initialImage: InitialImage; homeThumbnailColumns: HomeThumbnailColumns; recentPhotoCount: RecentPhotoCount; showKeyboardShortcuts: boolean; anshitsuInitialSelection: AnshitsuInitialSelection };

export function browserStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}
export function readSetting<T extends string>(key: string, choices: readonly T[], storage = browserStorage()): T | 'auto' {
  try { const value = storage?.getItem(key); return choices.includes(value as T) ? value as T : 'auto'; }
  catch { return 'auto'; }
}
export function readSettings(storage = browserStorage()): Settings {
  let homeThumbnailColumns: HomeThumbnailColumns = 6;
  let recentPhotoCount: RecentPhotoCount = 100;
  let showKeyboardShortcuts = true;
  let anshitsuInitialSelection: AnshitsuInitialSelection = 'nonRaw';
  try { showKeyboardShortcuts = storage?.getItem(SHOW_KEYBOARD_SHORTCUTS_KEY) !== 'false'; }
  catch { /* Blocked storage keeps shortcut explanations enabled by default. */ }
  try {
    const value = storage?.getItem(ANSHITSU_INITIAL_SELECTION_KEY);
    if (ANSHITSU_INITIAL_SELECTIONS.includes(value as AnshitsuInitialSelection)
      && (ANSHITSU_RAW_PRESETS_ENABLED || value === 'nonRaw')) anshitsuInitialSelection = value as AnshitsuInitialSelection;
  } catch { /* Blocked storage keeps the safe Non-RAW preset. */ }
  try {
    const value = Number(storage?.getItem(HOME_THUMBNAIL_COLUMNS_KEY));
    if (HOME_THUMBNAIL_COLUMNS.includes(value as HomeThumbnailColumns)) homeThumbnailColumns = value as HomeThumbnailColumns;
  } catch { /* Invalid or blocked storage keeps the default grid size. */ }
  try {
    const storedValue = storage?.getItem(RECENT_PHOTO_COUNT_KEY);
    const value = RECENT_PHOTO_COUNTS.find(count => String(count) === storedValue);
    if (value !== undefined) recentPhotoCount = value;
  } catch { /* Invalid or blocked storage keeps the default recent count. */ }
  return {
    dateLocale: readSetting(DATE_LOCALE_KEY, DATE_LOCALE_CHOICES, storage),
    weekStart: readSetting(WEEK_START_KEY, ['sunday', 'monday'] as const, storage),
    initialImage: readSetting(INITIAL_IMAGE_KEY, ['original', 'preview'] as const, storage),
    homeThumbnailColumns,
    recentPhotoCount,
    showKeyboardShortcuts,
    anshitsuInitialSelection,
  };
}
let settings = readSettings();
const listeners = new Set<() => void>();
export function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings = { ...settings, [key]: value };
  if (key === 'anshitsuInitialSelection' && !ANSHITSU_INITIAL_SELECTIONS.includes(value as AnshitsuInitialSelection)) return;
  if (key === 'anshitsuInitialSelection' && !ANSHITSU_RAW_PRESETS_ENABLED && value !== 'nonRaw') return;
  const storageKey = { dateLocale: DATE_LOCALE_KEY, weekStart: WEEK_START_KEY, initialImage: INITIAL_IMAGE_KEY, homeThumbnailColumns: HOME_THUMBNAIL_COLUMNS_KEY, recentPhotoCount: RECENT_PHOTO_COUNT_KEY, showKeyboardShortcuts: SHOW_KEYBOARD_SHORTCUTS_KEY, anshitsuInitialSelection: ANSHITSU_INITIAL_SELECTION_KEY }[key];
  try { browserStorage()?.setItem(storageKey, String(value)); } catch { /* Keep session preferences when storage is blocked. */ }
  listeners.forEach(listener => listener());
}
export function useAppSettings() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => settings, () => settings);
}
export function resolveDateLocale(preference: DateLocale = settings.dateLocale, languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? []) {
  if (preference === 'auto-language') {
    const language = (i18n.resolvedLanguage ?? i18n.language ?? 'en').split('-')[0];
    return LANGUAGE_DATE_LOCALES[language] ?? LANGUAGE_DATE_LOCALES.en;
  }
  if (preference !== 'auto') return preference;
  for (const locale of languages) {
    try { return new Intl.DateTimeFormat(locale).resolvedOptions().locale; } catch { /* Ignore malformed browser tags. */ }
  }
  return new Intl.DateTimeFormat().resolvedOptions().locale;
}
export function resolveWeekStart(preference: WeekStart = settings.weekStart, locale = resolveDateLocale()): number {
  if (preference !== 'auto') return preference === 'sunday' ? 0 : 1;
  try {
    const value = new Intl.Locale(locale) as Intl.Locale & { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } };
    const info = value.getWeekInfo?.() ?? value.weekInfo;
    if (info && Number.isInteger(info.firstDay) && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay % 7;
    // Older Firefox lacks weekInfo. Keep the fallback small and deterministic.
    const region = value.maximize().region;
    return region && ['US', 'CA', 'JP', 'CN', 'KR', 'TW', 'PH'].includes(region) ? 0 : 1;
  } catch { return 1; }
}
export function prefersOriginal(preference: InitialImage, gpuUsable: boolean) {
  return preference === 'original' || preference === 'auto' && gpuUsable;
}
