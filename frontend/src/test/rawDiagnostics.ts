import { LIGHTCRAFT_ENGINE } from '../lightcraftEngine';
import { rawTrialPlan, type RawDiagnosticConfig, type RawTrial, type RawTrialMetadata, type RawTrialResult } from '../rawDiagnostics';

export const diagnosticConfig: RawDiagnosticConfig = { assetId: '11111111-1111-4111-8111-111111111111',
  quality: 'both', stageCache: 'both', backend: 'cpu', temperature: 'cold', repeats: 1, budgetBytes: 512 * 1024 ** 2 };
export function trialMetadata(trial: RawTrial): RawTrialMetadata {
  return { trial, measuredAt: '2026-10-24T00:00:00.000Z', contract: { lightcraftVersion: LIGHTCRAFT_ENGINE.version,
    engineCommit: LIGHTCRAFT_ENGINE.commit, previewContract: 1, binarySha256: 'b'.repeat(64) },
    source: { width: 6000, height: 4500, format: 'DNG', identity: 'c'.repeat(64) }, settingsFingerprint: 'd'.repeat(64),
    frame: { geometryId: 'e'.repeat(64), nativeWidth: 6000, nativeHeight: 4500, aspect: 4 / 3, fullWidth: 16, fullHeight: 12, window: null },
    backend: { configured: 'cpu', execution: 'cpu', gpuAvailable: false, fallbackReported: false },
    width: 16, height: 12, payloadBytes: 8, metrics: { nativeMs: trial.quality === 'draft' ? 10 : 20, validationMs: 1,
      pngSha256: trial.quality === 'full' ? 'f'.repeat(64) : null, stageCache: { mode: trial.stageCache,
        applied: trial.stageCache === 'on', reason: 'none', cpuBytes: 0, gpuBytes: 0, retainedBytes: 0,
        budgetBytes: trial.stageCache === 'on' ? diagnosticConfig.budgetBytes : 0 } }, rssBytes: null, vramBytes: null };
}
export function trialRows(config = diagnosticConfig): RawTrialResult[] {
  return rawTrialPlan(config).map(trial => ({ trial, result: 'success', metadata: trialMetadata(trial),
    responseWaitMs: 30, transferMs: 2, decodeMs: 3, totalMs: 35, errorCode: null }));
}
