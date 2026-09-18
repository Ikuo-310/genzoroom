import { useEffect, useRef, useState } from 'react';
import type { EditRecipe } from './editing';
import { decodeEditSource, type EditImageSource } from './editImageSource';
import { renderAdjustments } from './adjustmentPipeline';
import { AdjustmentWorkerClient } from './adjustmentWorkerClient';

type Props = {
  source: EditImageSource; recipe: EditRecipe; alt: string; width?: number;
  onLoad: (width: number, height: number) => void; onError: () => void;
};

export function AdjustedImage({ source, recipe, alt, width, onLoad, onError }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pixels, setPixels] = useState<ImageData | null>(null);
  const [workerFailure, setWorkerFailure] = useState(0);
  const workerClient = useRef<AdjustmentWorkerClient | null>(null);
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
    const assetGeneration = nextAssetGeneration++;
    let client: AdjustmentWorkerClient | null = null;
    try {
      const worker = new Worker(new URL('./adjustmentWorker.ts', import.meta.url), { type: 'module' });
      client = new AdjustmentWorkerClient(worker, assetGeneration, {
        onResult: (result) => {
          try {
            const context = canvas.current?.getContext('2d', { colorSpace: 'srgb' });
            if (!context) throw new Error('Canvas unavailable');
            context.putImageData(new ImageData(new Uint8ClampedArray(result.pixelBuffer), result.width, result.height), 0, 0);
          } catch { callbacks.current.onError(); }
        },
        onError: (error) => {
          console.warn('Adjustment worker failed; using main-thread fallback.', error);
          if (client && workerClient.current === client) workerClient.current = null;
          setWorkerFailure((value) => value + 1);
        },
      });
      workerClient.current = client;
      client.initialize(pixels.data, pixels.width, pixels.height);
    } catch (error) {
      client?.dispose();
      console.warn('Adjustment worker could not start; using main-thread fallback.', error);
      workerClient.current = null;
      setWorkerFailure((value) => value + 1);
      return;
    }
    return () => {
      if (workerClient.current === client) workerClient.current = null;
      client?.dispose();
    };
  }, [pixels]);
  useEffect(() => {
    if (!pixels) return;
    // Coalesce recipe changes within a frame before issuing a Worker request.
    const frame = requestAnimationFrame(() => {
      const client = workerClient.current;
      if (client) {
        client.render(recipe);
        return;
      }
      try {
        const context = canvas.current?.getContext('2d', { colorSpace: 'srgb' });
        if (!context) throw new Error('Canvas unavailable');
        context.putImageData(new ImageData(renderAdjustments(pixels.data, recipe), pixels.width, pixels.height), 0, 0);
      } catch { callbacks.current.onError(); }
    });
    return () => cancelAnimationFrame(frame);
  }, [pixels, recipe, workerFailure]);
  return <canvas ref={canvas} role="img" aria-label={alt} width={pixels?.width ?? 0} height={pixels?.height ?? 0}
    style={{ width: width ? `${width}px` : undefined }} />;
}

let nextAssetGeneration = 1;
