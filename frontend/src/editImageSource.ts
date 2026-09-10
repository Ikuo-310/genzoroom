import type { AssetDetail } from './assets';

export type EditImageSource = { kind: 'immich-preview'; url: string };
// Temporary adapter. Replace with authenticated JPEG original acquisition later.
// Recipe and pixel processing deliberately contain no Immich URL knowledge.
export const getEditImageSource = (asset: AssetDetail): EditImageSource => ({ kind: 'immich-preview', url: asset.preview_url });

export async function decodeEditSource(source: EditImageSource, signal: AbortSignal): Promise<ImageData> {
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
