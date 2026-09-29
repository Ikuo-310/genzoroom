import { describe, expect, it, vi } from 'vitest';
import { AdjustmentGpuClient } from './adjustmentGpuClient';
import { defaultRecipe } from './editing';
import { deferred } from './webgpuTestDevice.testSupport';
import type { GpuAdjustmentResult } from './webgpuAdjustmentRenderer';

const pixels = { data: new Uint8ClampedArray([2, 3, 4, 73]), width: 1, height: 1 } as ImageData;
const result = (requestId = 1): GpuAdjustmentResult => ({ pixels: pixels.data.slice(), width: 1, height: 1, sourceGeneration: 4, requestId });
function setup() {
  const renderer = { available: true, dispose: vi.fn(), onDeviceLost: vi.fn(() => () => {}),
    setSource: vi.fn(async () => 4), render: vi.fn(async () => result()) };
  const callbacks = { onResult: vi.fn(), onError: vi.fn(), isCurrentRecipe: vi.fn(() => true) };
  return { renderer, callbacks, client: new AdjustmentGpuClient(renderer, pixels, callbacks) };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('GPU scheduling with mocked results, not WGSL execution', () => {
  it('uploads once and retains only the latest Recipe during upload and rendering', async () => {
    const { renderer, callbacks, client } = setup();
    const upload = deferred<number>(), first = deferred<GpuAdjustmentResult>();
    renderer.setSource.mockReturnValueOnce(upload.promise);
    renderer.render.mockReturnValueOnce(first.promise).mockResolvedValueOnce(result(2));
    const recipes = Array.from({ length: 5 }, () => defaultRecipe());
    client.render(recipes[0]); client.render(recipes[1]); client.render(recipes[2]);
    expect(renderer.render).not.toHaveBeenCalled();
    upload.resolve(4); await tick();
    expect(renderer.render).toHaveBeenCalledExactlyOnceWith(recipes[2]);
    client.render(recipes[3]); client.render(recipes[4]);
    first.resolve(result()); await tick();
    expect(renderer.render).toHaveBeenNthCalledWith(2, recipes[4]);
    expect(renderer.setSource).toHaveBeenCalledExactlyOnceWith(pixels.data, 1, 1);
    expect(callbacks.onResult).toHaveBeenCalledExactlyOnceWith(result(2));
  });
  it('rejects a Recipe that changed before its RAF request was submitted', async () => {
    const { callbacks, client } = setup();
    callbacks.isCurrentRecipe.mockReturnValue(false);
    client.render(defaultRecipe()); await tick();
    expect(callbacks.onResult).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
  it.each(['upload', 'render'])('reports %s failure once and rejects further work', async stage => {
    const { renderer, callbacks, client } = setup();
    const error = new Error('Device lost');
    if (stage === 'upload') renderer.setSource.mockRejectedValueOnce(error);
    else renderer.render.mockRejectedValueOnce(error);
    client.render(defaultRecipe()); await tick();
    client.render(defaultRecipe()); await tick();
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(callbacks.onResult).not.toHaveBeenCalled();
    expect(renderer.setSource).toHaveBeenCalledOnce();
  });
  it.each(['sourceGeneration', 'width', 'requestId'] as const)('rejects invalid %s', async field => {
    const { renderer, callbacks, client } = setup();
    renderer.render.mockResolvedValue({ ...result(), [field]: 0 });
    client.render(defaultRecipe()); await tick();
    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(callbacks.onResult).not.toHaveBeenCalled();
  });
  it('drops completion and pending work after disposal without destroying the workspace device', async () => {
    const { renderer, callbacks, client } = setup();
    const pending = deferred<GpuAdjustmentResult>();
    renderer.render.mockReturnValueOnce(pending.promise);
    client.render(defaultRecipe()); await tick();
    client.render(defaultRecipe()); client.dispose();
    pending.resolve(result()); await tick();
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(callbacks.onResult).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(renderer.dispose).not.toHaveBeenCalled();
  });
});
