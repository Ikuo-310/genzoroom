// @vitest-environment jsdom
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

function render(source: EditImageSource, recipe = defaultRecipe()) {
  act(() => root.render(<AdjustedImage source={source} recipe={recipe} alt="preview"
    onLoad={vi.fn()} onError={vi.fn()} />));
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
    expect(putImageData).toHaveBeenCalledOnce();
    expect((putImageData.mock.calls[0][0] as TestImageData).data).toEqual(renderAdjustments(secondPixels.data, recipe));
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

    render(secondSource);
    await act(async () => {});
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    staleHandler?.({ data: {
      type: 'result', requestId: firstRender.requestId, assetGeneration: firstInit.assetGeneration,
      pixelBuffer: new Uint8ClampedArray([1, 2, 3, 4]).buffer, width: 1, height: 1,
    } } as MessageEvent<AdjustmentWorkerResponse>);
    expect(putImageData).not.toHaveBeenCalled();

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
      pixelBuffer: new Uint8ClampedArray([9, 8, 7, 73]).buffer, width: 1, height: 1,
    });
    expect(putImageData).toHaveBeenCalledOnce();

    act(() => root.unmount());
    expect(secondWorker.terminate).toHaveBeenCalledOnce();
    root = createRoot(host);
  });

  it('falls back to the byte-identical main-thread renderer after a Worker error', async () => {
    vi.mocked(decodeEditSource).mockResolvedValue(firstPixels);
    const recipe = defaultRecipe();
    recipe.adjustments.shadowsTemperature = 60;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(firstSource, recipe);
    await act(async () => {});
    flushFrames();
    const worker = FakeWorker.instances[0];
    act(() => worker.onerror?.({ message: 'worker crash' } as ErrorEvent));
    flushFrames();

    expect(warning).toHaveBeenCalledWith(
      'Adjustment worker failed; using main-thread fallback.',
      expect.objectContaining({ message: 'worker crash' }),
    );
    expect(putImageData).toHaveBeenCalledOnce();
    const rendered = putImageData.mock.calls[0][0] as TestImageData;
    expect(rendered.data).toEqual(renderAdjustments(firstPixels.data, recipe));
  });
});
