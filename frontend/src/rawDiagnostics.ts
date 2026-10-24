import { BUILD_INFO } from './buildInfo';
import { readBounded, type RawGeometry } from './rawApi';

export type RawDiagnosticConfig = { assetId: string; quality: 'draft' | 'full' | 'both'; stageCache: 'off' | 'on' | 'both';
  backend: 'cpu' | 'gpu'; temperature: 'cold' | 'warm' | 'both'; repeats: number; budgetBytes: number };
export type RawTrial = { index: number; quality: 'draft' | 'full'; stageCache: 'off' | 'on';
  temperature: 'cold' | 'warm'; repeat: number; group: string };
export type RawTrialMetadata = {
  trial: RawTrial; measuredAt: string;
  contract: { lightcraftVersion: '0.10.0'; engineCommit: string; previewContract: 1; binarySha256: string };
  source: { width: number; height: number; format: string; identity: string }; settingsFingerprint: string; frame: RawGeometry;
  backend: { configured: 'cpu' | 'gpu'; execution: 'cpu' | 'unconfirmed'; gpuAvailable: boolean; fallbackReported: boolean };
  width: number; height: number; payloadBytes: number;
  metrics: { nativeMs: number; validationMs: number; pngSha256: string | null;
    stageCache: { mode: 'off' | 'on'; applied: boolean; reason: 'none' | 'budget'; cpuBytes: number; gpuBytes: number; retainedBytes: number; budgetBytes: number } };
  rssBytes: null; vramBytes: null;
};
export type RawTrialResult = { trial: RawTrial; result: 'success' | 'failed' | 'cancelled' | 'unsupported';
  metadata: RawTrialMetadata | null; responseWaitMs: number | null; transferMs: number | null; decodeMs: number | null;
  totalMs: number | null; errorCode: string | null };
export class RawDiagnosticError extends Error { constructor(public readonly code: string) { super(code); } }
const ROOT = '/api/developer/raw-preview';
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const duration = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 600_000;
const exact = (v: unknown, keys: string): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const fail = (): never => { throw new RawDiagnosticError('raw_invalid_response'); };

