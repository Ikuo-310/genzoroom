import {
  editSession,
  recipesEqual,
  type EditEntry,
  type EditKind,
  type EditRecipe,
  type EditSession,
} from './editing';

/** Current write format. Legacy v1 is strictly validated before restoring. */
export const EDIT_STATE_FORMAT_VERSION = 2 as const;

/** Bump only when a recipe's intended output pixels change. */
export const PROCESSING_VERSION = 'jpeg-preview-srgb8-v1' as const;

/** Initial policy default; a future settings layer can supply this value instead. */
export const COMPACT_HISTORY_ON_EXIT = true;

export type EditSourceIdentity = {
  provider: 'immich';
  assetId: string;
  inputKind: 'immich-preview';
  checksum?: string;
  checksumKind?: string;
};

/** Frontend state payload only. Backend-owned revision, timestamps and save IDs are separate. */
export type EditStateSnapshot = {
  stateFormatVersion: 1 | typeof EDIT_STATE_FORMAT_VERSION;
  recipeVersion: EditRecipe['version'];
  processingVersion: typeof PROCESSING_VERSION;
  currentRecipe: EditRecipe;
  history: EditEntry[];
  historyCursor: number;
  sourceIdentity: EditSourceIdentity;
};

export type EditStateIssueCode =
  | 'invalid_snapshot'
  | 'unsupported_state_format_version'
  | 'unsupported_recipe_version'
  | 'unsupported_processing_version'
  | 'invalid_source_identity'
  | 'invalid_recipe'
  | 'invalid_history'
  | 'invalid_history_semantics'
  | 'invalid_history_cursor'
  | 'history_discontinuity'
  | 'current_recipe_mismatch';

export type EditStateIssue = { code: EditStateIssueCode; path: string; message: string };
export type EditStateResult<T> = { ok: true; value: T } | { ok: false; issues: EditStateIssue[] };

const ADJUSTMENT_BOUNDS = {
  temperature: [-100, 100], tint: [-100, 100], exposure: [-5, 5], contrast: [-100, 100],
  highlights: [-100, 100], whites: [-100, 100], shadows: [-100, 100], blacks: [-100, 100],
  shadowsTemperature: [-100, 100], shadowsTint: [-100, 100], midtonesTemperature: [-100, 100],
  midtonesTint: [-100, 100], highlightsTemperature: [-100, 100], highlightsTint: [-100, 100],
  vibrance: [-100, 100], saturation: [-100, 100],
} as const satisfies Record<keyof EditRecipe['adjustments'], readonly [number, number]>;

const ENABLED_KEYS = [
  'whiteBalanceEnabled', 'basicEnabled', 'colorGradingEnabled', 'gradingShadowsEnabled',
  'gradingMidtonesEnabled', 'gradingHighlightsEnabled', 'colorEnabled',
] as const;

const ADJUSTMENT_KEYS = Object.keys(ADJUSTMENT_BOUNDS) as Array<keyof EditRecipe['adjustments']>;
const RECIPE_KEYS = ['version', ...ENABLED_KEYS, 'adjustments'] as const;
const ENTRY_KEYS = ['kind', 'before', 'after'] as const;
const SNAPSHOT_KEYS = [
  'stateFormatVersion', 'recipeVersion', 'processingVersion', 'currentRecipe', 'history',
  'historyCursor', 'sourceIdentity',
] as const;
const SOURCE_KEYS = ['provider', 'assetId', 'inputKind', 'checksum', 'checksumKind'] as const;

const EDIT_KINDS: readonly EditKind[] = [
  'temperature', 'temperatureReset', 'tint', 'tintReset', 'whiteBalanceToggle', 'whiteBalanceReset',
  'exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks', 'exposureReset',
  'contrastReset', 'highlightsReset', 'whitesReset', 'shadowsReset', 'blacksReset', 'basicToggle',
  'basicReset', 'shadowsTemperature', 'shadowsTemperatureReset', 'shadowsTint', 'shadowsTintReset',
  'midtonesTemperature', 'midtonesTemperatureReset', 'midtonesTint', 'midtonesTintReset',
  'highlightsTemperature', 'highlightsTemperatureReset', 'highlightsTint', 'highlightsTintReset',
  'colorGradingToggle', 'colorGradingReset', 'gradingShadowsToggle', 'gradingMidtonesToggle',
  'gradingHighlightsToggle', 'vibrance', 'vibranceReset', 'saturation', 'saturationReset',
  'colorToggle', 'colorReset', 'allReset', 'paste',
];

