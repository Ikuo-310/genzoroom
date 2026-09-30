import { describe, expect, it } from 'vitest';
import { formatAlbumMonth } from './albums';

describe('album period', () => {
  it('uses the selected date locale without shifting the album month', () => {
    expect(formatAlbumMonth('2026-09-01T00:00:00.000Z', 'ja-JP')).toBe('2026年9月');
    expect(formatAlbumMonth('2026-09-01T00:00:00.000Z', 'en-US')).toBe('Sep 2026');
    expect(formatAlbumMonth(null, 'en-US')).toBeNull();
  });
});
