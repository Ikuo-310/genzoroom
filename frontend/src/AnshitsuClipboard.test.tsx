// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AssetDetail, WorkspaceNavigationState } from './assets';
import { ADJUSTMENT_IDS, defaultRecipe, newSession, type EditRecipe } from './editing';
import { createEditStateSnapshot, type EditStateSnapshot } from './editState';
import i18n from './i18n';
import { copyEditSettings, readEditClipboard } from './editClipboard';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), detail: vi.fn() }));
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), fetchAssetDetail: api.detail }));
vi.mock('./editStateApi', async (original) => ({
  ...await original<typeof import('./editStateApi')>(), getAssetEditState: api.get, putAssetEditState: api.put,
}));
const rendered = vi.hoisted(() => ({ recipe: undefined as EditRecipe | undefined }));
vi.mock('./AdjustedImage', () => ({ AdjustedImage: ({ recipe, showBeforeAdjustments }: { recipe: EditRecipe; showBeforeAdjustments: boolean }) => {
  rendered.recipe = recipe;
  return <canvas data-testid="preview" data-before={String(showBeforeAdjustments)} />;
} }));
// Keep the real route lifecycle and workspace; Gallery's network work is unrelated.
vi.mock('./GalleryPage', () => ({
  GalleryPage: () => <Link to="/anshitsu/destination">Open destination</Link>, LanguageControl: () => null,
}));

const first: AssetDetail = { id: 'original', filename: 'PXL_20260920_050929890.jpg', date: '2026-09-20T00:00:00Z',
  preview_url: '/original', thumbnail_url: '/original-thumb', format: 'JPEG', is_raw: false, exif: {} };
const second: AssetDetail = { ...first, id: 'destination', filename: 'destination.jpg', preview_url: '/destination' };
let host: HTMLDivElement;
let root: Root;
let restoreDialog: () => void;
let rows: Map<string, { state: EditStateSnapshot; revision: number; lastSaveId: string; updatedAt: string }>;

function stored(assetId: string, recipe: EditRecipe) {
  const result = createEditStateSnapshot({ ...newSession(), recipe }, { provider: 'immich', assetId, inputKind: 'immich-preview' });
  if (!result.ok) throw new Error('Invalid fixture');
  return { state: result.value, revision: 1, lastSaveId: 'saved-id', updatedAt: '2026-09-26T00:00:00Z' };
}
async function mount() {
  const state: WorkspaceNavigationState = { selectedAssets: [first, second], activeAssetId: first.id };
  await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: '/anshitsu/original', state }]}><App /></MemoryRouter>));
}
function activatePreview() {
  const preview = host.querySelector('[data-testid="preview"], .viewer-image-position img')!;
  act(() => preview.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
  return host.querySelector<HTMLDivElement>('.viewer-viewport')!;
}
function key(target: EventTarget, key: string, options: KeyboardEventInit = {}, altGraph = false) {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...options });
  if (altGraph) Object.defineProperty(event, 'getModifierState', { value: (modifier: string) => modifier === 'AltGraph' });
  act(() => target.dispatchEvent(event));
  return event;
}
async function click(selector: string) {
  await act(async () => (host.querySelector<HTMLElement>(selector)!).click());
}

