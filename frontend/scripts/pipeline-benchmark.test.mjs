import './pipeline-loader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cases, pixels, verify, parseArgs, summarize, toCsv, hash } from './pipeline-benchmark.mjs';

// Register the resolver before Node links the TypeScript dependency graph.
const { defaultRecipe } = await import('../src/editing.ts');
const { renderAdjustments } = await import('../src/adjustmentPipeline.ts');

test('native TS loader and all catalog invariants including bypass', () => {
  const catalog = cases(defaultRecipe);
  assert.equal(Object.keys(catalog.all.recipe.adjustments).length, 16);
  assert.ok(Object.values(catalog.all.recipe.adjustments).every(value => value !== 0));
  assert.equal(verify(renderAdjustments, catalog, defaultRecipe).passed, true);
  assert.throws(() => verify(source => source, { identity: catalog.identity }, defaultRecipe));
});

test('seed, alpha and known input are reproducible', () => {
  // 17 * 1664525 + 1013904223 = 1042201148 = 0x3e1eba3c.
  assert.deepEqual(pixels(1, 1, 17), new Uint8ClampedArray([60, 186, 30, 255]));
  assert.equal(hash(pixels(10, 2, 17)), hash(pixels(10, 2, 17)));
  assert.notEqual(hash(pixels(10, 2, 17)), hash(pixels(10, 2, 18)));
});

test('validation rejects source mutation, alpha corruption and ignored bypass flags', () => {
  const catalog = cases(defaultRecipe);
  assert.throws(() => verify((source, recipe) => {
    source[0] ^= 1;
    return renderAdjustments(source, recipe);
  }, { identity: catalog.identity }, defaultRecipe), /source changed/);
  assert.throws(() => verify((source, recipe) => {
    const output = renderAdjustments(source, recipe);
    output[3] ^= 1;
    return output;
  }, { identity: catalog.identity }, defaultRecipe), /alpha changed/);
  assert.throws(() => verify((source, recipe) => {
    return renderAdjustments(source, { ...recipe, basicEnabled: true });
  }, { 'bypass-basicEnabled': catalog['bypass-basicEnabled'] }, defaultRecipe), /bypass differs/);
});

test('options reject malformed and unsafe workloads', () => {
  assert.equal(parseArgs([]).samples, 5);
  assert.equal(parseArgs(['--warmup', '0', '--seed', '0']).warmup, 0);
  for (const args of [['--samples', '0'], ['--seed', '-1'], ['--sizes', '0x10'], ['--sizes', '999999x999999'], ['--wat', '1'], ['--warmup'], ['--recipes', 'all,all']]) assert.throws(() => parseArgs(args));
});

test('statistics retain samples and identify extreme observations', () => {
  const samples = [1, 2, 3, 4, 100];
  const summary = summarize(samples, 1e6);
  assert.equal(summary.medianMs, 3);
  assert.equal(summary.p25Ms, 2);
  assert.equal(summary.p75Ms, 4);
  assert.deepEqual(summary.outlierIndices, [4]);
  assert.deepEqual(samples, [1, 2, 3, 4, 100]);
  assert.equal(summarize([2, 4], 1e6).medianMs, 3);
  assert.match(toCsv([{ name: 'a,"b' }]), /"a,""b"/);
});

test('fresh-process correctness command works without benchmark output', () => {
  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('benchmark-pipeline.mjs', import.meta.url)), '--verify'], { encoding: 'utf8' }));
  assert.equal(result.passed, true);
  assert.ok(result.cases > 30);
});