const NUMERIC_EDIT_KEYS: Partial<Record<EditKind, keyof EditRecipe['adjustments']>> = {
  temperature: 'temperature', tint: 'tint', exposure: 'exposure', contrast: 'contrast',
  highlights: 'highlights', whites: 'whites', shadows: 'shadows', blacks: 'blacks',
  shadowsTemperature: 'shadowsTemperature', shadowsTint: 'shadowsTint',
  midtonesTemperature: 'midtonesTemperature', midtonesTint: 'midtonesTint',
  highlightsTemperature: 'highlightsTemperature', highlightsTint: 'highlightsTint',
  vibrance: 'vibrance', saturation: 'saturation',
};

const TOGGLE_EDIT_KEYS: Partial<Record<EditKind, keyof EditRecipe>> = {
  whiteBalanceToggle: 'whiteBalanceEnabled', basicToggle: 'basicEnabled',
  colorGradingToggle: 'colorGradingEnabled', gradingShadowsToggle: 'gradingShadowsEnabled',
  gradingMidtonesToggle: 'gradingMidtonesEnabled', gradingHighlightsToggle: 'gradingHighlightsEnabled',
  colorToggle: 'colorEnabled',
};

const RESET_EDIT_KEYS: Partial<Record<EditKind, readonly (keyof EditRecipe['adjustments'])[]>> = {
  temperatureReset: ['temperature'], tintReset: ['tint'], exposureReset: ['exposure'],
  contrastReset: ['contrast'], highlightsReset: ['highlights'], whitesReset: ['whites'],
  shadowsReset: ['shadows'], blacksReset: ['blacks'],
  shadowsTemperatureReset: ['shadowsTemperature'], shadowsTintReset: ['shadowsTint'],
  midtonesTemperatureReset: ['midtonesTemperature'], midtonesTintReset: ['midtonesTint'],
  highlightsTemperatureReset: ['highlightsTemperature'], highlightsTintReset: ['highlightsTint'],
  vibranceReset: ['vibrance'], saturationReset: ['saturation'],
  whiteBalanceReset: ['temperature', 'tint'],
  basicReset: ['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks'],
  colorGradingReset: ['shadowsTemperature', 'shadowsTint', 'midtonesTemperature', 'midtonesTint', 'highlightsTemperature', 'highlightsTint'],
  colorReset: ['vibrance', 'saturation'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function issue(code: EditStateIssueCode, path: string, message: string): EditStateIssue {
  return { code, path, message };
}

function cloneRecipe(recipe: EditRecipe): EditRecipe {
  return { ...recipe, adjustments: { ...recipe.adjustments } };
}

function cloneEntry(entry: EditEntry): EditEntry {
  const recipes = { before: cloneRecipe(entry.before), after: cloneRecipe(entry.after) };
  return entry.kind === 'paste'
    ? { ...recipes, kind: 'paste', metadata: { ...entry.metadata, adjustmentIds: [...entry.metadata.adjustmentIds] } }
    : { ...recipes, kind: entry.kind };
}

function cloneSourceIdentity(source: EditSourceIdentity): EditSourceIdentity {
  return { ...source };
}

function validateRecipe(value: unknown, path: string): EditStateIssue[] {
  if (!isRecord(value) || !hasExactKeys(value, RECIPE_KEYS)) {
    return [issue('invalid_recipe', path, 'Recipe fields do not match the supported recipe structure.')];
  }
  if (value.version !== 17) return [issue('unsupported_recipe_version', `${path}.version`, 'Only recipe version 17 is supported.')];

  const errors: EditStateIssue[] = [];
  for (const key of ENABLED_KEYS) {
    if (typeof value[key] !== 'boolean') errors.push(issue('invalid_recipe', `${path}.${key}`, 'Enabled flags must be booleans.'));
  }
  if (!isRecord(value.adjustments) || !hasExactKeys(value.adjustments, ADJUSTMENT_KEYS)) {
    errors.push(issue('invalid_recipe', `${path}.adjustments`, 'Adjustment fields do not match recipe version 17.'));
  } else {
    for (const key of ADJUSTMENT_KEYS) {
      const adjustment = value.adjustments[key];
      const [min, max] = ADJUSTMENT_BOUNDS[key];
      if (typeof adjustment !== 'number' || !Number.isFinite(adjustment) || adjustment < min || adjustment > max) {
        errors.push(issue('invalid_recipe', `${path}.adjustments.${key}`, `Adjustment must be a finite number from ${min} to ${max}.`));
      }
    }
  }
  return errors;
}

function validateSourceIdentity(value: unknown): EditStateIssue[] {
  if (!isRecord(value)
    || !['provider', 'assetId', 'inputKind'].every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !SOURCE_KEYS.includes(key as typeof SOURCE_KEYS[number]))
    || value.provider !== 'immich' || value.inputKind !== 'immich-preview'
    || typeof value.assetId !== 'string' || value.assetId.trim() === ''
    || (value.checksum !== undefined && typeof value.checksum !== 'string')
    || (value.checksumKind !== undefined && typeof value.checksumKind !== 'string')
    || ((value.checksum === undefined) !== (value.checksumKind === undefined))) {
    return [issue('invalid_source_identity', 'sourceIdentity', 'Source identity must identify an Immich preview and pair any checksum with its kind.')];
  }
  return [];
}

function validateEntry(value: unknown, index: number, stateFormatVersion: unknown): EditStateIssue[] {
  const path = `history[${index}]`;
  const paste = isRecord(value) && value.kind === 'paste';
  if (!isRecord(value) || !hasExactKeys(value, paste ? [...ENTRY_KEYS, 'metadata'] : ENTRY_KEYS)
    || !EDIT_KINDS.includes(value.kind as EditKind) || (paste && stateFormatVersion !== 2)) {
    return [issue('invalid_history', path, 'History entry must contain a supported kind, before recipe, and after recipe.')];
  }
  if (paste) {
    const metadata = value.metadata;
    if (!isRecord(metadata) || !hasExactKeys(metadata, ['sourceAssetId', 'sourceFilename', 'adjustmentIds'])
      || typeof metadata.sourceAssetId !== 'string' || typeof metadata.sourceFilename !== 'string'
      || !Array.isArray(metadata.adjustmentIds) || metadata.adjustmentIds.length === 0
      || metadata.adjustmentIds.some((id) => typeof id !== 'string' || !ADJUSTMENT_KEYS.includes(id as keyof EditRecipe['adjustments']))
      || new Set(metadata.adjustmentIds).size !== metadata.adjustmentIds.length) {
      return [issue('invalid_history', `${path}.metadata`, 'Paste metadata must identify its source and distinct supported adjustments.')];
    }
  }
  const errors = [
    ...validateRecipe(value.before, `${path}.before`),
    ...validateRecipe(value.after, `${path}.after`),
  ];
  if (errors.length > 0) return errors;
  const kind = value.kind as EditKind;
  const before = value.before as EditRecipe;
  const after = value.after as EditRecipe;
  const changedAdjustments = ADJUSTMENT_KEYS.filter((key) => before.adjustments[key] !== after.adjustments[key]);
  const changedFlags = ENABLED_KEYS.filter((key) => before[key] !== after[key]);
  if (paste) {
    const ids = (value as unknown as Extract<EditEntry, { kind: 'paste' }>).metadata.adjustmentIds;
    return changedFlags.length === 0 && changedAdjustments.length > 0 && changedAdjustments.every((key) => ids.includes(key))
      ? [] : [issue('invalid_history_semantics', path, 'Paste must change only selected adjustment values and preserve enabled flags.')];
  }
  const numeric = NUMERIC_EDIT_KEYS[kind];
  const toggle = TOGGLE_EDIT_KEYS[kind];
  const reset = RESET_EDIT_KEYS[kind];
  const valid = kind === 'allReset' || (numeric && changedFlags.length === 0 && changedAdjustments.every((key) => key === numeric))
    || (toggle && changedAdjustments.length === 0 && changedFlags.every((key) => key === toggle))
    || (reset && changedFlags.length === 0 && changedAdjustments.every((key) => reset.includes(key)));
  return valid ? [] : [issue('invalid_history_semantics', path, 'History kind does not match changed recipe fields.')];
}

/** Validates untrusted JSON without coercing, defaulting, or discarding any state. */
export function validateEditStateSnapshot(value: unknown): EditStateResult<EditStateSnapshot> {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) {
    return { ok: false, issues: [issue('invalid_snapshot', '$', 'Snapshot fields do not match the supported state format.')] };
  }

  const errors: EditStateIssue[] = [];
  if (value.stateFormatVersion !== 1 && value.stateFormatVersion !== EDIT_STATE_FORMAT_VERSION) {
    errors.push(issue('unsupported_state_format_version', 'stateFormatVersion', 'Only state format versions 1 and 2 are supported.'));
  }
  if (value.recipeVersion !== 17) {
    errors.push(issue('unsupported_recipe_version', 'recipeVersion', 'Only recipe version 17 is supported.'));
  }
  if (value.processingVersion !== PROCESSING_VERSION) {
    errors.push(issue('unsupported_processing_version', 'processingVersion', `Only ${PROCESSING_VERSION} is supported.`));
  }
  errors.push(...validateSourceIdentity(value.sourceIdentity));
  errors.push(...validateRecipe(value.currentRecipe, 'currentRecipe'));

  if (!Array.isArray(value.history)) {
    errors.push(issue('invalid_history', 'history', 'History must be an array.'));
  } else {
    value.history.forEach((entry, index) => errors.push(...validateEntry(entry, index, value.stateFormatVersion)));
  }

  if (!Number.isInteger(value.historyCursor) || (value.historyCursor as number) < 0
    || !Array.isArray(value.history) || (value.historyCursor as number) > value.history.length) {
    errors.push(issue('invalid_history_cursor', 'historyCursor', 'History cursor must be an integer from zero through history length.'));
  }

  if (Array.isArray(value.history)) {
    for (let index = 1; index < value.history.length; index += 1) {
      const previous = value.history[index - 1];
      const current = value.history[index];
      if (isRecord(previous) && isRecord(current) && isRecipe(previous.after) && isRecipe(current.before)
        && !recipesEqual(previous.after, current.before)) {
        errors.push(issue('history_discontinuity', `history[${index}]`, 'Entry before recipe must equal the previous entry after recipe.'));
      }
    }

    if (Number.isInteger(value.historyCursor) && (value.historyCursor as number) >= 0
      && (value.historyCursor as number) <= value.history.length && isRecipe(value.currentRecipe)) {
      const cursor = value.historyCursor as number;
      const applied = cursor > 0 ? value.history[cursor - 1] : undefined;
      const redo = cursor < value.history.length ? value.history[cursor] : undefined;
      if (isRecord(applied) && isRecipe(applied.after) && !recipesEqual(value.currentRecipe, applied.after)) {
        errors.push(issue('current_recipe_mismatch', 'currentRecipe', 'Current recipe must equal the applied entry after recipe at the cursor.'));
      }
      if (isRecord(redo) && isRecipe(redo.before) && !recipesEqual(value.currentRecipe, redo.before)) {
        errors.push(issue('current_recipe_mismatch', 'currentRecipe', 'Current recipe must equal the next redo entry before recipe at the cursor.'));
      }
    }
  }

  if (errors.length > 0) return { ok: false, issues: errors };
  return { ok: true, value: cloneSnapshot(value as unknown as EditStateSnapshot) };
}

