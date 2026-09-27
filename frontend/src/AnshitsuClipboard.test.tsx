// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AssetDetail, WorkspaceNavigationState } from './assets';
import { GRADING_RANGE_CONTROLS, ADJUSTMENT_IDS, defaultRecipe, editSession, newSession, type EditRecipe } from './editing';
import * as editStateModule from './editState';
import { createEditStateSnapshot, type EditStateSnapshot } from './editState';
import i18n from './i18n';
import { copyEditSettings, readEditClipboard } from './editClipboard';
import { ADJUSTMENT_SELECTION_CATEGORIES } from './adjustmentSelection';

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
function categoryTitle(id: string) {
  return host.querySelector<HTMLButtonElement>(`.adjustment-category-title[data-adjustment-category-id="${id}"]`)!;
}
function openCategoryContextMenu(id: string, x = 120, y = 90) {
  const title = categoryTitle(id);
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y });
  act(() => title.dispatchEvent(event));
  return event;
}
function categoryMenuAction(text: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.adjustment-category-context-menu button'))
    .find((item) => item.textContent === text)!;
  act(() => button.click());
  return button;
}
function openViewerContextMenu() {
  const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 90 });
  act(() => viewport.dispatchEvent(event));
  return event;
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
function rowHistoryMenu(cursor: number, keyboard = false, x = 100, y = 100) {
  const trigger = host.querySelector<HTMLButtonElement>(`.edit-history li[value="${cursor}"] button`)!;
  act(() => {
    trigger.focus();
    if (keyboard) trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    else trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
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
    expect(document.querySelector('.history-organization-menu')?.classList.contains('workspace-menu-surface')).toBe(true);
    expect([...document.querySelectorAll('.history-organization-menu button')].every((button) => button.classList.contains('workspace-menu-item'))).toBe(true);
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

  it('fits the measured menu width at the viewport edge for header and row menus', async () => {
    await mountHistory();
    const oldWidth = window.innerWidth; const oldHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('history-organization-menu')) return new DOMRect(0, 0, 220, 150);
      if (this.classList.contains('history-menu-trigger')) return new DOMRect(970, 760, 30, 20);
      return originalRect.call(this);
    });
    try {
      headerHistoryMenu();
      let menu = document.querySelector<HTMLElement>('.history-organization-menu')!;
      expect(menu.style.left).toBe('772px');
      expect(menu.style.top).toBe('642px');
      key(document.activeElement!, 'Escape', { ctrlKey: false });
      rowHistoryMenu(1, false, 970, 780);
      menu = document.querySelector<HTMLElement>('.history-organization-menu')!;
      expect(menu.style.left).toBe('772px');
      expect(menu.style.top).toBe('642px');
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: oldWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: oldHeight });
    }
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
    menuAction('Copy selected settings');
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

  it.each(['copy', 'paste'] as const)('keeps %s dialog focus consistent across shortcuts, right clicks and toolbar actions', async (mode) => {
    await mount();
    copyEditSettings(defaultRecipe(), 'source', 'source.jpg', ['temperature']);
    const label = mode === 'copy' ? 'Copy' : 'Paste';
    const actionLabel = `${label} selected settings`;
    const viewport = activatePreview();
    key(viewport, mode === 'copy' ? 'c' : 'v', { altKey: true });
    const assertInitialFocus = () => {
      const confirm = dialogButton(label);
      expect(document.activeElement).toBe(confirm);
      expect(confirm.classList.contains('selection-confirm-button')).toBe(true);
      expect(confirm.disabled).toBe(false);
      expect(key(confirm, 'Enter', { ctrlKey: false }).defaultPrevented).toBe(false);
      // jsdom does not perform native button activation for Enter.
      act(() => confirm.click());
    };
    assertInitialFocus();
    expect(document.activeElement).toBe(viewport);
    openViewerContextMenu();
    let menu = document.querySelector<HTMLElement>('.edit-settings-context-menu')!;
    expect(menu.dataset.focusMode).toBe('pointer');
    const other = menu.querySelectorAll<HTMLButtonElement>('button')[1];
    act(() => other.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })));
    expect(menu.dataset.focusMode).toBe('pointer');
    key(document.activeElement!, 'Escape', { ctrlKey: false });
    expect(document.activeElement).toBe(viewport);
    const trigger = menuAction(actionLabel);
    assertInitialFocus();
    expect(document.activeElement).toBe(trigger);
    openViewerContextMenu();
    menu = document.querySelector<HTMLElement>('.edit-settings-context-menu')!;
    const action = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === actionLabel)!;
    act(() => action.click());
    expect(document.querySelector('.edit-settings-context-menu')).toBeNull();
    assertInitialFocus();
    expect(document.activeElement).toBe(viewport);
  });

  it('provides all four toolbar actions without photo focus and restores focus to its visible trigger', async () => {
    await mount();
    const trigger = menuAction('Copy selected settings');
    expect(host.querySelector('dialog')).not.toBeNull();
    choose(['exposure']); confirm('Copy');
    expect(document.activeElement).toBe(trigger);
    expect(Object.keys(readEditClipboard()!.values)).toEqual(['exposure']);
    menuAction('Copy all settings');
    expect(Object.keys(readEditClipboard()!.values)).toHaveLength(16);
    const source = defaultRecipe(); source.adjustments.exposure = 2; source.adjustments.tint = 10;
    copyEditSettings(source, 'other', 'other.jpg', ['tint', 'exposure']);
    menuAction('Paste selected settings'); choose(['tint']);
    act(() => dialogButton('Cancel').click());
    expect(document.activeElement).toBe(trigger);
    expect(rendered.recipe!.adjustments.tint).toBe(0);
    menuAction('Paste copied settings');
    expect(rendered.recipe!.adjustments.exposure).toBe(2);
    expect(rendered.recipe!.adjustments.tint).toBe(10);
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
  });

  it('opens the existing selected-copy dialog from the Viewer context menu', async () => {
    await mount();
    expect(openViewerContextMenu().defaultPrevented).toBe(true);
    const action = Array.from(document.querySelectorAll<HTMLButtonElement>('.edit-settings-context-menu button'))
      .find((button) => button.textContent === 'Copy selected settings')!;
    act(() => action.click());
    expect(document.querySelector('.edit-settings-context-menu')).toBeNull();
    expect(host.querySelector('dialog')).not.toBeNull();
    expect(host.querySelector('dialog input[name="exposure"]')).not.toBeNull();
  });

  it.each(ADJUSTMENT_SELECTION_CATEGORIES)('copies exactly the $id category ids, including stored values when it is OFF', async (category) => {
    const recipe = defaultRecipe();
    ADJUSTMENT_IDS.forEach((id, index) => { recipe.adjustments[id] = index + 1; });
    if (category.id === 'basic') recipe.basicEnabled = false;
    if (category.id === 'whiteBalance') recipe.whiteBalanceEnabled = false;
    if (category.id === 'color') recipe.colorEnabled = false;
    if (category.id === 'colorGrading') recipe.colorGradingEnabled = false;
    rows.set(first.id, stored(first.id, recipe));
    await mount();
    const title = categoryTitle(category.id);
    const expanded = title.getAttribute('aria-expanded');
    expect(openCategoryContextMenu(category.id).defaultPrevented).toBe(true);
    expect(document.querySelector('.adjustment-category-context-menu')).not.toBeNull();
    expect(title.getAttribute('aria-expanded')).toBe(expanded);
    expect(host.querySelector('dialog')).toBeNull();
    categoryMenuAction('Copy category settings');
    const copied = readEditClipboard()!;
    expect(Object.keys(copied.values)).toEqual([...category.ids]);
    expect(copied.values[category.ids[0]]).toBe(recipe.adjustments[category.ids[0]]);
    expect(Object.keys(copied.values).some((id) => id.endsWith('Enabled'))).toBe(false);
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
  });

  it('toggles and resets a category from its menu without changing the expansion, one History entry per action', async () => {
    const recipe = defaultRecipe(); recipe.adjustments.exposure = 2;
    rows.set(first.id, stored(first.id, recipe));
    await mount();
    const title = categoryTitle('basic');
    expect(title.getAttribute('aria-expanded')).toBe('true');
    openCategoryContextMenu('basic');
    expect(Array.from(document.querySelectorAll('.adjustment-category-context-menu [role="menuitem"]'), (item) => item.textContent))
      .toEqual(['Copy category settings', 'Paste into category', 'Disable Basic', 'Reset category']);
    categoryMenuAction('Disable Basic');
    expect(rendered.recipe!.basicEnabled).toBe(false);
    expect(title.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
    openCategoryContextMenu('basic');
    expect(Array.from(document.querySelectorAll('.adjustment-category-context-menu [role="menuitem"]'))
      .find((item) => item.textContent === 'Enable Basic')).not.toBeUndefined();
    categoryMenuAction('Reset category');
    expect(rendered.recipe!.adjustments.exposure).toBe(0);
    expect(rendered.recipe!.basicEnabled).toBe(false);
    expect(title.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(2);
    expect(document.activeElement).toBe(title);
  });

  it('localizes category menu actions in Japanese', async () => {
    await act(async () => { await i18n.changeLanguage('ja'); });
    const categoryLabels = [
      ['workspace.enableWhiteBalance', 'workspace.disableWhiteBalance', '色温度補正を有効にする', '色温度補正を無効にする'],
      ['workspace.enableBasic', 'workspace.disableBasic', '基本補正を有効にする', '基本補正を無効にする'],
      ['workspace.enableColor', 'workspace.disableColor', '色補正を有効にする', '色補正を無効にする'],
      ['workspace.enableColorGrading', 'workspace.disableColorGrading', 'カラーグレーディングを有効にする', 'カラーグレーディングを無効にする'],
    ];
    for (const [enableKey, disableKey, enableText, disableText] of categoryLabels) {
      expect(i18n.t(enableKey)).toBe(enableText);
      expect(i18n.t(disableKey)).toBe(disableText);
    }
    await mount();
    openCategoryContextMenu('basic');
    expect(Array.from(document.querySelectorAll('.adjustment-category-context-menu [role="menuitem"]'), (item) => item.textContent))
      .toEqual(['カテゴリの設定をコピー', 'カテゴリに設定を貼り付け', '基本補正を無効にする', 'カテゴリをリセット']);
    await act(async () => { await i18n.changeLanguage('en'); });
    expect(i18n.t('workspace.enableWhiteBalance')).toBe('Enable White Balance');
    expect(i18n.t('workspace.disableWhiteBalance')).toBe('Disable White Balance');
    expect(i18n.t('workspace.enableBasic')).toBe('Enable Basic');
    expect(i18n.t('workspace.disableBasic')).toBe('Disable Basic');
    expect(i18n.t('workspace.enableColor')).toBe('Enable Color');
    expect(i18n.t('workspace.disableColor')).toBe('Disable Color');
    expect(i18n.t('workspace.enableColorGrading')).toBe('Enable Color Grading');
    expect(i18n.t('workspace.disableColorGrading')).toBe('Disable Color Grading');
  });

  it('pastes only the clipboard/category intersection as one undoable entry and leaves the clipboard intact', async () => {
    const source = defaultRecipe(); source.adjustments.vibrance = 44; source.adjustments.saturation = 23; source.adjustments.exposure = 2.5;
    copyEditSettings(source, 'source', 'source.jpg', ['vibrance', 'saturation', 'exposure']);
    const destination = defaultRecipe(); destination.colorEnabled = false;
    rows.set(first.id, stored(first.id, destination));
    const copied = readEditClipboard();
    await mount();
    openCategoryContextMenu('color');
    const paste = Array.from(document.querySelectorAll<HTMLButtonElement>('.adjustment-category-context-menu button'))
      .find((button) => button.textContent === 'Paste into category')!;
    expect(paste.disabled).toBe(false);
    categoryMenuAction('Paste into category');
    expect(rendered.recipe!.adjustments.vibrance).toBe(44);
    expect(rendered.recipe!.adjustments.saturation).toBe(23);
    expect(rendered.recipe!.adjustments.exposure).toBe(0);
    expect(rendered.recipe!.colorEnabled).toBe(false);
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
    expect(readEditClipboard()).toEqual(copied);
    key(window, 'z'); expect(rendered.recipe!.adjustments.vibrance).toBe(0);
    key(window, 'y'); expect(rendered.recipe!.adjustments.vibrance).toBe(44);
    await click('.workspace-actions button');
    expect(rows.get(first.id)!.state.history).toHaveLength(1);
    expect(rows.get(first.id)!.state.history[0]).toMatchObject({ kind: 'paste', metadata: {
      sourceAssetId: 'source', sourceFilename: 'source.jpg', adjustmentIds: ['vibrance', 'saturation'],
    } });
  });

  it('clamps the category menu at viewport edges, restores focus on Escape, and closes outside', async () => {
    await mount();
    const oldWidth = window.innerWidth; const oldHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('adjustment-category-context-menu')) return new DOMRect(0, 0, 220, 150);
      return originalRect.call(this);
    });
    try {
      const title = categoryTitle('basic');
      openCategoryContextMenu('basic', 970, 780);
      let menu = document.querySelector<HTMLElement>('.adjustment-category-context-menu')!;
      expect(menu.style.left).toBe('772px');
      expect(menu.style.top).toBe('642px');
      key(document.activeElement!, 'Escape', { ctrlKey: false });
      expect(document.querySelector('.adjustment-category-context-menu')).toBeNull();
      expect(document.activeElement).toBe(title);
      openCategoryContextMenu('basic', 200, 200);
      menu = document.querySelector<HTMLElement>('.adjustment-category-context-menu')!;
      expect(menu.style.left).toBe('200px');
      expect(menu.style.top).toBe('200px');
      act(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
      expect(document.querySelector('.adjustment-category-context-menu')).toBeNull();
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: oldWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: oldHeight });
    }
  });

  it('keeps the category, Viewer, and History menus exclusive', async () => {
    await mount();
    openCategoryContextMenu('basic');
    expect(document.querySelector('.adjustment-category-context-menu')).not.toBeNull();
    headerHistoryMenu();
    expect(document.querySelector('.adjustment-category-context-menu')).toBeNull();
    expect(document.querySelector('.history-organization-menu')).not.toBeNull();
    openCategoryContextMenu('color');
    expect(document.querySelector('.history-organization-menu')).toBeNull();
    expect(document.querySelector('.adjustment-category-context-menu')).not.toBeNull();
    act(() => host.querySelector<HTMLElement>('.viewer-viewport')!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 })));
    openViewerContextMenu();
    expect(document.querySelector('.adjustment-category-context-menu')).toBeNull();
    expect(document.querySelector('.history-organization-menu')).toBeNull();
    expect(document.querySelector('.edit-settings-context-menu')).not.toBeNull();
  });

  it('disables category Paste when the clipboard has no matching ids and keeps Ctrl+C/V scope rules', async () => {
    const recipe = defaultRecipe(); recipe.adjustments.temperature = 17; recipe.adjustments.exposure = 2; recipe.adjustments.vibrance = 31;
    rows.set(first.id, stored(first.id, recipe));
    copyEditSettings(defaultRecipe(), 'source', 'source.jpg', ['exposure']);
    await mount();
    openCategoryContextMenu('color');
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>('.adjustment-category-context-menu button'))
      .find((button) => button.textContent === 'Paste into category')!.disabled).toBe(true);
    key(document.activeElement!, 'Escape', { ctrlKey: false });

    const title = categoryTitle('whiteBalance');
    act(() => title.focus());
    expect(key(title, 'c').defaultPrevented).toBe(true);
    expect(Object.keys(readEditClipboard()!.values)).toEqual(['temperature', 'tint']);
    expect(readEditClipboard()!.values.temperature).toBe(17);
    const crossCategoryClipboard = defaultRecipe();
    crossCategoryClipboard.adjustments.exposure = 4;
    crossCategoryClipboard.adjustments.vibrance = 60;
    copyEditSettings(crossCategoryClipboard, 'source', 'source.jpg', ['exposure', 'vibrance']);
    const colorTitle = categoryTitle('color'); act(() => colorTitle.focus());
    expect(key(colorTitle, 'v').defaultPrevented).toBe(true);
    expect(rendered.recipe!.adjustments.exposure).toBe(4);
    expect(rendered.recipe!.adjustments.vibrance).toBe(60);
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


