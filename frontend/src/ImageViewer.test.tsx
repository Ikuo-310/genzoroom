// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnshitsuPage } from './AnshitsuPage';
import { ImageViewer } from './ImageViewer';
import { defaultRecipe } from './editing';
import { collectHistogram, type HistogramChangeHandler } from './histogram';
import i18n from './i18n';

vi.mock('./editStateApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('./editStateApi')>(),
  getAssetEditState: vi.fn(async () => ({ state: null })),
}));

const mockImage = vi.hoisted(() => ({
  onLoad: undefined as undefined | ((width: number, height: number) => void),
  recipe: undefined as unknown,
  onHistogramChange: undefined as HistogramChangeHandler | undefined,
  renders: 0,
}));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, fetchAssetDetail: vi.fn(async (id: string) => ({
    id, filename: `${id}.jpg`, date: '2026-09-01T10:00:00', thumbnail_url: `/${id}/thumbnail`,
    preview_url: `/${id}/preview`, format: 'JPEG', is_raw: false, exif: {},
  })) };
});
vi.mock('./AdjustedImage', () => ({
  AdjustedImage: ({ showBeforeAdjustments, onLoad, recipe, onHistogramChange }: { showBeforeAdjustments: boolean; onLoad: (width: number, height: number) => void; recipe: unknown; onHistogramChange?: HistogramChangeHandler }) => {
    mockImage.onLoad = onLoad;
    mockImage.recipe = recipe;
    mockImage.onHistogramChange = onHistogramChange;
    mockImage.renders++;
    return <div data-testid="adjusted-image" data-before={String(showBeforeAdjustments)} />;
  },
}));

let host: HTMLDivElement;
let root: Root;

function Harness({ src = '/first' }: { src?: string }) {
  const [persistentBeforeAdjustments, setPersistentBeforeAdjustments] = useState(false);
  return <ImageViewer key={src} src={src} alt="photo" leftOpen rightOpen
    editSource={{ kind: 'immich-preview', url: src }} recipe={defaultRecipe()}
    persistentBeforeAdjustments={persistentBeforeAdjustments}
    onBeforeAdjustmentsChange={setPersistentBeforeAdjustments}
    onToggleLeft={vi.fn()} onToggleRight={vi.fn()} />;
}

function key(type: 'keydown' | 'keyup', target: EventTarget = window, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent(type, { key: '\\', code: 'Backslash', bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event));
  return event;
}

function comparisonToggle() { return host.querySelector<HTMLButtonElement>('.before-after-controls')!; }
function image() { return host.querySelector<HTMLElement>('[data-testid="adjusted-image"]')!; }
function click(button: HTMLButtonElement) { act(() => button.click()); }
function contextMenu(target: Element, x = 120, y = 90) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y });
  act(() => target.dispatchEvent(event));
  return event;
}

const contextActions = {
  copy: vi.fn(() => true), paste: vi.fn(() => true), selectCopy: vi.fn(() => true), selectPaste: vi.fn(() => true),
};