function isRecipe(value: unknown): value is EditRecipe {
  return validateRecipe(value, 'recipe').length === 0;
}

function cloneSnapshot(snapshot: EditStateSnapshot): EditStateSnapshot {
  return {
    stateFormatVersion: snapshot.stateFormatVersion,
    recipeVersion: snapshot.recipeVersion,
    processingVersion: PROCESSING_VERSION,
    currentRecipe: cloneRecipe(snapshot.currentRecipe),
    history: snapshot.history.map(cloneEntry),
    historyCursor: snapshot.historyCursor,
    sourceIdentity: cloneSourceIdentity(snapshot.sourceIdentity),
  };
}

/** Commits pending work on a copy, preserving the live session and its operation boundary. */
export function createEditStateSnapshot(
  session: EditSession,
  sourceIdentity: EditSourceIdentity,
): EditStateResult<EditStateSnapshot> {
  if (!isRecipe(session.recipe)) {
    return { ok: false, issues: [issue('invalid_recipe', 'session.recipe', 'Current session recipe is invalid.')] };
  }

  const committed = editSession(session, { type: 'commit' });
  const untrusted: unknown = {
    stateFormatVersion: EDIT_STATE_FORMAT_VERSION,
    recipeVersion: committed.recipe.version,
    processingVersion: PROCESSING_VERSION,
    currentRecipe: committed.recipe,
    history: committed.history,
    historyCursor: committed.cursor,
    sourceIdentity,
  };
  const validated = validateEditStateSnapshot(untrusted);
  return validated;
}