beforeEach(async () => {
  const prototype = HTMLDialogElement.prototype;
  const show = Object.getOwnPropertyDescriptor(prototype, 'showModal');
  const close = Object.getOwnPropertyDescriptor(prototype, 'close');
  Object.defineProperty(prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  restoreDialog = () => {
    if (show) Object.defineProperty(prototype, 'showModal', show); else Reflect.deleteProperty(prototype, 'showModal');
    if (close) Object.defineProperty(prototype, 'close', close); else Reflect.deleteProperty(prototype, 'close');
  };
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  rows = new Map(); rendered.recipe = undefined;
  api.get.mockReset(); api.put.mockReset(); api.detail.mockReset();
  api.detail.mockImplementation(async (id: string) => id === first.id ? first : second);
  api.get.mockImplementation(async (id: string) => rows.get(id) ?? { state: null });
  api.put.mockImplementation(async (id: string, state: EditStateSnapshot, revision: number, saveId: string) => {
    const row = { state, revision: revision + 1, lastSaveId: saveId, updatedAt: '2026-09-26T00:00:00Z' };
    rows.set(id, row);
    return row;
  });
});

function dialogButton(text: string) {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('dialog button')).find((button) => button.textContent === text)!;
}
function choose(ids: readonly string[]) {
  act(() => dialogButton('Clear all').click());
  for (const id of ids) act(() => host.querySelector<HTMLInputElement>(`dialog input[name="${id}"]`)!.click());
}
function confirm(text: 'Copy' | 'Paste') { act(() => dialogButton(text).click()); }
function menuAction(text: string) {
  const trigger = host.querySelector<HTMLElement>('.edit-settings-menu summary')!;
  act(() => { trigger.focus(); trigger.click(); });
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>('.edit-settings-menu-actions button')).find((button) => button.textContent === text)!;
  act(() => button.click());
  return trigger;
}