function ContextMenuHarness({ src = '/first', disabled = false, hasClipboard = true, keyboardBlocked = false }: { src?: string; disabled?: boolean; hasClipboard?: boolean; keyboardBlocked?: boolean }) {
  return <ImageViewer src={src} alt="photo" leftOpen rightOpen editSource={{ kind: 'immich-preview', url: src }}
    recipe={defaultRecipe()} editClipboardDisabled={disabled} hasEditClipboard={hasClipboard}
    keyboardBlocked={keyboardBlocked}
    onCopyAdjustments={contextActions.copy} onPasteAdjustments={contextActions.paste}
    onSelectCopyAdjustments={contextActions.selectCopy} onSelectPasteAdjustments={contextActions.selectPaste}
    onToggleLeft={vi.fn()} onToggleRight={vi.fn()} />;
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en');
  Object.values(contextActions).forEach((action) => action.mockClear());
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Viewer edit settings context menu', () => {
  it('forwards histogram snapshots unchanged through ImageViewer', () => {
    const receive = vi.fn();
    act(() => root.render(<ImageViewer src="/first" editSource={{ kind: 'immich-preview', url: '/first' }}
      recipe={defaultRecipe()} alt="photo" leftOpen rightOpen onHistogramChange={receive}
      onToggleLeft={vi.fn()} onToggleRight={vi.fn()} />));
    const snapshot = { sourceKey: 'immich-preview:/first', before: collectHistogram(new Uint8ClampedArray(4)), after: null };
    act(() => mockImage.onHistogramChange?.(snapshot));
    expect(receive).toHaveBeenCalledWith(snapshot);
    expect(receive.mock.calls[0][0]).toBe(snapshot);
  });

  it('stores current photo histograms in AnshitsuPage and rejects a previous photo callback', async () => {
    const selectedAssets = ['first', 'second'].map((id) => ({
      id, filename: `${id}.jpg`, date: '2026-09-01T10:00:00', thumbnail_url: `/${id}/thumbnail`,
      format: 'JPEG', is_raw: false,
    }));
    act(() => root.render(<MemoryRouter initialEntries={[{
      pathname: '/anshitsu/first', state: { selectedAssets, activeAssetId: 'first' },
    }]}><Routes><Route path="/anshitsu/:assetId" element={<AnshitsuPage />} /></Routes></MemoryRouter>));
    await act(async () => {});
    const firstCallback = mockImage.onHistogramChange!;
    const firstSnapshot = { sourceKey: 'immich-preview:/first/preview', before: collectHistogram(new Uint8ClampedArray(4)), after: null };
    const firstRenders = mockImage.renders;
    act(() => firstCallback(firstSnapshot));
    expect(mockImage.renders).toBeGreaterThan(firstRenders);
    click(host.querySelector<HTMLButtonElement>('.filmstrip-item[aria-label="second.jpg"]')!);
    await act(async () => {});
    const secondRenders = mockImage.renders;
    act(() => firstCallback(firstSnapshot));
    act(() => mockImage.onHistogramChange?.(firstSnapshot));
    expect(mockImage.renders).toBe(secondRenders);
    act(() => mockImage.onHistogramChange?.({ ...firstSnapshot, sourceKey: 'immich-preview:/second/preview' }));
    expect(mockImage.renders).toBeGreaterThan(secondRenders);
  });

  it('uses pointer styling on every mouse open, keyboard styling on Tab, and hover styling after mouse movement', () => {
    act(() => root.render(<ContextMenuHarness />));
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    act(() => viewport.focus());
    key('keydown', viewport, { key: 'F10', code: 'F10', shiftKey: true });
    let menu = document.querySelector<HTMLElement>('.edit-settings-context-menu')!;
    expect(menu.dataset.focusMode).toBe('keyboard');
    key('keydown', document.activeElement!, { key: 'Escape', code: 'Escape' });
    contextMenu(viewport);
    menu = document.querySelector<HTMLElement>('.edit-settings-context-menu')!;
    const first = menu.querySelector<HTMLButtonElement>('button')!;
    expect(document.activeElement).toBe(first);
    expect(menu.dataset.focusMode).toBe('pointer');
    key('keydown', first, { key: 'Tab', code: 'Tab' });
    expect(menu.dataset.focusMode).toBe('keyboard');
    const other = menu.querySelectorAll('button')[1];
    act(() => other.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })));
    expect(menu.dataset.focusMode).toBe('pointer');
    contextMenu(viewport, 200, 200);
    expect(menu.dataset.focusMode).toBe('pointer');
  });

  it('uses the same explicit input mode for toolbar actions', () => {
    act(() => root.render(<ContextMenuHarness />));
    const trigger = host.querySelector<HTMLElement>('.edit-settings-menu summary')!;
    const list = host.querySelector<HTMLElement>('.edit-settings-menu-actions')!;
    act(() => { trigger.focus(); trigger.click(); });
    expect(list.dataset.focusMode).toBe('pointer');
    expect(key('keydown', trigger, { key: 'Tab', code: 'Tab' }).defaultPrevented).toBe(false);
    const first = list.querySelector<HTMLButtonElement>('button')!;
    act(() => first.focus());
    expect(list.dataset.focusMode).toBe('keyboard');
    act(() => first.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })));
    expect(list.dataset.focusMode).toBe('pointer');
    for (const value of ['Enter', ' ']) {
      expect(key('keydown', first, { key: value, code: value === 'Enter' ? 'Enter' : 'Space' }).defaultPrevented).toBe(false);
      expect(list.dataset.focusMode).toBe('keyboard');
    }
    // jsdom does not synthesize button activation from Enter/Space.
    click(first);
    expect(contextActions.copy).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLDetailsElement>('.edit-settings-menu')!.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    act(() => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      trigger.click();
    });
    expect(list.dataset.focusMode).toBe('pointer');
  });
  it('opens over both the image and viewport whitespace and reuses all toolbar actions', () => {
    act(() => root.render(<ContextMenuHarness />));
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    expect(contextMenu(image()).defaultPrevented).toBe(true);
    let menu = document.body.querySelector<HTMLElement>('.edit-settings-context-menu')!;
    expect(menu).not.toBeNull();
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]'), (item) => item.textContent)).toEqual([
      'Copy all settings', 'Copy selected settings', 'Paste copied settings', 'Paste selected settings',
    ]);
    click(menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!);
    expect(contextActions.copy).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('.edit-settings-context-menu')).toBeNull();

    expect(contextMenu(viewport, 210, 130).defaultPrevented).toBe(true);
    menu = document.body.querySelector<HTMLElement>('.edit-settings-context-menu')!;
    click(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]);
    expect(contextActions.selectCopy).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('.edit-settings-context-menu')).toBeNull();

    contextMenu(viewport, 300, 170);
    menu = document.body.querySelector<HTMLElement>('.edit-settings-context-menu')!;
    click(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[2]);
    expect(contextActions.paste).toHaveBeenCalledTimes(1);
    contextMenu(viewport, 340, 200);
    menu = document.body.querySelector<HTMLElement>('.edit-settings-context-menu')!;
    click(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[3]);
    expect(contextActions.selectPaste).toHaveBeenCalledTimes(1);
  });

  it('shares disabled rules with the toolbar menu', () => {
    act(() => root.render(<ContextMenuHarness disabled hasClipboard={false} />));
    contextMenu(host.querySelector<HTMLElement>('.viewer-viewport')!);
    const contextItems = [...document.body.querySelectorAll<HTMLButtonElement>('.edit-settings-context-menu [role="menuitem"]')];
    const toolbarItems = [...host.querySelectorAll<HTMLButtonElement>('.edit-settings-menu-actions button')];
    expect([...document.body.querySelectorAll('.edit-settings-context-menu [role="separator"]')]).toHaveLength(1);
    expect([...host.querySelectorAll('.edit-settings-menu-actions [role="separator"]')]).toHaveLength(1);
    expect(document.body.querySelector('.edit-settings-context-menu')?.classList.contains('workspace-menu-surface')).toBe(true);
    expect(host.querySelector('.edit-settings-menu-actions')?.classList.contains('workspace-menu-surface')).toBe(true);
    expect(toolbarItems.map((item) => item.textContent)).toEqual(contextItems.map((item) => item.textContent));
    expect(contextItems.every((item) => item.classList.contains('edit-settings-menu-item'))).toBe(true);
    expect(toolbarItems.every((item) => item.classList.contains('edit-settings-menu-item'))).toBe(true);
    expect(contextItems.every((item) => item.classList.contains('workspace-menu-item'))).toBe(true);
    expect(toolbarItems.every((item) => item.classList.contains('workspace-menu-item'))).toBe(true);
    expect(contextItems.map((item) => item.disabled)).toEqual([true, true, true, true]);
    expect(toolbarItems.map((item) => item.disabled)).toEqual([true, true, true, true]);
    act(() => root.render(<ContextMenuHarness hasClipboard={false} />));
    contextMenu(host.querySelector<HTMLElement>('.viewer-viewport')!);
    const pasteItems = [...document.body.querySelectorAll<HTMLButtonElement>('.edit-settings-context-menu [role="menuitem"]')];
    expect(pasteItems.map((item) => item.disabled)).toEqual([false, false, true, true]);
  });

  it('closes on outside click and Escape, restores preview focus for Escape, and replaces an open toolbar menu', () => {
    act(() => root.render(<ContextMenuHarness />));
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    const trigger = host.querySelector<HTMLElement>('.edit-settings-menu summary')!;
    act(() => trigger.click());
    expect(host.querySelector<HTMLDetailsElement>('.edit-settings-menu')!.open).toBe(true);
    contextMenu(viewport, 100, 100);
    expect(host.querySelector<HTMLDetailsElement>('.edit-settings-menu')!.open).toBe(false);
    expect(document.body.querySelector('.edit-settings-context-menu')).not.toBeNull();
    expect(document.activeElement).toBe(document.body.querySelector('.edit-settings-context-menu button'));
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => document.activeElement?.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(document.body.querySelector('.edit-settings-context-menu')).toBeNull();
    expect(document.activeElement).toBe(viewport);
    contextMenu(viewport);
    act(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(document.body.querySelector('.edit-settings-context-menu')).toBeNull();
  });

  it('clamps repeated right clicks to the viewport and closes when the photo changes', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    act(() => root.render(<ContextMenuHarness />));
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    contextMenu(viewport, 100, 100);
    const menu = document.body.querySelector<HTMLElement>('.edit-settings-context-menu')!;
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue({ width: 260, height: 170 } as DOMRect);
    contextMenu(viewport, 970, 780);
    expect(menu.style.left).toBe('732px');
    expect(menu.style.top).toBe('622px');
    act(() => root.render(<ContextMenuHarness src="/second" />));
    expect(document.body.querySelector('.edit-settings-context-menu')).toBeNull();
  });

  it('does not replace native context menus on toolbar controls or outside the preview', () => {
    act(() => root.render(<ContextMenuHarness />));
    const trigger = host.querySelector<HTMLElement>('.edit-settings-menu summary')!;
    expect(contextMenu(trigger).defaultPrevented).toBe(false);
    expect(document.body.querySelector('.edit-settings-context-menu')).toBeNull();
    const outside = document.createElement('div'); document.body.append(outside);
    expect(contextMenu(outside).defaultPrevented).toBe(false);
    expect(document.body.querySelector('.edit-settings-context-menu')).toBeNull();
    outside.remove();
  });

  it('leaves the native menu available while a blocking dialog or operation is active', () => {
    act(() => root.render(<ContextMenuHarness keyboardBlocked />));
    expect(contextMenu(host.querySelector<HTMLElement>('.viewer-viewport')!).defaultPrevented).toBe(false);
    expect(document.body.querySelector('.edit-settings-context-menu')).toBeNull();
  });

  it('keeps viewer shortcuts from reaching global handlers while context menu items are focused', () => {
    act(() => root.render(<ContextMenuHarness />));
    contextMenu(host.querySelector<HTMLElement>('.viewer-viewport')!);
    const item = document.body.querySelector<HTMLButtonElement>('.edit-settings-context-menu button')!;
    const global = vi.fn(); window.addEventListener('keydown', global);
    const shortcut = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => item.dispatchEvent(shortcut));
    window.removeEventListener('keydown', global);
    expect(global).not.toHaveBeenCalled();
    expect(contextActions.copy).not.toHaveBeenCalled();
  });
});

