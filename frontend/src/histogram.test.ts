import { describe, expect, it } from 'vitest';
import { collectHistogram } from './histogram';

describe('collectHistogram', () => {
  it('counts black, white and middle gray using 256 Uint32 bins', () => {
    const result = collectHistogram(new Uint8ClampedArray([
      0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255,
    ]));
    for (const channel of Object.values(result)) {
      expect(channel).toBeInstanceOf(Uint32Array);
      expect(channel).toHaveLength(256);
      expect(channel[0]).toBe(1);
      expect(channel[128]).toBe(1);
      expect(channel[255]).toBe(1);
      expect(channel.reduce((sum, count) => sum + count, 0)).toBe(3);
    }
  });

  it('counts RGB primaries and rounds nonlinear BT.709 Y-prime', () => {
    const result = collectHistogram(new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      1, 0, 0, 255, 0, 1, 0, 255,
    ]));
    expect(result.r[255]).toBe(1);
    expect(result.g[255]).toBe(1);
    expect(result.b[255]).toBe(1);
    expect(result.y[54]).toBe(1);
    expect(result.y[182]).toBe(1);
    expect(result.y[18]).toBe(1);
    expect(result.y[0]).toBe(1);
    expect(result.y[1]).toBe(1);
    for (const channel of Object.values(result)) {
      expect(channel.reduce((sum, count) => sum + count, 0)).toBe(5);
    }
  });

  it('counts repeated pixels independently of alpha without mutating input', () => {
    const pixels = new Uint8ClampedArray([20, 40, 60, 0, 20, 40, 60, 255, 20, 40, 60, 73]);
    const original = pixels.slice();
    const result = collectHistogram(pixels);
    expect(pixels).toEqual(original);
    expect(result.r[20]).toBe(3);
    expect(result.g[40]).toBe(3);
    expect(result.b[60]).toBe(3);
    expect(result.y[37]).toBe(3);
    for (const channel of Object.values(result)) {
      expect(channel.reduce((sum, count) => sum + count, 0)).toBe(pixels.length / 4);
    }
  });

  it('returns empty bins for empty input and rejects incomplete RGBA', () => {
    for (const channel of Object.values(collectHistogram(new Uint8ClampedArray()))) {
      expect(channel.every((count) => count === 0)).toBe(true);
    }
    expect(() => collectHistogram(new Uint8ClampedArray(3))).toThrow('complete RGBA');
  });
});
