// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeEditSource } from './editImageSource';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('original decoding into the sRGB pipeline', () => {
  it('uses the ICC-aware HTML image and explicit sRGB readback, then releases temporary storage', async () => {
    const image = { src: '', decode: vi.fn(async () => {}), naturalWidth: 2, naturalHeight: 3, removeAttribute: vi.fn() };
    vi.stubGlobal('Image', function () { return image; });
    const pixels = { width: 2, height: 3, data: new Uint8ClampedArray(24) } as ImageData;
    const drawImage = vi.fn(); const getImageData = vi.fn(() => pixels);
    const context = { drawImage, getImageData, getContextAttributes: () => ({ colorSpace: 'srgb' }) };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const create = vi.spyOn(document, 'createElement');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await decodeEditSource({ kind: 'jpeg-original', url: 'blob:cached-original' }, new AbortController().signal)).toBe(pixels);
    expect(image.src).toBe('blob:cached-original'); expect(fetch).not.toHaveBeenCalled();
    expect(getContext).toHaveBeenCalledWith('2d', { colorSpace: 'srgb', willReadFrequently: true });
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 2, 3, { colorSpace: 'srgb' });
    const canvas = create.mock.results[0].value as HTMLCanvasElement;
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
    expect(image.removeAttribute).toHaveBeenCalledWith('src');
  });
  it('never accepts an aborted decode result', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>(yes => { resolve = yes; });
    const image = { src: '', decode: () => pending, removeAttribute: vi.fn() };
    vi.stubGlobal('Image', function () { return image; });
    const controller = new AbortController();
    const decode = decodeEditSource({ kind: 'jpeg-original', url: 'blob:old' }, controller.signal);
    controller.abort(); resolve();
    await expect(decode).rejects.toThrow();
    expect(image.removeAttribute).toHaveBeenCalledWith('src');
  });
});
