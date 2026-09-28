import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const basic = { exposure: 0.5, contrast: 20, highlights: -30, whites: 25, shadows: 40, blacks: -20 };
const wb = { temperature: -25, tint: 15 };
const grading = { shadowsTemperature: 60, shadowsTint: -45, midtonesTemperature: -70, midtonesTint: 65, highlightsTemperature: 80, highlightsTint: -90 };
const color = { vibrance: 25, saturation: 15 };

export function cases(defaultRecipe) {
  const result = {};
  const add = (name, values) => {
    const recipe = defaultRecipe();
    assert.equal(recipe.version, 18, 'Re-audit benchmark cases before using another Recipe version');
    Object.assign(recipe.adjustments, values);
    result[name] = { recipe, zeroKeys: [] };
  };
  for (const [name, values] of Object.entries({ identity: {}, exposure: { exposure: 0.5 }, basic, wb,
    'wb-basic': { ...wb, ...basic }, grading, color, all: { ...basic, ...wb, ...grading, ...color } })) add(name, values);
  for (const [key, value] of Object.entries({ ...grading, ...color })) add(key, { [key]: value });
  for (const range of ['shadows', 'midtones', 'highlights']) {
    add(range, Object.fromEntries(Object.entries(grading).filter(([key]) => key.startsWith(range))));
  }
  const groups = { whiteBalanceEnabled: Object.keys(wb), basicEnabled: Object.keys(basic),
    colorGradingEnabled: Object.keys(grading), colorEnabled: Object.keys(color),
    gradingShadowsEnabled: ['shadowsTemperature', 'shadowsTint'],
    gradingMidtonesEnabled: ['midtonesTemperature', 'midtonesTint'],
    gradingHighlightsEnabled: ['highlightsTemperature', 'highlightsTint'] };
  for (const [flag, keys] of Object.entries(groups)) {
    const recipe = structuredClone(result.all.recipe);
    recipe[flag] = false;
    result[`bypass-${flag}`] = { recipe, zeroKeys: keys };
  }
  for (const key of Object.keys(result.all.recipe.adjustments)) {
    const recipe = structuredClone(result.all.recipe);
    recipe.adjustmentEnabled[key] = false;
    result[`bypass-${key}`] = { recipe, zeroKeys: [key] };
  }
  const recipe = structuredClone(result.all.recipe);
  for (const flag of ['whiteBalanceEnabled', 'basicEnabled', 'colorGradingEnabled', 'colorEnabled']) recipe[flag] = false;
  result['bypass-all'] = { recipe, zeroKeys: Object.keys(recipe.adjustments) };
  return result;
}

export function pixels(width, height, seed, variableAlpha = false) {
  const source = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < source.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    source[i] = seed & 255;
    source[i + 1] = (seed >>> 8) & 255;
    source[i + 2] = (seed >>> 16) & 255;
    source[i + 3] = variableAlpha ? seed >>> 24 : 255;
  }
  return source;
}

export function verify(render, catalog, defaultRecipe) {
  const source = pixels(64, 4, 17, true);
  const original = source.slice();
  const outputs = {};
  for (const [name, { recipe, zeroKeys }] of Object.entries(catalog)) {
    const recipeBefore = structuredClone(recipe);
    const output = render(source, recipe);
    assert.deepEqual(source, original, `${name}: source changed`);
    assert.deepEqual(recipe, recipeBefore, `${name}: recipe changed`);
    assert.notEqual(output.buffer, source.buffer, `${name}: source buffer reused`);
    assert.equal(output.length, source.length);
    for (let i = 3; i < output.length; i += 4) assert.equal(output[i], source[i], `${name}: alpha changed`);
    if (name === 'identity') assert.deepEqual(output, source);
    if (zeroKeys.length) {
      // Explicit expected keys avoid testing effectiveAdjustments against itself.
      const expected = defaultRecipe();
      Object.assign(expected.adjustments, recipe.adjustments);
      for (const key of zeroKeys) expected.adjustments[key] = 0;
      assert.deepEqual(output, render(source, expected), `${name}: bypass differs from zero values`);
    }
    outputs[name] = hash(output);
  }
  return { type: 'validation', passed: true, pixels: source.length / 4, cases: Object.keys(catalog).length,
    inputHash: hash(source), outputHashes: outputs };
}

export function summarize(samples, count) {
  const sorted = [...samples].sort((a, b) => a - b);
  const q = p => {
    const index = (sorted.length - 1) * p;
    return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
  };
  const medianMs = q(0.5), p25Ms = q(0.25), p75Ms = q(0.75), iqr = p75Ms - p25Ms;
  return { minMs: sorted[0], p25Ms, medianMs, p75Ms, maxMs: sorted.at(-1),
    meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
    msPerMP: medianMs / (count / 1e6), megapixelsPerSecond: count / (medianMs * 1000),
    outlierIndices: samples.flatMap((v, i) => v < p25Ms - 1.5 * iqr || v > p75Ms + 1.5 * iqr ? [i] : []) };
}

export function parseArgs(args) {
  const options = { sizes: '640x360,1920x1080', recipes: 'identity,basic,grading,all', warmup: '5', samples: '5', seed: '17' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || !(key in options) || args[i + 1] === undefined) throw new Error(`Unknown or incomplete option: ${args[i]}`);
    options[key] = args[i + 1];
  }
  for (const key of ['warmup', 'samples', 'seed']) {
    if (!/^\d+$/.test(options[key])) throw new Error(`Invalid ${key}`);
    options[key] = Number(options[key]);
    const max = key === 'seed' ? 0xffffffff : 10000;
    if (!Number.isSafeInteger(options[key]) || options[key] > max || (key === 'samples' && options[key] === 0)) throw new Error(`Invalid ${key}`);
  }
  options.sizes = options.sizes.split(',').map(size => {
    if (!/^[1-9]\d*x[1-9]\d*$/.test(size)) throw new Error(`Invalid size: ${size}`);
    const [width, height] = size.split('x').map(Number);
    if (!Number.isSafeInteger(width * height) || width * height > 100000000) throw new Error(`Size too large: ${size}`);
    return { width, height };
  });
  options.recipes = options.recipes.split(',');
  if (new Set(options.recipes).size !== options.recipes.length) throw new Error('Duplicate recipes');
  return options;
}

export function toCsv(rows) {
  const columns = ['runId', 'condition', 'width', 'height', 'name', 'warmup', 'samples', 'medianMs', 'minMs', 'p25Ms', 'p75Ms', 'maxMs', 'meanMs', 'msPerMP', 'megapixelsPerSecond', 'inputHash', 'outputHash'];
  const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [columns.join(','), ...rows.map(row => columns.map(key => escape(row[key])).join(','))].join('\n') + '\n';
}
