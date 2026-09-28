export type Histogram = {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  y: Uint32Array;
};

export type ImageHistograms = {
  sourceKey: string;
  before: Histogram | null;
  after: Histogram | null;
};

export type AssetHistograms = ImageHistograms & { assetId: string };
export type HistogramChangeHandler = (histograms: ImageHistograms) => void;

export function collectHistogram(pixels: Uint8ClampedArray): Histogram {
  if (pixels.length % 4 !== 0) throw new Error('Histogram input must contain complete RGBA pixels.');
  const histogram: Histogram = {
    r: new Uint32Array(256), g: new Uint32Array(256),
    b: new Uint32Array(256), y: new Uint32Array(256),
  };
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    histogram.r[r]++;
    histogram.g[g]++;
    histogram.b[b]++;
    // Y-prime uses nonlinear sRGB code values, independently of pipeline luminance.
    histogram.y[Math.max(0, Math.min(255, Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)))]++;
  }
  return histogram;
}
