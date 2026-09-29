import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SCOPE_HEIGHT_PERCENT,
  MAX_SCOPE_HEIGHT_PERCENT,
  MIN_SCOPE_HEIGHT_PERCENT,
  SCOPE_HEIGHT_STORAGE_KEY,
  readScopePanelBasis,
  saveScopePanelBasis,
} from './scopeSizing';

describe('Scope height persistence', () => {
  it('restores a saved height and uses the default when storage is missing or invalid', () => {
    expect(readScopePanelBasis({ getItem: () => JSON.stringify(27.5) })).toBe(27.5);
    for (const value of [null, 'not json', JSON.stringify('30'), JSON.stringify(14), JSON.stringify(Number.NaN)]) {
      expect(readScopePanelBasis({ getItem: () => value })).toBe(DEFAULT_SCOPE_HEIGHT_PERCENT);
    }
  });

  it('clamps legacy values above 40% when restoring them', () => {
    const storage = { getItem: () => JSON.stringify(68) };
    expect(readScopePanelBasis(storage)).toBe(MAX_SCOPE_HEIGHT_PERCENT);
  });

  it('persists resized values within the allowed range and tolerates blocked storage', () => {
    const storage = { setItem: vi.fn() };
    saveScopePanelBasis(38.5, storage);
    expect(storage.setItem).toHaveBeenCalledWith(SCOPE_HEIGHT_STORAGE_KEY, JSON.stringify(38.5));
    saveScopePanelBasis(60, storage);
    expect(storage.setItem).toHaveBeenLastCalledWith(SCOPE_HEIGHT_STORAGE_KEY, JSON.stringify(MAX_SCOPE_HEIGHT_PERCENT));
    saveScopePanelBasis(10, storage);
    expect(storage.setItem).toHaveBeenLastCalledWith(SCOPE_HEIGHT_STORAGE_KEY, JSON.stringify(MIN_SCOPE_HEIGHT_PERCENT));
    expect(() => saveScopePanelBasis(30, { setItem: () => { throw new Error('blocked'); } })).not.toThrow();
  });
});
