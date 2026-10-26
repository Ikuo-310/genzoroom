import { LIGHTCRAFT_ENGINE } from '../lightcraftEngine';
import type { RawViewerTrial, RawViewerMetadata } from '../rawViewerBenchmark';

export function viewerMetadata(trial: RawViewerTrial): RawViewerMetadata {
  return { operation: trial.operation, repeat: trial.repeat, warmup: trial.warmup, revision: 1, viewGeneration: trial.index + 1,
    quality: trial.quality, geometry: { geometryId: 'a'.repeat(64), nativeWidth: 4000, nativeHeight: 3000,
      aspect: 4 / 3, fullWidth: 16, fullHeight: 12, window: null }, bitmap: { width: 16, height: 12 }, region: null,
    wholeRequestedSide: 1024, stageCache: { mode: 'off', applied: false }, payloadBytes: trial.operation === 'regionPlan' ? 0 : 8,
    timing: { backendOperationMs: 1000, openMs: trial.operation === 'open' ? 100 : null, nativeMs: 900, validationMs: 2 },
    engine: { version: LIGHTCRAFT_ENGINE.version, commit: LIGHTCRAFT_ENGINE.commit, binarySha256: 'b'.repeat(64),
      previewContract: 1, regionContract: 1, geometryDescriptor: 2, gpuBackend: 'dx12', gpuAdapter: null } };
}