describe('Before / After viewer state', () => {
  it('keeps toolbar group order, panel actions, editing menu and all zoom buttons', () => {
    const left = vi.fn(); const right = vi.fn();
    const clipboardActions = [vi.fn(() => true), vi.fn(() => true), vi.fn(() => true), vi.fn(() => true)];
    act(() => root.render(<ImageViewer src="/first" alt="photo" leftOpen rightOpen
      editSource={{ kind: 'immich-preview', url: '/first' }} recipe={defaultRecipe()}
      onToggleLeft={left} onToggleRight={right} editClipboardDisabled={false} hasEditClipboard
      onCopyAdjustments={clipboardActions[0]} onPasteAdjustments={clipboardActions[1]}
      onSelectCopyAdjustments={clipboardActions[2]} onSelectPasteAdjustments={clipboardActions[3]} />));
    const toolbar = host.querySelector('.viewer-toolbar')!;
    expect(Array.from(toolbar.children, (item) => item.className)).toEqual([
      'tool-button panel-toggle', 'zoom-controls', 'viewer-toolbar-right',
    ]);
    const rightGroup = host.querySelector('.viewer-toolbar-right')!;
    expect(Array.from(rightGroup.children, (item) => item.className)).toEqual([
      'edit-settings-menu', 'tool-button before-after-controls', 'tool-button panel-toggle right',
    ]);
    click(toolbar.querySelector<HTMLButtonElement>(':scope > .panel-toggle')!);
    click(rightGroup.querySelector<HTMLButtonElement>('.panel-toggle')!);
    expect(left).toHaveBeenCalledTimes(1); expect(right).toHaveBeenCalledTimes(1);
    const menu = host.querySelector<HTMLDetailsElement>('.edit-settings-menu')!;
    expect(menu.querySelector('summary')?.getAttribute('aria-label')).toBeTruthy();
    const menuButtons = menu.querySelectorAll<HTMLButtonElement>('button');
    for (const index of [0, 2, 1, 3]) click(menuButtons[index]);
    for (const action of clipboardActions) expect(action).toHaveBeenCalledTimes(1);

    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    Object.defineProperty(viewport, 'clientWidth', { value: 400 });
    Object.defineProperty(viewport, 'clientHeight', { value: 300 });
    act(() => mockImage.onLoad?.(800, 600));
    const controls = host.querySelector('.zoom-controls')!;
    const buttons = controls.querySelectorAll<HTMLButtonElement>('button');
    expect(Array.from(controls.children, (item) => item.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON', 'OUTPUT', 'BUTTON']);
    expect(controls.querySelector('output')?.textContent).toBe('50%');
    click(buttons[1]); expect(controls.querySelector('output')?.textContent).toBe('100%');
    click(buttons[3]); expect(controls.querySelector('output')?.textContent).toBe('125%');
    click(buttons[2]); expect(controls.querySelector('output')?.textContent).toBe('100%');
    click(buttons[0]); expect(controls.querySelector('output')?.textContent).toBe('50%');
  });

  it.each([0, 1])('reverses the permanent choice on every click of segment %s', (index) => {
    act(() => root.render(<Harness />));
    const toggle = comparisonToggle();
    const side = toggle.querySelectorAll('span')[index];
    expect(toggle.getAttribute('aria-description')).toBe('After');
    for (const expected of [true, false, true, false]) {
      act(() => side.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(image().dataset.before).toBe(String(expected));
      expect(toggle.getAttribute('aria-pressed')).toBe(String(expected));
      expect(toggle.getAttribute('aria-description')).toBe(expected ? 'Before' : 'After');
      expect(toggle.querySelector('span.active')?.textContent).toBe(expected ? 'Before' : 'After');
    }
    expect(mockImage.recipe).toEqual(defaultRecipe());
  });

  it.each(['Enter', ' '])('uses one native %s activation and one Tab stop for comparison', (value) => {
    act(() => root.render(<Harness />));
    const toggle = comparisonToggle();
    expect(toggle.tagName).toBe('BUTTON');
    expect(host.querySelectorAll('button.before-after-controls')).toHaveLength(1);
    expect(toggle.querySelectorAll('button, input, a, [tabindex]')).toHaveLength(0);
    expect(toggle.getAttribute('aria-label')).toBeTruthy();
    act(() => toggle.focus());
    expect(key('keydown', toggle, { key: 'Tab', code: 'Tab' }).defaultPrevented).toBe(false);
    expect(key('keydown', toggle, { key: value, code: value === 'Enter' ? 'Enter' : 'Space' }).defaultPrevented).toBe(false);
    expect(image().dataset.before).toBe('false');
    // jsdom does not synthesize the native button click following Enter/Space.
    key('keyup', toggle, { key: value, code: value === 'Enter' ? 'Enter' : 'Space' });
    click(toggle);
    expect(image().dataset.before).toBe('true');
    expect(document.activeElement).toBe(toggle);
  });

  it('keeps the actual Before indication while held and restores changes made to the permanent choice', () => {
    act(() => root.render(<Harness />));
    key('keydown');
    click(comparisonToggle());
    expect(image().dataset.before).toBe('true');
    expect(comparisonToggle().querySelector('.active')?.textContent).toBe('Before');
    key('keyup');
    expect(image().dataset.before).toBe('true');
    key('keydown');
    click(comparisonToggle());
    expect(image().dataset.before).toBe('true');
    expect(comparisonToggle().getAttribute('aria-description')).toBe('Before');
    key('keyup');
    expect(image().dataset.before).toBe('false');
    expect(comparisonToggle().querySelector('.active')?.textContent).toBe('After');
  });

  it('defaults to After and toggles persistent Before without editing the recipe', () => {
    act(() => root.render(<Harness />));
    expect(comparisonToggle().getAttribute('aria-pressed')).toBe('false');
    expect(image().dataset.before).toBe('false');
    click(comparisonToggle());
    expect(comparisonToggle().getAttribute('aria-pressed')).toBe('true');
    expect(image().dataset.before).toBe('true');
    click(comparisonToggle());
    expect(image().dataset.before).toBe('false');
  });

  it('shows Before only while Backslash is held, then returns to the persistent choice', () => {
    act(() => root.render(<Harness />));
    expect(key('keydown', window, { key: '/', code: 'Slash' }).defaultPrevented).toBe(false);
    expect(image().dataset.before).toBe('false');
    expect(key('keydown', window, { key: '¥' }).defaultPrevented).toBe(true);
    expect(key('keydown').defaultPrevented).toBe(true);
    expect(image().dataset.before).toBe('true');
    expect(key('keydown', window, { repeat: true }).defaultPrevented).toBe(true);
    key('keyup');
    expect(image().dataset.before).toBe('false');
    click(comparisonToggle());
    key('keydown');
    key('keyup');
    expect(image().dataset.before).toBe('true');
    expect(comparisonToggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('leaves native fields and IME alone, and clears a held Backslash on blur and visibility loss', () => {
    act(() => root.render(<Harness />));
    const textInput = document.createElement('input');
    textInput.type = 'text';
    const numberInput = document.createElement('input');
    numberInput.type = 'number';
    const fields = [textInput, numberInput, document.createElement('textarea'), document.createElement('select'), document.createElement('div')];
    fields[4].setAttribute('contenteditable', 'true');
    fields.forEach((field) => document.body.append(field));
    for (const field of fields) {
      expect(key('keydown', field).defaultPrevented).toBe(false);
      expect(image().dataset.before).toBe('false');
    }
    expect(key('keydown', window, { isComposing: true }).defaultPrevented).toBe(false);
    key('keydown');
    act(() => window.dispatchEvent(new Event('blur')));
    expect(image().dataset.before).toBe('false');
    key('keydown');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(image().dataset.before).toBe('false');
    Reflect.deleteProperty(document, 'hidden');
    fields.forEach((field) => field.remove());
  });

  it('allows Before comparison with a focused range slider and preserves focus and value', () => {
    act(() => root.render(<Harness />));
    const range = document.createElement('input');
    range.type = 'range';
    range.value = '37';
    range.classList.add('focus-visible');
    document.body.append(range);
    range.focus();
    expect(document.activeElement).toBe(range);
    expect(key('keydown', range).defaultPrevented).toBe(true);
    expect(image().dataset.before).toBe('true');
    expect(range.value).toBe('37');
    expect(document.activeElement).toBe(range);
    key('keyup', range);
    expect(image().dataset.before).toBe('false');
    expect(range.value).toBe('37');
    expect(document.activeElement).toBe(range);
    click(comparisonToggle());
    range.focus();
    key('keydown', range);
    key('keyup', range);
    expect(image().dataset.before).toBe('true');
    expect(comparisonToggle().getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(range);
    range.remove();
  });

  it('preserves zoom and pan while comparing', () => {
    act(() => root.render(<Harness />));
    act(() => mockImage.onLoad?.(400, 300));
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) });
    act(() => viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 300, clientY: 150 })));
    const zoom = host.querySelector('.zoom-controls output')!.textContent;
    const pan = host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform;
    expect(zoom).not.toBe('100%');
    expect(pan).not.toBe('translate(calc(-50% + 0px), calc(-50% + 0px))');
    click(comparisonToggle());
    key('keydown');
    key('keyup');
    click(comparisonToggle());
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe(zoom);
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe(pan);
  });

  it('focuses the photo while starting a captured pan and preserves comparison and zoom', () => {
    act(() => root.render(<Harness />));
    act(() => mockImage.onLoad?.(400, 300));
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    const position = host.querySelector<HTMLElement>('.viewer-image-position')!;
    const capture = vi.fn();
    Object.defineProperty(viewport, 'setPointerCapture', { value: capture });
    act(() => viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 })));
    const zoom = host.querySelector('.zoom-controls output')!.textContent;
    const before = position.style.transform;
    function pointer(type: string, target: EventTarget, x: number) {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 20 });
      Object.defineProperty(event, 'pointerId', { value: 7 });
      act(() => target.dispatchEvent(event));
    }
    pointer('pointerdown', image(), 10);
    expect(document.activeElement).toBe(viewport);
    expect(capture).toHaveBeenCalledWith(7);
    pointer('pointermove', viewport, 60);
    expect(position.style.transform).not.toBe(before);
    const pan = position.style.transform;
    key('keydown', viewport);
    expect(image().dataset.before).toBe('true');
    key('keyup', viewport);
    pointer('pointerup', viewport, 60);
    pointer('pointermove', viewport, 100);
    expect(position.style.transform).toBe(pan);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe(zoom);
  });

  it('keeps the persistent choice across a keyed asset switch and does not retain the old image', () => {
    act(() => root.render(<Harness />));
    click(comparisonToggle());
    act(() => root.render(<Harness src="/second" />));
    expect(image().dataset.before).toBe('true');
    expect(comparisonToggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps Before selected across a Filmstrip switch without changing recipe or History', async () => {
    const selectedAssets = ['first', 'second'].map((id) => ({
      id, filename: `${id}.jpg`, date: '2026-09-01T10:00:00', thumbnail_url: `/${id}/thumbnail`,
      format: 'JPEG', is_raw: false,
    }));
    act(() => root.render(<MemoryRouter initialEntries={[{
      pathname: '/anshitsu/first', state: { selectedAssets, activeAssetId: 'first' },
    }]}><Routes><Route path="/anshitsu/:assetId" element={<AnshitsuPage />} /></Routes></MemoryRouter>));
    await act(async () => {});
    click(comparisonToggle());
    expect(mockImage.recipe).toEqual(defaultRecipe());
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
    expect(host.querySelector<HTMLButtonElement>('.edit-actions button')!.disabled).toBe(true);
    click(host.querySelector<HTMLButtonElement>('.filmstrip-item[aria-label="second.jpg"]')!);
    await act(async () => {});
    expect(comparisonToggle().getAttribute('aria-pressed')).toBe('true');
    expect(image().dataset.before).toBe('true');
    expect(mockImage.recipe).toEqual(defaultRecipe());
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
    click(comparisonToggle());
    const sliders = host.querySelectorAll<HTMLInputElement>('input[type="range"]');
    const firstSlider = sliders[0];
    const focusedSlider = sliders[1];
    act(() => firstSlider.focus());
    key('keydown', firstSlider, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true });
    expect(document.activeElement).toBe(focusedSlider);
    focusedSlider.classList.add('focus-visible');
    const value = focusedSlider.value;
    expect(key('keydown', focusedSlider).defaultPrevented).toBe(true);
    expect(image().dataset.before).toBe('true');
    expect(focusedSlider.value).toBe(value);
    key('keyup', focusedSlider);
    expect(image().dataset.before).toBe('false');
    expect(document.activeElement).toBe(focusedSlider);
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
  });
});
