import { describe, expect, it, vi } from 'vitest';
import { copyEditSettings, copyLightcraftEditSettings, readEditClipboard, selectLightcraftEditClipboardItems,
  RAW_COPY_SETTING_CATEGORIES, RAW_COPY_SETTING_LABEL_KEYS } from './editClipboard';
import { ADJUSTMENT_IDS, defaultRecipe, editSession, newSession, type EditAction, type EditRecipe, type EditSession } from './editing';
import { compactEditStateSnapshot, createEditStateSnapshot, restoreEditSession, validateEditStateSnapshot } from './editState';
import type { RawCopySettingsResponse } from './rawApi';

const source = { provider: 'immich' as const, assetId: 'destination', inputKind: 'immich-preview' as const };
const paste = (values: Partial<EditRecipe['adjustments']>): EditAction => ({
  type: 'paste', values, sourceAssetId: 'original', sourceFilename: 'original.jpg',
});
function snapshot(session: EditSession) {
  const result = createEditStateSnapshot(session, source);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
function allValues() {
  const recipe = defaultRecipe();
  ADJUSTMENT_IDS.forEach((id, index) => { recipe.adjustments[id] = id === 'exposure' ? 1.23 : index + 1; });
  return recipe;
}

describe('tab edit clipboard and compound Paste', () => {
  it('provides complete category and display-label definitions for the Backend IDs', () => {
    const grouped = RAW_COPY_SETTING_CATEGORIES.flatMap(category => category.selectedIds);
    expect(grouped).toHaveLength(25);
    expect(new Set(grouped).size).toBe(25);
    expect(grouped.sort()).toEqual(Object.keys(RAW_COPY_SETTING_LABEL_KEYS).sort());
  });

  it('projects every selectable ID to its complete Native JSON field set', () => {
    const settings = { light: { exposure: 1, contrast: 2, highlights: 3, shadows: 4, whites: 5, blacks: 6 },
      wb: { mode: 'custom', temp: 5151.25, tint: -4.75 }, color: { vibrance: 7, saturation: 8 },
      mixer: { red: { hue: 9, sat: 10, lum: 11 } }, point_colors: [{ hue: 12 }], grading: { shadows: { hue: 13 } },
      curve: { master: [{ x: 0, y: 0 }, { x: 1, y: 1 }], red: [], green: [], blue: [] },
      effects: { texture: 14, clarity: 15, dehaze: 16 }, vignette: { amount: 17 },
      detail: { sharpen_amount: 18, sharpen_radius: 1.25, sharpen_detail: 19, sharpen_masking: 20,
        nr_luminance: 21, nr_detail: 22, nr_color: 23, nr_color_detail: 24, nr_color_smoothness: 25 },
      optics: { distortion: 26, vignetting: 27, vignetting_midpoint: 28, profile_distortion: 29,
        profile_vignetting: 30, lens_profile: false, remove_ca: true, defringe_purple_amount: 31,
        defringe_purple_hue_lo: 32, defringe_purple_hue_hi: 33, defringe_green_amount: 34,
        defringe_green_hue_lo: 35, defringe_green_hue_hi: 36, ca_red: 37, ca_blue: 38 },
      profile: { camera_local_tone: false }, calibration: { red: { hue: 39 } }, crop: { left: 0, right: 1 }, orientation: 'Normal' };
    const confirmed = { workspaceId: 'workspace', handle: 'handle', assetId: 'source', generation: 1,
      documentToken: 'token', documentRevision: 2, settingsFingerprint: 'a'.repeat(64), recipeRevision: 3, sourceWbMode: 'absolute',
      selectedIds: RAW_COPY_SETTING_CATEGORIES.flatMap(category => category.selectedIds), settings } as unknown as RawCopySettingsResponse;
    const copied = copyLightcraftEditSettings(confirmed, 'source.dng');
    const selected = selectLightcraftEditClipboardItems(copied, confirmed.selectedIds);
    expect(selected.settings).toEqual(settings);
  });

  it('has no copy initially and keeps an independent read-only-by-copy snapshot of all stored values', async () => {
    // A fresh module represents a newly loaded tab, without resetting production state.
    vi.resetModules();
    const fresh = await import('./editClipboard');
    expect(fresh.readEditClipboard()).toBeNull();
    const recipe = allValues();
    recipe.whiteBalanceEnabled = recipe.basicEnabled = recipe.colorEnabled = recipe.colorGradingEnabled = false;
    recipe.gradingShadowsEnabled = recipe.gradingMidtonesEnabled = recipe.gradingHighlightsEnabled = false;
    const expected = { ...recipe.adjustments };
    fresh.copyEditSettings(recipe, 'original', 'original.jpg');
    recipe.adjustments.temperature = 99;
    const copied = fresh.readEditClipboard()!;
    expect(copied).toEqual({ engine: 'jpeg', values: expected, sourceAssetId: 'original', sourceFilename: 'original.jpg' });
    if (copied.engine !== 'jpeg') throw new Error('Expected JPEG clipboard');
    expect(Object.keys(copied.values)).toHaveLength(16);
    copied.values.tint = 88;
    expect(fresh.jpegEditClipboardValues(fresh.readEditClipboard())).toEqual(expected);
  });

  it('keeps an independent LightCraft snapshot and projects selected fields without default completion', () => {
    const settings = { light: { exposure: 1.23456789012345, contrast: 0.25 },
      wb: { mode: 'custom', scale: 'kelvin', temp: 5432.1, tint: -2.25 },
      point_colors: [{ hue: 1.25, range: .75 }], crop: { aspect: null }, orientation: 'Rotate90' };
    const response: RawCopySettingsResponse = { workspaceId: 'w', handle: 'h', assetId: 'source', generation: 2, documentToken: 't',
      documentRevision: 7, settingsFingerprint: 'a'.repeat(64), recipeRevision: 4, sourceWbMode: 'absolute',
      selectedIds: ['basic.exposure', 'whiteBalance', 'pointColor', 'crop'], settings };
    const clipboard = copyLightcraftEditSettings(response, 'portrait.dng');
    settings.light.exposure = 99;
    const returned = readEditClipboard();
    expect(returned).toMatchObject({ engine: 'lightcraft', sourceAssetId: 'source', sourceFilename: 'portrait.dng',
      selectedIds: response.selectedIds });
    if (returned?.engine !== 'lightcraft') throw new Error('Expected LightCraft clipboard');
    returned.settings.wb = { temp: -1 };
    expect(readEditClipboard()).toMatchObject({ settings: { light: { exposure: 1.23456789012345 } } });

    const partial = selectLightcraftEditClipboardItems(clipboard, ['whiteBalance', 'crop']);
    expect(partial.selectedIds).toEqual(['whiteBalance', 'crop']);
    expect(partial.settings).toEqual({ wb: { mode: 'custom', scale: 'kelvin', temp: 5432.1, tint: -2.25 },
      crop: { aspect: null }, orientation: 'Rotate90' });
    expect(selectLightcraftEditClipboardItems(clipboard, ['basic.exposure']).settings).toEqual({
      light: { exposure: 1.23456789012345 },
    });
    expect(readEditClipboard()).toMatchObject({ selectedIds: response.selectedIds, settings: { point_colors: [{ hue: 1.25, range: .75 }] } });
  });

  it('rejects LightCraft selection outside the copied IDs and keeps the single clipboard slot unchanged', () => {
    const response: RawCopySettingsResponse = { workspaceId: 'w', handle: 'h', assetId: 'source', generation: 1, documentToken: 't',
      documentRevision: 1, settingsFingerprint: 'a'.repeat(64), recipeRevision: 0, sourceWbMode: 'absolute',
      selectedIds: ['basic.exposure'], settings: { light: { exposure: 2 } } };
    const copied = copyLightcraftEditSettings(response, 'source.dng');
    const before = readEditClipboard();
    expect(() => selectLightcraftEditClipboardItems(copied, ['crop'])).toThrow('raw_invalid_request');
    expect(readEditClipboard()).toEqual(before);
    copyEditSettings(defaultRecipe(), 'jpeg-source', 'source.jpg');
    expect(readEditClipboard()).toMatchObject({ engine: 'jpeg', sourceAssetId: 'jpeg-source' });
  });

  it('pastes all values in one operation, preserves every flag, and undoes/redoes together', () => {
    const target = newSession();
    target.recipe.whiteBalanceEnabled = target.recipe.basicEnabled = target.recipe.colorGradingEnabled = target.recipe.colorEnabled = false;
    target.recipe.gradingShadowsEnabled = target.recipe.gradingMidtonesEnabled = target.recipe.gradingHighlightsEnabled = false;
    const original = structuredClone(target);
    const copied = allValues();
    copyEditSettings(copied, 'original', 'original.jpg');
    const clipboard = readEditClipboard()!;
    if (clipboard.engine !== 'jpeg') throw new Error('Expected JPEG clipboard');
    const result = editSession(target, { type: 'paste', ...clipboard });
    clipboard.values.temperature = 80;
    expect(result.recipe).toEqual({ ...original.recipe, adjustments: copied.adjustments });
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({ kind: 'paste', before: original.recipe, after: result.recipe,
      metadata: { sourceAssetId: 'original', sourceFilename: 'original.jpg', adjustmentIds: ADJUSTMENT_IDS } });
    expect(editSession(result, { type: 'undo' }).recipe).toEqual(original.recipe);
    expect(editSession(editSession(result, { type: 'undo' }), { type: 'redo' })).toEqual(result);
    expect(target).toEqual(original);
  });

  it('uses the same partial-value Paste for future selection and retains specified unchanged IDs', () => {
    const result = editSession(newSession(), paste({ exposure: 0.4, tint: 0 }));
    expect(result.recipe.adjustments).toEqual({ ...defaultRecipe().adjustments, exposure: 0.4 });
    expect(result.history[0]).toMatchObject({ kind: 'paste', metadata: { adjustmentIds: ['tint', 'exposure'] } });
  });

  it('commits pending work separately, including when Paste itself is a no-op', () => {
    const pending = editSession(newSession(), { type: 'exposure', value: 0.5 });
    const result = editSession(pending, paste({ exposure: 1, tint: 10 }));
    expect(result.history.map((entry) => entry.kind)).toEqual(['exposure', 'paste']);
    expect(result.history[1].before).toEqual(pending.recipe);
    expect(editSession(result, { type: 'undo' }).recipe).toEqual(pending.recipe);
    const noOp = editSession(pending, paste({ exposure: 0.5 }));
    expect(noOp.history.map((entry) => entry.kind)).toEqual(['exposure']);
    expect(noOp.pending).toBeNull();
  });

  it('preserves Redo on no-op and replaces it only on a changed Paste', () => {
    const edited = editSession(newSession(), paste({ temperature: 10 }));
    const undone = editSession(edited, { type: 'undo' });
    expect(editSession(undone, paste({ temperature: 0 }))).toBe(undone);
    expect(editSession(undone, paste({}))).toBe(undone);
    const changed = editSession(undone, paste({ tint: 4 }));
    expect(changed.history).toHaveLength(1);
    expect(changed.history[0].after.adjustments.temperature).toBe(0);
    expect(changed.history[0].after.adjustments.tint).toBe(4);
    expect(changed.cursor).toBe(1);
  });

  it('preserves independent Paste metadata through snapshots, validation, restore and both compacted branches', () => {
    let session = newSession();
    for (const value of [1, 2]) session = editSession(editSession(session, { type: 'temperature', value }), { type: 'commit' });
    session = editSession(session, paste({ tint: 10 }));
    session = editSession(session, paste({ tint: 20 }));
    for (const value of [3, 4]) session = editSession(editSession(session, { type: 'temperature', value }), { type: 'commit' });
    session = editSession(session, paste({ tint: 30 }));
    session = editSession(session, { type: 'undo' });
    const saved = snapshot(session);
    const validated = validateEditStateSnapshot(JSON.parse(JSON.stringify(saved)));
    expect(validated).toEqual({ ok: true, value: saved });
    const compacted = compactEditStateSnapshot(saved);
    if (!compacted.ok) throw new Error('Invalid compaction');
    expect(compacted.value.history.map((entry) => entry.kind)).toEqual(['temperature', 'paste', 'paste', 'temperature', 'paste']);
    expect(compacted.value.historyCursor).toBe(4);
    expect(compacted.value.currentRecipe).toEqual(session.recipe);
    const restored = restoreEditSession(compacted.value);
    if (!restored.ok) throw new Error('Invalid restore');
    const redone = editSession(restored.value, { type: 'redo' });
    expect(redone.recipe.adjustments.tint).toBe(30);
    expect(redone.history.filter((entry) => entry.kind === 'paste').map((entry) => entry.metadata))
      .toEqual(session.history.filter((entry) => entry.kind === 'paste').map((entry) => entry.metadata));
    const savedPaste = saved.history.find((entry) => entry.kind === 'paste')!;
    if (savedPaste.kind !== 'paste') throw new Error('Missing Paste');
    savedPaste.metadata.sourceFilename = 'mutated';
    savedPaste.metadata.adjustmentIds.push('exposure');
    expect(session.history[2]).toMatchObject({ metadata: { sourceFilename: 'original.jpg', adjustmentIds: ['tint'] } });
    expect(compacted.value.history[1]).toMatchObject({ metadata: { sourceFilename: 'original.jpg', adjustmentIds: ['tint'] } });
  });
});

describe('Paste snapshot validation and legacy read compatibility', () => {
  const valid = () => snapshot(editSession(newSession(), paste({ tint: 10 })));
  const metadata = { sourceAssetId: 'original', sourceFilename: 'original.jpg', adjustmentIds: ['tint'] };

  it.each([
    null, [], {}, { ...metadata, extra: true }, { ...metadata, sourceAssetId: 1 },
    { ...metadata, sourceFilename: null }, { ...metadata, adjustmentIds: 'tint' },
    { ...metadata, adjustmentIds: ['unknown'] }, { ...metadata, adjustmentIds: [['tint']] },
    { ...metadata, adjustmentIds: ['tint', 'tint'] }, { ...metadata, adjustmentIds: [] },
  ])('rejects malformed metadata %j', (bad) => {
    const saved = valid();
    expect(validateEditStateSnapshot({ ...saved, history: [{ ...saved.history[0], metadata: bad }] }))
      .toMatchObject({ ok: false, issues: [{ code: 'invalid_history' }] });
  });

  it.each(['flag', 'outside', 'noop', 'recipe'] as const)('rejects invalid Paste %s', (bad) => {
    const saved = valid();
    const entry = saved.history[0];
    if (bad === 'flag') entry.after.basicEnabled = false;
    if (bad === 'outside') entry.after.adjustments.exposure = 1;
    if (bad === 'noop') entry.after = structuredClone(entry.before);
    if (bad === 'recipe') entry.after.adjustments.tint = 101;
    saved.currentRecipe = entry.after;
    const result = validateEditStateSnapshot(saved);
    if (result.ok) throw new Error('Invalid Paste accepted');
    expect(result.issues.every((issue) => issue.code === (bad === 'recipe' ? 'invalid_recipe' : 'invalid_history_semantics'))).toBe(true);
  });

  it('strictly validates v1 and creates v2 only after restoring it; v1 never accepts Paste or metadata', () => {
    const original = snapshot(editSession(editSession(newSession(), { type: 'temperature', value: 12 }), { type: 'commit' }));
    const legacy = { ...original, stateFormatVersion: 1 as const };
    expect(validateEditStateSnapshot(legacy)).toEqual({ ok: true, value: legacy });
    const restored = restoreEditSession(legacy);
    if (!restored.ok) throw new Error('Invalid v1');
    expect(snapshot(restored.value)).toEqual(original);
    expect(legacy.stateFormatVersion).toBe(1);
    expect(validateEditStateSnapshot({ ...valid(), stateFormatVersion: 1 }).ok).toBe(false);
    expect(validateEditStateSnapshot({ ...legacy, history: [{ ...legacy.history[0], metadata }] }).ok).toBe(false);
    expect(validateEditStateSnapshot({ ...legacy, historyCursor: 0 }).ok).toBe(false);
    expect(validateEditStateSnapshot({ ...legacy, history: [{ ...legacy.history[0], kind: 'unknown' }] }).ok).toBe(false);
    const invalid = structuredClone(legacy);
    invalid.currentRecipe.adjustments.exposure = 6;
    expect(restoreEditSession(invalid).ok).toBe(false);
  });
});
