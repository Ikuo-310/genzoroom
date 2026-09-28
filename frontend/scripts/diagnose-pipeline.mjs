import './pipeline-loader.mjs';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cases, pixels, hash, summarize } from './pipeline-benchmark.mjs';

export function overlapMs(sample, event) {
  return Math.max(0, Math.min(sample.end, event.startTime + event.duration) - Math.max(sample.start, event.startTime));
}

function timerProbe() {
  const count = 100000;
  const gaps = new Float64Array(count);
  for (let i = 0; i < 10000; i++) performance.now();
  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i++) {
    const a = performance.now();
    gaps[i] = performance.now() - a;
  }
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const sorted = [...gaps].sort((a, b) => a - b);
  return { count, elapsedNs, nsPerPairIncludingLoopAndStore: elapsedNs / count,
    zeroDeltas: sorted.filter(n => n === 0).length,
    minPositiveMs: sorted.find(n => n > 0), medianMs: sorted[count / 2],
    p99Ms: sorted[Math.floor(count * 0.99)], maxMs: sorted.at(-1) };
}

async function main() {
  const started = performance.now();
  const smoke = process.argv[2] === '--smoke';
  if (process.argv.length > (smoke ? 3 : 2)) throw new Error('Usage: node scripts/diagnose-pipeline.mjs [--smoke]');
  const warmup = smoke ? 2 : 10, samples = smoke ? 3 : 20;
  const directory = new URL(`../benchmark-results/diagnostic-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}/`, import.meta.url);
  mkdirSync(directory, { recursive: true });
  const timer = timerProbe();
  const loadStart = performance.now();
  const { defaultRecipe } = await import('../src/editing.ts');
  const { renderAdjustments } = await import('../src/adjustmentPipeline.ts');
  const moduleLoadMs = performance.now() - loadStart;
  const catalog = cases(defaultRecipe);
  const source = pixels(1920, 1080, 17), inputHash = hash(source);
  const events = [], intervals = [];
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) events.push({ startTime: entry.startTime, duration: entry.duration, detail: entry.detail });
  });
  observer.observe({ entryTypes: ['gc'] });
  const metadata = { type: 'diagnostic', smoke, pid: process.pid, node: process.version, v8: process.versions.v8,
    execArgv: process.execArgv, timeOrigin: performance.timeOrigin, width: 1920, height: 1080,
    seed: 17, alpha: 255, warmup, samples, order: ['identity', 'grading'], inputHash, moduleLoadMs, timer,
    cpu: cpus()[0]?.model, logicalCPUs: cpus().length,
    hashes: Object.fromEntries(['src/editing.ts','src/adjustmentPipeline.ts','scripts/diagnose-pipeline.mjs','scripts/pipeline-benchmark.mjs','scripts/pipeline-loader.mjs'].map(file => [file, hash(readFileSync(new URL(`../${file}`, import.meta.url)))])),
    effects: 'No forced GC or per-sample yield. cpuUsage/memoryUsage outside render; synchronous JSONL/hash between calls. Observer delivery deferred until after synchronous run. CPU usage covers all process threads.' };
  writeFileSync(new URL('timeline.jsonl', directory), JSON.stringify(metadata) + '\n');
  const cpuBefore = cpus();
  for (const name of metadata.order) {
    const recipe = catalog[name].recipe;
    let expectedHash;
    for (let i = -warmup - 1; i < samples; i++) {
      const phase = i === -warmup - 1 ? 'first' : i < 0 ? 'warmup' : 'sample';
      const memoryBefore = process.memoryUsage();
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      let output = renderAdjustments(source, recipe);
      const end = performance.now();
      const cpu = process.cpuUsage(cpuStart);
      const memoryAfter = process.memoryUsage();
      if (phase !== 'warmup') {
        const digest = hash(output);
        if (expectedHash && digest !== expectedHash) throw new Error('Output hash mismatch');
        expectedHash = digest;
      }
      output = null;
      const row = { type: 'interval', name, phase, index: i, start, end, ms: end - start, cpu,
        memoryBefore, memoryAfter, outputHash: expectedHash, recipe };
      intervals.push(row);
      appendFileSync(new URL('timeline.jsonl', directory), JSON.stringify(row) + '\n');
    }
    if (hash(source) !== inputHash) throw new Error('Source changed');
    console.log(`${name} diagnostic renders complete`);
  }
  const cpuAfter = cpus();
  // GC entries are asynchronous: match event timestamps, never callback delivery time.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 50));
  for (const entry of observer.takeRecords()) events.push({ startTime: entry.startTime, duration: entry.duration, detail: entry.detail });
  observer.disconnect();
  const summaries = metadata.order.map(name => {
    const rows = intervals.filter(row => row.name === name && row.phase === 'sample');
    const stats = summarize(rows.map(row => row.ms), 1920 * 1080);
    return { name, ...stats, samples: rows.map((row, index) => ({ index: index + 1, ms: row.ms,
      cpuMs: (row.cpu.user + row.cpu.system) / 1000,
      overlappingGC: events.filter(event => overlapMs(row, event) > 0),
      gcOverlapMs: events.reduce((sum, event) => sum + overlapMs(row, event), 0),
      externalBefore: row.memoryBefore.external, externalAfter: row.memoryAfter.external,
      arrayBuffersBefore: row.memoryBefore.arrayBuffers, arrayBuffersAfter: row.memoryAfter.arrayBuffers })) };
  });
  const result = { metadata, summaries, events, cpuBefore, cpuAfter, elapsedMs: performance.now() - started };
  writeFileSync(new URL('diagnosis.json', directory), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ path: fileURLToPath(directory), elapsedMs: result.elapsedMs, events: events.length, timer,
    summaries: summaries.map(({ samples, ...summary }) => summary) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
