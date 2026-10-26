import { LIGHTCRAFT_ENGINE } from './lightcraftEngine';
import { readBounded, type RawGeometry } from './rawApi';
import { postRawDiagnostic, rawDiagnosticJson, RawDiagnosticError, statistics } from './rawDiagnostics';

export const RAW_VIEWER_OPERATIONS = ['open', 'wholeDraft', 'wholeFull', 'mutationDraft', 'endFull',
  'regionPlan', 'regionFull', 'pan', 'before', 'after'] as const;
export type RawViewerOperation = typeof RAW_VIEWER_OPERATIONS[number];
export type RawViewerConfig = { assetId: string; scenario: 'viewer'; backend: 'cpu' | 'gpu'; repeats: number };
export type RawViewerTrial = { index: number; operation: RawViewerOperation; repeat: number; warmup: boolean;
  quality: 'draft' | 'full'; stageCache: 'off'; temperature: 'cold'; group: string };
export type RawRegionPlanTiming = { sourceKind: 'loaded' | 'fit' | 'file' | 'other';
  sourcePreparationMs: number; sourceAcquisitionMs: number; imageSelectionMs: number;
  plannerMs: number; geometryMs: number; sourceRetentionMs: number; otherMs: number };
export type RawViewerMetadata = {
  operation: RawViewerOperation; repeat: number; warmup: boolean; revision: number; viewGeneration: number;
  quality: 'draft' | 'full'; geometry: RawGeometry; bitmap: { width: number; height: number };
  region: { fullWidth: number; fullHeight: number; window: { x: number; y: number; w: number; h: number }; limited: boolean } | null;
  wholeRequestedSide: 1024; stageCache: { mode: 'off'; applied: false }; payloadBytes: number;
  timing: { backendOperationMs: number; openMs: number | null; nativeMs: number | null; validationMs: number | null;
    regionPlan?: RawRegionPlanTiming };
  engine: { version: string; commit: string; binarySha256: string; previewContract: 1; regionContract: 1;
    geometryDescriptor: 2; gpuBackend: 'off' | 'dx12'; gpuAdapter: string | null };
};
export type RawViewerRow = { metadata: RawViewerMetadata; responseWaitMs: number; transferMs: number; decodeMs: number | null;
  adoptMs: number | null; totalMs: number };
export type RawViewerFailure = { operation: RawViewerOperation; repeat: number; code: string };
const fail = (): never => { throw new RawDiagnosticError('raw_invalid_response'); };
const exact = (v: unknown, keys: string): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const positive = (v: unknown): v is number => integer(v) && v > 0 && v <= 2 ** 31 - 1;
const duration = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

export function rawViewerPlan(repeats: number): RawViewerTrial[] {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) return fail();
  return Array.from({ length: repeats + 1 }, (_, repeat) => RAW_VIEWER_OPERATIONS.map(operation => ({
    index: 0, operation, repeat, warmup: repeat === 0, quality: (['wholeDraft', 'mutationDraft'].includes(operation) ? 'draft' : 'full') as 'draft' | 'full',
    stageCache: 'off' as const, temperature: 'cold' as const, group: `viewer:${repeat}` }))).flat().map((trial, index) => ({ ...trial, index }));
}

