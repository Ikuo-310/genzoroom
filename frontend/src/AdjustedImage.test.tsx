// @vitest-environment jsdom
import { collectHistogram, type HistogramChangeHandler } from './histogram';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdjustedImage } from './AdjustedImage';
import { renderAdjustments } from './adjustmentPipeline';
import type { AdjustmentWorkerRequest, AdjustmentWorkerResponse } from './adjustmentWorkerProtocol';
import { decodeEditSource, type EditImageSource } from './editImageSource';
import { defaultRecipe } from './editing';

vi.mock('./editImageSource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./editImageSource')>();
  return { ...actual, decodeEditSource: vi.fn() };
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<AdjustmentWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  sent: AdjustmentWorkerRequest[] = [];
  terminate = vi.fn();

  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: AdjustmentWorkerRequest) { this.sent.push(message); }
  emit(response: AdjustmentWorkerResponse) { this.onmessage?.({ data: response } as MessageEvent<AdjustmentWorkerResponse>); }
}

class TestImageData {
  constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
}

const firstSource: EditImageSource = { kind: 'immich-preview', url: '/first' };
const secondSource: EditImageSource = { kind: 'immich-preview', url: '/second' };
const firstPixels = new TestImageData(new Uint8ClampedArray([20, 40, 60, 255]), 1, 1) as ImageData;
const secondPixels = new TestImageData(new Uint8ClampedArray([80, 100, 120, 73]), 1, 1) as ImageData;

let host: HTMLDivElement;
let root: Root;
let frames: Array<{ id: number; callback: FrameRequestCallback }>;
let nextFrame: number;
let putImageData: ReturnType<typeof vi.fn>;
let onHistogramChange: ReturnType<typeof vi.fn<HistogramChangeHandler>>;

function render(source: EditImageSource, recipe = defaultRecipe(), showBeforeAdjustments = false) {
  act(() => root.render(<AdjustedImage source={source} recipe={recipe} alt="preview"
    showBeforeAdjustments={showBeforeAdjustments} onHistogramChange={onHistogramChange} onLoad={vi.fn()} onError={vi.fn()} />));
}

