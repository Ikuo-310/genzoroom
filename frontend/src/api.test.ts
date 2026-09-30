import { describe, expect, it, vi } from 'vitest';
import { fetchRecentAssets } from './api';

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
