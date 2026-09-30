import { describe, expect, it, vi } from 'vitest';
import { fetchAlbumAssets, fetchAlbums, fetchCalendarDayAssets, fetchCalendarHeatmap, fetchRecentAssets } from './api';

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
  it('passes year and month and validates the heatmap', async () => {
    const heatmap = { year: 2026, month: 9, days: [{ date: '2026-09-30', hasAssets: true, count: 1558 }] };
    const fetch = vi.fn(async () => new Response(JSON.stringify(heatmap)));
    vi.stubGlobal('fetch', fetch);
    try {
      const controller = new AbortController();
      expect(await fetchCalendarHeatmap(2026, 9, controller.signal)).toEqual(heatmap);
      expect(fetch).toHaveBeenCalledWith('/api/calendar/heatmap?year=2026&month=9',
        { signal: controller.signal, cache: 'no-store' });
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
