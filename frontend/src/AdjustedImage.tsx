import { useEffect, useRef, useState } from 'react';
import type { EditRecipe } from './editing';
import { decodeEditSource, type EditImageSource } from './editImageSource';
import { renderAdjustments } from './adjustmentPipeline';
import { AdjustmentWorkerClient } from './adjustmentWorkerClient';
import { collectHistogram, type Histogram, type HistogramChangeHandler } from './histogram';

type Props = {
  source: EditImageSource; recipe: EditRecipe; alt: string; width?: number; showBeforeAdjustments?: boolean;
  onLoad: (width: number, height: number) => void; onError: () => void;
  onHistogramChange?: HistogramChangeHandler;
};

export function AdjustedImage({ source, recipe, alt, width, showBeforeAdjustments = false, onLoad, onError, onHistogramChange }: Props) {
  const beforeCanvas = useRef<HTMLCanvasElement>(null);
  const afterCanvas = useRef<HTMLCanvasElement>(null);
  const sourceKey = `${source.kind}:${source.url}`;
  const currentSourceKey = useRef(sourceKey);
  currentSourceKey.current = sourceKey;
  const [decoded, setDecoded] = useState<{ sourceKey: string; pixels: ImageData; histogram: Histogram } | null>(null);
  const pixels = decoded?.sourceKey === sourceKey ? decoded.pixels : null;
  const beforeHistogram = decoded?.sourceKey === sourceKey ? decoded.histogram : null;
  const [workerFailure, setWorkerFailure] = useState(0);
  const workerClient = useRef<AdjustmentWorkerClient | null>(null);
  const callbacks = useRef({ onLoad, onError, onHistogramChange });
  callbacks.current = { onLoad, onError, onHistogramChange };
  useEffect(() => {
    const controller = new AbortController();
    setDecoded(null);
    callbacks.current.onHistogramChange?.({ sourceKey, before: null, after: null });
    void decodeEditSource(source, controller.signal).then((decoded) => {
      if (controller.signal.aborted || currentSourceKey.current !== sourceKey) return;
      const histogram = collectHistogram(decoded.data);
      setDecoded({ sourceKey, pixels: decoded, histogram });
      callbacks.current.onHistogramChange?.({ sourceKey, before: histogram, after: null });
      callbacks.current.onLoad(decoded.width, decoded.height);
    }).catch(() => { if (!controller.signal.aborted) callbacks.current.onError(); });
    return () => controller.abort();
  }, [source.kind, source.url]);
  useEffect(() => {
    if (!pixels) return;
    try {
      const context = beforeCanvas.current?.getContext('2d', { colorSpace: 'srgb' });
      if (!context) throw new Error('Canvas unavailable');
      context.putImageData(pixels, 0, 0);
    } catch { callbacks.current.onError(); }
  }, [pixels]);
  useEffect(() => {
    if (!pixels) return;
    const assetGeneration = nextAssetGeneration++;
    let client: AdjustmentWorkerClient | null = null;
    try {
      const worker = new Worker(new URL('./adjustmentWorker.ts', import.meta.url), { type: 'module' });
      client = new AdjustmentWorkerClient(worker, assetGeneration, {
        onResult: (result) => {
          if (currentSourceKey.current !== sourceKey) return;
          try {
            const context = afterCanvas.current?.getContext('2d', { colorSpace: 'srgb' });
            if (!context) throw new Error('Canvas unavailable');
            context.putImageData(new ImageData(new Uint8ClampedArray(result.pixelBuffer), result.width, result.height), 0, 0);
            // Notify only after the same result has been accepted by the canvas.
            callbacks.current.onHistogramChange?.({ sourceKey, before: beforeHistogram, after: result.histogram });
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
  }, [pixels, sourceKey, beforeHistogram]);
  useEffect(() => {
    if (!pixels) return;
    // Coalesce recipe changes within a frame before issuing a Worker request.
    const frame = requestAnimationFrame(() => {
      if (currentSourceKey.current !== sourceKey) return;
      const client = workerClient.current;
      if (client) {
        client.render(recipe);
        return;
      }
      try {
        const context = afterCanvas.current?.getContext('2d', { colorSpace: 'srgb' });
        if (!context) throw new Error('Canvas unavailable');
        const adjusted = renderAdjustments(pixels.data, recipe);
        const histogram = collectHistogram(adjusted);
        context.putImageData(new ImageData(adjusted, pixels.width, pixels.height), 0, 0);
        callbacks.current.onHistogramChange?.({ sourceKey, before: beforeHistogram, after: histogram });
      } catch { callbacks.current.onError(); }
    });
    return () => cancelAnimationFrame(frame);
  }, [pixels, recipe, workerFailure, sourceKey, beforeHistogram]);
  return <div className="viewer-comparison-image" role="img" aria-label={alt}
    style={{ width: width ? `${width}px` : undefined }}>
    <canvas ref={beforeCanvas} aria-hidden="true" width={pixels?.width ?? 0} height={pixels?.height ?? 0} />
    <canvas ref={afterCanvas} aria-hidden="true" width={pixels?.width ?? 0} height={pixels?.height ?? 0}
      className={showBeforeAdjustments ? 'comparison-hidden' : undefined} />
  </div>;
}

let nextAssetGeneration = 1;
