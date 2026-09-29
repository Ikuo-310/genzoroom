import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ja from './locales/ja.json';
import { resolveDateLocale } from './appSettings';

export const LANGUAGE_STORAGE_KEY = 'genzoroom.language';
export const LANGUAGE_RESOURCES = { en: { translation: en }, ja: { translation: ja } };
export type AppLanguage = keyof typeof LANGUAGE_RESOURCES;
export type LanguagePreference = AppLanguage | 'auto';
export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_RESOURCES) as AppLanguage[];
export function readLanguagePreference(storage: ReadableLanguageStorage | undefined = browserStorage()): LanguagePreference {
  try { const value = storage?.getItem(LANGUAGE_STORAGE_KEY); return SUPPORTED_LANGUAGES.includes(value as AppLanguage) ? value as AppLanguage : 'auto'; } catch { return 'auto'; }
}
export function resolveLanguage(languages: readonly string[]): AppLanguage {
  for (const tag of languages) {
    if (typeof tag !== 'string') continue;
    const language = tag.toLowerCase().split('-')[0] as AppLanguage;
    if (SUPPORTED_LANGUAGES.includes(language)) return language;
  }
  return 'en';
}

type ReadableLanguageStorage = Pick<Storage, 'getItem'>;
type WritableLanguageStorage = Pick<Storage, 'setItem'>;

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function detectLanguage(
  storage: ReadableLanguageStorage | undefined = browserStorage(),
  browserLanguage: string | readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language],
): AppLanguage {
  // A valid manual choice wins; invalid or unavailable storage falls back to browser language.
  try {
    const storedLanguage = storage?.getItem(LANGUAGE_STORAGE_KEY);
    if (SUPPORTED_LANGUAGES.includes(storedLanguage as AppLanguage)) return storedLanguage as AppLanguage;
  } catch {
    // The UI remains usable when storage is blocked by browser privacy settings.
  }

  return resolveLanguage(typeof browserLanguage === 'string' ? [browserLanguage] : browserLanguage);
}

const initialLanguage = detectLanguage();
let languagePreference = readLanguagePreference();
export const currentLanguagePreference = () => languagePreference;

void i18n.use(initReactI18next).init({
  resources: LANGUAGE_RESOURCES,
  lng: initialLanguage,
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LANGUAGES,
  load: 'languageOnly',
  interpolation: { escapeValue: false },
  initAsync: false,
});

if (typeof document !== 'undefined') document.documentElement.lang = initialLanguage;

export async function changeAppLanguage(
  language: LanguagePreference,
  storage: WritableLanguageStorage | undefined = browserStorage(),
): Promise<void> {
  languagePreference = language;
  // Preserve the preference (including Auto), rather than persisting its resolved language.
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Changing language should still work for the current page when storage is unavailable.
  }

  const resolved = language === 'auto' ? resolveLanguage(typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]) : language;
  await i18n.changeLanguage(resolved);
  if (typeof document !== 'undefined') document.documentElement.lang = resolved;
}

export function formatPhotoDate(value: string, locale = resolveDateLocale()): string {
  // Zone-less EXIF is a wall clock, not an instant in the browser's timezone.
  const normalized = value.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T').replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');
  const wallClock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized);
  const date = new Date(wallClock ? normalized + 'Z' : normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'short', timeStyle: 'medium', ...(wallClock ? { timeZone: 'UTC' } : {}),
  }).format(date);
}

export default i18n;
