import { describe, expect, it } from 'vitest';
import { defaultRecipe, type EditRecipe } from './editing';
import { renderAdjustments } from './exposurePipeline';

function compatibilityPixels() {
  const pixels = new Uint8ClampedArray((4096 + 256) * 4);
  let seed = 17;
  for (let i = 0; i < 4096 * 4; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels.set([seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, seed >>> 24], i);
  }
  for (let value = 0; value < 256; value++) pixels.set([value, value, value, value], (4096 + value) * 4);
  return pixels;
}

// Frozen outputs from pre-optimization commit 99c58aae3ec621eddbea0b4d7e5ba76c52be5147.
// Mixed RGB/alpha plus all 256 grayscale levels; do not regenerate from the optimized pipeline.
const compatibilityCases: Array<{ name: string; adjustments: Partial<EditRecipe['adjustments']>; hash: string }> = [
  { name: "identity", adjustments: {}, hash: '32dc59115896b5af444fc62db05c6c47fcc24260a1d0aef1211a5627f339cc9e' },
  { name: "exposure", adjustments: {"exposure":0.5}, hash: 'ff9bfc9222ac55ea7050a20ca2ebe020ca63c2071ade2e10f15c009f9d281e36' },
  { name: "highlights -100", adjustments: {"highlights":-100}, hash: 'bd5bceddac4bdb7b8766fd5d4349457785e3baec04c7b1ade64fbb466af90726' },
  { name: "highlights 100", adjustments: {"highlights":100}, hash: '9e3eb05f42423513761c5b61f13d1f31509856556dd356d0e3eeb1d13e47c323' },
  { name: "whites -100", adjustments: {"whites":-100}, hash: '85ec989a0c7cf1f73a31ffc8e35e1c516bb95e023a5433966477fe698f6be46a' },
  { name: "whites 100", adjustments: {"whites":100}, hash: '86d28226d4ffc6be4a2fc9008fb88dfad948763e81e9bdbf32f69f9a15ab1569' },
  { name: "shadows -100", adjustments: {"shadows":-100}, hash: 'db72730826a567c392411be9e89ec9ad6d5875d4d17cb84d2a4d982ec20921d3' },
  { name: "shadows 100", adjustments: {"shadows":100}, hash: '623c27ebd3e061bf40aa821568d0771d52c005a7756280878168a89d493a08e0' },
  { name: "blacks -100", adjustments: {"blacks":-100}, hash: 'd5c7f67c1bb63d5bd0f30a06250349c9e597d26bdeec6bf3ed6b5d5a0442db1f' },
  { name: "blacks 100", adjustments: {"blacks":100}, hash: 'f6d78387e39039e0e2f1c5d3faf0c85603b6e36d9e204b28edb03a9d2aea5aad' },
  { name: "six", adjustments: {"exposure":0.5,"contrast":20,"highlights":-30,"whites":25,"shadows":40,"blacks":-20}, hash: '7a4bbee2bfc99b7edf754dce121f3a7d4bf7cd61258e769252d7f271f1c57a74' },
  { name: "six opposite", adjustments: {"exposure":-0.5,"contrast":-20,"highlights":30,"whites":-25,"shadows":-40,"blacks":20}, hash: '6ee20f9c4b41d7002967909113ca9d5fc003086d92b9eb66226d52e8a64fac48' },
  { name: "clipping", adjustments: {"exposure":5,"contrast":100,"highlights":-100,"whites":-100,"shadows":100,"blacks":100}, hash: 'ef17153241787b00f5dc574969b2ff23d4aecca4364d6bfdf5fbdbbf24c69b87' },
];

describe('preview byte compatibility', () => {
  it.each(compatibilityCases)('preserves baseline bytes: $name', async ({ adjustments, hash }) => {
    const source = compatibilityPixels();
    const original = source.slice();
    const recipe = defaultRecipe();
    Object.assign(recipe.adjustments, adjustments);
    const result = renderAdjustments(source, recipe);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', result));
    expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')).toBe(hash);
    expect(source).toEqual(original);
    for (let i = 3; i < result.length; i += 4) expect(result[i]).toBe(source[i]);
  });

  it.each(['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks'] as const)('%s at zero is identity', (name) => {
    const recipe = defaultRecipe();
    recipe.adjustments[name] = 0;
    const source = compatibilityPixels();
    expect(renderAdjustments(source, recipe)).toEqual(source);
  });

  it.each([
    ['highlights', [127, 127, 127, 17]],
    ['whites', [4, 243, 230, 31]],
    ['shadows', [15, 36, 129, 73]],
    ['blacks', [1, 104, 203, 139]],
  ] as const)('%s leaves its inactive boundary side unchanged in both directions', (name, rgba) => {
    const source = new Uint8ClampedArray(rgba);
    for (const value of [-100, 100]) {
      const recipe = defaultRecipe();
      recipe.adjustments[name] = value;
      expect(renderAdjustments(source, recipe)).toEqual(source);
    }
  });

  it.each([
    ['highlights', [210, 200, 190, 17]],
    ['whites', [250, 240, 230, 31]],
    ['shadows', [30, 20, 10, 73]],
    ['blacks', [72, 48, 24, 139]],
  ] as const)('%s still changes pixels inside its active region', (name, rgba) => {
    for (const value of [-100, 100]) {
      const recipe = defaultRecipe();
      recipe.adjustments[name] = value;
      const result = renderAdjustments(new Uint8ClampedArray(rgba), recipe);
      if (value > 0) expect(result[0]).toBeGreaterThan(rgba[0]);
      else expect(result[0]).toBeLessThan(rgba[0]);
      expect(result[3]).toBe(rgba[3]);
    }
  });
});
