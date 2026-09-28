# Current Recipe v18 pipeline benchmark

Run from `frontend/` with Node 24.19 or later. No extra dependencies are needed.
The loader uses native TypeScript stripping and an ESM resolution hook for the
application's extensionless relative imports. It does not concatenate source or
rewrite import/export statements. Keep application modules unchanged.

```powershell
node --test scripts/pipeline-benchmark.test.mjs
node scripts/benchmark-pipeline.mjs --verify
node scripts/benchmark-pipeline.mjs --sizes 640x360,1920x1080 --recipes identity,basic,grading,all --warmup 5 --samples 5 --seed 17
node scripts/benchmark-pipeline.mjs --csv benchmark-results/<run>/results.jsonl
```

The default command is exactly the P1-B1 preliminary matrix. Runs are sequential;
do not launch another benchmark concurrently. Results are written under
`frontend/benchmark-results/<timestamp>-<pid>/`, ignored by Git. Harness sources,
tests and this guide are tracked. CSV export writes to stdout. JSONL is the
authoritative record; it contains full recipes, effective values, source and
harness SHA-256 hashes, input/output hashes, environment, warmups, raw samples and
summaries. A `complete` record marks success; partial results must not be reported
as a completed run. The exporter refuses incomplete runs.

Recipes: `identity`, `exposure`, `basic`, `wb`, `wb-basic`, `grading`, `color`,
`all`; `shadows`, `midtones`, `highlights` pairs; each of the six grading field
names; `vibrance`, `saturation`; `bypass-all`; `bypass-<adjustment name>` for all
16 fields; and `bypass-<flag>` for the four category and three grading range flags.
Unknown names fail with the available list. Values are fixed in
`pipeline-benchmark.mjs` and recorded in full per condition. Inputs use the legacy
seed-17 LCG RGB sequence, with alpha fixed at 255 for timing.

Correctness runs first in a separate process on 256 mixed-color pixels with
variable alpha, across the entire catalog. It checks source and recipe immutability,
distinct output buffers, alpha, identity, and bypass versus explicitly zeroed
values. Existing fixed-hash pipeline tests remain a separate regression check.
The benchmark also checks output determinism and source hashes outside timing.

Each condition executes one separately recorded first call, then the requested
warmups and samples. Only condition zero is the process's first renderer call;
later first calls share JIT state. `moduleLoadMs` includes dynamic import, file I/O,
TS stripping and module evaluation, not just LUT initialization, and excludes Node
startup and hook registration. Neither first-call nor module-load time is included
in warm summaries. `elapsedMs` covers validation, module loading, setup, rendering,
hashing and output through CSV writing, excluding Node startup and final logging.

Timed intervals contain only `renderAdjustments(source, recipe)`, including output
allocation/copy, effective adjustments and LUT generation. Generation, hashing,
imports, recipe setup and logging are outside. Hashing/logging between calls may
still affect cache and GC state; GC is natural, and outputs are not retained across
samples. This is Node CPU work, not Worker latency, decode, Canvas or browser FPS.

Quantiles use linear interpolation at `(n-1)*p`; median, quartiles, min/max, mean,
ms/MP and MP/s are exported. Zero-based outlier indices use the 1.5-IQR rule and
are diagnostic only: never silently discard them. Five preliminary samples cannot
establish stable tail latency. Independent process repeats and case-order changes
can be requested manually for later runs; the exact CLI and listed order are saved.