export function parseRawViewerMetadata(v: unknown, trial: RawViewerTrial): RawViewerMetadata {
  if (!exact(v, 'operation,repeat,warmup,revision,viewGeneration,quality,geometry,bitmap,region,wholeRequestedSide,stageCache,timing,payloadBytes,engine')
    || v.operation !== trial.operation || v.repeat !== trial.repeat || v.warmup !== trial.warmup || v.quality !== trial.quality
    || !integer(v.revision) || v.viewGeneration !== trial.index + 1 || v.wholeRequestedSide !== 1024
    || !(trial.operation === 'regionPlan' ? v.payloadBytes === 0 : positive(v.payloadBytes)) || Number(v.payloadBytes) > 17 * 1024 ** 2) return fail();
  const { geometry: g, bitmap: b, region: r, engine: e, timing: t, stageCache: c } = v;
  if (!exact(g, 'geometryId,nativeWidth,nativeHeight,aspect,fullWidth,fullHeight,window') || !hash(g.geometryId)
    || !['nativeWidth', 'nativeHeight', 'fullWidth', 'fullHeight'].every(k => positive(g[k]))
    || typeof g.aspect !== 'number' || !Number.isFinite(g.aspect) || g.aspect <= 0 || g.window !== null
    || !exact(b, 'width,height') || !positive(b.width) || !positive(b.height) || Math.max(b.width, b.height) > 2048
    || !exact(c, 'mode,applied') || c.mode !== 'off' || c.applied !== false
    || !exact(t, `backendOperationMs,openMs,nativeMs,validationMs${t && typeof t === 'object' && 'regionPlan' in t ? ',regionPlan' : ''}`) || !duration(t.backendOperationMs)
    || !['openMs', 'nativeMs', 'validationMs'].every(k => t[k] === null || duration(t[k]))
    || !exact(e, 'version,commit,binarySha256,previewContract,regionContract,geometryDescriptor,gpuBackend,gpuAdapter')
    || e.version !== LIGHTCRAFT_ENGINE.version || e.commit !== LIGHTCRAFT_ENGINE.commit || !hash(e.binarySha256)
    || e.previewContract !== 1 || e.regionContract !== 1 || e.geometryDescriptor !== 2 || !['off', 'dx12'].includes(String(e.gpuBackend))
    || !(e.gpuAdapter === null || typeof e.gpuAdapter === 'string' && e.gpuAdapter.length <= 200)) return fail();
  if ('regionPlan' in t) {
    const p = t.regionPlan;
    const keys = ['sourcePreparationMs', 'sourceAcquisitionMs', 'imageSelectionMs', 'plannerMs',
      'geometryMs', 'sourceRetentionMs', 'otherMs'];
    if (trial.operation !== 'regionPlan' || !exact(p, `sourceKind,${keys.join(',')}`)
      || typeof p.sourceKind !== 'string' || !['loaded', 'fit', 'file', 'other'].includes(p.sourceKind)
      || !keys.every(k => duration(p[k])) || !duration(t.nativeMs)
      || Math.abs(keys.reduce((sum, k) => sum + Number(p[k]), 0) - t.nativeMs) > 0.01) return fail();
  }
  if (r !== null) {
    if (!['regionFull', 'pan'].includes(trial.operation) || !exact(r, 'fullWidth,fullHeight,window,limited')
      || !positive(r.fullWidth) || !positive(r.fullHeight) || typeof r.limited !== 'boolean'
      || !exact(r.window, 'x,y,w,h') || !integer(r.window.x) || !integer(r.window.y)
      || r.window.w !== b.width || r.window.h !== b.height || r.window.x + b.width > r.fullWidth
      || r.window.y + b.height > r.fullHeight) return fail();
  } else if (['regionFull', 'pan'].includes(trial.operation) || b.width !== g.fullWidth || b.height !== g.fullHeight) return fail();
  // Strict shape validation precedes cloning: no identifiers, paths or native error text enter reports.
  return structuredClone(v) as unknown as RawViewerMetadata;
}

export async function startRawViewerBenchmark(config: RawViewerConfig, signal: AbortSignal) {
  const result = await rawDiagnosticJson('start', config, signal), plan = rawViewerPlan(config.repeats);
  if (!result || typeof result.runId !== 'string' || !/^[a-f0-9]{32}$/.test(result.runId)
    || JSON.stringify(result.plan) !== JSON.stringify(plan)) return fail();
  return { runId: result.runId as string, plan };
}
export async function fetchRawViewerTrial(runId: string, trial: RawViewerTrial, signal: AbortSignal) {
  const started = performance.now();
  const response = await postRawDiagnostic('render', { runId, index: trial.index }, signal);
  const received = performance.now();
  try {
    const encoded = response.headers.get('x-raw-diagnostic');
    const planning = trial.operation === 'regionPlan';
    if (response.headers.get('content-type') !== (planning ? 'application/json' : 'image/png') || !encoded || encoded.length > 16 * 1024) return fail();
    let metadata: RawViewerMetadata;
    try { metadata = parseRawViewerMetadata(JSON.parse(encoded), trial); } catch { return fail(); }
    const bytes = await readBounded(response, planning ? 16 * 1024 : 17 * 1024 ** 2);
    signal.throwIfAborted();
    if (planning) {
      try { if (JSON.stringify(parseRawViewerMetadata(JSON.parse(new TextDecoder().decode(bytes)), trial)) !== JSON.stringify(metadata)) return fail(); }
      catch { return fail(); }
      return { metadata, blob: null, started, responseWaitMs: received - started, transferMs: performance.now() - received };
    }
    if (bytes.length !== metadata.payloadBytes || ![137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => bytes[i] === x)) return fail();
    return { metadata, blob: new Blob([bytes], { type: 'image/png' }), started,
      responseWaitMs: received - started, transferMs: performance.now() - received };
  } finally { await response.body?.cancel().catch(() => {}); }
}

