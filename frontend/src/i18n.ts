import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ja from './locales/ja.json';

export const LANGUAGE_STORAGE_KEY = 'genzoroom.language';
export type AppLanguage = 'en' | 'ja';

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
  browserLanguage = typeof navigator === 'undefined' ? '' : navigator.language,
): AppLanguage {
  // A valid manual choice wins; invalid or unavailable storage falls back to browser language.
  try {
    const storedLanguage = storage?.getItem(LANGUAGE_STORAGE_KEY);
    if (storedLanguage === 'en' || storedLanguage === 'ja') return storedLanguage;
  } catch {
    // The UI remains usable when storage is blocked by browser privacy settings.
  }

  return browserLanguage.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

const initialLanguage = detectLanguage();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ja: { translation: ja },
  },
  lng: initialLanguage,
  fallbackLng: 'en',
  supportedLngs: ['en', 'ja'],
  load: 'languageOnly',
  interpolation: { escapeValue: false },
  initAsync: false,
});

if (typeof document !== 'undefined') document.documentElement.lang = initialLanguage;

export async function changeAppLanguage(
  language: AppLanguage,
  storage: WritableLanguageStorage | undefined = browserStorage(),
): Promise<void> {
  // Persist only the supported language code so reloads keep the explicit user choice.
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Changing language should still work for the current page when storage is unavailable.
  }

  await i18n.changeLanguage(language);
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

export function formatPhotoDate(value: string, language: AppLanguage): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

export default i18n;