async function post(action: string, body: unknown, signal?: AbortSignal) {
  const response = await fetch(`${ROOT}/${action}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) });
  if (!response.ok) {
    let code = response.status === 404 || response.status === 503 ? 'raw_preview_unsupported' : 'raw_diagnostic_failed';
    try {
      const value = JSON.parse(new TextDecoder().decode(await readBounded(response, 4096)));
      if (typeof value.code === 'string' && /^(raw|lightcraft)_[a-z_]{1,60}$/.test(value.code)) code = value.code;
    } catch { /* Never display upstream bodies. */ }
    throw new RawDiagnosticError(code);
  }
  return response;
}

async function json(action: string, body: unknown, signal?: AbortSignal) {
  const response = await post(action, body, signal);
  try {
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') return fail();
    return JSON.parse(new TextDecoder().decode(await readBounded(response, 16 * 1024)));
  }
  catch { return fail(); }
  finally { await response.body?.cancel().catch(() => {}); }
}

export function rawTrialPlan(config: RawDiagnosticConfig): RawTrial[] {
  const rows: RawTrial[] = [];
  const caches: ('off' | 'on')[] = config.stageCache === 'both' ? ['off', 'on'] : [config.stageCache];
  const qualities: ('draft' | 'full')[] = config.quality === 'both' ? ['draft', 'full'] : [config.quality];
  const temperatures: ('cold' | 'warm')[] = config.temperature === 'both' ? ['cold', 'warm'] : [config.temperature];
  for (const stageCache of caches) for (const quality of qualities) for (const temperature of temperatures)
    for (let repeat = 0; repeat < config.repeats; repeat++) rows.push({ index: rows.length, quality, stageCache, temperature,
      repeat: repeat + 1, group: `${stageCache}:${quality}:${temperature}:${temperature === 'cold' ? repeat : 0}` });
  return rows;
}

export async function startRawDiagnostic(config: RawDiagnosticConfig, signal: AbortSignal) {
  const value = await json('start', config, signal);
  const plan = rawTrialPlan(config);
  if (!value || typeof value.runId !== 'string' || !/^[a-f0-9]{32}$/.test(value.runId)
    || value.maxSide !== 1024 || JSON.stringify(value.plan) !== JSON.stringify(plan)) return fail();
  return { runId: value.runId as string, plan };
}
export async function prepareRawTrial(runId: string, trial: RawTrial, signal: AbortSignal) {
  const value = await json('prepare', { runId, index: trial.index }, signal);
  if (value.preparedIndex !== trial.index) fail();
}
export async function stopRawDiagnostic(runId: string, signal?: AbortSignal) {
  const value = await json('stop', { runId }, signal);
  return value.state === 'closed';
}
export async function rawDiagnosticClosed(runId: string, signal?: AbortSignal) {
  const value = await json('status', { runId }, signal);
  if (value.state === 'cleanup_failed') throw new RawDiagnosticError('raw_diagnostic_cleanup_failed');
  return value.state === 'closed';
}
export function leaveRawDiagnostic(runId: string) {
  // Keep the stop request independent of the UI waiter's abort; the server collects native work.
  void fetch(`${ROOT}/stop`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }) }).catch(() => {});
}

export function parseRawTrial(value: unknown, trial: RawTrial): RawTrialMetadata {
  if (!exact(value, 'trial,measuredAt,contract,source,settingsFingerprint,frame,backend,width,height,payloadBytes,metrics,rssBytes,vramBytes')
    || JSON.stringify(value.trial) !== JSON.stringify(trial) || typeof value.measuredAt !== 'string' || !Number.isFinite(Date.parse(value.measuredAt))
    || !hash(value.settingsFingerprint) || value.rssBytes !== null || value.vramBytes !== null) return fail();
  const { contract, source, frame, backend, metrics } = value;
  if (!exact(contract, 'lightcraftVersion,engineCommit,previewContract,binarySha256') || contract.lightcraftVersion !== '0.10.0'
    || contract.engineCommit !== 'a2a41383c4fd62fa85a46ccd00998639221f2d3c' || contract.previewContract !== 1 || !hash(contract.binarySha256)
    || !exact(source, 'width,height,format,identity') || !count(source.width) || !source.width || !count(source.height) || !source.height
    || typeof source.format !== 'string' || !/^[A-Z0-9]{1,12}$/.test(source.format) || !hash(source.identity)
    || !exact(frame, 'geometryId,nativeWidth,nativeHeight,aspect,fullWidth,fullHeight,window') || !hash(frame.geometryId)
    || !['nativeWidth', 'nativeHeight', 'fullWidth', 'fullHeight'].every(k => count(frame[k]) && (frame[k] as number) > 0 && (frame[k] as number) <= 2 ** 31 - 1)
    || typeof frame.aspect !== 'number' || !Number.isFinite(frame.aspect) || frame.aspect <= 0 || frame.window !== null
    || !exact(backend, 'configured,execution,gpuAvailable,fallbackReported') || !['cpu', 'gpu'].includes(backend.configured as string)
    || !['cpu', 'unconfirmed'].includes(backend.execution as string) || backend.execution === 'cpu' && backend.configured !== 'cpu'
    || typeof backend.gpuAvailable !== 'boolean' || typeof backend.fallbackReported !== 'boolean'
    || !count(value.width) || !value.width || !count(value.height) || !value.height || Math.max(value.width, value.height) > 1024
    || value.width !== frame.fullWidth || value.height !== frame.fullHeight || !count(value.payloadBytes) || value.payloadBytes > 5 * 1024 ** 2
    || !exact(metrics, 'nativeMs,validationMs,pngSha256,stageCache') || !duration(metrics.nativeMs) || !duration(metrics.validationMs)
    || (trial.quality === 'full' ? !hash(metrics.pngSha256) : metrics.pngSha256 !== null)) return fail();
  const cache = metrics.stageCache;
  if (!exact(cache, 'mode,applied,reason,cpuBytes,gpuBytes,retainedBytes,budgetBytes') || cache.mode !== trial.stageCache
    || typeof cache.applied !== 'boolean' || !['none', 'budget'].includes(cache.reason as string)
    || !['cpuBytes', 'gpuBytes', 'retainedBytes', 'budgetBytes'].every(k => count(cache[k]))
    || (cache.retainedBytes as number) > (cache.budgetBytes as number) || (cache.budgetBytes as number) > 1024 ** 3
    || cache.mode === 'off' && (cache.applied || cache.retainedBytes !== 0 || cache.budgetBytes !== 0 || cache.reason !== 'none')
    || cache.mode === 'on' && (cache.budgetBytes === 0 || cache.applied !== (cache.reason === 'none'))) return fail();
  return structuredClone(value) as unknown as RawTrialMetadata;
}

export async function fetchRawTrial(runId: string, trial: RawTrial, signal: AbortSignal) {
  const started = performance.now();
  const response = await post('render', { runId, index: trial.index }, signal);
  const received = performance.now();
  try {
    if (response.headers.get('content-type') !== 'image/png') return fail();
    const encoded = response.headers.get('x-raw-diagnostic');
    if (!encoded || encoded.length > 16 * 1024) return fail();
    let metadata: RawTrialMetadata;
    try { metadata = parseRawTrial(JSON.parse(encoded), trial); } catch { return fail(); }
    const transferStarted = performance.now();
    const bytes = await readBounded(response, 5 * 1024 ** 2);
    const transferMs = performance.now() - transferStarted;
    signal.throwIfAborted();
    if (bytes.length !== metadata.payloadBytes || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return fail();
    return { metadata, blob: new Blob([bytes], { type: 'image/png' }), responseWaitMs: received - started, transferMs, started };
  } finally { await response.body?.cancel().catch(() => {}); }
}

export function statistics(values: number[]) {
  const sorted = values.filter(duration).sort((a, b) => a - b), n = sorted.length;
  return n ? { count: n, min: sorted[0], max: sorted[n - 1], median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 }
    : { count: 0, min: null, max: null, median: null };
}
function comparisonKey(row: RawTrialResult) {
  const m = row.metadata;
  if (row.result !== 'success' || !m || m.backend.execution === 'unconfirmed' || m.backend.fallbackReported
    || m.metrics.stageCache.mode === 'on' && !m.metrics.stageCache.applied) return null;
  return JSON.stringify([m.source.identity, m.settingsFingerprint, m.frame, m.contract, m.backend,
    m.width, m.height, row.trial.temperature]);
}
export function rawComparisons(rows: RawTrialResult[]) {
  const ratios: { comparison: 'draftFull' | 'cache'; temperature: string; fixed: string; ratio: number }[] = [];
  const matches: { temperature: string; repeat: number; result: 'equal' | 'different' | 'unverified' }[] = [];
  for (const temperature of ['cold', 'warm']) {
    const selected = rows.filter(r => r.trial.temperature === temperature && comparisonKey(r));
    const ratio = (a: RawTrialResult[], b: RawTrialResult[], comparison: 'draftFull' | 'cache', fixed: string) => {
      const keys = new Set([...a, ...b].map(comparisonKey));
      if (!a.length || !b.length || keys.size !== 1) return;
      const fast = statistics(a.map(r => r.metadata!.metrics.nativeMs)).median;
      const slow = statistics(b.map(r => r.metadata!.metrics.nativeMs)).median;
      if (fast !== null && slow !== null && fast > 0) ratios.push({ comparison, temperature, fixed, ratio: slow / fast });
    };
    for (const cache of ['off', 'on']) ratio(selected.filter(r => r.trial.stageCache === cache && r.trial.quality === 'draft'),
      selected.filter(r => r.trial.stageCache === cache && r.trial.quality === 'full'), 'draftFull', cache);
    for (const quality of ['draft', 'full']) ratio(selected.filter(r => r.trial.quality === quality && r.trial.stageCache === 'on'),
      selected.filter(r => r.trial.quality === quality && r.trial.stageCache === 'off'), 'cache', quality);
    const full = rows.filter(r => r.trial.temperature === temperature && r.trial.quality === 'full');
    for (const repeat of new Set(full.map(r => r.trial.repeat))) {
      const off = full.find(r => r.trial.repeat === repeat && r.trial.stageCache === 'off');
      const on = full.find(r => r.trial.repeat === repeat && r.trial.stageCache === 'on');
      const verified = off && on && comparisonKey(off) && comparisonKey(off) === comparisonKey(on);
      matches.push({ temperature, repeat, result: verified
        ? off.metadata!.metrics.pngSha256 === on.metadata!.metrics.pngSha256 ? 'equal' : 'different' : 'unverified' });
    }
  }
  return { ratios, matches };
}

export function rawStatistics(rows: RawTrialResult[]) {
  const groups = new Map<string, { condition: string; rows: RawTrialResult[] }>();
  for (const row of rows) {
    const m = row.metadata;
    const condition = `${row.trial.quality}/${row.trial.stageCache}/${row.trial.temperature}/${m?.metrics.stageCache.applied ?? 'unknown'}`;
    const key = JSON.stringify([condition, m?.source.identity, m?.settingsFingerprint, m?.frame, m?.backend,
      m?.contract, m?.metrics.stageCache.budgetBytes, m?.width, m?.height]);
    const group = groups.get(key) ?? { condition, rows: [] };
    group.rows.push(row); groups.set(key, group);
  }
  return [...groups.values()].map(({ condition, rows: group }, index) => ({ condition: `${condition} #${index + 1}`, nativeMs: statistics(group.filter(r => r.result === 'success').map(r => r.metadata!.metrics.nativeMs)),
    validationMs: statistics(group.filter(r => r.result === 'success').map(r => r.metadata!.metrics.validationMs)),
    transferMs: statistics(group.filter(r => r.result === 'success').flatMap(r => r.transferMs === null ? [] : [r.transferMs])),
    decodeMs: statistics(group.filter(r => r.result === 'success').flatMap(r => r.decodeMs === null ? [] : [r.decodeMs])),
    totalMs: statistics(group.filter(r => r.result === 'success').flatMap(r => r.totalMs === null ? [] : [r.totalMs])) }));
}

