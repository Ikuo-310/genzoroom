import { useEffect, useRef, useState } from 'react';
import type { EditRecipe } from './editing';
import { decodeEditSource, type EditImageSource } from './editImageSource';
import { renderAdjustments } from './exposurePipeline';

type Props = {
  source: EditImageSource; recipe: EditRecipe; alt: string; width?: number;
  onLoad: (width: number, height: number) => void; onError: () => void;
};

export function AdjustedImage({ source, recipe, alt, width, onLoad, onError }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pixels, setPixels] = useState<ImageData | null>(null);
  const callbacks = useRef({ onLoad, onError });
  callbacks.current = { onLoad, onError };
  useEffect(() => {
    const controller = new AbortController();
    setPixels(null);
    void decodeEditSource(source, controller.signal).then((decoded) => {
      if (controller.signal.aborted) return;
      setPixels(decoded);
      callbacks.current.onLoad(decoded.width, decoded.height);
    }).catch(() => { if (!controller.signal.aborted) callbacks.current.onError(); });
    return () => controller.abort();
  }, [source.kind, source.url]);
  useEffect(() => {
    if (!pixels) return;
    // Coalesce rapid changes; always render from the untouched decoded source.
    const frame = requestAnimationFrame(() => {
      try {
        const context = canvas.current?.getContext('2d', { colorSpace: 'srgb' });
        if (!context) throw new Error('Canvas unavailable');
        context.putImageData(new ImageData(renderAdjustments(pixels.data, recipe), pixels.width, pixels.height), 0, 0);
      } catch { callbacks.current.onError(); }
    });
    return () => cancelAnimationFrame(frame);
  }, [pixels, recipe]);
  return <canvas ref={canvas} role="img" aria-label={alt} width={pixels?.width ?? 0} height={pixels?.height ?? 0}
    style={{ width: width ? `${width}px` : undefined }} />;
}
