import { afterEach, describe, expect, it } from 'vitest';
import i18n, {
  LANGUAGE_STORAGE_KEY,
  changeAppLanguage,
  detectLanguage,
  formatPhotoDate,
} from './i18n';

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: (key: string) => key === LANGUAGE_STORAGE_KEY ? value : null,
    setItem: (key: string, nextValue: string) => {
      if (key === LANGUAGE_STORAGE_KEY) value = nextValue;
    },
  };
}

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('language selection', () => {
  it('prefers a saved manual selection over the browser language', () => {
    expect(detectLanguage(memoryStorage('en'), 'ja-JP')).toBe('en');
    expect(detectLanguage(memoryStorage('ja'), 'en-US')).toBe('ja');
  });

  it('uses Japanese for a Japanese browser when no valid choice is saved', () => {
    expect(detectLanguage(memoryStorage(), 'ja-JP')).toBe('ja');
    expect(detectLanguage(memoryStorage('invalid'), 'ja')).toBe('ja');
  });

  it('falls back to English for other browser languages', () => {
    expect(detectLanguage(memoryStorage(), 'en-US')).toBe('en');
    expect(detectLanguage(memoryStorage(), 'fr-FR')).toBe('en');
  });

  it('persists a manual change so it is selected after reload detection', async () => {
    const storage = memoryStorage();

    await changeAppLanguage('ja', storage);

    expect(i18n.resolvedLanguage).toBe('ja');
    expect(detectLanguage(storage, 'en-US')).toBe('ja');
  });
});

describe('localized resources', () => {
  it('provides English and Japanese UI text', () => {
    expect(i18n.t('connection.connected', { lng: 'en' })).toBe('Connected');
    expect(i18n.t('connection.connected', { lng: 'ja' })).toBe('接続済み');
    expect(i18n.t('photos.recent', { lng: 'en' })).toBe('Recent photos');
    expect(i18n.t('photos.recent', { lng: 'ja' })).toBe('最近の写真');
    expect(i18n.t('photos.noMatches', { lng: 'en' })).toBe('No photos match this filter.');
    expect(i18n.t('photos.noMatches', { lng: 'ja' })).toBe('この条件に一致する写真はありません。');
    expect(i18n.t('workspace.name', { lng: 'en' })).toBe('Anshitsu');
    expect(i18n.t('workspace.name', { lng: 'ja' })).toBe('暗室');
    expect(i18n.t('workspace.actualSize', { lng: 'en' })).toBe('1:1');
    expect(i18n.t('workspace.actualSize', { lng: 'ja' })).toBe('等倍');
    expect(i18n.t('workspace.highlights', { lng: 'en' })).toBe('Highlights');
    expect(i18n.t('workspace.highlights', { lng: 'ja' })).toBe('ハイライト');
    expect(i18n.t('workspace.whites', { lng: 'en' })).toBe('Whites');
    expect(i18n.t('workspace.whites', { lng: 'ja' })).toBe('ホワイト');
    expect(i18n.t('workspace.shadows', { lng: 'en' })).toBe('Shadows');
    expect(i18n.t('workspace.shadows', { lng: 'ja' })).toBe('シャドウ');
    expect(i18n.t('workspace.blacks', { lng: 'en' })).toBe('Blacks');
    expect(i18n.t('workspace.blacks', { lng: 'ja' })).toBe('ブラック');
    expect(i18n.t('workspace.basic', { lng: 'en' })).toBe('Basic');
    expect(i18n.t('workspace.basic', { lng: 'ja' })).toBe('基本補正');
    expect(i18n.t('workspace.basicResetHistory', { lng: 'en' })).toBe('Reset Basic adjustments');
    expect(i18n.t('workspace.basicResetHistory', { lng: 'ja' })).toBe('基本補正をリセット');
    expect(i18n.t('photos.selectionCount', { lng: 'en', count: 3 })).toBe('3 selected');
    expect(i18n.t('photos.selectionCount', { lng: 'ja', count: 3 })).toBe('3枚選択中');
  });

  it('uses English as the translation fallback', () => {
    expect(i18n.t('app.title', { lng: 'ja' })).toBe('GenzoRoom');
  });

  it('formats dates with the selected locale', () => {
    const value = '2026-09-08T20:43:43';
    const date = new Date(value);
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: 'short',
      timeStyle: 'medium',
    };

    expect(formatPhotoDate(value, 'ja')).toBe(
      new Intl.DateTimeFormat('ja-JP', options).format(date),
    );
    expect(formatPhotoDate(value, 'en')).toBe(
      new Intl.DateTimeFormat('en-US', options).format(date),
    );
    expect(formatPhotoDate(value, 'ja')).not.toBe(formatPhotoDate(value, 'en'));
  });
});
