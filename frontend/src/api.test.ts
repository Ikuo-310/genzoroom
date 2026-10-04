import { describe, expect, it, vi } from 'vitest';
import { fetchAssetDetail, fetchAlbumAssets, fetchAlbums, fetchCalendarDayAssets, fetchCalendarHeatmap, fetchCalendarMinYear, fetchFavoriteAssets, fetchRecentAssets, isRecentAsset } from './api';

describe('Home asset stack metadata', () => {
  const asset = { id: 'asset-1', filename: 'member.dng', date: '2026-09-01',
    thumbnail_url: '/api/assets/asset-1/thumbnail', format: 'DNG', is_raw: true };
  const stack = { stackId: '22345678-1234-4234-9234-123456789abc',
    primaryAssetId: '32345678-1234-4234-9234-123456789abc', stackAssetCount: 2 };
  const readers = [
    (signal: AbortSignal) => fetchRecentAssets(100, signal),
    (signal: AbortSignal) => fetchAlbumAssets('album-1', signal),
    (signal: AbortSignal) => fetchCalendarDayAssets('2026-09-01', signal),
    fetchFavoriteAssets,
  ];
  it.each(readers)('preserves stack metadata and accepts older non-stack responses (%#)', async read => {
    const data = [asset, { ...asset, stackId: null, primaryAssetId: null }, { ...asset, ...stack }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))));
    try {
      expect(await read(new AbortController().signal)).toEqual(data);
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([1, 2, 12])('accepts safe Stack counts in Home asset validation: %s', count => {
    expect(isRecentAsset({ ...asset, ...stack, stackAssetCount: count })).toBe(true);
  });
  it.each([null, undefined])('accepts an absent optional Stack count: %s', count => {
    expect(isRecentAsset({ ...asset, ...stack, stackAssetCount: count })).toBe(true);
  });
  it.each([0, -1, 2.5, Number.NaN, '1'])('rejects invalid Stack counts before Home sanitization: %s', count => {
    expect(isRecentAsset({ ...asset, ...stack, stackAssetCount: count })).toBe(false);
  });
  it('preserves singleton Stack count 1 in the Home recent assets response', async () => {
    const singleton = { ...asset, ...stack, stackAssetCount: 1 };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [singleton] })));
    try {
      const result = await fetchRecentAssets(100, new AbortController().signal);
      expect(result[0].stackAssetCount).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([null, undefined])('preserves a nullish optional count in the Home response: %s', async count => {
    const value = { ...asset, ...stack, stackAssetCount: count };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [value] })));
    try {
      const result = await fetchRecentAssets(100, new AbortController().signal);
      expect(result[0].stackAssetCount).toBe(count);
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([0, -1, 2.5, Number.NaN, 'bad'])('nulls invalid optional Stack count %s without dropping the Home photo', async count => {
    const invalid = { ...asset, ...stack, stackAssetCount: count };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [invalid] })));
    try {
      const result = await fetchRecentAssets(100, new AbortController().signal);
      expect(result).toHaveLength(1);
      expect(result[0].stackAssetCount).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(readers)('keeps photos when optional stack counts are missing or malformed (%#)', async read => {
    const data = [{ ...asset, ...stack, stackAssetCount: undefined }, { ...asset, ...stack, stackAssetCount: 'bad' }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))));
    try {
      const result = await read(new AbortController().signal);
      expect(result).toHaveLength(2);
      expect(result[0].stackAssetCount).toBeUndefined();
      expect(result[1].stackAssetCount).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(readers)('rejects malformed or incomplete stack metadata (%#)', async read => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      for (const metadata of [{ ...stack, stackId: 'bad' }, { ...stack, primaryAssetId: 'bad' },
        { stackId: stack.stackId }, { ...stack, primaryAssetId: 123 }]) {
        fetch.mockResolvedValue(new Response(JSON.stringify([{ ...asset, ...metadata }])));
        await expect(read(new AbortController().signal)).rejects.toThrow('Unexpected');
      }
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('favorites API', () => {
  it('uses the favorites endpoint and validates its response', async () => {
    const fetch = vi.fn(async () => new Response('[]'));
    vi.stubGlobal('fetch', fetch);
    try {
      const controller = new AbortController();
      expect(await fetchFavoriteAssets(controller.signal)).toEqual([]);
      expect(fetch).toHaveBeenCalledWith('/api/assets/favorites', { signal: controller.signal, cache: 'no-store' });
      fetch.mockImplementation(async () => new Response('[{}]'));
      await expect(fetchFavoriteAssets(controller.signal)).rejects.toThrow('Unexpected favorites response');
      fetch.mockImplementation(async () => new Response('', { status: 502 }));
      await expect(fetchFavoriteAssets(controller.signal)).rejects.toThrow('Favorites request failed');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('recent assets API', () => {
  it('passes the selected limit to the backend', async () => {
    const fetch = vi.fn(async () => new Response('[]'));
    vi.stubGlobal('fetch', fetch);
    try {
      const controller = new AbortController();
      expect(await fetchRecentAssets(250, controller.signal)).toEqual([]);
      expect(fetch).toHaveBeenCalledWith('/api/assets/recent?limit=250', { signal: controller.signal, cache: 'no-store' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('albums API', () => {
  it('fetches the backend album list and validates its fields', async () => {
    const album = { id: 'album-1', albumName: '旅行', albumThumbnailAssetId: null, assetCount: 0, startDate: null, endDate: null };
    const fetch = vi.fn(async () => new Response(JSON.stringify([album])));
    vi.stubGlobal('fetch', fetch);
    try {
      const controller = new AbortController();
      expect(await fetchAlbums(controller.signal)).toEqual([album]);
      expect(fetch).toHaveBeenCalledWith('/api/albums', { signal: controller.signal, cache: 'no-store' });
      fetch.mockImplementation(async () => new Response(JSON.stringify([{ ...album, assetCount: '0' }])));
      await expect(fetchAlbums(controller.signal)).rejects.toThrow('Unexpected albums response');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('album assets API', () => {
  it('fetches and validates the complete backend asset list', async () => {
    const asset = { id: 'asset-1', filename: 'photo.dng', date: '2026-09-27',
      thumbnail_url: '/api/assets/asset-1/thumbnail', format: 'DNG', is_raw: true };
    const fetch = vi.fn(async () => new Response(JSON.stringify([asset])));
    vi.stubGlobal('fetch', fetch);
    try {
      const controller = new AbortController();
      expect(await fetchAlbumAssets('album/id', controller.signal)).toEqual([asset]);
      expect(fetch).toHaveBeenCalledWith('/api/albums/album%2Fid/assets', { signal: controller.signal, cache: 'no-store' });
      fetch.mockImplementation(async () => new Response(JSON.stringify([{ ...asset, is_raw: 'true' }])));
      await expect(fetchAlbumAssets('album/id', controller.signal)).rejects.toThrow('Unexpected album assets response');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('calendar API', () => {
  it('requests a whole year without month and validates the annual response', async () => {
    const heatmap = { year: 2026, month: null, days: [{ date: '2026-08-15', hasAssets: true, count: 3 }] };
    const fetch = vi.fn(async () => new Response(JSON.stringify(heatmap)));
    vi.stubGlobal('fetch', fetch);
    try {
      const controller = new AbortController();
      expect(await fetchCalendarHeatmap(2026, null, controller.signal)).toEqual(heatmap);
      expect(fetch).toHaveBeenCalledWith('/api/calendar/heatmap?year=2026', { signal: controller.signal, cache: 'no-store' });
      expect(fetch).toHaveBeenCalledTimes(1);
      fetch.mockImplementation(async () => new Response(JSON.stringify({ ...heatmap, month: 8 })));
      await expect(fetchCalendarHeatmap(2026, null, controller.signal)).rejects.toThrow('Unexpected calendar heatmap response');
    } finally { vi.unstubAllGlobals(); }
  });
  it('fetches and validates the calendar minimum year metadata', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ minYear: 2002 })));
    vi.stubGlobal('fetch', fetch);
    try {
      const controller = new AbortController();
      expect(await fetchCalendarMinYear(controller.signal)).toBe(2002);
      expect(fetch).toHaveBeenCalledWith('/api/calendar/min-year', { signal: controller.signal, cache: 'no-store' });
      fetch.mockImplementation(async () => new Response(JSON.stringify({ minYear: null })));
      expect(await fetchCalendarMinYear(controller.signal)).toBeNull();
      fetch.mockImplementation(async () => new Response(JSON.stringify({ minYear: '1900' })));
      await expect(fetchCalendarMinYear(controller.signal)).rejects.toThrow('Unexpected calendar minimum year response');
    } finally { vi.unstubAllGlobals(); }
  });

  it('passes year and month and validates the heatmap', async () => {
    const heatmap = { year: 2026, month: 9, days: [{ date: '2026-09-30', hasAssets: true, count: 1558,
      thumbnail_url: '/api/assets/cover-id/thumbnail' }] };
    const fetch = vi.fn(async () => new Response(JSON.stringify(heatmap)));
    vi.stubGlobal('fetch', fetch);
    try {
      const controller = new AbortController();
      expect(await fetchCalendarHeatmap(2026, 9, controller.signal)).toEqual(heatmap);
      expect(fetch).toHaveBeenCalledWith('/api/calendar/heatmap?year=2026&month=9',
        { signal: controller.signal, cache: 'no-store' });
      fetch.mockImplementation(async () => new Response(JSON.stringify({ ...heatmap,
        days: [{ ...heatmap.days[0], thumbnail_url: 123 }] })));
      await expect(fetchCalendarHeatmap(2026, 9, controller.signal)).rejects.toThrow('Unexpected calendar heatmap response');
      fetch.mockImplementation(async () => new Response(JSON.stringify({ ...heatmap, month: 8 })));
      await expect(fetchCalendarHeatmap(2026, 9, controller.signal)).rejects.toThrow('Unexpected calendar heatmap response');
      fetch.mockImplementation(async () => new Response(JSON.stringify({ ...heatmap, days: [{ date: '2026-09-30', hasAssets: true, count: -1 }] })));
      await expect(fetchCalendarHeatmap(2026, 9, controller.signal)).rejects.toThrow('Unexpected calendar heatmap response');
    } finally { vi.unstubAllGlobals(); }
  });

  it('requests a selected day and validates PhotoCard assets', async () => {
    const photo = { id: 'photo-1', filename: 'photo.jpg', date: '2026-09-30',
      thumbnail_url: '/api/assets/photo-1/thumbnail', format: 'JPEG', is_raw: false };
    const fetch = vi.fn(async () => new Response(JSON.stringify([photo])));
    vi.stubGlobal('fetch', fetch);
    try {
      const controller = new AbortController();
      expect(await fetchCalendarDayAssets('2026-09-30', controller.signal)).toEqual([photo]);
      expect(fetch).toHaveBeenCalledWith('/api/calendar/2026-09-30/assets',
        { signal: controller.signal, cache: 'no-store' });
      fetch.mockImplementation(async () => new Response(JSON.stringify([{ ...photo, is_raw: 'false' }])));
      await expect(fetchCalendarDayAssets('2026-09-30', controller.signal)).rejects.toThrow('Unexpected calendar photos response');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('optional detail GPS', () => {
  it.each([undefined, null, 'bad', true, {}, 91, -91])('ignores invalid latitude without losing detail: %j', async latitude => {
    const data = { id: 'asset-1', filename: 'photo.jpg', date: '2026-10-01', thumbnail_url: '/thumb', preview_url: '/preview', is_raw: false, format: 'JPEG', exif: { make: 'Camera', latitude, longitude: 139 } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))));
    try { const detail = await fetchAssetDetail(data.id, new AbortController().signal); expect(detail.exif.latitude).toBeUndefined(); expect(detail.exif.longitude).toBe(139); expect(detail.exif.make).toBe('Camera'); } finally { vi.unstubAllGlobals(); }
  });
  it('keeps zero and boundary GPS values and ignores out-of-range longitude', async () => {
    for (const [latitude, longitude, expected] of [[0, 0, 0], [-90, 180, 180], [90, 181, undefined]] as const) {
      const data = { id: 'a', filename: 'a.jpg', date: '', thumbnail_url: '/t', preview_url: '/p', is_raw: false, format: 'JPEG', exif: { latitude, longitude } };
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))));
      try { const detail = await fetchAssetDetail('a', new AbortController().signal); expect(detail.exif.latitude).toBe(latitude); expect(detail.exif.longitude).toBe(expected); } finally { vi.unstubAllGlobals(); }
    }
  });
});
