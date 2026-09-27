import { describe, expect, it } from 'vitest';
import { editMenuPosition } from './EditSettingsMenu';
import i18n from './i18n';

describe('viewer context menu placement', () => {
  it.each([
    [100, 120, 260, 170, 1000, 800, 100, 120],
    [970, 780, 260, 170, 1000, 800, 732, 622],
    [-30, -20, 260, 170, 1000, 800, 8, 8],
  ])('keeps the menu at %s,%s within a %s by %s viewport', (x, y, width, height, vw, vh, left, top) => {
    expect(editMenuPosition(x, y, width, height, vw, vh)).toEqual({ left, top });
  });
});

describe('edit settings menu labels', () => {
  it('uses complete selected-copy and selected-paste labels in Japanese and English', async () => {
    await i18n.changeLanguage('ja');
    expect(i18n.t('workspace.selectCopy')).toBe('項目を選んでコピー');
    expect(i18n.t('workspace.selectPaste')).toBe('項目を選んでペースト');
    await i18n.changeLanguage('en');
    expect(i18n.t('workspace.selectCopy')).toBe('Copy selected settings');
    expect(i18n.t('workspace.selectPaste')).toBe('Paste selected settings');
  });
});
