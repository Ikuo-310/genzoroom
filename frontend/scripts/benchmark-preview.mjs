// Node 24 reference benchmark, excluding Canvas, React, decode and RAF costs.
// From frontend/: node scripts/benchmark-preview.mjs <baseline-git-ref>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ref = process.argv[2];
if (!ref || ref.startsWith('-')) throw new Error('Supply a baseline git ref.');
const compile = (source) => new Function(
  stripTypeScriptTypes(source).replace('export function', 'function') + '; return renderAdjustments;',
)();
const before = compile(execFileSync('git', ['show', `${ref}:frontend/src/exposurePipeline.ts`], { cwd: root, encoding: 'utf8' }));
const after = compile(readFileSync(new URL('../src/exposurePipeline.ts', import.meta.url), 'utf8'));
const names = ['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks'];
const cases = { identity: [0, 0, 0, 0, 0, 0], exposure: [0.5, 0, 0, 0, 0, 0], six: [0.5, 20, -30, 25, 40, -20] };
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({ node: process.version, baseline: ref, warmup: 3, samples: 7, seed: 17 }));
for (const [width, height] of [[640, 360], [1920, 1080], [2560, 1440]]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  let seed = 17;
  for (let i = 0; i < pixels.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed & 255;
    pixels[i + 1] = (seed >>> 8) & 255;
    pixels[i + 2] = (seed >>> 16) & 255;
    pixels[i + 3] = 255;
  }
  for (const [name, values] of Object.entries(cases)) {
    const recipe = { version: 6, basicEnabled: true, adjustments: Object.fromEntries(names.map((key, i) => [key, values[i]])) };
    assert.deepEqual(after(pixels, recipe), before(pixels, recipe));
    for (let i = 0; i < 3; i++) { before(pixels, recipe); after(pixels, recipe); }
    const timings = [[], []];
    for (let sample = 0; sample < 7; sample++) {
      // Alternate order to reduce bias from warmup and machine drift.
      for (const index of sample % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now();
        const result = [before, after][index](pixels, recipe);
        timings[index].push(performance.now() - start);
        assert.equal(result.length, pixels.length);
      }
    }
    const beforeMs = median(timings[0]), afterMs = median(timings[1]);
    console.log(JSON.stringify({ width, height, name, beforeMs: +beforeMs.toFixed(2), afterMs: +afterMs.toFixed(2), reductionPercent: +(100 * (1 - afterMs / beforeMs)).toFixed(1) }));
  }
}
