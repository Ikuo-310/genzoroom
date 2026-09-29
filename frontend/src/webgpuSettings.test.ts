import { describe, expect, it, vi } from 'vitest';
import { readWebGpuEnabled, saveWebGpuEnabled, WEBGPU_STORAGE_KEY } from './webgpuSettings';

describe('WebGPU preference storage', () => {
  it.each([null, 'true', 'invalid'])('defaults to enabled for %s', value => {
    expect(readWebGpuEnabled({ getItem: () => value })).toBe(true);
  });
  it('reads an explicit OFF preference and writes both choices', () => {
    const storage = { getItem: vi.fn(() => 'false'), setItem: vi.fn() };
    expect(readWebGpuEnabled(storage)).toBe(false);
    expect(storage.getItem).toHaveBeenCalledWith(WEBGPU_STORAGE_KEY);
    saveWebGpuEnabled(true, storage);
    saveWebGpuEnabled(false, storage);
    expect(storage.setItem.mock.calls).toEqual([[WEBGPU_STORAGE_KEY, 'true'], [WEBGPU_STORAGE_KEY, 'false']]);
  });
  it('continues when storage access is denied', () => {
    const storage = { getItem: () => { throw new Error('Denied'); }, setItem: () => { throw new Error('Full'); } };
    expect(readWebGpuEnabled(storage)).toBe(true);
    expect(() => saveWebGpuEnabled(false, storage)).not.toThrow();
    expect(readWebGpuEnabled(storage)).toBe(false);
    saveWebGpuEnabled(true, { setItem: () => {} });
  });
});
