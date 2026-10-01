import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATE_LOCALE_KEY, HOME_THUMBNAIL_COLUMNS_KEY, INITIAL_IMAGE_KEY, RECENT_PHOTO_COUNT_KEY, WEEK_START_KEY, prefersOriginal, readSettings, resolveDateLocale, resolveWeekStart, updateSetting } from './appSettings';
import i18n, { changeAppLanguage, currentLanguagePreference, detectLanguage, formatPhotoDate, LANGUAGE_STORAGE_KEY, readLanguagePreference } from './i18n';

afterEach(() => { vi.unstubAllGlobals(); updateSetting('dateLocale', 'auto'); updateSetting('weekStart', 'auto'); updateSetting('initialImage', 'auto'); updateSetting('homeThumbnailColumns', 6); updateSetting('recentPhotoCount', 100); });
const memory = (initial: Record<string, string> = {}) => ({
  getItem: (key: string) => initial[key] ?? null,
  setItem: (key: string, value: string) => { initial[key] = value; },
});
describe('browser preferences', () => {
  it('uses ordered browser languages and exact primary subtags with English fallback', () => {
    expect(detectLanguage(memory(), ['fr-FR', 'ja-JP', 'en-GB'])).toBe('ja');
    expect(detectLanguage(memory(), ['fr-FR', 'en-GB', 'ja-JP'])).toBe('en');
    expect(detectLanguage(memory(), ['jargon', 'fr-FR'])).toBe('en');
    expect(detectLanguage(memory(), [])).toBe('en');
    expect(detectLanguage(memory({ [LANGUAGE_STORAGE_KEY]: 'ja' }), ['en-GB'])).toBe('ja');
    expect(readLanguagePreference(memory({ [LANGUAGE_STORAGE_KEY]: 'unknown' }))).toBe('auto');
  });
  it('persists Auto rather than its resolved language and preserves legacy manual values', async () => {
    vi.stubGlobal('navigator', { languages: ['fr-FR', 'ja-JP'] });
    const storage = memory();
    await changeAppLanguage('auto', storage);
    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe('auto');
    expect(i18n.resolvedLanguage).toBe('ja');
    expect(detectLanguage(storage, ['en-GB'])).toBe('en');
    await changeAppLanguage('en', storage);
    expect(detectLanguage(storage, ['ja-JP'])).toBe('en');
  });
  it('defaults and reloads independent preferences, ignoring invalid saved values', () => {
    expect(readSettings(memory() as Storage)).toEqual({ dateLocale: 'auto', weekStart: 'auto', initialImage: 'auto', homeThumbnailColumns: 6, recentPhotoCount: 100 });
    const storage = memory({ [DATE_LOCALE_KEY]: 'en-GB', [WEEK_START_KEY]: 'sunday', [INITIAL_IMAGE_KEY]: 'original', [HOME_THUMBNAIL_COLUMNS_KEY]: '3', [RECENT_PHOTO_COUNT_KEY]: '250' });
    expect(readSettings(storage as Storage)).toEqual({ dateLocale: 'en-GB', weekStart: 'sunday', initialImage: 'original', homeThumbnailColumns: 3, recentPhotoCount: 250 });
    for (const columns of [3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(readSettings(memory({ [HOME_THUMBNAIL_COLUMNS_KEY]: String(columns) }) as Storage).homeThumbnailColumns).toBe(columns);
    }
    for (const invalidCount of ['49', '51', '501', '225', '100.0', 'invalid']) {
      expect(readSettings(memory({ [RECENT_PHOTO_COUNT_KEY]: invalidCount }) as Storage).recentPhotoCount).toBe(100);
    }
    expect(readSettings(memory({ [DATE_LOCALE_KEY]: 'invalid', [WEEK_START_KEY]: 'friday', [INITIAL_IMAGE_KEY]: 'raw', [HOME_THUMBNAIL_COLUMNS_KEY]: '11', [RECENT_PHOTO_COUNT_KEY]: '225' }) as Storage)).toEqual({ dateLocale: 'auto', weekStart: 'auto', initialImage: 'auto', homeThumbnailColumns: 6, recentPhotoCount: 100 });
    vi.stubGlobal('window', { localStorage: storage });
    updateSetting('initialImage', 'preview'); updateSetting('weekStart', 'monday'); updateSetting('dateLocale', 'ja-JP');
    updateSetting('homeThumbnailColumns', 4);
    updateSetting('recentPhotoCount', 450);
    expect(storage.getItem(HOME_THUMBNAIL_COLUMNS_KEY)).toBe('4');
    expect(storage.getItem(RECENT_PHOTO_COUNT_KEY)).toBe('450');
    expect(readSettings(storage as Storage)).toEqual({ dateLocale: 'ja-JP', weekStart: 'monday', initialImage: 'preview', homeThumbnailColumns: 4, recentPhotoCount: 450 });
  });
  it('keeps date locale independent of manual or fallback display language', async () => {
    vi.stubGlobal('navigator', { languages: ['fr-FR'] });
    await changeAppLanguage('auto', memory()); expect(i18n.resolvedLanguage).toBe('en');
    expect(resolveDateLocale()).toBe('fr-FR');
    const value = '2026-09-08T20:43:43Z'; const date = formatPhotoDate(value);
    await changeAppLanguage('ja', memory()); expect(formatPhotoDate(value)).toBe(date);
    expect(resolveDateLocale('en-GB', ['ja-JP'])).toBe('en-GB');
    expect(resolveDateLocale('auto', ['bad_tag', 'de-DE'])).toBe('de-DE');
  });
  it('formats timezone-less EXIF as a wall clock without changing data or inferring a zone', () => {
    const value = '2026-09-08T20:43:43';
    expect(formatPhotoDate(value, 'en-GB')).toBe(new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(value + 'Z')));
    expect(formatPhotoDate('invalid', 'en-GB')).toBe('invalid');
  });
  it('uses weekInfo and keeps manual week start independent of region', () => {
    const spy = vi.spyOn(Intl, 'Locale').mockImplementation(function () { return { weekInfo: { firstDay: 7 } } as unknown as Intl.Locale; });
    expect(resolveWeekStart('auto', 'en-GB')).toBe(0);
    spy.mockImplementation(function () { return { getWeekInfo: () => ({ firstDay: 1 }) } as unknown as Intl.Locale; });
    expect(resolveWeekStart('auto', 'ja-JP')).toBe(1);
    expect(resolveWeekStart('sunday', 'en-GB')).toBe(0);
    expect(resolveWeekStart('monday', 'ja-JP')).toBe(1);
    spy.mockRestore();
  });
  it('falls back safely without weekInfo', () => {
    const spy = vi.spyOn(Intl, 'Locale').mockImplementation(function (locale) { return { maximize: () => ({ region: String(locale).endsWith('JP') ? 'JP' : 'GB' }) } as unknown as Intl.Locale; });
    expect(resolveWeekStart('auto', 'ja-JP')).toBe(0); expect(resolveWeekStart('auto', 'en-GB')).toBe(1);
    spy.mockImplementation(function () { throw new Error('Unsupported'); });
    expect(resolveWeekStart('auto', 'invalid')).toBe(1); spy.mockRestore();
  });
  it('accepts changes for the current session when storage is blocked', async () => {
    const storage = { getItem: () => { throw new Error('Denied'); }, setItem: () => { throw new Error('Denied'); } };
    vi.stubGlobal('window', { localStorage: storage });
    expect(readSettings()).toEqual({ dateLocale: 'auto', weekStart: 'auto', initialImage: 'auto', homeThumbnailColumns: 6, recentPhotoCount: 100 });
    updateSetting('dateLocale', 'en-GB'); expect(resolveDateLocale()).toBe('en-GB');
    updateSetting('weekStart', 'sunday'); expect(resolveWeekStart()).toBe(0);
    await changeAppLanguage('ja', storage); expect(i18n.resolvedLanguage).toBe('ja'); expect(currentLanguagePreference()).toBe('ja');
  });
  it('Auto uses Original only when GPU is usable, while explicit choices are independent', () => {
    expect(prefersOriginal('auto', true)).toBe(true); expect(prefersOriginal('auto', false)).toBe(false);
    expect(prefersOriginal('original', false)).toBe(true); expect(prefersOriginal('preview', true)).toBe(false);
  });
});