describe('individual adjustment UI', () => {
  function row(id: string) { return host.querySelector<HTMLInputElement>('[data-adjustment-id="' + id + '"]')!.closest('.adjustment-control')!; }
  function open(id: string, selector = 'label', x = 120, y = 90) {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y });
    act(() => row(id).querySelector(selector)!.dispatchEvent(event));
    return event;
  }
  function buttons() { return Array.from(document.querySelectorAll<HTMLButtonElement>('.adjustment-slider-context-menu button')); }
  it.each(ADJUSTMENT_IDS)('connects %s power and menu to the same retained value and Undo/Redo', async (id) => {
    const recipe = defaultRecipe(); recipe.adjustments[id] = id === 'exposure' ? 2 : 20;
    rows.set(first.id, stored(first.id, recipe)); await mount();
    expect(host.querySelectorAll('.adjustment-power')).toHaveLength(16);
    const power = row(id).querySelector<HTMLButtonElement>('.adjustment-power')!;
    expect(power.getAttribute('aria-pressed')).toBe('true');
    act(() => power.click());
    expect(rendered.recipe!.adjustmentEnabled[id]).toBe(false);
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
    expect(rendered.recipe!.adjustments[id]).toBe(recipe.adjustments[id]);
    expect(row(id).classList.contains('is-bypassed')).toBe(true);
    expect(row(id).querySelector<HTMLInputElement>('input[type="range"]')!.disabled).toBe(false);
    key(window, 'z'); expect(rendered.recipe!.adjustmentEnabled[id]).toBe(true);
    key(window, 'z', { shiftKey: true }); expect(rendered.recipe!.adjustmentEnabled[id]).toBe(false);
    expect(open(id).defaultPrevented).toBe(true);
    expect(buttons().map(item => item.textContent)).toEqual(['Copy this adjustment', 'Paste into this adjustment', 'Enable this adjustment', 'Reset this adjustment']);
    act(() => buttons()[2].click());
    expect(rendered.recipe!.adjustmentEnabled[id]).toBe(true);
    expect(rendered.recipe!.adjustments).toEqual(recipe.adjustments);
    expect(rendered.recipe!.adjustmentEnabled).toEqual(recipe.adjustmentEnabled);
  });

  it.each(['filmstrip', 'home'])('closes the slider menu on %s transition', async (transition) => {
    await mount(); open('exposure');
    await click(transition === 'home' ? '.workspace-actions button' : 'button[aria-label="destination.jpg"]');
    expect(buttons()).toHaveLength(0);
  });
  it.each(['en', 'ja'])('uses shared menu style and translated actions in %s', async (language) => {
    await i18n.changeLanguage(language); await mount(); open('exposure');
    const menu = document.querySelector('.adjustment-slider-context-menu')!;
    expect(menu.classList.contains('workspace-menu-surface')).toBe(true);
    expect(Array.from(menu.children).map(item => item.getAttribute('role'))).toEqual(['menuitem', 'menuitem', 'separator', 'menuitem', 'menuitem']);
    expect(buttons().map(item => item.textContent)).toEqual(language === 'ja'
      ? ['この項目をコピー', 'この項目に貼り付け', 'この項目を無効にする', 'この項目をリセット']
      : ['Copy this adjustment', 'Paste into this adjustment', 'Disable this adjustment', 'Reset this adjustment']);
    expect(row('exposure').querySelector('.adjustment-power')!.getAttribute('title')).toBe(i18n.t('workspace.disableAdjustment', { name: i18n.t('workspace.exposure') }));
  });
  it('keeps category and grading range bypass independent and resets values without enabling them', async () => {
    const recipe = defaultRecipe(); recipe.basicEnabled = false; recipe.gradingShadowsEnabled = false;
    recipe.adjustments.shadowsTemperature = 30; recipe.adjustmentEnabled.shadowsTemperature = false;
    rows.set(first.id, stored(first.id, recipe)); await mount();
    const power = row('exposure').querySelector<HTMLButtonElement>('.adjustment-power')!;
    expect(power.disabled).toBe(false); act(() => power.click());
    expect(rendered.recipe!.basicEnabled).toBe(false); expect(rendered.recipe!.adjustmentEnabled.exposure).toBe(false);
    act(() => power.focus()); key(power, 'ArrowUp', { ctrlKey: false, shiftKey: true });
    expect(document.activeElement).toBe(categoryTitle('basic'));
    act(() => power.focus()); key(power, 'ArrowDown', { ctrlKey: false, shiftKey: true });
    expect(document.activeElement).toBe(categoryTitle('color'));
    open('shadowsTemperature'); act(() => buttons()[3].click());
    expect(rendered.recipe!.adjustments.shadowsTemperature).toBe(0);
    expect(rendered.recipe!.adjustmentEnabled.shadowsTemperature).toBe(false);
    expect(rendered.recipe!.gradingShadowsEnabled).toBe(false);
    key(window, 'z'); expect(rendered.recipe!.adjustments.shadowsTemperature).toBe(30);
    open('shadowsTemperature'); key(document.activeElement!, 'Escape', { ctrlKey: false });
    expect(document.activeElement).toBe(row('shadowsTemperature').querySelector('.adjustment-power'));
  });
  it('clamps to the viewport, relocates, excludes background keys and closes on outside interaction', async () => {
    await mount();
    const original = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('adjustment-slider-context-menu')
        ? { width: 210, height: 130, left: 0, top: 0, right: 210, bottom: 130, x: 0, y: 0, toJSON() {} }
        : original.call(this);
    });
    try {
      open('exposure', 'input[type="range"]', window.innerWidth, window.innerHeight);
      const menu = document.querySelector<HTMLElement>('.adjustment-slider-context-menu')!;
      expect(menu.style.left).toBe((window.innerWidth - 218) + 'px');
      expect(menu.style.top).toBe((window.innerHeight - 138) + 'px');
      const before = structuredClone(rendered.recipe);
      key(document.activeElement!, 'ArrowRight', { ctrlKey: false }); key(document.activeElement!, 'v');
      expect(rendered.recipe).toEqual(before);
      open('contrast', 'label', 30, 40);
      expect(document.querySelector<HTMLElement>('.adjustment-slider-context-menu')!.style.left).toBe('30px');
      act(() => categoryTitle('basic').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 })));
      expect(buttons()).toHaveLength(0); openCategoryContextMenu('basic');
      expect(document.querySelectorAll('.adjustment-context-menu')).toHaveLength(1);
      open('exposure'); expect(document.querySelector('.adjustment-category-context-menu')).toBeNull();
      act(() => host.querySelector('.viewer-viewport')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 })));
      openViewerContextMenu(); expect(buttons()).toHaveLength(0);
      expect(document.querySelector('.edit-settings-context-menu')).not.toBeNull();
    } finally { rect.mockRestore(); }
  });
  it('preserves native number context menus and closes with Escape restoring focus', async () => {
    await mount();
    expect(open('exposure', '.adjustment-number').defaultPrevented).toBe(false);
    expect(buttons()).toHaveLength(0);
    open('exposure');
    expect(document.querySelector('.adjustment-slider-context-menu [role="separator"]')).not.toBeNull();
    key(document.activeElement!, 'Escape', { ctrlKey: false });
    expect(buttons()).toHaveLength(0);
    expect(document.activeElement).toBe(row('exposure').querySelector('input[type="range"]'));
  });
  it('copies retained OFF values, pastes only a matching ID and preserves all power states', async () => {
    const recipe = defaultRecipe(); recipe.adjustments.exposure = 2; recipe.adjustmentEnabled.exposure = false;
    rows.set(first.id, stored(first.id, recipe)); await mount();
    open('exposure'); act(() => buttons()[0].click());
    expect(readEditClipboard()!.values).toEqual({ exposure: 2 });
    open('contrast'); expect(buttons()[1].disabled).toBe(true);
    key(document.activeElement!, 'Escape', { ctrlKey: false });
    const copied = defaultRecipe(); copied.adjustments.exposure = 3; copied.adjustments.contrast = 25;
    copyEditSettings(copied, first.id, first.filename, ['exposure', 'contrast']);
    open('exposure'); expect(buttons()[1].disabled).toBe(false); act(() => buttons()[1].click());
    expect(rendered.recipe!.adjustments.exposure).toBe(3);
    expect(rendered.recipe!.adjustments.contrast).toBe(0);
    expect(rendered.recipe!.adjustmentEnabled.exposure).toBe(false);
    expect(readEditClipboard()!.values).toEqual({ exposure: 3, contrast: 25 });
    key(window, 'z'); expect(rendered.recipe!.adjustments.exposure).toBe(2);
    key(window, 'z', { shiftKey: true }); expect(rendered.recipe!.adjustments.exposure).toBe(3);
    act(() => row('exposure').querySelector<HTMLButtonElement>('.adjustment-power')!.focus());
    key(document.activeElement!, 'v'); expect(rendered.recipe!.adjustments.contrast).toBe(25);
    expect(rendered.recipe!.adjustmentEnabled.exposure).toBe(false);
  });
});