export function createRawDiagnosticReport(config: RawDiagnosticConfig, rows: RawTrialResult[], now = new Date()) {
  const plan = rawTrialPlan(config);
  if (new Set(rows.map(r => r.trial.index)).size !== rows.length || rows.some(r => JSON.stringify(r.trial) !== JSON.stringify(plan[r.trial.index])
    || !['success', 'failed', 'cancelled', 'unsupported'].includes(r.result) || r.result === 'success' && !r.metadata
    || r.metadata && (r.metadata.backend.configured !== config.backend || r.trial.stageCache === 'on'
      && r.metadata.metrics.stageCache.budgetBytes !== config.budgetBytes)
    || [r.responseWaitMs, r.transferMs, r.decodeMs, r.totalMs].some(v => v !== null && !duration(v)))) fail();
  // Re-parse successful metadata and project every field: arbitrary caller/server extras cannot enter JSON.
  const trials = rows.map(r => ({ trial: { index: r.trial.index, quality: r.trial.quality, stageCache: r.trial.stageCache,
    temperature: r.trial.temperature, repeat: r.trial.repeat, group: r.trial.group }, result: r.result,
    metadata: r.metadata ? parseRawTrial(r.metadata, r.trial) : null,
    responseWaitMs: r.responseWaitMs, transferMs: r.transferMs, decodeMs: r.decodeMs, totalMs: r.totalMs,
    errorCode: r.errorCode && /^(raw|lightcraft)_[a-z_]{1,60}$/.test(r.errorCode) ? r.errorCode : null }));
  return { schemaVersion: 1, reportType: 'raw-preview', generatedAt: now.toISOString(), genzoroom: { ...BUILD_INFO },
    conditions: { quality: config.quality, stageCache: config.stageCache, backend: config.backend, temperature: config.temperature,
      repeats: config.repeats, budgetBytes: config.budgetBytes, maxSide: 1024 }, trials,
    statistics: rawStatistics(trials), comparisons: rawComparisons(trials),
    limitations: ['nativeIncludesMcpEncodeAndReadback', 'gpuExecutionUnconfirmed', 'coldMeansFreshNativeProcessNotOsDiskCache',
      'warmMeansOneUnmeasuredNativeWarmupNotCacheHitProof', 'rssAndVramNotCollected', 'stageRetentionIsNotProcessMemory',
      'importDefaultsOnlyNoSavedRecipe', 'totalIncludesGpuStatusQueriesAndFullHash', 'maxSide1024', 'windowsLocalOnly'] };
}