/** Validates persisted JSON and reconstructs the existing editing model. */
export function restoreEditSession(value: unknown): EditStateResult<EditSession> {
  const validated = validateEditStateSnapshot(value);
  if (!validated.ok) return validated;
  return {
    ok: true,
    value: {
      recipe: cloneRecipe(validated.value.currentRecipe),
      history: validated.value.history.map(cloneEntry),
      cursor: validated.value.historyCursor,
      pending: null,
    },
  };
}

function compactOperations(entries: readonly EditEntry[]): EditEntry[] {
  const stack: EditEntry[] = [];
  for (const entry of entries) {
    const current = cloneEntry(entry);
    stack.push(current);
    let merged = true;
    while (merged && stack.length >= 2) {
      merged = false;
      const right = stack[stack.length - 1];
      const left = stack[stack.length - 2];
      if (left.kind === 'paste' || right.kind === 'paste') continue;
      if (!sameMergeTarget(left, right) || !recipesEqual(left.after, right.before)) continue;

      const combined: EditEntry = { kind: left.kind, before: left.before, after: right.after };
      stack.splice(stack.length - 2, 2);
      if (!recipesEqual(combined.before, combined.after)) stack.push(combined);
      merged = true;
    }
  }
  return stack;
}

function sameMergeTarget(left: EditEntry, right: EditEntry): boolean {
  const leftAdjustment = NUMERIC_EDIT_KEYS[left.kind];
  const rightAdjustment = NUMERIC_EDIT_KEYS[right.kind];
  if (leftAdjustment && rightAdjustment) return leftAdjustment === rightAdjustment;

  const leftToggle = TOGGLE_EDIT_KEYS[left.kind];
  const rightToggle = TOGGLE_EDIT_KEYS[right.kind];
  return !!leftToggle && leftToggle === rightToggle;
}

/** Compacts applied and redo branches independently. A failure leaves the input snapshot untouched. */
export function compactEditStateSnapshot(snapshot: unknown): EditStateResult<EditStateSnapshot> {
  const validated = validateEditStateSnapshot(snapshot);
  if (!validated.ok) return validated;

  const source = validated.value;
  const applied = source.history.slice(0, source.historyCursor);
  const redo = source.history.slice(source.historyCursor);
  const compactedApplied = compactOperations(applied);
  const history = [...compactedApplied, ...compactOperations(redo)];
  const compacted: EditStateSnapshot = {
    ...source,
    currentRecipe: cloneRecipe(source.currentRecipe),
    history,
    historyCursor: compactedApplied.length,
    sourceIdentity: cloneSourceIdentity(source.sourceIdentity),
  };
  return validateEditStateSnapshot(compacted);
}