describe('3WAY range actions', () => {
  function title(id: string) { return host.querySelector<HTMLButtonElement>('[data-grading-range-id="' + id + '"]')!; }
  function open(id: string, x = 120, y = 90) {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y });
    act(() => title(id).dispatchEvent(event)); return event;
  }
  function buttons() { return Array.from(document.querySelectorAll<HTMLButtonElement>('.grading-range-context-menu button')); }
  it.each(GRADING_RANGE_CONTROLS)('copies $id OFF values and pastes an intersection as one operation without changing flags', async range => {
    const recipe = defaultRecipe(); recipe[range.enabled] = false;
    for (const id of range.ids) { recipe.adjustments[id] = 20; recipe.adjustmentEnabled[id] = false; }
    rows.set(first.id, stored(first.id, recipe)); await mount();
    act(() => title(range.id).focus());
    expect(key(title(range.id), 'c').defaultPrevented).toBe(true);
    expect(readEditClipboard()!.values).toEqual(Object.fromEntries(range.ids.map(id => [id, 20])));
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
    expect(open(range.id).defaultPrevented).toBe(true); act(() => buttons()[0].click());
    expect(Object.keys(readEditClipboard()!.values)).toEqual(range.ids);
    const copy = defaultRecipe(); copy.adjustments[range.ids[0]] = 30; copy.adjustments.exposure = 3;
    copyEditSettings(copy, 'source', 'source.jpg', [range.ids[0], 'exposure']);
    open(range.id); expect(buttons()[1].disabled).toBe(false); act(() => buttons()[1].click());
    const expected = structuredClone(recipe); expected.adjustments[range.ids[0]] = 30;
    expect(rendered.recipe).toEqual(expected);
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
    expect(readEditClipboard()!.values).toEqual({ [range.ids[0]]: 30, exposure: 3 });
    key(window, 'z'); expect(rendered.recipe).toEqual(recipe);
    key(window, 'z', { shiftKey: true }); expect(rendered.recipe).toEqual(expected);
    act(() => title(range.id).focus()); key(title(range.id), 'v');
    expect(rendered.recipe!.adjustments.exposure).toBe(3);
    expect(rendered.recipe!.adjustmentEnabled).toEqual(recipe.adjustmentEnabled);
    const other = GRADING_RANGE_CONTROLS.find(item => item.id !== range.id)!;
    open(other.id); expect(buttons()[1].disabled).toBe(true);
  });
  it.each(GRADING_RANGE_CONTROLS)('resets $id from button and menu with one History entry and keeps all enabled flags', async range => {
    const recipe = defaultRecipe(); recipe.colorGradingEnabled = false; recipe[range.enabled] = false;
    for (const group of GRADING_RANGE_CONTROLS) for (const id of group.ids) recipe.adjustments[id] = 20;
    recipe.adjustmentEnabled[range.ids[0]] = false; rows.set(first.id, stored(first.id, recipe)); await mount();
    const row = title(range.id).closest('.grading-range-header')!;
    const reset = row.querySelector<HTMLButtonElement>('.grading-range-reset')!;
    expect(reset.disabled).toBe(false); act(() => reset.click());
    expect(reset.textContent).toBe('↺');
    expect(reset.classList.contains('grading-range-reset')).toBe(true);
    expect(reset.getAttribute('aria-label')).toBe(i18n.t('workspace.resetGradingRange', { name: i18n.t(range.label) }));
    const expected = structuredClone(recipe); for (const id of range.ids) expected.adjustments[id] = 0;
    expect(rendered.recipe).toEqual(expected);
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
    expect(reset.disabled).toBe(true); key(window, 'z'); expect(rendered.recipe).toEqual(recipe);
    open(range.id); act(() => buttons()[3].click()); expect(rendered.recipe).toEqual(expected);
    expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(1);
    key(window, 'z'); expect(rendered.recipe).toEqual(recipe); key(window, 'y'); expect(rendered.recipe).toEqual(expected);
  });
  it.each(['en', 'ja'])('renders translated range actions, native toggles and non-collapsing headings in %s', async lang => {
    await i18n.changeLanguage(lang); await mount();
    for (const range of GRADING_RANGE_CONTROLS) {
      const name = i18n.t(range.label); const heading = title(range.id);
      const header = heading.closest('.grading-range-header')!;
      const power = header.querySelector<HTMLButtonElement>('.grading-range-toggle')!;
      expect(power.getAttribute('aria-label')).toBe(i18n.t('workspace.disableAdjustment', { name }));
      act(() => heading.click()); expect(host.querySelectorAll('.adjustment-range')).toHaveLength(16);
      open(range.id); expect(buttons().map(item => item.textContent)).toEqual([
        i18n.t('workspace.copyGradingRange', { name }), i18n.t('workspace.pasteGradingRange', { name }),
        i18n.t('workspace.disableAdjustment', { name }), i18n.t('workspace.resetGradingRange', { name })]);
      expect(document.querySelector('.grading-range-context-menu [role="separator"]')).not.toBeNull();
      act(() => buttons()[2].click()); expect(rendered.recipe![range.enabled]).toBe(false);
      open(range.id); expect(buttons()[2].textContent).toBe(i18n.t('workspace.enableAdjustment', { name }));
      key(document.activeElement!, 'Escape', { ctrlKey: false }); expect(document.activeElement).toBe(heading);
      for (const value of ['Enter', ' ']) {
        act(() => power.focus()); expect(key(power, value, { ctrlKey: false }).defaultPrevented).toBe(false);
        const beforeCount = host.querySelectorAll('.edit-history li:not(.initial-state)').length;
        act(() => power.click());
        expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(beforeCount + 1);
      }
    }
  });
  it('navigates headers horizontally and vertically, skipping disabled Reset without changing values', async () => {
    await mount();
    const heading = title('shadows'); const header = heading.closest('.grading-range-header')!;
    const power = header.querySelector<HTMLButtonElement>('.grading-range-toggle')!;
    const reset = header.querySelector<HTMLButtonElement>('.grading-range-reset')!;
    const range = host.querySelector<HTMLInputElement>('[data-adjustment-id="shadowsTemperature"]')!;
    const before = structuredClone(rendered.recipe);
    act(() => heading.focus()); key(heading, 'ArrowRight', { shiftKey: true, ctrlKey: false }); expect(document.activeElement).toBe(power);
    key(power, 'ArrowRight', { shiftKey: true, ctrlKey: false }); expect(document.activeElement).toBe(power); expect(reset.disabled).toBe(true);
    key(power, 'ArrowDown', { shiftKey: true, ctrlKey: false }); expect(document.activeElement).toBe(range);
    key(range, 'ArrowUp', { shiftKey: true, ctrlKey: false }); expect(document.activeElement).toBe(heading);
    expect(rendered.recipe).toEqual(before); expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
    const copy = defaultRecipe(); copy.adjustments.shadowsTemperature = 30; copyEditSettings(copy, 'a', 'a.jpg', ['shadowsTemperature']);
    key(heading, 'v'); act(() => heading.focus()); key(heading, 'ArrowRight', { shiftKey: true, ctrlKey: false });
    key(power, 'ArrowRight', { shiftKey: true, ctrlKey: false }); expect(document.activeElement).toBe(reset);
    key(reset, 'ArrowLeft', { shiftKey: true, ctrlKey: false }); expect(document.activeElement).toBe(power);
    key(power, 'ArrowLeft', { shiftKey: true, ctrlKey: false }); expect(document.activeElement).toBe(heading);
    act(() => reset.focus()); key(reset, 'ArrowUp', { shiftKey: true, ctrlKey: false }); expect(document.activeElement).toBe(categoryTitle('colorGrading'));
    act(() => reset.focus()); key(reset, 'ArrowDown', { shiftKey: true, ctrlKey: false }); expect(document.activeElement).toBe(range);
  });

  it('keeps range, category, slider, History and Viewer menus exclusive and clamps/repositions range menus', async () => {
    await mount();
    const original = HTMLElement.prototype.getBoundingClientRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('grading-range-context-menu')
        ? { x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 130, width: 200, height: 130, toJSON() {} }
        : original.call(this);
    });
    try {
      open('shadows', window.innerWidth, window.innerHeight);
      let menu = document.querySelector<HTMLElement>('.grading-range-context-menu')!;
      expect(menu.style.left).toBe((window.innerWidth - 208) + 'px'); expect(menu.style.top).toBe((window.innerHeight - 138) + 'px');
      open('midtones', 35, 45); menu = document.querySelector<HTMLElement>('.grading-range-context-menu')!;
      expect(menu.style.left).toBe('35px'); expect(menu.style.top).toBe('45px');
      openCategoryContextMenu('basic'); expect(buttons()).toHaveLength(0);
      open('shadows'); expect(document.querySelector('.adjustment-category-context-menu')).toBeNull();
      const row = host.querySelector('[data-adjustment-id="exposure"]')!.closest('.adjustment-control')!;
      act(() => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })));
      expect(buttons()).toHaveLength(0); expect(document.querySelector('.adjustment-slider-context-menu')).not.toBeNull();
      open('shadows'); expect(document.querySelector('.adjustment-slider-context-menu')).toBeNull();
      headerHistoryMenu(); expect(buttons()).toHaveLength(0); expect(document.querySelector('.history-organization-menu')).not.toBeNull();
      open('shadows'); expect(document.querySelector('.history-organization-menu')).toBeNull();
      act(() => host.querySelector('.viewer-viewport')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 })));
      openViewerContextMenu(); expect(buttons()).toHaveLength(0); expect(document.querySelector('.edit-settings-context-menu')).not.toBeNull();
      act(() => title('shadows').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2 })));
      open('shadows'); expect(document.querySelector('.edit-settings-context-menu')).toBeNull();
      act(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
      expect(buttons()).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
  it('reveals only an out-of-view range title in the adjustment list and keeps horizontal movement from scrolling', async () => {
    await mount();
    const scroll = host.querySelector<HTMLElement>('.develop-scroll-region')!;
    const heading = title('midtones');
    const prior = host.querySelector<HTMLInputElement>('[data-adjustment-id="shadowsTint"]')!;
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 100 });
    scroll.style.overflowY = 'auto';
    const bounds = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100, x: 0, y: top, width: 100, height: bottom - top, toJSON() {} });
    const a = vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(bounds(100, 200));
    const b = vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue(bounds(240, 265));
    try {
      act(() => prior.focus()); key(prior, 'ArrowDown', { ctrlKey: false, shiftKey: true });
      expect(document.activeElement).toBe(heading); expect(scroll.scrollTop).toBe(65);
      b.mockReturnValue(bounds(120, 145));
      act(() => prior.focus()); key(prior, 'ArrowDown', { ctrlKey: false, shiftKey: true }); expect(scroll.scrollTop).toBe(65);
      b.mockReturnValue(bounds(50, 75));
      key(heading, 'ArrowRight', { ctrlKey: false, shiftKey: true }); expect(scroll.scrollTop).toBe(65);
      expect(document.documentElement.scrollTop).toBe(0);
      expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
    } finally { a.mockRestore(); b.mockRestore(); }
  });
  it.each(['filmstrip', 'home'])('closes range menu on %s transition', async transition => {
    await mount(); open('shadows');
    await click(transition === 'home' ? '.workspace-actions button' : 'button[aria-label="destination.jpg"]');
    expect(buttons()).toHaveLength(0);
  });
});


