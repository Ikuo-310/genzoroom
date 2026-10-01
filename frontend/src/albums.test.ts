import { describe, expect, it } from 'vitest';
import { formatAlbumMonth } from './albums';

describe('album period', () => {
  it('uses the selected date locale without shifting the album month', () => {
    expect(formatAlbumMonth('2026-09-01T00:00:00.000Z', 'ja-JP')).toBe('2026年9月');
    expect(formatAlbumMonth('2026-09-01T00:00:00.000Z', 'en-US')).toBe('Sep 2026');
    expect(formatAlbumMonth(null, 'en-US')).toBeNull();
  });

  it('uses compact zero-padded year/month labels for Japanese album periods', () => {
    expect(formatAlbumMonth('2021-10-01T00:00:00.000Z', undefined, true)).toBe('2021/10');
    expect(formatAlbumMonth('2023-10-01T00:00:00.000Z', undefined, true)).toBe('2023/10');
    expect(formatAlbumMonth('2023-11-01T00:00:00.000Z', undefined, true)).toBe('2023/11');
    expect(formatAlbumMonth('2002-09-01T00:00:00.000Z', undefined, true)).toBe('2002/09');
    expect(formatAlbumMonth('2025-11-01T00:00:00.000Z', undefined, true)).toBe('2025/11');
  });

  it('preserves existing empty and invalid date behavior for compact Japanese labels', () => {
    expect(formatAlbumMonth(null, undefined, true)).toBeNull();
    expect(formatAlbumMonth('2026-13-01T00:00:00.000Z', undefined, true)).toBeNull();
    expect(formatAlbumMonth('not-a-date', undefined, true)).toBeNull();
  });
});
