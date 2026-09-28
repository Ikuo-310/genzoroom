import './pipeline-loader.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { cases, hash, pixels, verify, summarize, parseArgs, toCsv } from './pipeline-benchmark.mjs';

const started = performance.now();
const frontend = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: frontend, encoding: 'utf8' }).trim();
const load = async () => {
  const start = performance.now();
  const editing = await import('../src/editing.ts');
  const pipeline = await import('../src/adjustmentPipeline.ts');
  return { ...editing, ...pipeline, moduleLoadMs: performance.now() - start };
};

if (process.argv[2] === '--verify') {
  const api = await load();
  console.log(JSON.stringify(verify(api.renderAdjustments, cases(api.defaultRecipe), api.defaultRecipe)));
} else if (process.argv[2] === '--csv') {
  if (process.argv.length !== 4) throw new Error('Usage: --csv <results.jsonl>');
  const records = readFileSync(process.argv[3], 'utf8').trim().split('\n').map(line => JSON.parse(line));
  if (!records.some(row => row.type === 'complete')) throw new Error('Cannot export an incomplete run');
  process.stdout.write(toCsv(records.filter(row => row.type === 'summary')));
} else if (process.argv[2] === '--help') {
  console.log('Node >=24.19: node scripts/benchmark-pipeline.mjs [--sizes 640x360,1920x1080] [--recipes identity,basic,grading,all] [--warmup 5] [--samples 5] [--seed 17]\n--verify: correctness only; --csv <results.jsonl>: regenerate CSV on stdout.\nOutputs: frontend/benchmark-results/<timestamp>/results.jsonl and summary.csv');
} else {
  const options = parseArgs(process.argv.slice(2));
  // Correctness runs in a separate process, so it cannot warm this process's renderer.
  const validation = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--verify'], { encoding: 'utf8' }));
  const api = await load();
  const catalog = cases(api.defaultRecipe);
  for (const name of options.recipes) if (!Object.hasOwn(catalog, name)) throw new Error(`Unknown recipe: ${name}. Available: ${Object.keys(catalog).join(',')}`);
  const runId = new Date().toISOString().replaceAll(':', '-') + `-${process.pid}`;
  const directory = new URL(`../benchmark-results/${runId}/`, import.meta.url);
  mkdirSync(directory, { recursive: true });
  const jsonl = new URL('results.jsonl', directory);
  const record = data => appendFileSync(jsonl, JSON.stringify(data) + '\n');
  const files = ['src/editing.ts', 'src/adjustmentPipeline.ts', 'scripts/benchmark-pipeline.mjs', 'scripts/pipeline-benchmark.mjs', 'scripts/pipeline-loader.mjs', 'package-lock.json'];
  record({ type: 'metadata', schemaVersion: 1, runId, timestamp: new Date().toISOString(),
    node: process.version, v8: process.versions.v8, execArgv: process.execArgv, argv: process.argv.slice(2),
    cpu: cpus()[0]?.model, logicalCPUs: cpus().length, os: `${platform()} ${release()}`, arch: arch(), ramBytes: totalmem(),
    head: git('rev-parse', 'HEAD'), status: git('status', '--short'),
    hashes: Object.fromEntries(files.map(file => [file, hash(readFileSync(new URL(`../${file}`, import.meta.url)))])),
    options, generator: 'LCG 1664525/1013904223, RGB low 3 bytes, alpha 255',
    moduleLoadMs: api.moduleLoadMs, moduleLoadMeaning: 'dynamic ESM import including file I/O, native TS stripping and evaluation; excludes loader registration and Node startup',
    timing: 'renderAdjustments call only; natural GC; sequential; fixed listed order',
    quantiles: 'linear interpolation at (n-1)*p; outliers: 1.5 IQR, zero-based sample indices' });
  record(validation);
  const summaries = [];
  let condition = 0;
  for (const { width, height } of options.sizes) {
    const source = pixels(width, height, options.seed);
    const inputHash = hash(source);
    for (const name of options.recipes) {
      const recipe = catalog[name].recipe;
      const id = condition++;
      record({ type: 'condition', runId, condition: id, width, height, name, recipe,
        effectiveAdjustments: api.effectiveAdjustments(recipe), inputHash, outputBytes: source.byteLength });
      let output;
      // Only the first condition is the process's first render; later cases share JIT state.
      const firstStart = performance.now();
      output = api.renderAdjustments(source, recipe);
      const firstMs = performance.now() - firstStart;
      const outputHash = hash(output);
      output = null;
      record({ type: 'first-call', condition: id, ms: firstMs, processFirstRender: id === 0, outputHash });
      for (let i = 0; i < options.warmup; i++) {
        const start = performance.now();
        output = api.renderAdjustments(source, recipe);
        const ms = performance.now() - start;
        output = null;
        record({ type: 'warmup', condition: id, index: i, ms });
      }
      const samples = [];
      for (let i = 0; i < options.samples; i++) {
        const start = performance.now();
        output = api.renderAdjustments(source, recipe);
        const ms = performance.now() - start;
        samples.push(ms);
        // Hashing and logging stay outside the timed interval, but their cache/GC effects remain possible.
        if (hash(output) !== outputHash) throw new Error(`Nondeterministic output: ${name}`);
        output = null;
        record({ type: 'sample', condition: id, index: i, ms });
      }
      if (hash(source) !== inputHash) throw new Error(`Source changed: ${name}`);
      const summary = { type: 'summary', runId, condition: id, width, height, name,
        warmup: options.warmup, samples: options.samples, inputHash, outputHash,
        ...summarize(samples, width * height) };
      summaries.push(summary);
      record(summary);
      console.log(`${width}x${height} ${name}: median ${summary.medianMs.toFixed(3)} ms`);
    }
  }
  writeFileSync(new URL('summary.csv', directory), toCsv(summaries));
  record({ type: 'complete', runId, conditions: condition, elapsedMs: performance.now() - started });
  console.log(`Results: ${fileURLToPath(directory)}`);
}
