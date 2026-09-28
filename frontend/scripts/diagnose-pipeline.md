# Pipeline timing diagnostics (separate from the benchmark)

From `frontend/`, using Node >=24.19:

```powershell
node --test scripts/diagnose-pipeline.test.mjs
node scripts/diagnose-pipeline.mjs --smoke
node scripts/diagnose-pipeline.mjs
```

Both modes use 1920x1080, LCG seed 17, RGB/alpha 255, and only identity then
3WAY grading. Smoke uses 2 warmups/3 samples; the full diagnostic uses 10/20.
Each condition also has a separate first call. Never run benchmark processes
concurrently. No forced GC or special Node options are required.

Files are saved to ignored `frontend/benchmark-results/diagnostic-<time>-<pid>/`:
`timeline.jsonl` contains per-call timestamps, recipes, CPU usage and memory;
`diagnosis.json` contains GC entries, interval correlations, timer calibration,
source hashes, CPU snapshots and summaries. Only a completed `diagnosis.json`
constitutes a successful diagnostic. Standard benchmark files remain untouched.

PerformanceObserver GC timestamps and render timestamps use the same performance
clock. Observer delivery is deferred until the synchronous measurement loop ends;
the script then yields to drain entries. It correlates intervals, not callback time.
Summed event overlaps are observations, not a complete accounting of GC costs or
proof of causality. Concurrent/background work and memory reclamation may not be
fully represented by an event's duration.

Timer calibration records 100,000 adjacent performance.now pairs after warming the
clock calls. hrtime measures the entire loop. Its per-pair average includes loop
and array-store costs, so it is not an isolated single-call overhead. Minimum
positive delta estimates observed granularity, not guaranteed clock accuracy.
Large rare deltas may include interruptions; do not subtract them from renders.

CPU/memory probes, retained diagnostic rows, GC observation and logging change
allocation/cache behavior, even though they are outside the render interval.
Compare with a separate normal run rather than pooling these results. CPU usage
covers all Node threads and may have coarse OS accounting increments; it cannot
resolve millisecond identity calls on every platform. os.cpus speed snapshots are
not live frequency telemetry, and aggregate CPU times cannot locate a brief stall.
Memory snapshots are not peak memory measurements. The diagnostic checks source
and output hashes; the standard harness tests remain the correctness gate.