afterEach(() => { act(() => root.unmount()); host.remove(); restoreDialog(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('workspace full-settings clipboard', () => {
  it('does nothing before the first copy and requires actual preview focus', async () => {
    await mount();
    const viewport = host.querySelector('.viewer-viewport')!;
    // No focused photo: even events aimed at the image itself are not photo shortcuts.
    expect(key(host.querySelector('[data-testid="preview"]')!, 'c').defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(viewport);
    expect(key(viewport, 'c').defaultPrevented).toBe(false);
    expect(key(activatePreview(), 'v').defaultPrevented).toBe(false);
    expect(key(activatePreview(), 'v', { altKey: true }).defaultPrevented).toBe(false);
    expect(host.querySelector('dialog')).toBeNull();
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('.edit-settings-menu-actions button')).slice(2).every((button) => button.disabled)).toBe(true);
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('copies all stored values across Home, preserves target flags, displays and saves one undoable Paste', async () => {
    const original = defaultRecipe();
    ADJUSTMENT_IDS.forEach((id, index) => { original.adjustments[id] = id === 'exposure' ? 1.2 : index + 1; });
    original.basicEnabled = original.whiteBalanceEnabled = original.colorEnabled = original.colorGradingEnabled = false;
    original.gradingShadowsEnabled = original.gradingMidtonesEnabled = original.gradingHighlightsEnabled = false;
    rows.set(first.id, stored(first.id, original));
    const destination = defaultRecipe();
    destination.basicEnabled = destination.colorEnabled = destination.gradingMidtonesEnabled = false;
    rows.set(second.id, stored(second.id, destination));
    await mount();
    const viewport = activatePreview();
    expect(document.activeElement).toBe(viewport);
    expect(key(viewport, 'c').defaultPrevented).toBe(true);
    await click('.workspace-actions button');
    expect(api.put).not.toHaveBeenCalled();
    await click('a');
    const target = activatePreview();
    expect(key(target, 'v').defaultPrevented).toBe(true);
    expect(rendered.recipe).toEqual({ ...destination, adjustments: original.adjustments });
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(1);
    const history = host.querySelector('.edit-history li')!;
    expect(history.textContent).toBe(`Pasted from ${first.filename}`);
    expect(history.getAttribute('title')).toBe(history.textContent);
    expect(key(target, 'z').defaultPrevented).toBe(true);
    expect(rendered.recipe).toEqual(destination);
    expect(key(target, 'z', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(rendered.recipe!.adjustments).toEqual(original.adjustments);
    await act(async () => { await i18n.changeLanguage('ja'); });
    expect(history.textContent).toBe(`${first.filename}からペースト`);
    await click('.workspace-actions button');
    expect(api.put).toHaveBeenCalledTimes(1);
    const saved = rows.get(second.id)!;
    expect(saved.state.stateFormatVersion).toBe(2);
    expect(saved.state.history).toHaveLength(1);
    expect(saved.state.history[0]).toMatchObject({ kind: 'paste', metadata: { sourceAssetId: first.id, sourceFilename: first.filename, adjustmentIds: ADJUSTMENT_IDS } });
    await click('a');
    expect(host.querySelector('.edit-history li')!.textContent).toBe(`${first.filename}からペースト`);
    expect(rendered.recipe!.adjustments).toEqual(original.adjustments);
  });

  it('copies the existing operation target on hover and clears it on leave and photo switch', async () => {
    const original = defaultRecipe();
    original.adjustments.exposure = 1.5; original.adjustments.shadowsTemperature = 42;
    const destination = defaultRecipe(); destination.adjustments.exposure = -2;
    rows.set(first.id, stored(first.id, original)); rows.set(second.id, stored(second.id, destination));
    await mount();
    const viewport = activatePreview();
    const hovered = host.querySelector<HTMLInputElement>('[data-adjustment-id="shadowsTemperature"]')!;
    act(() => hovered.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    expect(document.activeElement).toBe(viewport);
    expect(key(viewport, 'c').defaultPrevented).toBe(true);
    expect(readEditClipboard()?.values).toEqual({ shadowsTemperature: 42 });

    act(() => hovered.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })));
    expect(key(viewport, 'c').defaultPrevented).toBe(true);
    expect(Object.keys(readEditClipboard()!.values)).toEqual([...ADJUSTMENT_IDS]);

    act(() => hovered.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    await click('button[aria-label="destination.jpg"]');
    const targetViewport = activatePreview();
    expect(key(targetViewport, 'c').defaultPrevented).toBe(true);
    expect(Object.keys(readEditClipboard()!.values)).toEqual([...ADJUSTMENT_IDS]);
    expect(readEditClipboard()?.sourceAssetId).toBe(second.id);
  });

  it('copies the slider selected by Shift+Arrow using the active slider target', async () => {
    const original = defaultRecipe();
    original.adjustments.temperature = 12; original.adjustments.tint = -8;
    rows.set(first.id, stored(first.id, original));
    await mount();
    const temperature = host.querySelector<HTMLInputElement>('[data-adjustment-id="temperature"]')!;
    const tint = host.querySelector<HTMLInputElement>('[data-adjustment-id="tint"]')!;
    act(() => temperature.focus());
    expect(key(temperature, 'c').defaultPrevented).toBe(true);
    expect(readEditClipboard()?.values).toEqual({ temperature: 12 });
    key(temperature, 'ArrowDown', { ctrlKey: false, shiftKey: true });
    expect(document.activeElement).toBe(tint);
    expect(key(tint, 'c').defaultPrevented).toBe(true);
    expect(readEditClipboard()?.values).toEqual({ tint: -8 });
  });

  it('keeps copy independent after the source is edited and uses Filmstrip save and autosave for Paste', async () => {
    vi.useFakeTimers();
    const original = defaultRecipe(); original.adjustments.exposure = 1;
    rows.set(first.id, stored(first.id, original));
    await mount();
    key(activatePreview(), 'c');
    const number = host.querySelector<HTMLInputElement>('input[aria-label="Exposure value"]')!;
    act(() => {
      number.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(number, '2');
      number.dispatchEvent(new Event('input', { bubbles: true }));
    });
    key(number, 'Enter', { ctrlKey: false });
    expect(rendered.recipe!.adjustments.exposure).toBe(2);
    await click('button[aria-label="destination.jpg"]');
    expect(rows.get(first.id)!.state.currentRecipe.adjustments.exposure).toBe(2);
    key(activatePreview(), 'v');
    expect(rendered.recipe!.adjustments.exposure).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(rows.has(second.id)).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(rows.get(second.id)!.state.history.map((entry) => entry.kind)).toEqual(['paste']);
  });

  it.each(['input[type="number"]', 'input[type="search"]', 'textarea', '[contenteditable="true"]', '[role="textbox"]', 'input[type="range"]'])
    ('preserves native or non-photo shortcuts in %s', async (selector) => {
      const recipe = defaultRecipe(); recipe.adjustments.tint = 10;
      rows.set(first.id, stored(first.id, recipe));
      copyEditSettings(defaultRecipe(), 'other', 'other.jpg');
      await mount(); activatePreview();
      const field = document.createElement(selector.startsWith('textarea') ? 'textarea' : selector.startsWith('input') ? 'input' : 'div');
      if (field instanceof HTMLInputElement) field.type = selector.match(/type="([^"]+)"/)![1];
      if (selector.includes('contenteditable')) field.setAttribute('contenteditable', 'true');
      if (selector.includes('role=')) field.setAttribute('role', 'textbox');
      field.tabIndex = 0; host.append(field); field.focus();
      expect(key(field, 'c').defaultPrevented).toBe(false);
      expect(key(field, 'v').defaultPrevented).toBe(false);
      expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
    });

  it.each([
    { isComposing: true }, { repeat: true }, { altKey: true, shiftKey: true }, { metaKey: true },
    { shiftKey: true }, { ctrlKey: false },
  ])('ignores unsupported clipboard key conditions %j', async (options) => {
    const recipe = defaultRecipe(); recipe.adjustments.tint = 10;
    rows.set(first.id, stored(first.id, recipe));
    copyEditSettings(defaultRecipe(), 'other', 'other.jpg');
    await mount(); const viewport = activatePreview();
    expect(key(viewport, 'c', options).defaultPrevented).toBe(false);
    expect(key(viewport, 'v', options).defaultPrevented).toBe(false);
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
  });

  it('ignores AltGraph and already prevented events', async () => {
    const recipe = defaultRecipe(); recipe.adjustments.tint = 10;
    rows.set(first.id, stored(first.id, recipe));
    copyEditSettings(defaultRecipe(), 'other', 'other.jpg');
    await mount(); const viewport = activatePreview();
    expect(key(viewport, 'c', {}, true).defaultPrevented).toBe(false);
    expect(key(viewport, 'v', {}, true).defaultPrevented).toBe(false);
    const cancel = (event: Event) => event.preventDefault();
    viewport.addEventListener('keydown', cancel, { capture: true });
    key(viewport, 'v');
    viewport.removeEventListener('keydown', cancel, { capture: true });
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
  });
});

describe('single-slider clipboard', () => {
  it('replaces a multi-item copy, pastes by source adjustment despite another focused slider, and supports Undo/Redo and save', async () => {
    const source = defaultRecipe(); source.adjustments.exposure = 1.25; source.adjustments.tint = 8;
    const destination = defaultRecipe(); destination.adjustments.exposure = -2; destination.adjustments.tint = 35;
    destination.basicEnabled = false;
    rows.set(first.id, stored(first.id, source)); rows.set(second.id, stored(second.id, destination));
    copyEditSettings(source, 'older', 'older.jpg');
    await mount();
    const sourceSlider = host.querySelector<HTMLInputElement>('[data-adjustment-id="exposure"]')!;
    act(() => sourceSlider.focus());
    expect(key(sourceSlider, 'c').defaultPrevented).toBe(true);
    expect(readEditClipboard()).toEqual({ values: { exposure: 1.25 }, sourceAssetId: first.id, sourceFilename: first.filename });

    await click('button[aria-label="destination.jpg"]');
    const otherSlider = host.querySelector<HTMLInputElement>('[data-adjustment-id="tint"]')!;
    act(() => otherSlider.focus());
    expect(key(otherSlider, 'v').defaultPrevented).toBe(true);
    expect(rendered.recipe!.adjustments.exposure).toBe(1.25);
    expect(rendered.recipe!.adjustments.tint).toBe(35);
    expect(rendered.recipe!.basicEnabled).toBe(false);
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(1);
    expect(api.put).not.toHaveBeenCalled();

    key(otherSlider, 'z'); expect(rendered.recipe).toEqual(destination);
    key(otherSlider, 'y'); expect(rendered.recipe!.adjustments.exposure).toBe(1.25);
    expect(rendered.recipe!.adjustments.tint).toBe(35);
    expect(readEditClipboard()?.values).toEqual({ exposure: 1.25 });
    await click('.workspace-actions button');
    const saved = rows.get(second.id)!.state;
    expect(saved.currentRecipe.adjustments.exposure).toBe(1.25);
    expect(saved.history).toHaveLength(1);
    expect(saved.history[0]).toMatchObject({ kind: 'paste', metadata: { sourceAssetId: first.id,
      sourceFilename: first.filename, adjustmentIds: ['exposure'] } });
  });

  it('pastes with preview focus and leaves History unchanged when the copied value already matches', async () => {
    const source = defaultRecipe(); source.adjustments.shadowsTemperature = 24;
    rows.set(first.id, stored(first.id, source)); rows.set(second.id, stored(second.id, source));
    await mount();
    const slider = host.querySelector<HTMLInputElement>('[data-adjustment-id="shadowsTemperature"]')!;
    act(() => slider.focus()); key(slider, 'c');
    expect(readEditClipboard()?.values).toEqual({ shadowsTemperature: 24 });
    await click('button[aria-label="destination.jpg"]');
    const viewport = activatePreview();
    expect(key(viewport, 'v').defaultPrevented).toBe(true);
    expect(rendered.recipe!.adjustments.shadowsTemperature).toBe(24);
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('preserves the clipboard and native Ctrl+C/Ctrl+V while a numeric input is focused', async () => {
    const recipe = defaultRecipe(); recipe.adjustments.exposure = 1.5;
    rows.set(first.id, stored(first.id, recipe));
    await mount();
    const slider = host.querySelector<HTMLInputElement>('[data-adjustment-id="exposure"]')!;
    act(() => slider.focus()); key(slider, 'c');
    const copied = readEditClipboard();
    const number = host.querySelector<HTMLInputElement>('input[aria-label="Exposure value"]')!;
    const hovered = host.querySelector<HTMLInputElement>('[data-adjustment-id="tint"]')!;
    act(() => hovered.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    act(() => number.focus());
    expect(key(number, 'c').defaultPrevented).toBe(false);
    expect(key(number, 'v').defaultPrevented).toBe(false);
    expect(readEditClipboard()).toEqual(copied);
    expect(rendered.recipe!.adjustments.exposure).toBe(1.5);
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
  });
});

describe('selected settings clipboard', () => {
  it.each([
    ['B', false, true], ['C', true, false], ['D', true, true],
  ] as const)('supports combination %s through the same clipboard, Paste History and save path', async (_name, selectedCopy, selectedPaste) => {
    const original = defaultRecipe();
    ADJUSTMENT_IDS.forEach((id, index) => { original.adjustments[id] = id === 'exposure' ? 1.25 : index + 1; });
    original.whiteBalanceEnabled = original.basicEnabled = original.colorEnabled = original.colorGradingEnabled = false;
    original.gradingShadowsEnabled = original.gradingMidtonesEnabled = original.gradingHighlightsEnabled = false;
    rows.set(first.id, stored(first.id, original));
    const destination = { ...defaultRecipe(), whiteBalanceEnabled: false, basicEnabled: false, colorEnabled: false,
      colorGradingEnabled: false, gradingShadowsEnabled: false, gradingMidtonesEnabled: false, gradingHighlightsEnabled: false };
    rows.set(second.id, stored(second.id, destination));
    await mount();
    const viewport = activatePreview();
    expect(key(viewport, 'c', { altKey: selectedCopy }).defaultPrevented).toBe(true);
    const copiedIds = selectedCopy ? ['temperature', 'tint', 'exposure', 'shadowsTemperature'] as const : ADJUSTMENT_IDS;
    if (selectedCopy) {
      expect(host.querySelectorAll('dialog input[name]')).toHaveLength(16);
      expect(Array.from(host.querySelectorAll<HTMLInputElement>('dialog input[name]')).every((input) => input.checked && !input.disabled)).toBe(true);
      choose(copiedIds); confirm('Copy');
      expect(document.activeElement).toBe(viewport);
    }
    const copied = readEditClipboard()!;
    expect(Object.keys(copied.values)).toEqual([...copiedIds]);
    expect(copied.sourceAssetId).toBe(first.id);
    expect(copied.values.exposure).toBe(1.25);
    await click('button[aria-label="destination.jpg"]');
    const target = activatePreview();
    expect(key(target, 'v', { altKey: selectedPaste }).defaultPrevented).toBe(true);
    const pastedIds = selectedPaste ? ['temperature', 'exposure'] as const : copiedIds;
    if (selectedPaste) {
      expect(Array.from(host.querySelectorAll<HTMLInputElement>('dialog input[name]')).map((input) => input.name)).toEqual([...copiedIds]);
      expect(Array.from(host.querySelectorAll<HTMLInputElement>('dialog input[name]')).every((input) => input.checked)).toBe(true);
      choose(pastedIds); confirm('Paste');
      expect(document.activeElement).toBe(target);
    }
    const adjustments = { ...destination.adjustments };
    for (const id of pastedIds) adjustments[id] = original.adjustments[id];
    expect(rendered.recipe).toEqual({ ...destination, adjustments });
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(1);
    expect(readEditClipboard()).toEqual(copied);
    key(target, 'z'); expect(rendered.recipe).toEqual(destination);
    key(target, 'y'); expect(rendered.recipe).toEqual({ ...destination, adjustments });
    await click('.workspace-actions button');
    expect(api.put).toHaveBeenCalledTimes(1);
    const saved = rows.get(second.id)!.state;
    expect(saved.history).toHaveLength(1);
    expect(saved.history[0]).toMatchObject({ kind: 'paste', metadata: {
      sourceAssetId: first.id, sourceFilename: first.filename, adjustmentIds: [...pastedIds],
    } });
    expect(saved.stateFormatVersion).toBe(2);
    await click('a');
    const reopened = activatePreview();
    key(reopened, 'v', { altKey: true });
    expect(Array.from(host.querySelectorAll<HTMLInputElement>('dialog input[name]')).every((input) => input.checked)).toBe(true);
    key(dialogButton('Cancel'), 'Escape', { ctrlKey: false });
    key(reopened, 'v');
    const allCopied = { ...destination.adjustments };
    for (const id of copiedIds) allCopied[id] = original.adjustments[id];
    expect(rendered.recipe).toEqual({ ...destination, adjustments: allCopied });
    expect(readEditClipboard()).toEqual(copied);
  });

  it('keeps the old clipboard and Recipe on cancelled copy or Paste, and resets selection on every open', async () => {
    const previous = defaultRecipe(); previous.adjustments.tint = 22;
    copyEditSettings(previous, 'previous', 'previous.jpg', ['tint']);
    const copied = readEditClipboard();
    await mount(); const viewport = activatePreview();
    key(viewport, 'c', { altKey: true }); choose(['exposure']);
    key(dialogButton('Cancel'), 'Escape', { ctrlKey: false });
    expect(readEditClipboard()).toEqual(copied);
    expect(document.activeElement).toBe(viewport);
    key(viewport, 'c', { altKey: true });
    expect(Array.from(host.querySelectorAll<HTMLInputElement>('dialog input[name]')).every((input) => input.checked)).toBe(true);
    act(() => dialogButton('Cancel').click());
    key(viewport, 'v', { altKey: true });
    expect(host.querySelectorAll('dialog input[name]')).toHaveLength(1);
    act(() => dialogButton('Clear all').click());
    expect(dialogButton('Paste').disabled).toBe(true);
    key(dialogButton('Cancel'), 'Escape', { ctrlKey: false });
    expect(rendered.recipe).toEqual(defaultRecipe());
    expect(readEditClipboard()).toEqual(copied);
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
    key(viewport, 'v', { altKey: true });
    expect(host.querySelector<HTMLInputElement>('dialog input[name="tint"]')!.checked).toBe(true);
  });

  it('keeps no-op selected Paste out of History and leaves its clipboard intact', async () => {
    const recipe = defaultRecipe(); recipe.adjustments.tint = 5;
    rows.set(first.id, stored(first.id, recipe));
    copyEditSettings(recipe, 'same', 'same.jpg', ['tint', 'exposure']);
    const copied = readEditClipboard();
    await mount(); key(activatePreview(), 'v', { altKey: true }); choose(['tint']); confirm('Paste');
    expect(rendered.recipe).toEqual(recipe);
    expect(readEditClipboard()).toEqual(copied);
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
    await click('.workspace-actions button'); expect(api.put).not.toHaveBeenCalled();
  });

  it('provides all four toolbar actions without photo focus and restores focus to its visible trigger', async () => {
    await mount();
    const trigger = menuAction('Copy selected settings…');
    expect(host.querySelector('dialog')).not.toBeNull();
    choose(['exposure']); confirm('Copy');
    expect(document.activeElement).toBe(trigger);
    expect(Object.keys(readEditClipboard()!.values)).toEqual(['exposure']);
    menuAction('Copy all settings');
    expect(Object.keys(readEditClipboard()!.values)).toHaveLength(16);
    const source = defaultRecipe(); source.adjustments.exposure = 2; source.adjustments.tint = 10;
    copyEditSettings(source, 'other', 'other.jpg', ['tint', 'exposure']);
    menuAction('Paste selected settings…'); choose(['tint']);
    act(() => dialogButton('Cancel').click());
    expect(document.activeElement).toBe(trigger);
    expect(rendered.recipe!.adjustments.tint).toBe(0);
    menuAction('Paste copied settings');
    expect(rendered.recipe!.adjustments.exposure).toBe(2);
    expect(rendered.recipe!.adjustments.tint).toBe(10);
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(1);
  });

  it('blocks background Undo/Redo, clipboard, hovered slider arrows, and Backslash while modal', async () => {
    const source = defaultRecipe(); source.adjustments.exposure = 1;
    copyEditSettings(source, 'other', 'other.jpg');
    await mount(); const viewport = activatePreview(); key(viewport, 'v');
    const range = host.querySelector<HTMLInputElement>('.adjustment-range')!;
    act(() => range.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    key(viewport, '\\', { ctrlKey: false, code: 'Backslash' });
    expect(host.querySelector('[data-testid="preview"]')!.getAttribute('data-before')).toBe('true');
    key(viewport, 'c', { altKey: true });
    expect(host.querySelector('[data-testid="preview"]')!.getAttribute('data-before')).toBe('false');
    const before = structuredClone(rendered.recipe);
    const copied = readEditClipboard();
    const control = host.querySelector<HTMLInputElement>('dialog input[name="exposure"]')!;
    for (const target of [control, viewport, range, window]) {
      for (const shortcut of ['z', 'y', 'c', 'v']) key(target, shortcut);
      key(target, 'ArrowUp', { ctrlKey: false });
      key(target, '\\', { ctrlKey: false, code: 'Backslash' });
    }
    expect(rendered.recipe).toEqual(before);
    expect(readEditClipboard()).toEqual(copied);
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(1);
    expect(host.querySelector('[data-testid="preview"]')!.getAttribute('data-before')).toBe('false');
    key(control, 'Escape', { ctrlKey: false });
    expect(document.activeElement).toBe(viewport);
    key(viewport, 'z'); expect(rendered.recipe!.adjustments.exposure).toBe(0);
    key(viewport, 'y'); expect(rendered.recipe!.adjustments.exposure).toBe(1);
  });

  it.each([
    { isComposing: true }, { repeat: true }, { shiftKey: true }, { metaKey: true }, { ctrlKey: false },
  ])('does not open selection for excluded modifiers %j', async (options) => {
    await mount(); const viewport = activatePreview();
    expect(key(viewport, 'c', { altKey: true, ...options }).defaultPrevented).toBe(false);
    expect(key(viewport, 'v', { altKey: true, ...options }).defaultPrevented).toBe(false);
    expect(host.querySelector('dialog')).toBeNull();
  });

  it('excludes AltGraph and defaultPrevented Ctrl+Alt events', async () => {
    await mount(); const viewport = activatePreview();
    expect(key(viewport, 'c', { altKey: true }, true).defaultPrevented).toBe(false);
    expect(key(viewport, 'v', { altKey: true }, true).defaultPrevented).toBe(false);
    const cancel = (event: Event) => event.preventDefault();
    viewport.addEventListener('keydown', cancel, { capture: true });
    key(viewport, 'c', { altKey: true }); key(viewport, 'v', { altKey: true });
    viewport.removeEventListener('keydown', cancel, { capture: true });
    expect(host.querySelector('dialog')).toBeNull();
  });

  it.each(['number', 'text', 'textarea', 'select', 'contenteditable'])('leaves Ctrl+Alt events in native %s alone', async (type) => {
    await mount(); activatePreview();
    const field = document.createElement(type === 'textarea' || type === 'select' ? type : type === 'contenteditable' ? 'div' : 'input');
    if (field instanceof HTMLInputElement) field.type = type;
    if (type === 'contenteditable') field.setAttribute('contenteditable', 'true');
    field.tabIndex = 0; host.append(field); field.focus();
    expect(key(field, 'c', { altKey: true }).defaultPrevented).toBe(false);
    expect(key(field, 'v', { altKey: true }).defaultPrevented).toBe(false);
    expect(host.querySelector('dialog')).toBeNull();
  });

  it('disables clipboard UI and shortcuts while edit state is still loading', async () => {
    api.get.mockReturnValue(new Promise(() => {}));
    await mount(); const viewport = activatePreview();
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('.edit-settings-menu-actions button')).every((button) => button.disabled)).toBe(true);
    expect(key(viewport, 'c', { altKey: true }).defaultPrevented).toBe(false);
    expect(key(viewport, 'v', { altKey: true }).defaultPrevented).toBe(false);
    expect(host.querySelector('dialog')).toBeNull();
  });

  it.each(['filmstrip', 'home'])('disables clipboard operations during %s save', async (transition) => {
    const recipe = defaultRecipe(); recipe.adjustments.tint = 10;
    copyEditSettings(recipe, 'other', 'other.jpg');
    await mount(); const viewport = activatePreview(); key(viewport, 'v');
    let finish!: () => void;
    api.put.mockImplementationOnce((_id, state: EditStateSnapshot, revision: number, lastSaveId: string) =>
      new Promise((resolve) => { finish = () => resolve({ state, revision: revision + 1, lastSaveId, updatedAt: '2026-09-26T00:00:00Z' }); }));
    await click(transition === 'home' ? '.workspace-actions button' : 'button[aria-label="destination.jpg"]');
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('.edit-settings-menu-actions button')).every((button) => button.disabled)).toBe(true);
    expect(key(viewport, 'c', { altKey: true }).defaultPrevented).toBe(false);
    expect(key(viewport, 'v', { altKey: true }).defaultPrevented).toBe(false);
    expect(host.querySelector('dialog')).toBeNull();
    await act(async () => finish());
  });
});
