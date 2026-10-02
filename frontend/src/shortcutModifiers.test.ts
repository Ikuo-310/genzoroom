import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPrimaryModifier, shortcutPlatform } from './shortcutModifiers';

afterEach(() => vi.unstubAllGlobals());

describe('platform primary modifier', () => {
  it.each([
    ['Win32', 'other'], ['Linux x86_64', 'other'], ['MacIntel', 'mac'], ['iPhone', 'mac'],
  ] as const)('resolves %s as %s', (platform, expected) => {
    vi.stubGlobal('navigator', { platform });
    expect(shortcutPlatform()).toBe(expected);
  });

  it('accepts only the platform Primary key and rejects Control+Meta together', () => {
    expect(isPrimaryModifier({ ctrlKey: true, metaKey: false }, 'other')).toBe(true);
    expect(isPrimaryModifier({ ctrlKey: false, metaKey: true }, 'other')).toBe(false);
    expect(isPrimaryModifier({ ctrlKey: false, metaKey: true }, 'mac')).toBe(true);
    expect(isPrimaryModifier({ ctrlKey: true, metaKey: false }, 'mac')).toBe(false);
    expect(isPrimaryModifier({ ctrlKey: true, metaKey: true }, 'other')).toBe(false);
    expect(isPrimaryModifier({ ctrlKey: true, metaKey: true }, 'mac')).toBe(false);
  });
});
