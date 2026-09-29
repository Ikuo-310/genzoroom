import { useEffect, useRef, useState } from 'react';
import type { EditRecipe } from './editing';
import { decodeEditSource, type EditImageSource } from './editImageSource';
import { renderAdjustments } from './adjustmentPipeline';
import { AdjustmentGpuClient } from './adjustmentGpuClient';
import type { WorkspaceGpuRenderer, ProcessingBackend } from './useWorkspaceGpu';
import { AdjustmentWorkerClient } from './adjustmentWorkerClient';
import { collectHistogram, type Histogram, type HistogramChangeHandler } from './histogram';

type Props = {
  source: EditImageSource; recipe: EditRecipe; alt: string; width?: number; showBeforeAdjustments?: boolean;
  onLoad: (width: number, height: number) => void; onError: () => void;
  onHistogramChange?: HistogramChangeHandler;
  gpuRenderer?: WorkspaceGpuRenderer | null;
  onGpuError?: (renderer: WorkspaceGpuRenderer, error: unknown) => void;
  onBackendChange?: (backend: ProcessingBackend) => void;
};

export function AdjustedImage({ source, recipe, alt, width, showBeforeAdjustments = false, onLoad, onError, onHistogramChange, gpuRenderer = null, onGpuError, onBackendChange }: Props) {
  const beforeCanvas = useRef<HTMLCanvasElement>(null);
  const afterCanvas = useRef<HTMLCanvasElement>(null);
  const sourceKey = `${source.kind}:${source.url}`;
  const currentSourceKey = useRef(sourceKey);
  currentSourceKey.current = sourceKey;
  const [decoded, setDecoded] = useState<{ sourceKey: string; pixels: ImageData; histogram: Histogram } | null>(null);
  const pixels = decoded?.sourceKey === sourceKey ? decoded.pixels : null;
  const beforeHistogram = decoded?.sourceKey === sourceKey ? decoded.histogram : null;
  const [workerFailure, setWorkerFailure] = useState(0);
  const [failedGpu, setFailedGpu] = useState<WorkspaceGpuRenderer | null>(null);
  const renderer = gpuRenderer === failedGpu ? null : gpuRenderer;
  const currentRoute = useRef({ sourceKey, renderer, recipe });
  currentRoute.current = { sourceKey, renderer, recipe };
  const workerClient = useRef<AdjustmentWorkerClient | AdjustmentGpuClient | null>(null);
  const callbacks = useRef({ onLoad, onError, onHistogramChange, onGpuError, onBackendChange });
  callbacks.current = { onLoad, onError, onHistogramChange, onGpuError, onBackendChange };
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
    let active = true;
    const isCurrent = () => active && currentRoute.current.sourceKey === sourceKey
      && currentRoute.current.renderer === renderer;
    const isCurrentRecipe = (candidate: EditRecipe) => isCurrent() && currentRoute.current.recipe === candidate;
    const paint = (data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, histogram: Histogram,
      backend: ProcessingBackend) => {
      if (!isCurrent()) return;
      try {
        const context = afterCanvas.current?.getContext('2d', { colorSpace: 'srgb' });
        if (!context) throw new Error('Canvas unavailable');
        context.putImageData(new ImageData(data, width, height), 0, 0);
        // Canvas and histogram accept exactly the same source, Recipe, and processing route.
        callbacks.current.onHistogramChange?.({ sourceKey, before: beforeHistogram, after: histogram });
        callbacks.current.onBackendChange?.(backend);
      } catch { callbacks.current.onError(); }
    };
    let client: AdjustmentWorkerClient | AdjustmentGpuClient | null = null;
    if (renderer) {
      client = new AdjustmentGpuClient(renderer, pixels, {
        isCurrentRecipe,
        onResult: (result) => {
          if (isCurrent()) paint(result.pixels, result.width, result.height, collectHistogram(result.pixels), 'gpu');
        },
        onError: (error) => {
          if (!isCurrent()) return;
          // Reuse decoded pixels for CPU fallback; GPU errors are not image download/decode errors.
          setFailedGpu(renderer);
          callbacks.current.onGpuError?.(renderer, error);
        },
      });
      workerClient.current = client;
    } else {
      try {
        const worker = new Worker(new URL('./adjustmentWorker.ts', import.meta.url), { type: 'module' });
        const cpuClient = new AdjustmentWorkerClient(worker, nextAssetGeneration++, {
          isCurrentRecipe,
          onResult: (result) => paint(new Uint8ClampedArray(result.pixelBuffer), result.width, result.height, result.histogram, 'cpu'),
          onError: (error) => {
            if (!isCurrent()) return;
            console.warn('Adjustment worker failed; using main-thread fallback.', error);
            if (workerClient.current === client) workerClient.current = null;
            setWorkerFailure((value) => value + 1);
          },
        });
        client = cpuClient;
        workerClient.current = client;
        cpuClient.initialize(pixels.data, pixels.width, pixels.height);
      } catch (error) {
        client?.dispose();
        console.warn('Adjustment worker could not start; using main-thread fallback.', error);
        workerClient.current = null;
        setWorkerFailure((value) => value + 1);
      }
    }
    return () => {
      active = false;
      if (workerClient.current === client) workerClient.current = null;
      client?.dispose();
    };
  }, [pixels, sourceKey, beforeHistogram, renderer]);
  useEffect(() => {
    if (!pixels) return;
    // Coalesce Recipe changes before issuing a request to either processing route.
    const frame = requestAnimationFrame(() => {
      if (currentRoute.current.sourceKey !== sourceKey || currentRoute.current.renderer !== renderer
        || currentRoute.current.recipe !== recipe) return;
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
        callbacks.current.onBackendChange?.('cpu');
      } catch { callbacks.current.onError(); }
    });
    return () => cancelAnimationFrame(frame);
  }, [pixels, recipe, workerFailure, sourceKey, beforeHistogram, renderer]);
  return <div className="viewer-comparison-image" role="img" aria-label={alt}
    style={{ width: width ? `${width}px` : undefined }}>
    <canvas ref={beforeCanvas} aria-hidden="true" width={pixels?.width ?? 0} height={pixels?.height ?? 0} />
    <canvas ref={afterCanvas} aria-hidden="true" width={pixels?.width ?? 0} height={pixels?.height ?? 0}
      className={showBeforeAdjustments ? 'comparison-hidden' : undefined} />
  </div>;
}

let nextAssetGeneration = 1;
