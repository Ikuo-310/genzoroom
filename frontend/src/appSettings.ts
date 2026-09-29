import { useSyncExternalStore } from 'react';

export const DATE_LOCALE_KEY = 'genzoroom.dateLocale';
export const WEEK_START_KEY = 'genzoroom.weekStart';
export const INITIAL_IMAGE_KEY = 'genzoroom.initialImage';
export const DATE_LOCALES = ['ja-JP', 'en-US', 'en-GB', 'de-DE', 'fr-FR', 'zh-CN', 'ko-KR'] as const;
export type DateLocale = 'auto' | typeof DATE_LOCALES[number];
export type WeekStart = 'auto' | 'sunday' | 'monday';
export type InitialImage = 'auto' | 'original' | 'preview';
export type Settings = { dateLocale: DateLocale; weekStart: WeekStart; initialImage: InitialImage };

export function browserStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}
export function readSetting<T extends string>(key: string, choices: readonly T[], storage = browserStorage()): T | 'auto' {
  try { const value = storage?.getItem(key); return choices.includes(value as T) ? value as T : 'auto'; }
  catch { return 'auto'; }
}
export function readSettings(storage = browserStorage()): Settings {
  return {
    dateLocale: readSetting(DATE_LOCALE_KEY, DATE_LOCALES, storage),
    weekStart: readSetting(WEEK_START_KEY, ['sunday', 'monday'] as const, storage),
    initialImage: readSetting(INITIAL_IMAGE_KEY, ['original', 'preview'] as const, storage),
  };
}
let settings = readSettings();
const listeners = new Set<() => void>();
export function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings = { ...settings, [key]: value };
  const storageKey = { dateLocale: DATE_LOCALE_KEY, weekStart: WEEK_START_KEY, initialImage: INITIAL_IMAGE_KEY }[key];
  try { browserStorage()?.setItem(storageKey, value); } catch { /* Keep session preferences when storage is blocked. */ }
  listeners.forEach(listener => listener());
}
export function useAppSettings() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => settings, () => settings);
}
export function resolveDateLocale(preference: DateLocale = settings.dateLocale, languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? []) {
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
