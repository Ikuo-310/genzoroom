import { BLACKS, CONTRAST, EXPOSURE, HIGHLIGHTS, SHADOWS, WHITES, formatBlacks, formatContrast, formatExposure, formatHighlights, formatShadows, formatWhites, type BasicAdjustmentKey } from './editing';

type BasicControl<K extends BasicAdjustmentKey> = {
  key: K; label: `workspace.${K}`; valueLabel: `workspace.${K}Value`;
  reset: `${K}Reset`; resetLabel: `workspace.${K}Reset`;
  min: number; max: number; step: number; precision: number; unit: string;
  format: (value: number) => string;
};

// Only the six Basic controls belong here; this is not a category registry.
export const BASIC_CONTROLS = {
  exposure: {
    key: 'exposure', label: 'workspace.exposure', valueLabel: 'workspace.exposureValue',
    reset: 'exposureReset', resetLabel: 'workspace.exposureReset',
    ...EXPOSURE, precision: 2, unit: 'EV', format: formatExposure
  },
  contrast: {
    key: 'contrast', label: 'workspace.contrast', valueLabel: 'workspace.contrastValue',
    reset: 'contrastReset', resetLabel: 'workspace.contrastReset',
    ...CONTRAST, precision: 0, unit: '', format: formatContrast
  },
  highlights: {
    key: 'highlights', label: 'workspace.highlights', valueLabel: 'workspace.highlightsValue',
    reset: 'highlightsReset', resetLabel: 'workspace.highlightsReset',
    ...HIGHLIGHTS, precision: 0, unit: '', format: formatHighlights
  },
  whites: {
    key: 'whites', label: 'workspace.whites', valueLabel: 'workspace.whitesValue',
    reset: 'whitesReset', resetLabel: 'workspace.whitesReset',
    ...WHITES, precision: 0, unit: '', format: formatWhites
  },
  shadows: {
    key: 'shadows', label: 'workspace.shadows', valueLabel: 'workspace.shadowsValue',
    reset: 'shadowsReset', resetLabel: 'workspace.shadowsReset',
    ...SHADOWS, precision: 0, unit: '', format: formatShadows
  },
  blacks: {
    key: 'blacks', label: 'workspace.blacks', valueLabel: 'workspace.blacksValue',
    reset: 'blacksReset', resetLabel: 'workspace.blacksReset',
    ...BLACKS, precision: 0, unit: '', format: formatBlacks
  },
} satisfies { [K in BasicAdjustmentKey]: BasicControl<K> };

export function basicHistoryControl(kind: string) {
  return Object.values(BASIC_CONTROLS).find((control) => control.key === kind || control.reset === kind);
}
