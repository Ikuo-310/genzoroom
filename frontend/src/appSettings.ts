import { useSyncExternalStore } from 'react';
import i18n from 'i18next';

export const DATE_LOCALE_KEY = 'genzoroom.dateLocale';
export const WEEK_START_KEY = 'genzoroom.weekStart';
export const INITIAL_IMAGE_KEY = 'genzoroom.initialImage';
export const HOME_THUMBNAIL_WIDTH_KEY = 'genzoroom.homeThumbnailWidth';
export const HOME_THUMBNAIL_COLUMNS_KEY = 'genzoroom.homeThumbnailColumns';
export const RECENT_PHOTO_COUNT_KEY = 'genzoroom.recentPhotoCount';
export const SHOW_KEYBOARD_SHORTCUTS_KEY = 'genzoroom.showKeyboardShortcuts';
export const ANSHITSU_INITIAL_SELECTION_KEY = 'genzoroom.anshitsuInitialSelection';
export const ZOOM_NAVIGATOR_POSITION_KEY = 'genzoroom.zoomNavigatorPosition';
export const RAW_DEVELOPMENT_PANEL_UI_KEY = 'genzoroom.rawDevelopmentPanelUi';
export const ANSHITSU_INITIAL_SELECTIONS = ['nonRaw', 'raw', 'both'] as const;
export type AnshitsuInitialSelection = typeof ANSHITSU_INITIAL_SELECTIONS[number];
export function effectiveAnshitsuSelection(saved: AnshitsuInitialSelection, rawAvailable: boolean): AnshitsuInitialSelection {
  return rawAvailable ? saved : 'nonRaw';
}
export const DATE_LOCALES = ['ja-JP', 'en-US', 'en-GB', 'de-DE', 'fr-FR', 'zh-CN', 'ko-KR'] as const;
// Keep the legacy Auto value as browser-region mode; saved preferences must not switch to language sync.
export const DATE_LOCALE_CHOICES = ['auto', 'auto-language', ...DATE_LOCALES] as const;
export type DateLocale = typeof DATE_LOCALE_CHOICES[number];
const LANGUAGE_DATE_LOCALES: Record<string, string> = { ja: 'ja-JP', en: 'en-US' };
export type WeekStart = 'auto' | 'sunday' | 'monday';
export type InitialImage = 'auto' | 'original' | 'preview';
export const HOME_THUMBNAIL_WIDTHS = [140, 160, 180, 200, 220, 240, 260, 280] as const;
export type HomeThumbnailWidth = typeof HOME_THUMBNAIL_WIDTHS[number];
export const RECENT_PHOTO_COUNTS = [50, 100, 150, 200, 250, 300, 350, 400, 450, 500] as const;
export type RecentPhotoCount = typeof RECENT_PHOTO_COUNTS[number];
export const ZOOM_NAVIGATOR_POSITIONS = ['off', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type ZoomNavigatorPosition = typeof ZOOM_NAVIGATOR_POSITIONS[number];
export const RAW_PANEL_CATEGORIES = ['basic', 'color', 'curves', 'effects', 'detail'] as const;
export type RawPanelCategory = typeof RAW_PANEL_CATEGORIES[number];
export const RAW_PANEL_MIXER_COLORS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type RawPanelMixerColor = typeof RAW_PANEL_MIXER_COLORS[number];
export const RAW_PANEL_GRADING_BANDS = ['shadows', 'midtones', 'highlights'] as const;
export type RawPanelGradingBand = typeof RAW_PANEL_GRADING_BANDS[number];
export type RawDevelopmentPanelUi = {
  version: 1;
  categories: Record<RawPanelCategory, boolean>;
  subcategories: { mixer: boolean; grading: boolean; lensCorrections: boolean; defringe: boolean };
  selection: { mixerColor: RawPanelMixerColor; gradingBand: RawPanelGradingBand };
};
export type Settings = { dateLocale: DateLocale; weekStart: WeekStart; initialImage: InitialImage; homeThumbnailWidth: HomeThumbnailWidth; recentPhotoCount: RecentPhotoCount; showKeyboardShortcuts: boolean; anshitsuInitialSelection: AnshitsuInitialSelection; zoomNavigatorPosition: ZoomNavigatorPosition; rawDevelopmentPanelUi: RawDevelopmentPanelUi };

export function defaultRawDevelopmentPanelUi(): RawDevelopmentPanelUi {
  return {
    version: 1,
    categories: { basic: true, color: true, curves: true, effects: true, detail: true },
    subcategories: { mixer: false, grading: false, lensCorrections: true, defringe: false },
    selection: { mixerColor: 'red', gradingBand: 'shadows' },
  };
}

function normalizeRawDevelopmentPanelUi(value: unknown): RawDevelopmentPanelUi {
  const defaults = defaultRawDevelopmentPanelUi();
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) return defaults;
  const saved = value as Partial<RawDevelopmentPanelUi>;
  const categories = saved.categories && typeof saved.categories === 'object' ? saved.categories as Partial<Record<RawPanelCategory, unknown>> : {};
  const subcategories = saved.subcategories && typeof saved.subcategories === 'object'
    ? saved.subcategories as Partial<Record<'mixer' | 'grading' | 'lensCorrections' | 'defringe', unknown>> : {};
  const selection = saved.selection && typeof saved.selection === 'object'
    ? saved.selection as Partial<Record<'mixerColor' | 'gradingBand', unknown>> : {};
  return {
    version: 1,
    categories: Object.fromEntries(RAW_PANEL_CATEGORIES.map(category => [category,
      typeof categories[category] === 'boolean' ? categories[category] : defaults.categories[category]])) as RawDevelopmentPanelUi['categories'],
    subcategories: {
      mixer: typeof subcategories.mixer === 'boolean' ? subcategories.mixer : defaults.subcategories.mixer,
      grading: typeof subcategories.grading === 'boolean' ? subcategories.grading : defaults.subcategories.grading,
      lensCorrections: typeof subcategories.lensCorrections === 'boolean' ? subcategories.lensCorrections : defaults.subcategories.lensCorrections,
      defringe: typeof subcategories.defringe === 'boolean' ? subcategories.defringe : defaults.subcategories.defringe,
    },
    selection: {
      mixerColor: RAW_PANEL_MIXER_COLORS.includes(selection.mixerColor as RawPanelMixerColor)
        ? selection.mixerColor as RawPanelMixerColor : defaults.selection.mixerColor,
      gradingBand: RAW_PANEL_GRADING_BANDS.includes(selection.gradingBand as RawPanelGradingBand)
        ? selection.gradingBand as RawPanelGradingBand : defaults.selection.gradingBand,
    },
  };
}

