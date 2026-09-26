// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AssetDetail, WorkspaceNavigationState } from './assets';
import { ADJUSTMENT_IDS, defaultRecipe, editSession, newSession, type EditRecipe } from './editing';
import * as editStateModule from './editState';
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

async function mountHistory(cursor = 2) {
  let session = newSession();
  for (const value of [10, 20, 30, 40]) session = editSession(editSession(session, { type: 'temperature', value }), { type: 'commit' });
  session = editSession(session, { type: 'jumpToHistory', cursor });
  const snapshot = createEditStateSnapshot(session, { provider: 'immich', assetId: first.id, inputKind: 'immich-preview' });
  if (!snapshot.ok) throw new Error('Invalid History fixture');
  rows.set(first.id, { state: snapshot.value, revision: 1, lastSaveId: 'initial', updatedAt: '2026-09-26T00:00:00Z' });
  await mount();
  return session;
}
function headerHistoryMenu() {
  const trigger = host.querySelector<HTMLButtonElement>('.history-menu-trigger')!;
  act(() => { trigger.focus(); trigger.click(); });
  return trigger;
}
function rowHistoryMenu(cursor: number, keyboard = false) {
  const trigger = host.querySelector<HTMLButtonElement>(`.edit-history li[value="${cursor}"] button`)!;
  act(() => {
    trigger.focus();
    if (keyboard) trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    else trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
  });
  return trigger;
}
function historyMenuAction(label: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.history-organization-menu button')).find((item) => item.textContent === label)!;
  act(() => button.click());
  return button;
}