describe('focus entry into the selected operation panel', () => {
  function slider(id = 'temperature') { return host.querySelector<HTMLInputElement>('[data-adjustment-id="' + id + '"]')!; }
  function enter(target: HTMLElement, direction = 'ArrowDown', modifiers: KeyboardEventInit = {}) {
    act(() => target.focus()); return key(target, direction, { ctrlKey: false, shiftKey: true, ...modifiers });
  }
  it.each(['ArrowUp', 'ArrowDown'])('enters the first slider from Viewer with %s without changing edits', async direction => {
    await mount(); const before = structuredClone(rendered.recipe); const viewport = activatePreview();
    expect(enter(viewport, direction).defaultPrevented).toBe(true); expect(document.activeElement).toBe(slider());
    expect(rendered.recipe).toEqual(before); expect(host.querySelectorAll('.edit-history li:not(.initial-state)')).toHaveLength(0);
  });
  it.each(['.history-menu-trigger', '.filmstrip button', '.workspace-actions button', '.exif-toggle'])('enters from %s', async selector => {
    await mount(); const target = host.querySelector<HTMLElement>(selector)!;
    expect(enter(target).defaultPrevented).toBe(true); expect(document.activeElement).toBe(slider());
  });
  it('restores actual slider focus rather than hover and preserves the existing row navigation', async () => {
    await mount(); const remembered = slider('shadowsTint');
    act(() => remembered.focus());
    act(() => slider('contrast').dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: 30, clientY: 40 })));
    const viewport = activatePreview(); enter(viewport);
    expect(document.activeElement).toBe(remembered);
    key(remembered, 'ArrowDown', { ctrlKey: false, shiftKey: true });
    expect(document.activeElement).toBe(host.querySelector('[data-grading-range-id="midtones"]'));
    key(document.activeElement!, 'ArrowDown', { ctrlKey: false, shiftKey: true }); expect(document.activeElement).toBe(slider('midtonesTemperature'));
    key(document.activeElement!, 'ArrowRight', { ctrlKey: false, shiftKey: true }); expect(document.activeElement).toBe(slider('midtonesTemperature').closest('.adjustment-control')!.querySelector('.adjustment-number'));
  });
  it('falls back from a collapsed or disabled remembered slider without expanding its category', async () => {
    await mount(); act(() => slider('exposure').focus()); const basic = categoryTitle('basic'); act(() => basic.click());
    enter(activatePreview()); expect(document.activeElement).toBe(slider()); expect(basic.getAttribute('aria-expanded')).toBe('false');
    act(() => basic.click()); act(() => slider('exposure').focus());
    act(() => basic.closest('.adjustment-category-header')!.querySelector<HTMLButtonElement>('[data-category-switch]')!.click());
    enter(activatePreview()); expect(document.activeElement).toBe(slider());
  });
  it('does not open a hidden panel or handle a shortcut when no usable slider exists', async () => {
    await mount(); act(() => slider('exposure').focus());
    await click('.panel-toggle.right'); const viewport = activatePreview();
    expect(enter(viewport).defaultPrevented).toBe(false); expect(document.activeElement).toBe(viewport);
    expect(host.querySelector<HTMLElement>('.right-panel')!.hidden).toBe(true);
    await click('.panel-toggle.right');
    for (const title of host.querySelectorAll<HTMLButtonElement>('.adjustment-category-title')) act(() => title.click());
    expect(enter(viewport).defaultPrevented).toBe(false); expect(document.activeElement).toBe(viewport);
  });
  it.each([{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { shiftKey: false }])('ignores excluded keys %j', async modifiers => {
    await mount(); const viewport = activatePreview(); enter(viewport, 'ArrowDown', modifiers); expect(document.activeElement).toBe(viewport);
  });
  it('leaves native editing and already handled events alone', async () => {
    await mount();
    for (const tag of ['input', 'textarea', 'div']) {
      const target = document.createElement(tag); if (tag === 'div') target.setAttribute('contenteditable', 'true');
      host.querySelector('.workspace-page')!.append(target); enter(target); expect(document.activeElement).toBe(target); target.remove();
    }
    const viewport = activatePreview(); const cancel = (event: Event) => event.preventDefault(); viewport.addEventListener('keydown', cancel);
    enter(viewport); expect(document.activeElement).toBe(viewport); viewport.removeEventListener('keydown', cancel);
  });
  it('blocks entry while a menu or dialog is open even with a hovered slider', async () => {
    await mount(); const viewport = activatePreview();
    act(() => slider().dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    openCategoryContextMenu('basic');
    key(viewport, 'ArrowDown', { ctrlKey: false, shiftKey: true }); expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
    key(document.activeElement!, 'Escape', { ctrlKey: false });
    openViewerContextMenu(); key(viewport, 'ArrowDown', { ctrlKey: false, shiftKey: true }); expect(document.activeElement).not.toBe(slider());
    key(document.activeElement!, 'Escape', { ctrlKey: false });
    const menu = host.querySelector<HTMLDetailsElement>('.edit-settings-menu')!; menu.open = true;
    expect(enter(viewport).defaultPrevented).toBe(false); expect(document.activeElement).toBe(viewport); menu.open = false;
    const dialog = document.createElement('dialog'); dialog.setAttribute('open', ''); host.append(dialog);
    expect(enter(viewport).defaultPrevented).toBe(false); expect(document.activeElement).toBe(viewport); dialog.remove();
  });

  it('reveals the restored slider minimally and keeps stationary pointer events from stealing focus', async () => {
    await mount(); const target = slider('contrast'); act(() => target.focus()); const viewport = activatePreview();
    const scroll = host.querySelector<HTMLElement>('.develop-scroll-region')!;
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 100 }); scroll.style.overflowY = 'auto';
    const bounds = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100, x: 0, y: top, width: 100, height: bottom - top, toJSON() {} });
    const a = vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(bounds(100, 200));
    const b = vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(bounds(250, 278));
    try {
      enter(viewport); expect(document.activeElement).toBe(target); expect(scroll.scrollTop).toBe(78);
      b.mockReturnValue(bounds(110, 138)); enter(viewport); expect(scroll.scrollTop).toBe(78);
      b.mockReturnValue(bounds(80, 108)); enter(viewport); expect(scroll.scrollTop).toBe(58);
      const other = slider('exposure');
      act(() => other.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: 10, clientY: 20 })));
      act(() => other.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 20 })));
      expect(document.activeElement).toBe(target); key(target, 'ArrowRight', { ctrlKey: false });
      expect(rendered.recipe!.adjustments.contrast).toBe(1); expect(rendered.recipe!.adjustments.exposure).toBe(0);
      act(() => other.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 20, clientY: 20 })));
      key(other, 'ArrowRight', { ctrlKey: false }); expect(rendered.recipe!.adjustments.exposure).toBe(0.01);
      expect(document.documentElement.scrollTop).toBe(0);
    } finally { a.mockRestore(); b.mockRestore(); }
  });
  it.each(['filmstrip', 'home'])('does not enter during %s save', async transition => {
    await mount(); const viewport = activatePreview();
    const copied = defaultRecipe(); copied.adjustments.exposure = 2; copyEditSettings(copied, 'source', 'source.jpg', ['exposure']); key(viewport, 'v');
    let resolveSave!: (value: ReturnType<typeof stored>) => void;
    api.put.mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; }));
    await click(transition === 'home' ? '.workspace-actions button' : 'button[aria-label="destination.jpg"]');
    enter(viewport); expect(document.activeElement).toBe(viewport);
    await act(async () => resolveSave(stored(first.id, rendered.recipe!)));
  });
  it('keeps the remembered ID through photo changes and allows Filmstrip arrows', async () => {
    await mount(); act(() => slider('contrast').focus()); const firstThumb = host.querySelector<HTMLButtonElement>('.filmstrip button')!;
    act(() => firstThumb.focus()); key(firstThumb, 'ArrowRight', { ctrlKey: false });
    await act(async () => {});
    expect(host.querySelector('.workspace-asset-title')!.textContent).toContain(second.filename);
    const viewport = activatePreview(); enter(viewport); expect(document.activeElement).toBe(slider('contrast'));
  });
});


