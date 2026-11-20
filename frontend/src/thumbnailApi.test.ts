import { afterEach, describe, expect, it, vi } from 'vitest';
import { frontendLogger } from './frontendLogging';
import { requestThumbnailGeneration } from './thumbnailApi';
import { thumbnailDiagnosticUrl, thumbnailSourceUrl } from './thumbnailUrl';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); frontendLogger.setLevel('off'); frontendLogger.clear(); });


describe('thumbnail boundaries', () => {
  it('adds a correlated diagnostic ID only when debug logging is enabled', () => {
    expect(thumbnailDiagnosticUrl('/thumb', 'trace')).toBe('/thumb');
    frontendLogger.setLevel('debug');
    expect(thumbnailDiagnosticUrl('/thumb?view=1', 'trace')).toBe('/thumb?view=1&__diag=trace');
  });

  it('selects display URLs without requesting generation and encodes Asset IDs and publication versions', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const publication = 'a'.repeat(32);
    expect(thumbnailSourceUrl('asset/id', 'thumbnail')).toBe('/api/assets/asset%2Fid/thumbnail');
    expect(thumbnailSourceUrl('asset/id', 'preview')).toBe('/api/assets/asset%2Fid/preview');
    expect(thumbnailSourceUrl('asset/id', 'immersive-preview', publication)).toBe(`/api/assets/asset%2Fid/immersive-preview?publication=${publication}`);
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
