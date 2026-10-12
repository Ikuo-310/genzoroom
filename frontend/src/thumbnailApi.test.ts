import { afterEach, describe, expect, it, vi } from 'vitest';
import { frontendLogger } from './frontendLogging';
import { requestThumbnailGeneration } from './thumbnailApi';
import { thumbnailUrl } from './thumbnailUrl';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); frontendLogger.setLevel('off'); frontendLogger.clear(); });

describe('thumbnail boundaries', () => {
  it('selects display URLs without requesting generation and encodes Asset IDs and refresh keys', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const asset = { id: 'asset/id', thumbnail_url: '/original' };
    expect(thumbnailUrl(asset)).toBe('/api/assets/asset%2Fid/rendered-thumbnail');
    expect(thumbnailUrl(asset, false, 'ignored')).toBe('/original');
    expect(thumbnailUrl(asset, true, 'view:2')).toBe('/api/assets/asset%2Fid/rendered-thumbnail?view=view%3A2');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([200, 202])('posts independently of navigation and accepts status %s', async status => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status })); vi.stubGlobal('fetch', fetch);
    expect(requestThumbnailGeneration('asset', 'filmstrip')).toBeUndefined();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledWith('/api/assets/asset/rendered-thumbnail', {
      method: 'POST', cache: 'no-store', keepalive: true,
    });
  });

  it.each(['network', 'http'])('consumes %s failure and logs only safe metadata', async failure => {
    frontendLogger.setLevel('debug');
    vi.stubGlobal('fetch', failure === 'network' ? vi.fn().mockRejectedValue(new Error('private credentials'))
      : vi.fn().mockResolvedValue(new Response('private Recipe', { status: 503 })));
    requestThumbnailGeneration('asset', 'exit');
    await Promise.resolve(); await Promise.resolve();
    const entries = frontendLogger.getEntries();
    expect(entries.some(entry => entry.event === 'request.failed' && entry.level === 'warn')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('private');
  });

  it('ignores logger failure and consumes synchronous fetch exceptions', async () => {
    vi.spyOn(frontendLogger, 'add').mockImplementation(() => { throw new Error('logger'); });
    const fetch = vi.fn(() => { throw new Error('fetch'); }); vi.stubGlobal('fetch', fetch);
    requestThumbnailGeneration('asset', 'filmstrip');
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
