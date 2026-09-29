// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetDetail } from './assets';
import { useJpegOriginal } from './useJpegOriginal';
import { readJpegProfile } from './jpegProfile';

vi.mock('./jpegProfile', () => ({ readJpegProfile: vi.fn() }));
const first: AssetDetail = { id: 'first', filename: 'RAW-01.COVER.jpg', format: 'JPEG', is_raw: false, date: '', thumbnail_url: '/thumb', preview_url: '/preview', exif: {} };
const second = { ...first, id: 'second', preview_url: '/second-preview' };
let root: Root;
let host: HTMLDivElement;
let current: ReturnType<typeof useJpegOriginal>;
const fetchOriginal = vi.fn();
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
function Harness({ asset }: { asset: AssetDetail | null }) { current = useJpegOriginal(asset); return null; }
async function render(asset: AssetDetail | null) { await act(async () => root.render(<Harness asset={asset} />)); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const response = () => ({ ok: true, blob: async () => new Blob(['image']) }) as Response;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchOriginal);
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  fetchOriginal.mockReset(); createObjectURL.mockReset(); revokeObjectURL.mockReset();
  createObjectURL.mockImplementation(() => `blob:${createObjectURL.mock.calls.length}`);
  vi.mocked(readJpegProfile).mockReset().mockResolvedValue({ status: 'embedded', description: 'Display P3' });
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

describe('current-photo original ownership', () => {
  it('keeps preview usable while loading and reuses one compressed original for mode toggles', async () => {
    const pending = deferred<Response>(); fetchOriginal.mockReturnValue(pending.promise);
    await render(first);
    expect(current.status).toBe('loading'); expect(current.source?.kind).toBe('immich-preview');
    await act(async () => current.toggle()); expect(current.showingOriginal).toBe(false);
    await act(async () => pending.resolve(response()));
    expect(current.profile).toEqual({ status: 'embedded', description: 'Display P3' });
    for (let i = 0; i < 3; i++) {
      await act(async () => current.toggle()); expect(current.source?.kind).toBe('jpeg-original');
      await act(async () => current.toggle()); expect(current.source?.kind).toBe('immich-preview');
    }
    await render({ ...first });
    expect(fetchOriginal).toHaveBeenCalledOnce(); expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await render(null); expect(revokeObjectURL).toHaveBeenCalledWith('blob:1');
  });
  it('aborts navigation and rejects late transfer completion', async () => {
    const pending = deferred<Response>();
    fetchOriginal.mockReturnValueOnce(pending.promise).mockResolvedValue(response());
    vi.mocked(readJpegProfile).mockResolvedValue({ status: 'none' });
    await render(first);
    await render(second);
    const firstSignal = fetchOriginal.mock.calls[0][1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    await act(async () => pending.resolve(response()));
    expect(current.profile).toEqual({ status: 'none' });
    expect(createObjectURL).toHaveBeenCalledOnce();
    await act(async () => current.toggle()); expect(current.source?.url).toBe('blob:1');
    await render({ ...first, format: 'DNG', is_raw: true });
    expect(current.status).toBeUndefined(); expect(fetchOriginal).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:1');
  });
  it('rejects late metadata completion after navigation', async () => {
    const metadata = deferred<Awaited<ReturnType<typeof readJpegProfile>>>();
    fetchOriginal.mockResolvedValue(response());
    vi.mocked(readJpegProfile).mockReturnValueOnce(metadata.promise).mockResolvedValue({ status: 'none' });
    await render(first); await render(second);
    await act(async () => metadata.resolve({ status: 'embedded', description: 'Old ICC' }));
    expect(current.profile).toEqual({ status: 'none' });
    expect(createObjectURL).toHaveBeenCalledOnce();
  });
  it('releases a ready original on photo switch and resets display to preview', async () => {
    fetchOriginal.mockResolvedValue(response());
    await render(first); await act(async () => current.toggle());
    await render(second);
    expect(current.showingOriginal).toBe(false); expect(current.source?.url).toBe('/second-preview');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:1');
    expect(fetchOriginal.mock.calls.map(call => call[0])).toEqual(['/api/assets/first/original', '/api/assets/second/original']);
  });
  it('falls back to preview on transfer or decode failure without a retry loop', async () => {
    fetchOriginal.mockResolvedValueOnce({ ok: false }).mockResolvedValue(response());
    await render(first);
    expect(current.status).toBe('error'); expect(current.source?.kind).toBe('immich-preview');
    await render(second); await act(async () => current.toggle());
    await act(async () => current.failDecode());
    expect(current.status).toBe('error'); expect(current.source?.kind).toBe('immich-preview');
    await act(async () => current.toggle()); expect(current.showingOriginal).toBe(false);
    expect(fetchOriginal).toHaveBeenCalledTimes(2);
  });
});