describe('History organization menus and confirmation', () => {
  it('offers three header actions, compacts without confirmation, and restores with Undo', async () => {
    const original = await mountHistory();
    headerHistoryMenu();
    expect(Array.from(document.querySelectorAll('.history-organization-menu button'), (item) => item.textContent))
      .toEqual(['Compact history', 'Clear all history', 'Reset edits']);
    historyMenuAction('Compact history');
    expect(host.querySelector('dialog')).toBeNull();
    expect(host.querySelectorAll('.edit-history li[value]')).toHaveLength(2);
    expect(rendered.recipe).toEqual(original.recipe);
    act(() => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === 'Undo')!.click());
    expect(host.querySelectorAll('.edit-history li[value]')).toHaveLength(4);
    expect(rendered.recipe).toEqual(original.recipe);
  });

  it.each([1, 3])('trims atomically at right-clicked row %s without moving on right-click and restores its prior cursor', async (target) => {
    const original = await mountHistory();
    rowHistoryMenu(target);
    expect(rendered.recipe).toEqual(original.recipe);
    expect(host.querySelector('.edit-history button[aria-current]')!.textContent).toContain('→ +20');
    expect(document.querySelectorAll('.history-organization-menu button')).toHaveLength(4);
    historyMenuAction('Delete this and earlier history');
    expect(host.querySelector('dialog')).toBeNull();
    expect(host.querySelectorAll('.edit-history li[value]')).toHaveLength(4 - target);
    expect(rendered.recipe!.adjustments.temperature).toBe(target <= 2 ? 20 : 30);
    key(window, 'z');
    expect(host.querySelectorAll('.edit-history li[value]')).toHaveLength(4);
    expect(rendered.recipe).toEqual(original.recipe);
    expect(host.querySelector('.edit-history button[aria-current]')!.textContent).toContain('→ +20');
    expect(api.put).not.toHaveBeenCalled();
  });

  it('supports Shift+F10, disables Initial State trimming at cursor zero, and preserves ordinary row click', async () => {
    await mountHistory(0);
    rowHistoryMenu(2, true);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    key(document.activeElement!, 'Escape', { ctrlKey: false });
    const initial = host.querySelector<HTMLButtonElement>('.initial-state button')!;
    act(() => initial.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    const trim = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((item) => item.textContent === 'Delete this and earlier history')!;
    expect(trim.disabled).toBe(true);
    key(document.activeElement!, 'Escape', { ctrlKey: false });
    act(() => host.querySelector<HTMLButtonElement>('.edit-history li[value="2"] button')!.click());
    expect(rendered.recipe!.adjustments.temperature).toBe(20);
  });

  it.each(['Clear all history', 'Reset edits'])('confirms %s with Cancel focused, cancellation unchanged, Continue applied and focus restored', async (label) => {
    const original = await mountHistory();
    const trigger = headerHistoryMenu();
    historyMenuAction(label);
    expect(document.activeElement).toBe(dialogButton('Cancel'));
    expect(host.querySelector('dialog')!.textContent).toContain(label === 'Reset edits' ? 'All adjustments and edit history will be deleted.' : 'Your edits will remain.');
    expect(host.querySelector('.history-confirmation-warning')?.textContent.trim() ?? null)
      .toBe(label === 'Reset edits' ? '⚠This action cannot be undone.' : null);
    act(() => dialogButton('Cancel').click());
    expect(rendered.recipe).toEqual(original.recipe);
    expect(host.querySelectorAll('.edit-history li[value]')).toHaveLength(4);
    expect(document.activeElement).toBe(trigger);
    headerHistoryMenu(); historyMenuAction(label);
    act(() => dialogButton('Continue').click());
    expect(host.querySelector('dialog')).toBeNull();
    expect(host.querySelectorAll('.edit-history li[value]')).toHaveLength(0);
    expect(rendered.recipe).toEqual(label === 'Reset edits' ? defaultRecipe() : original.recipe);
    const undo = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === 'Undo')!;
    expect(undo.disabled).toBe(label === 'Reset edits');
  });

  it('handles Tab, Shift+Tab, Enter, Y, N and Escape with dialog isolation', async () => {
    const original = await mountHistory();
    const open = () => { headerHistoryMenu(); historyMenuAction('Clear all history'); };
    open();
    key(document.activeElement!, 'Tab', { ctrlKey: false });
    expect(document.activeElement).toBe(dialogButton('Continue'));
    key(document.activeElement!, 'Tab', { ctrlKey: false });
    expect(document.activeElement).toBe(dialogButton('Cancel'));
    key(document.activeElement!, 'Tab', { ctrlKey: false, shiftKey: true });
    expect(document.activeElement).toBe(dialogButton('Continue'));
    key(document.activeElement!, 'Tab', { ctrlKey: false, shiftKey: true });
    key(document.activeElement!, 'Enter', { ctrlKey: false });
    expect(host.querySelector('dialog')).toBeNull();
    expect(rendered.recipe).toEqual(original.recipe);
    for (const cancel of ['n', 'Escape']) {
      open(); key(document.activeElement!, cancel, { ctrlKey: false });
      expect(host.querySelector('dialog')).toBeNull();
      expect(host.querySelectorAll('.edit-history li[value]')).toHaveLength(4);
    }
    open(); key(document.activeElement!, 'y', { ctrlKey: false });
    expect(host.querySelectorAll('.edit-history li[value]')).toHaveLength(0);
    key(window, 'z');
    open(); key(document.activeElement!, 'Tab', { ctrlKey: false });
    key(document.activeElement!, 'Enter', { ctrlKey: false });
    expect(host.querySelectorAll('.edit-history li[value]')).toHaveLength(0);
  });

  it('ignores IME, AltGraph, modifiers, repeats and handled Y/N events and blocks background shortcuts', async () => {
    const original = await mountHistory();
    headerHistoryMenu(); historyMenuAction('Clear all history');
    for (const options of [{ isComposing: true }, { repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
      for (const letter of ['y', 'n']) key(document.activeElement!, letter, { ctrlKey: false, ...options });
      expect(host.querySelector('dialog')).not.toBeNull();
    }
    key(document.activeElement!, 'y', { ctrlKey: false }, true);
    const handled = new KeyboardEvent('keydown', { key: 'y', bubbles: true, cancelable: true });
    handled.preventDefault(); act(() => document.activeElement!.dispatchEvent(handled));
    key(window, 'z'); key(window, 'y'); key(window, 'v'); key(window, 'c', { altKey: true });
    expect(host.querySelector('dialog')).not.toBeNull();
    expect(rendered.recipe).toEqual(original.recipe);
    expect(host.querySelectorAll('.edit-history li[value]')).toHaveLength(4);
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('.edit-actions button')).every((item) => item.disabled)).toBe(true);
  });

  it('closes on outside pointer, Escape, Tab, or photo switch and drops pending confirmation on switch', async () => {
    await mountHistory();
    headerHistoryMenu();
    act(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    headerHistoryMenu(); key(document.activeElement!, 'Escape', { ctrlKey: false });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    headerHistoryMenu(); key(document.activeElement!, 'Tab', { ctrlKey: false });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    headerHistoryMenu(); historyMenuAction('Reset edits');
    await click('button[aria-label="destination.jpg"]');
    expect(host.querySelector('dialog')).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(rendered.recipe).toEqual(defaultRecipe());
    expect(rows.get(first.id)!.state.history).toHaveLength(4);
  });

  it('disables empty-history actions and prohibits menus before edit-state load', async () => {
    await mount();
    headerHistoryMenu();
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).every((item) => item.disabled)).toBe(true);
    key(document.activeElement!, 'Escape', { ctrlKey: false });
    api.get.mockImplementation(() => new Promise(() => {}));
    await click('button[aria-label="destination.jpg"]');
    expect(host.querySelector<HTMLButtonElement>('.history-menu-trigger')!.disabled).toBe(true);
    headerHistoryMenu();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('shows a concise error for failed compaction without changing History', async () => {
    const original = await mountHistory();
    const spy = vi.spyOn(editStateModule, 'compactEditSession').mockReturnValueOnce({ ok: false, issues: [] });
    try {
      headerHistoryMenu(); historyMenuAction('Compact history');
      expect(host.querySelector('[role="alert"]')!.textContent).toBe('Could not organize history.');
      expect(rendered.recipe).toEqual(original.recipe);
      expect(host.querySelectorAll('.edit-history li[value]')).toHaveLength(4);
    } finally { spy.mockRestore(); }
  });

  it('localizes both confirmation titles, messages, and buttons in Japanese', async () => {
    await mountHistory();
    await act(async () => { await i18n.changeLanguage('ja'); });
    for (const [label, message] of [['履歴をすべて削除', '全履歴を削除します。現在の編集内容は失われません。'],
      ['編集を初期化', '編集結果と履歴をすべて削除します。']]) {
      headerHistoryMenu(); historyMenuAction(label);
      expect(host.querySelector('dialog h2')!.textContent).toBe(label);
      expect(host.querySelector('dialog p')!.textContent).toBe(message);
      expect(host.querySelector('.history-confirmation-warning')?.textContent.trim() ?? null)
        .toBe(label === '編集を初期化' ? '⚠この操作は元に戻せません。' : null);
      expect(Array.from(host.querySelectorAll<HTMLButtonElement>('dialog button')).map((button) => button.textContent))
        .toEqual(['キャンセル', '続行']);
      expect(document.activeElement).toBe(dialogButton('キャンセル'));
      act(() => dialogButton('キャンセル').click());
    }
  });

  it('blocks header and row menus after a failed Filmstrip save', async () => {
    await mountHistory();
    headerHistoryMenu(); historyMenuAction('Compact history');
    api.put.mockRejectedValueOnce(new Error('Unavailable'));
    await click('button[aria-label="destination.jpg"]');
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.history-menu-trigger')!.disabled).toBe(true);
    headerHistoryMenu(); rowHistoryMenu(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps History confirmation and the Copy/Paste selection dialog mutually exclusive', async () => {
    await mountHistory();
    headerHistoryMenu(); historyMenuAction('Clear all history');
    key(window, 'c', { altKey: true });
    expect(host.querySelectorAll('dialog')).toHaveLength(1);
    act(() => dialogButton('Cancel').click());
    menuAction('Copy selected settings…');
    expect(host.querySelectorAll('dialog')).toHaveLength(1);
    expect(host.querySelector<HTMLButtonElement>('.history-menu-trigger')!.disabled).toBe(true);
    key(document.activeElement!, 'Escape', { ctrlKey: false });
    expect(host.querySelector('dialog')).toBeNull();
    headerHistoryMenu();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
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
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
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
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
    const history = host.querySelector('.edit-history li:not(.initial-state)')!;
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
    expect(host.querySelector('.edit-history li:not(.initial-state)')!.textContent).toBe(`${first.filename}からペースト`);
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

  it.each(['input[type="number"]', 'input[type="search"]', 'textarea', '[contenteditable="true"]', '[role="textbox"]'])
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
      expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
    });

  it('allows Ctrl+V from an unrelated range input now that paste does not require a slider target', async () => {
    const recipe = defaultRecipe(); recipe.adjustments.tint = 10;
    rows.set(first.id, stored(first.id, recipe));
    copyEditSettings(defaultRecipe(), 'other', 'other.jpg');
    await mount(); activatePreview();
    const range = document.createElement('input'); range.type = 'range'; range.tabIndex = 0; host.append(range); range.focus();
    expect(key(range, 'c').defaultPrevented).toBe(false);
    expect(key(range, 'v').defaultPrevented).toBe(true);
    expect(rendered.recipe!.adjustments.tint).toBe(0);
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
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
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
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
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
  });
});

describe('single-slider clipboard', () => {
  it.each(['no focus after switch', 'non-input button focus'] as const)(
    'replaces a multi-item copy, pastes by source adjustment with %s, and supports Undo/Redo and save', async (focusMode) => {
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
    const pasteTarget = focusMode === 'no focus after switch'
      ? document.body
      : host.querySelector<HTMLButtonElement>('.workspace-actions button')!;
    if (focusMode === 'no focus after switch') expect(document.activeElement).toBe(document.body);
    if (focusMode === 'non-input button focus') act(() => pasteTarget.focus());
    expect(key(pasteTarget, 'v').defaultPrevented).toBe(true);
    expect(rendered.recipe!.adjustments.exposure).toBe(1.25);
    expect(rendered.recipe!.adjustments.tint).toBe(35);
    expect(rendered.recipe!.basicEnabled).toBe(false);
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
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
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
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
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
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
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
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
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
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
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
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
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
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
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
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
    expect(host.querySelector<HTMLButtonElement>('.history-menu-trigger')!.disabled).toBe(true);
    headerHistoryMenu();
    expect(document.querySelector('.history-organization-menu')).toBeNull();
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('.edit-settings-menu-actions button')).every((button) => button.disabled)).toBe(true);
    expect(key(viewport, 'c', { altKey: true }).defaultPrevented).toBe(false);
    expect(key(viewport, 'v', { altKey: true }).defaultPrevented).toBe(false);
    expect(host.querySelector('dialog')).toBeNull();
    await act(async () => finish());
  });
});