function readRawDevelopmentPanelUi(storage = browserStorage()): RawDevelopmentPanelUi {
  try {
    const raw = storage?.getItem(RAW_DEVELOPMENT_PANEL_UI_KEY);
    return raw === null || raw === undefined ? defaultRawDevelopmentPanelUi() : normalizeRawDevelopmentPanelUi(JSON.parse(raw));
  } catch { return defaultRawDevelopmentPanelUi(); }
}

export function browserStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}
export function readSetting<T extends string>(key: string, choices: readonly T[], storage = browserStorage()): T | 'auto' {
  try { const value = storage?.getItem(key); return choices.includes(value as T) ? value as T : 'auto'; }
  catch { return 'auto'; }
}
export function readSettings(storage = browserStorage()): Settings {
  let homeThumbnailWidth: HomeThumbnailWidth = 200;
  let recentPhotoCount: RecentPhotoCount = 100;
  let showKeyboardShortcuts = true;
  let anshitsuInitialSelection: AnshitsuInitialSelection = 'nonRaw';
  let zoomNavigatorPosition: ZoomNavigatorPosition = 'bottom-right';
  try { showKeyboardShortcuts = storage?.getItem(SHOW_KEYBOARD_SHORTCUTS_KEY) !== 'false'; }
  catch { /* Blocked storage keeps shortcut explanations enabled by default. */ }
  try {
    const value = storage?.getItem(ANSHITSU_INITIAL_SELECTION_KEY);
    if (ANSHITSU_INITIAL_SELECTIONS.includes(value as AnshitsuInitialSelection)) anshitsuInitialSelection = value as AnshitsuInitialSelection;
  } catch { /* Blocked storage keeps the safe Non-RAW preset. */ }
  try {
    const value = storage?.getItem(ZOOM_NAVIGATOR_POSITION_KEY);
    if (ZOOM_NAVIGATOR_POSITIONS.includes(value as ZoomNavigatorPosition)) zoomNavigatorPosition = value as ZoomNavigatorPosition;
  } catch { /* Invalid or blocked storage keeps the default Navigator position. */ }
  try {
    const width = storage?.getItem(HOME_THUMBNAIL_WIDTH_KEY);
    const savedWidth = Number(width);
    if (HOME_THUMBNAIL_WIDTHS.includes(savedWidth as HomeThumbnailWidth)) homeThumbnailWidth = savedWidth as HomeThumbnailWidth;
    else if (width === null || width === undefined) {
      const legacyRaw = storage?.getItem(HOME_THUMBNAIL_COLUMNS_KEY);
      const legacyColumns = Number(legacyRaw);
      if (legacyRaw !== null && Number.isInteger(legacyColumns) && legacyColumns >= 3 && legacyColumns <= 10) {
        homeThumbnailWidth = (340 - legacyColumns * 20) as HomeThumbnailWidth;
        storage?.setItem(HOME_THUMBNAIL_WIDTH_KEY, String(homeThumbnailWidth));
      }
    }
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
    homeThumbnailWidth,
    recentPhotoCount,
    showKeyboardShortcuts,
    anshitsuInitialSelection,
    zoomNavigatorPosition,
    rawDevelopmentPanelUi: readRawDevelopmentPanelUi(storage),
  };
}
let settings = readSettings();
const listeners = new Set<() => void>();
export function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  if (key === 'zoomNavigatorPosition' && !ZOOM_NAVIGATOR_POSITIONS.includes(value as ZoomNavigatorPosition)) return;
  if (key === 'anshitsuInitialSelection' && !ANSHITSU_INITIAL_SELECTIONS.includes(value as AnshitsuInitialSelection)) return;
  const nextValue = (key === 'rawDevelopmentPanelUi' ? normalizeRawDevelopmentPanelUi(value) : value) as Settings[K];
  settings = { ...settings, [key]: nextValue };
  const storageKey = { dateLocale: DATE_LOCALE_KEY, weekStart: WEEK_START_KEY, initialImage: INITIAL_IMAGE_KEY, homeThumbnailWidth: HOME_THUMBNAIL_WIDTH_KEY, recentPhotoCount: RECENT_PHOTO_COUNT_KEY, showKeyboardShortcuts: SHOW_KEYBOARD_SHORTCUTS_KEY, anshitsuInitialSelection: ANSHITSU_INITIAL_SELECTION_KEY, zoomNavigatorPosition: ZOOM_NAVIGATOR_POSITION_KEY, rawDevelopmentPanelUi: RAW_DEVELOPMENT_PANEL_UI_KEY }[key];
  try { browserStorage()?.setItem(storageKey, key === 'rawDevelopmentPanelUi' ? JSON.stringify(nextValue) : String(nextValue)); } catch { /* Keep session preferences when storage is blocked. */ }
  listeners.forEach(listener => listener());
}
export function updateRawDevelopmentPanelUi(update: (current: RawDevelopmentPanelUi) => RawDevelopmentPanelUi) {
  updateSetting('rawDevelopmentPanelUi', update(settings.rawDevelopmentPanelUi));
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
