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
import { copyEditSettings } from './editClipboard';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), detail: vi.fn() }));
vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(), fetchAssetDetail: api.detail }));
vi.mock('./editStateApi', async (original) => ({
  ...await original<typeof import('./editStateApi')>(), getAssetEditState: api.get, putAssetEditState: api.put,
}));
const rendered = vi.hoisted(() => ({ recipe: undefined as EditRecipe | undefined }));
vi.mock('./AdjustedImage', () => ({ AdjustedImage: ({ recipe }: { recipe: EditRecipe }) => {
  rendered.recipe = recipe;
  return <canvas data-testid="preview" />;
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
  const preview = host.querySelector('[data-testid="preview"]')!;
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
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('workspace full-settings clipboard', () => {
  it('does nothing before the first copy and requires actual preview focus', async () => {
    await mount();
    const viewport = host.querySelector('.viewer-viewport')!;
    // No focused photo: even events aimed at the image itself are not photo shortcuts.
    expect(key(host.querySelector('[data-testid="preview"]')!, 'c').defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(viewport);
    expect(key(viewport, 'c').defaultPrevented).toBe(false);
    expect(key(activatePreview(), 'v').defaultPrevented).toBe(false);
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
    { isComposing: true }, { repeat: true }, { altKey: true }, { metaKey: true },
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