function flushFrames() {
  const pending = frames;
  frames = [];
  act(() => pending.forEach(({ callback }) => callback(0)));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('ImageData', TestImageData);
  frames = [];
  nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.push({ id, callback });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames = frames.filter((frame) => frame.id !== id);
  });
  putImageData = vi.fn();
  onHistogramChange = vi.fn<HistogramChangeHandler>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData } as unknown as CanvasRenderingContext2D);
  FakeWorker.instances = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AdjustedImage Worker lifecycle', () => {
  it('rejects a retired original Worker even when returning to the same cached URL', async () => {
    const original: EditImageSource = { kind: 'jpeg-original', url: 'blob:original' };
    vi.mocked(decodeEditSource).mockResolvedValue(secondPixels);
    render(original); await act(async () => {}); flushFrames();
    const oldWorker = FakeWorker.instances[0];
    const staleHandler = oldWorker.onmessage;
    const init = oldWorker.sent[0]; const request = oldWorker.sent[1];
    if (init.type !== 'init' || request.type !== 'render') throw new Error('Expected worker messages');
    render(firstSource); await act(async () => {}); flushFrames();
    render(original); await act(async () => {}); flushFrames();
    const count = onHistogramChange.mock.calls.length;
    staleHandler?.({ data: { type: 'result', requestId: request.requestId, assetGeneration: init.assetGeneration,
      pixelBuffer: firstPixels.data.slice().buffer, histogram: collectHistogram(firstPixels.data), width: 1, height: 1,
    } } as MessageEvent<AdjustmentWorkerResponse>);
    expect(onHistogramChange).toHaveBeenCalledTimes(count);
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(onHistogramChange).toHaveBeenLastCalledWith({ sourceKey: 'jpeg-original:blob:original', before: collectHistogram(secondPixels.data), after: null });
  });
  it('notifies only the painted latest Worker histogram and caches the before histogram', async () => {
    vi.mocked(decodeEditSource).mockResolvedValue(firstPixels);
    render(firstSource);
    await act(async () => {});
    flushFrames();
    const before = onHistogramChange.mock.calls[1][0].before;
    expect(before).toEqual(collectHistogram(firstPixels.data));
    const recipe = defaultRecipe();
    recipe.adjustments.exposure = 1;
    render(firstSource, recipe);
    flushFrames();
    const worker = FakeWorker.instances[0];
    const init = worker.sent[0];
    if (init.type !== 'init') throw new Error('Expected init');
    const histogram = collectHistogram(new Uint8ClampedArray([9, 8, 7, 255]));
    const result = { type: 'result' as const, requestId: 1, assetGeneration: init.assetGeneration,
      pixelBuffer: new Uint8ClampedArray([9, 8, 7, 255]).buffer, histogram, width: 1, height: 1 };
    worker.emit(result);
    expect(onHistogramChange).toHaveBeenCalledTimes(2);
    expect(putImageData).toHaveBeenCalledOnce();
    worker.emit({ ...result, requestId: 2 });
    expect(onHistogramChange).toHaveBeenLastCalledWith({ sourceKey: 'immich-preview:/first', before, after: histogram });
    expect(onHistogramChange.mock.calls[2][0].before).toBe(before);
    render(firstSource, recipe, true);
    render(firstSource, recipe, false);
    expect(onHistogramChange).toHaveBeenCalledTimes(3);
    expect(vi.mocked(decodeEditSource)).toHaveBeenCalledOnce();
    render(firstSource, defaultRecipe());
    flushFrames();
    const staleHandler = worker.onmessage;
    act(() => root.unmount());
    staleHandler?.({ data: { ...result, requestId: 3 } } as MessageEvent<AdjustmentWorkerResponse>);
    expect(onHistogramChange).toHaveBeenCalledTimes(3);
    root = createRoot(host);
  });

  it('ignores old decode completion after a photo switch or unmount', async () => {
    let resolveFirst!: (pixels: ImageData) => void;
    let resolveSecond!: (pixels: ImageData) => void;
    vi.mocked(decodeEditSource)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    render(firstSource);
    render(secondSource);
    await act(async () => resolveFirst(firstPixels));
    expect(onHistogramChange).toHaveBeenCalledTimes(2);
    expect(onHistogramChange.mock.calls.every(([value]) => value.before === null)).toBe(true);
    act(() => root.unmount());
    await act(async () => resolveSecond(secondPixels));
    expect(onHistogramChange).toHaveBeenCalledTimes(2);
    expect(FakeWorker.instances).toHaveLength(0);
    root = createRoot(host);
  });

  it('does not notify an adjusted histogram when painting fails', async () => {
    vi.mocked(decodeEditSource).mockResolvedValue(firstPixels);
    render(firstSource);
    await act(async () => {});
    flushFrames();
    putImageData.mockImplementationOnce(() => { throw new Error('paint failed'); });
    const worker = FakeWorker.instances[0];
    const init = worker.sent[0];
    if (init.type !== 'init') throw new Error('Expected init');
    worker.emit({ type: 'result', requestId: 1, assetGeneration: init.assetGeneration,
      pixelBuffer: firstPixels.data.slice().buffer, histogram: collectHistogram(firstPixels.data), width: 1, height: 1 });
    expect(onHistogramChange).toHaveBeenCalledTimes(2);
    expect(onHistogramChange.mock.calls.every(([value]) => value.after === null)).toBe(true);
  });

  it.each(['unavailable', 'initialization failure'])('falls back when Worker startup has %s', async (failure) => {
    vi.mocked(decodeEditSource).mockResolvedValue(secondPixels);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (failure === 'unavailable') vi.stubGlobal('Worker', undefined);
    else vi.spyOn(FakeWorker.prototype, 'postMessage').mockImplementationOnce(() => { throw new Error('init failed'); });
    const recipe = defaultRecipe();
    recipe.adjustments.temperature = 30;
    recipe.adjustments.midtonesTint = 75;
    recipe.gradingMidtonesEnabled = false;
    render(secondSource, recipe);
    await act(async () => {});
    flushFrames();
    expect(putImageData).toHaveBeenCalledTimes(2);
    expect((putImageData.mock.calls[0][0] as TestImageData).data).toEqual(secondPixels.data);
    expect((putImageData.mock.calls[1][0] as TestImageData).data).toEqual(renderAdjustments(secondPixels.data, recipe));
    expect(onHistogramChange).toHaveBeenLastCalledWith({ sourceKey: 'immich-preview:/second', before: collectHistogram(secondPixels.data), after: collectHistogram(renderAdjustments(secondPixels.data, recipe)) });
    if (failure === 'initialization failure') expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it('terminates the old asset Worker, ignores its result, and cleans up on unmount', async () => {
    vi.mocked(decodeEditSource)
      .mockResolvedValueOnce(firstPixels)
      .mockResolvedValueOnce(secondPixels);
    render(firstSource);
    await act(async () => {});
    flushFrames();
    const firstWorker = FakeWorker.instances[0];
    const firstInit = firstWorker.sent[0];
    const firstRender = firstWorker.sent[1];
    expect(firstInit.type).toBe('init');
    expect(firstRender.type).toBe('render');
    if (firstInit.type !== 'init' || firstRender.type !== 'render') throw new Error('Expected init and render');
    const staleHandler = firstWorker.onmessage;
    firstWorker.emit({
      type: 'result', requestId: firstRender.requestId, assetGeneration: firstInit.assetGeneration,
      histogram: collectHistogram(new Uint8ClampedArray([5, 6, 7, 255])), pixelBuffer: new Uint8ClampedArray([5, 6, 7, 255]).buffer, width: 1, height: 1,
    });

    render(secondSource);
    expect(host.querySelectorAll('canvas')[1].width).toBe(0);
    await act(async () => {});
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    const notificationsAfterSwitch = onHistogramChange.mock.calls.length;
    staleHandler?.({ data: {
      type: 'result', requestId: firstRender.requestId, assetGeneration: firstInit.assetGeneration,
      histogram: collectHistogram(new Uint8ClampedArray([1, 2, 3, 4])), pixelBuffer: new Uint8ClampedArray([1, 2, 3, 4]).buffer, width: 1, height: 1,
    } } as MessageEvent<AdjustmentWorkerResponse>);
    expect(putImageData).toHaveBeenCalledTimes(3);
    expect(onHistogramChange).toHaveBeenCalledTimes(notificationsAfterSwitch);
    expect(onHistogramChange).toHaveBeenLastCalledWith({
      sourceKey: 'immich-preview:/second', before: collectHistogram(secondPixels.data), after: null,
    });

    flushFrames();
    const secondWorker = FakeWorker.instances[1];
    const secondInit = secondWorker.sent[0];
    const secondRender = secondWorker.sent[1];
    expect(secondInit.type).toBe('init');
    expect(secondRender.type).toBe('render');
    if (secondInit.type !== 'init' || secondRender.type !== 'render') throw new Error('Expected init and render');
    expect(secondInit.assetGeneration).toBeGreaterThan(firstInit.assetGeneration);
    secondWorker.emit({
      type: 'result', requestId: secondRender.requestId, assetGeneration: secondInit.assetGeneration,
      histogram: collectHistogram(new Uint8ClampedArray([9, 8, 7, 73])), pixelBuffer: new Uint8ClampedArray([9, 8, 7, 73]).buffer, width: 1, height: 1,
    });
    expect(putImageData).toHaveBeenCalledTimes(4);

    act(() => root.unmount());
    expect(secondWorker.terminate).toHaveBeenCalledOnce();
    root = createRoot(host);
  });

  it('falls back to the byte-identical main-thread renderer after a Worker error', async () => {
    vi.mocked(decodeEditSource).mockResolvedValue(firstPixels);
    const recipe = defaultRecipe();
    recipe.adjustments.shadowsTemperature = 60;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(firstSource);
    await act(async () => {});
    flushFrames();
    render(firstSource, recipe);
    flushFrames();
    const worker = FakeWorker.instances[0];
    act(() => worker.onerror?.({ message: 'worker crash' } as ErrorEvent));
    flushFrames();

    expect(warning).toHaveBeenCalledWith(
      'Adjustment worker failed; using main-thread fallback.',
      expect.objectContaining({ message: 'worker crash' }),
    );
    expect(putImageData).toHaveBeenCalledTimes(2);
    const rendered = putImageData.mock.calls[1][0] as TestImageData;
    expect(rendered.data).toEqual(renderAdjustments(firstPixels.data, recipe));
    expect(onHistogramChange).toHaveBeenLastCalledWith({ sourceKey: 'immich-preview:/first', before: collectHistogram(firstPixels.data), after: collectHistogram(rendered.data) });
  });

  it('switches cached source and adjusted canvases without a Worker render or recipe change', async () => {
    vi.mocked(decodeEditSource).mockResolvedValue(firstPixels);
    const recipe = defaultRecipe();
    recipe.adjustments.tint = 40;
    render(firstSource, recipe);
    await act(async () => {});
    flushFrames();
    const worker = FakeWorker.instances[0];
    const initialRequests = worker.sent.length;
    const sourceCanvas = host.querySelectorAll('canvas')[0];
    const adjustedCanvas = host.querySelectorAll('canvas')[1];
    expect((putImageData.mock.calls[0][0] as TestImageData).data).toEqual(firstPixels.data);
    render(firstSource, recipe, true);
    expect(adjustedCanvas.classList.contains('comparison-hidden')).toBe(true);
    expect(sourceCanvas.classList.contains('comparison-hidden')).toBe(false);
    const init = worker.sent[0];
    const request = worker.sent[1];
    if (init.type !== 'init' || request.type !== 'render') throw new Error('Expected init and render');
    worker.emit({
      type: 'result', requestId: request.requestId, assetGeneration: init.assetGeneration,
      histogram: collectHistogram(new Uint8ClampedArray([9, 8, 7, 255])), pixelBuffer: new Uint8ClampedArray([9, 8, 7, 255]).buffer, width: 1, height: 1,
    });
    expect((putImageData.mock.calls[1][0] as TestImageData).data).toEqual(new Uint8ClampedArray([9, 8, 7, 255]));
    render(firstSource, recipe, false);
    expect(adjustedCanvas.classList.contains('comparison-hidden')).toBe(false);
    expect(worker.sent).toHaveLength(initialRequests);
    expect(putImageData).toHaveBeenCalledTimes(2);
    expect(recipe.adjustments.tint).toBe(40);
  });
});
