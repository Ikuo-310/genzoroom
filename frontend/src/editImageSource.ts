import type { AssetDetail } from './assets';

export type EditImageSource = { kind: 'immich-preview' | 'jpeg-original'; url: string };
// Recipe and pixel processing deliberately contain no Immich URL knowledge.
export const getEditImageSource = (asset: AssetDetail): EditImageSource => ({ kind: 'immich-preview', url: asset.preview_url });

export async function decodeEditSource(source: EditImageSource, signal: AbortSignal): Promise<ImageData> {
  if (source.kind === 'jpeg-original') return decodeOriginal(source.url, signal);
  const response = await fetch(source.url, { signal });
  if (!response.ok) throw new Error('Image source unavailable');
  const bitmap = await createImageBitmap(await response.blob());
  try {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
}

async function decodeOriginal(url: string, signal: AbortSignal): Promise<ImageData> {
  signal.throwIfAborted();
  const image = new Image();
  const canvas = document.createElement('canvas');
  const abort = () => { image.removeAttribute('src'); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    // HTML image decoding preserves embedded ICC. Drawing into an explicit sRGB
    // canvas converts P3 to the existing 8-bit working space before any processing.
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    if (!context || context.getContextAttributes().colorSpace !== 'srgb') throw new Error('sRGB canvas unavailable');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height, { colorSpace: 'srgb' });
  } finally {
    signal.removeEventListener('abort', abort);
    image.removeAttribute('src');
    canvas.width = canvas.height = 0;
  }
}
