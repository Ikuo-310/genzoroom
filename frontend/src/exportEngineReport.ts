import { DECODE_COMPARE_ERRORS, EXPORT_ENGINE_ERRORS, type ExportEngineErrorCode, type ExportEngineMetadata } from './exportEngineApi';
import type { DecodeComparisonReport } from './decodeComparison';
import { downloadJsonReport } from './jsonReportDownload';

export const DECODE_STATISTIC_KEYS = ['meanDeltaR', 'meanDeltaG', 'meanDeltaB', 'meanAbsoluteDeltaR', 'meanAbsoluteDeltaG',
  'meanAbsoluteDeltaB', 'maxAbsoluteDeltaR', 'maxAbsoluteDeltaG', 'maxAbsoluteDeltaB', 'meanAbsoluteError', 'rmse',
  'exactMatchPixelPercent', 'pixelsAtLeast1Percent', 'pixelsAtLeast2Percent', 'pixelsAtLeast4Percent', 'pixelsAtLeast8Percent',
  'meanLumaDelta', 'greenBias'] as const;
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const dimensions = (value: { width: number; height: number } | null) => value ? { width: numeric(value.width), height: numeric(value.height) } : null;
const icc = (value: unknown) => value === 'embedded' || value === 'absent' ? value : null;

export function createExportEngineReport(engine: { status: string; error: ExportEngineErrorCode | null; metadata: ExportEngineMetadata | null },
  decode: DecodeComparisonReport, generatedAt = new Date()) {
  const result = engine.metadata;
  // Never spread UI/run objects: selected Assets, Recipes, URLs and pixels have no report fields.
  return {
    schemaVersion: 1 as const, generatedAt: generatedAt.toISOString(),
    engine: {
      frontendDecodePath: 'html-image-explicit-srgb-canvas', backendDecodePath: 'pillow-imagecms-srgb-rgb8',
      recipeVersion: 18, processingVersion: 'jpeg-preview-srgb8-v1',
      encoder: { format: 'JPEG', quality: 95, subsampling: '4:4:4', outputColorSpace: 'sRGB' },
      status: ['idle', 'recipe', 'original', 'preview', 'backend', 'completed', 'failed', 'cancelled'].includes(engine.status) ? engine.status : 'idle',
      error: engine.error && EXPORT_ENGINE_ERRORS.includes(engine.error) ? engine.error : null,
      result: result ? {
        sourceWidth: numeric(result.sourceWidth), sourceHeight: numeric(result.sourceHeight),
        outputWidth: numeric(result.outputWidth), outputHeight: numeric(result.outputHeight), sourceIcc: icc(result.sourceIcc),
        outputColorSpace: 'sRGB', recipeVersion: 18, outputBytes: numeric(result.outputBytes),
        decodeMs: numeric(result.decodeMs), renderMs: numeric(result.renderMs), encodeMs: numeric(result.encodeMs),
        totalMs: numeric(result.totalMs), quality: 95, subsampling: '4:4:4',
      } : null,
    },
    decodeComparison: {
      status: ['not_run', 'running', 'completed', 'failed', 'cancelled'].includes(decode.status) ? decode.status : 'not_run',
      error: decode.error && DECODE_COMPARE_ERRORS.includes(decode.error) ? decode.error : null,
      dimensions: { frontend: dimensions(decode.dimensions.frontend), backend: dimensions(decode.dimensions.backend) },
      sourceIcc: icc(decode.sourceIcc), orientationNormalized: typeof decode.orientationNormalized === 'boolean' ? decode.orientationNormalized : null,
      pixelFormat: 'rgb8', deltaDirection: 'backend-minus-frontend',
      timing: { frontendDecodeMs: numeric(decode.timing.frontendDecodeMs), backendDecodeMs: numeric(decode.timing.backendDecodeMs),
        backendRequestMs: numeric(decode.timing.backendRequestMs), comparisonMs: numeric(decode.timing.comparisonMs), totalMs: numeric(decode.timing.totalMs) },
      statistics: decode.statistics ? Object.fromEntries(DECODE_STATISTIC_KEYS.map(key => [key, numeric(decode.statistics![key])])) : null,
      assessment: decode.assessment ? {
        brightnessDirection: ['brighter', 'darker', 'neutral'].includes(decode.assessment.brightnessDirection) ? decode.assessment.brightnessDirection : 'neutral',
        tintDirection: ['green', 'magenta', 'neutral'].includes(decode.assessment.tintDirection) ? decode.assessment.tintDirection : 'neutral',
        differenceLevel: ['minimal', 'small', 'noticeable'].includes(decode.assessment.differenceLevel) ? decode.assessment.differenceLevel : 'minimal',
      } : null,
    },
  };
}

export function exportEngineReport(report: ReturnType<typeof createExportEngineReport>) {
  downloadJsonReport(report, 'genzoroom-export-engine-diagnostics');
}
