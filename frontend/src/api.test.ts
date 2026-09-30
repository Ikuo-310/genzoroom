import { describe, expect, it, vi } from 'vitest';
import { fetchAlbumAssets, fetchAlbums, fetchRecentAssets } from './api';

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
