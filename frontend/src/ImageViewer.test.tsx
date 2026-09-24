// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnshitsuPage } from './AnshitsuPage';
import { ImageViewer } from './ImageViewer';
import { defaultRecipe } from './editing';
import i18n from './i18n';

const mockImage = vi.hoisted(() => ({
  onLoad: undefined as undefined | ((width: number, height: number) => void),
  recipe: undefined as unknown,
}));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, fetchAssetDetail: vi.fn(async (id: string) => ({
    id, filename: `${id}.jpg`, date: '2026-09-01T10:00:00', thumbnail_url: `/${id}/thumbnail`,
    preview_url: `/${id}/preview`, format: 'JPEG', is_raw: false, exif: {},
  })) };
});
vi.mock('./AdjustedImage', () => ({
  AdjustedImage: ({ showBeforeAdjustments, onLoad, recipe }: { showBeforeAdjustments: boolean; onLoad: (width: number, height: number) => void; recipe: unknown }) => {
    mockImage.onLoad = onLoad;
    mockImage.recipe = recipe;
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

function beforeButton() { return host.querySelector<HTMLButtonElement>('.before-after-controls button:first-child')!; }
function afterButton() { return host.querySelector<HTMLButtonElement>('.before-after-controls button:last-child')!; }
function image() { return host.querySelector<HTMLElement>('[data-testid="adjusted-image"]')!; }
function click(button: HTMLButtonElement) { act(() => button.click()); }

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await i18n.changeLanguage('en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Before / After viewer state', () => {
  it('defaults to After and toggles persistent Before without editing the recipe', () => {
    act(() => root.render(<Harness />));
    expect(afterButton().getAttribute('aria-pressed')).toBe('true');
    expect(image().dataset.before).toBe('false');
    click(beforeButton());
    expect(beforeButton().getAttribute('aria-pressed')).toBe('true');
    expect(image().dataset.before).toBe('true');
    click(afterButton());
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
    click(beforeButton());
    key('keydown');
    key('keyup');
    expect(image().dataset.before).toBe('true');
    expect(beforeButton().getAttribute('aria-pressed')).toBe('true');
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
    click(beforeButton());
    range.focus();
    key('keydown', range);
    key('keyup', range);
    expect(image().dataset.before).toBe('true');
    expect(beforeButton().getAttribute('aria-pressed')).toBe('true');
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
    click(beforeButton());
    key('keydown');
    key('keyup');
    click(afterButton());
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe(zoom);
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe(pan);
  });

  it('keeps the persistent choice across a keyed asset switch and does not retain the old image', () => {
    act(() => root.render(<Harness />));
    click(beforeButton());
    act(() => root.render(<Harness src="/second" />));
    expect(image().dataset.before).toBe('true');
    expect(beforeButton().getAttribute('aria-pressed')).toBe('true');
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
    click(beforeButton());
    expect(mockImage.recipe).toEqual(defaultRecipe());
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
    expect(host.querySelector<HTMLButtonElement>('.edit-actions button')!.disabled).toBe(true);
    click(host.querySelector<HTMLButtonElement>('.filmstrip-item[aria-label="second.jpg"]')!);
    await act(async () => {});
    expect(beforeButton().getAttribute('aria-pressed')).toBe('true');
    expect(image().dataset.before).toBe('true');
    expect(mockImage.recipe).toEqual(defaultRecipe());
    expect(host.querySelectorAll('.edit-history li')).toHaveLength(0);
    click(afterButton());
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