describe('Filmstrip hover versus slider arrow priority', () => {
  it('switches the photo from a hovered gap without changing a still focused slider value', async () => {
    await mount();
    const range = host.querySelector<HTMLInputElement>('[data-adjustment-id="exposure"]')!;
    act(() => range.focus()); key(range, 'ArrowRight', { ctrlKey: false });
    const filmstrip = host.querySelector<HTMLElement>('.filmstrip-scroll')!;
    const move = new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 20 });
    Object.defineProperty(move, 'movementX', { value: 8 }); act(() => filmstrip.dispatchEvent(move));
    expect(document.activeElement).toBe(range);
    const before = range.value;
    expect(before).toBe('0.01');
    const event = key(range, 'ArrowRight', { ctrlKey: false });
    expect(event.defaultPrevented).toBe(true); expect(range.value).toBe(before);
    await act(async () => {});
    expect(host.querySelector('.workspace-asset-title')!.textContent).toContain(second.filename);
    expect(rows.get(first.id)?.state.currentRecipe.adjustments.exposure).toBe(0.01);
    key(window, 'ArrowLeft', { ctrlKey: false }); await act(async () => {});
    expect(host.querySelector('.workspace-asset-title')!.textContent).toContain(first.filename);
    expect(host.querySelector<HTMLInputElement>('[data-adjustment-id="exposure"]')!.value).toBe(before);
  });
});
