// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Developer control contrast', () => {
  it('raises controls from the retained green panels using neutral surfaces and clear states', () => {
    const sheet = document.createElement('style');
    sheet.textContent = readFileSync('src/developer.css', 'utf8');
    document.head.append(sheet);
    try {
      const rule = selector => Array.from(sheet.sheet.cssRules).find(item => item.selectorText === selector)?.style;
      expect(rule('.developer-page button, .developer-page select').getPropertyValue('background')).toBe('#383a3f');
      expect(rule('.developer-page button, .developer-page select').getPropertyValue('border')).toBe('1px solid #696b72');
      expect(rule('.developer-page button:hover:not(:disabled)').getPropertyValue('background')).toBe('#494b51');
      expect(rule('.developer-page button:active:not(:disabled)').getPropertyValue('background')).toBe('#303237');
      expect(rule('.developer-page button:disabled').getPropertyValue('opacity')).toBe('0.72');
      expect(rule('.developer-page select').getPropertyValue('background')).toBe('#34363b');
      expect(rule('.developer-page select').getPropertyValue('color-scheme')).toBe('dark');
      expect(rule('.developer-tabs [role="tab"][aria-selected="false"]').getPropertyValue('background')).toBe('#383a3f');
      expect(rule('.developer-tabs [role="tab"][aria-selected="true"]').getPropertyValue('background')).toBe('#c2c4ca');
      expect(rule('.developer-log-sources button[aria-pressed="false"]').getPropertyValue('background')).toBe('#383a3f');
      expect(rule('.developer-log-sources button[aria-pressed="true"]').getPropertyValue('background')).toBe('#c2c4ca');
      expect(rule('.developer-section').getPropertyValue('background')).toBe('#203029');
      expect(rule('.developer-log-console').getPropertyValue('background')).toBe('#090e0b');
    } finally {
      sheet.remove();
    }
  });
});