export function rawViewerStatistics(rows: RawViewerRow[]) {
  return RAW_VIEWER_OPERATIONS.map(operation => {
    const selected = rows.filter(r => !r.metadata.warmup && r.metadata.operation === operation);
    return { operation, backendOperationMs: statistics(selected.map(r => r.metadata.timing.backendOperationMs)),
      nativeMs: statistics(selected.flatMap(r => r.metadata.timing.nativeMs === null ? [] : [r.metadata.timing.nativeMs])),
      validationMs: statistics(selected.flatMap(r => r.metadata.timing.validationMs === null ? [] : [r.metadata.timing.validationMs])),
      responseWaitMs: statistics(selected.map(r => r.responseWaitMs)), transferMs: statistics(selected.map(r => r.transferMs)),
      decodeMs: statistics(selected.flatMap(r => r.decodeMs === null ? [] : [r.decodeMs])),
      adoptMs: statistics(selected.flatMap(r => r.adoptMs === null ? [] : [r.adoptMs])), totalMs: statistics(selected.map(r => r.totalMs)) };
  });
}
export function createRawViewerReport(rows: RawViewerRow[], status: string, backend: 'cpu' | 'gpu', repeats: number,
  failure: RawViewerFailure | null = null) {
  if (!['cpu', 'gpu'].includes(backend) || rows.length > 40) return fail();
  const trials = rows.map(row => {
    const trial = rawViewerPlan(repeats).find(t => t.operation === row.metadata.operation && t.repeat === row.metadata.repeat);
    if (!trial || row.metadata.engine.gpuBackend !== (backend === 'cpu' ? 'off' : 'dx12')
      || ![row.responseWaitMs, row.transferMs, row.totalMs].every(duration)
      || ![row.decodeMs, row.adoptMs].every(v => row.metadata.operation === 'regionPlan' ? v === null : duration(v))) return fail();
    return { metadata: parseRawViewerMetadata(row.metadata, trial), responseWaitMs: row.responseWaitMs,
      transferMs: row.transferMs, decodeMs: row.decodeMs, adoptMs: row.adoptMs, totalMs: row.totalMs };
  });
  return { status: ['idle', 'running', 'complete', 'failed', 'cancelled', 'cleanup_failed'].includes(status) ? status : 'failed',
    failure: failure && RAW_VIEWER_OPERATIONS.includes(failure.operation) && Number.isInteger(failure.repeat) && failure.repeat >= 0 && failure.repeat <= repeats
      ? { operation: failure.operation, repeat: failure.repeat, code: /^(raw|lightcraft)_[a-z_]{1,60}$/.test(failure.code) ? failure.code : 'raw_diagnostic_failed' } : null,
    conditions: { backend, repeats, warmups: 1, wholeRequestedSide: 1024, regionWindow: { width: 768, height: 576 }, stageCache: 'off' },
    trials, statistics: rawViewerStatistics(trials), limitations: ['noPerformanceVerdict', 'diagnosticSequenceNotProductionSchedulerTiming',
      'adoptMeansReactLayoutCommitNotScreenPresentation', 'nativeIncludesMcpEncodeAndReadback', 'regionNativeIsEngineReported',
      'regionValidationNotSeparatelyCollected', 'responseWaitIncludesBackendAndTransport', 'openExcludesProcessStartupAndSourceDownload',
      'warmupUsesSeparateNativeDocument', 'rssAndVramNotCollected'] };
}
export type RawViewerReport = ReturnType<typeof createRawViewerReport>;
