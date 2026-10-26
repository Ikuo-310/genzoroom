import { SettingsProvider } from './SettingsDialog';
import { readSettings, updateSetting, ZOOM_NAVIGATOR_POSITION_KEY, ZOOM_NAVIGATOR_POSITIONS } from './appSettings';
// @vitest-environment jsdom
import { act, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnshitsuPage } from './AnshitsuPage';
import { ImageViewer } from './ImageViewer';
import { defaultRecipe } from './editing';
import { collectHistogram, type HistogramChangeHandler } from './histogram';
import i18n from './i18n';
import type { EditImageSource } from './editImageSource';
import { WebGpuAdjustmentRenderer } from './webgpuAdjustmentRenderer';
import type { WorkspaceGpuRenderer, ProcessingBackend } from './useWorkspaceGpu';
import { WEBGPU_STORAGE_KEY } from './webgpuSettings';
import { regionRequest, regionResponse } from './test/rawRegion';
import { regionLayerPlacement, type RawRegionDisplay } from './rawRegionOverlay';

vi.mock('./jpegProfile', () => ({ readJpegProfile: vi.fn(async () => ({ status: 'embedded', description: 'Display P3' })) }));

vi.mock('./editStateApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('./editStateApi')>(),
  getAssetEditState: vi.fn(async () => ({ state: null })),
}));

const mockImage = vi.hoisted(() => ({
  onLoad: undefined as undefined | ((width: number, height: number) => void),
  onCanvasRendered: undefined as undefined | (() => void),
  recipe: undefined as unknown,
  source: undefined as EditImageSource | undefined,
  onHistogramChange: undefined as HistogramChangeHandler | undefined,
  renders: 0,
  beforeDisplay: false,
  gpuRenderer: undefined as WorkspaceGpuRenderer | null | undefined,
  onGpuError: undefined as ((renderer: WorkspaceGpuRenderer, error: unknown) => void) | undefined,
  onBackendChange: undefined as ((backend: ProcessingBackend) => void) | undefined,
}));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, fetchAssetDetail: vi.fn(async (id: string) => ({
    id, filename: `${id}.jpg`, date: '2026-09-01T10:00:00', thumbnail_url: `/${id}/thumbnail`,
    preview_url: `/${id}/preview`, format: 'JPEG', is_raw: false, exif: {},
  })) };
});
vi.mock('./AdjustedImage', () => ({
  AdjustedImage: ({ source, showBeforeAdjustments, onLoad, onCanvasRendered, recipe, onHistogramChange, gpuRenderer, onGpuError, onBackendChange }: { source: EditImageSource; showBeforeAdjustments: boolean; onLoad: (width: number, height: number) => void; onCanvasRendered?: () => void; recipe: unknown; onHistogramChange?: HistogramChangeHandler;
    gpuRenderer?: WorkspaceGpuRenderer | null; onGpuError?: (renderer: WorkspaceGpuRenderer, error: unknown) => void; onBackendChange?: (backend: ProcessingBackend) => void }) => {
    mockImage.source = source;
    mockImage.onLoad = onLoad;
    mockImage.onCanvasRendered = onCanvasRendered;
    mockImage.recipe = recipe;
    mockImage.onHistogramChange = onHistogramChange;
    mockImage.gpuRenderer = gpuRenderer;
    mockImage.onGpuError = onGpuError;
    mockImage.onBackendChange = onBackendChange;
    mockImage.renders++;
    return <div className={source.url === 'navigator-canvas' ? 'viewer-comparison-image' : undefined}
      data-testid="adjusted-image" data-before={String(showBeforeAdjustments)}>
      {source.url === 'navigator-canvas' && <>
        <canvas width={800} height={600} />
        <canvas width={800} height={600} className={showBeforeAdjustments ? 'comparison-hidden' : undefined} />
      </>}
    </div>;
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
    onBeforeAdjustmentsDisplayChange={(value) => { mockImage.beforeDisplay = value; }}
    onToggleLeft={vi.fn()} onToggleRight={vi.fn()} />;
}

function fitRestoreKey(target: EventTarget = window, init: KeyboardEventInit = {}) {
  return key('keydown', target, { key: 'Z', code: 'KeyZ', shiftKey: true, ...init });
}

function zoomViewer() {
  const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
  act(() => mockImage.onLoad?.(800, 600));
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 300 } as DOMRect);
  act(() => viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 300, clientY: 200 })));
  return {
    zoom: host.querySelector('.zoom-controls output')!.textContent,
    pan: host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform,
  };
}

function BlockingBeforeHarness({ keyboardBlocked = false }: { keyboardBlocked?: boolean }) {
  const [persistentBeforeAdjustments, setPersistentBeforeAdjustments] = useState(false);
  return <ImageViewer src="/first" alt="photo" leftOpen rightOpen recipe={defaultRecipe()}
    editSource={{ kind: 'immich-preview', url: '/first' }} persistentBeforeAdjustments={persistentBeforeAdjustments}
    onBeforeAdjustmentsChange={setPersistentBeforeAdjustments}
    onBeforeAdjustmentsDisplayChange={(value) => { mockImage.beforeDisplay = value; }}
    keyboardBlocked={keyboardBlocked} onToggleLeft={vi.fn()} onToggleRight={vi.fn()} />;
}

function NativePreviewHarness({ src, documentKey, previewStatus, autoLoad }: {
  src: string; documentKey?: string; previewStatus?: 'loading' | 'error'; autoLoad: boolean;
}) {
  useLayoutEffect(() => {
    if (!autoLoad) return;
    const image = host.querySelector<HTMLImageElement>('.viewer-panel img');
    if (!image) return;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1024 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 770 });
    // A cached Blob can report load before ImageViewer's passive identity effect runs.
    image.dispatchEvent(new Event('load'));
  }, [autoLoad, documentKey, src]);
  return <ImageViewer src={src} documentKey={documentKey} previewStatus={previewStatus}
    statusNote={documentKey ? 'LightCraft RAW Preview' : undefined} previewPixels={!!documentKey}
    alt="photo" leftOpen rightOpen onToggleLeft={vi.fn()} onToggleRight={vi.fn()} />;
}

function PanelToggleHarness() {
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  return <ImageViewer src="/first" alt="photo" leftOpen={leftOpen} rightOpen={rightOpen}
    onToggleLeft={() => setLeftOpen(value => !value)} onToggleRight={() => setRightOpen(value => !value)} />;
}

function RawComparisonHarness({ beforeSrc, beforeStatus }: { beforeSrc?: string; beforeStatus?: 'loading' | 'ready' | 'error' }) {
  const [persistent, setPersistent] = useState(false);
  return <ImageViewer src="blob:after" documentKey="raw-document" beforeSrc={beforeSrc} beforeStatus={beforeStatus}
    alt="raw" leftOpen rightOpen previewPixels persistentBeforeAdjustments={persistent}
    onBeforeAdjustmentsChange={setPersistent} onToggleLeft={vi.fn()} onToggleRight={vi.fn()} />;
}

function key(type: 'keydown' | 'keyup', target: EventTarget = window, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent(type, { key: '\\', code: 'Backslash', bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event));
  return event;
}

function comparisonToggle() { return host.querySelector<HTMLButtonElement>('[aria-label="Before and after adjustments"]')!; }
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
  mockImage.beforeDisplay = false;
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
  it.each([1, 1.25, 1.5, 2])('shares Native scale, pan and comparison placement at DPR %s', dpr => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });
    const metadata = regionResponse(), geometry = { nativeWidth: 4000, nativeHeight: 3000, geometryId: metadata.geometryId };
    const layer = { url: 'blob:region-after', metadata, planGeneration: 1, ...regionLayerPlacement(metadata, geometry) };
    const whole = { url: 'blob:base-after', doc: { workspaceId: 'w', handle: 'h', ...metadata.identity, revision: 2 },
      frame: { ...geometry, fullWidth: 4000, fullHeight: 3000, aspect: 4/3, window: null }, quality: 'full' as const };
    const display: RawRegionDisplay = { after: layer, wholeAfter: whole,
      before: { ...layer, url: 'blob:region-before' }, wholeBefore: { ...whole, url: 'blob:base-before' } };
    const render = (before: boolean, value = display) => act(() => root.render(<ImageViewer src="blob:current-whole" documentKey="raw"
      rawFrame={geometry} rawRegionDisplay={value} previewPixels beforeSrc="blob:before-whole" persistentBeforeAdjustments={before}
      alt="raw" leftOpen rightOpen onToggleLeft={() => {}} onToggleRight={() => {}} />));
    render(false);
    click([...host.querySelectorAll<HTMLButtonElement>('.zoom-controls button')].find(b => b.textContent === '1:1')!);
    const overlay = host.querySelector<HTMLImageElement>('.raw-region-overlay')!;
    expect(parseFloat(overlay.style.left)).toBeCloseTo(1000/dpr, 10); expect(parseFloat(overlay.style.top)).toBeCloseTo(800/dpr, 10);
    expect(parseFloat(overlay.style.width)).toBeCloseTo(1000/dpr, 10); expect(overlay.style.pointerEvents).toBe('none');
    expect(overlay.style.clipPath).toBe(`inset(${16/dpr}px ${16/dpr}px ${16/dpr}px ${16/dpr}px)`);
    expect(host.querySelector<HTMLImageElement>('.raw-whole-base')!.getAttribute('src')).toBe('blob:base-after');
    const position = host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform;
    const placement = overlay.style.cssText;
    render(true);
    expect(host.querySelector<HTMLImageElement>('.raw-region-overlay')!.style.cssText).toBe(placement);
    expect(host.querySelector<HTMLImageElement>('.raw-region-overlay')!.getAttribute('src')).toBe('blob:region-before');
    expect(host.querySelector<HTMLImageElement>('.raw-whole-base')!.getAttribute('src')).toBe('blob:base-before');
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe(position);
    render(true, { ...display, before: undefined });
    expect(host.querySelector('.raw-region-overlay')).toBeNull();
    expect(host.querySelector<HTMLImageElement>('.raw-whole-base')!.getAttribute('src')).toBe('blob:before-whole');
    render(false, { ...display, after: { ...layer, metadata: { ...metadata, geometryId: 'f'.repeat(64) } } });
    expect(host.querySelector('.raw-region-overlay')).toBeNull();
  });
  it('uses native RAW dimensions for Fit and physical 1:1, preserving transform across bitmap changes', () => {
    let resize = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const viewChanged = vi.fn();
    const render = (src: string) => act(() => root.render(<ImageViewer src={src} documentKey="raw"
      onRawViewChange={viewChanged}
      rawFrame={{ nativeWidth: 6000, nativeHeight: 4000, geometryId: 'a'.repeat(64) }} previewPixels
      alt="raw" leftOpen rightOpen onToggleLeft={() => {}} onToggleRight={() => {}} />));
    render('blob:draft');
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 900 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 });
    act(() => resize());
    expect(viewChanged).toHaveBeenLastCalledWith(expect.objectContaining({ width: 900, height: 600, dpr: 2, nativeWidth: 6000, fit: true }));
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('30%');
    expect(host.querySelector<HTMLElement>('.raw-native-frame')!.style.width).toBe('900px');
    click([...host.querySelectorAll<HTMLButtonElement>('.zoom-controls button')].find(b => b.textContent === '1:1')!);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
    expect(host.querySelector<HTMLElement>('.raw-native-frame')!.style.width).toBe('3000px');
    const transform = host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform;
    render('blob:full');
    expect(host.querySelector<HTMLElement>('.raw-native-frame')!.style.width).toBe('3000px');
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe(transform);
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    act(() => window.dispatchEvent(new Event('resize')));
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
    expect(host.querySelector<HTMLElement>('.raw-native-frame')!.style.width).toBe('6000px');
  });
  it('publishes actual Native Pan and wheel gesture state through the existing RawView callback', async () => {
    vi.useFakeTimers(); let resize = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    const changed = vi.fn();
    act(() => root.render(<ImageViewer src="blob:raw" documentKey="raw" previewPixels rawFrame={{ nativeWidth: 4000, nativeHeight: 3000, geometryId: 'a'.repeat(64) }}
      onRawViewChange={changed} alt="raw" leftOpen rightOpen onToggleLeft={() => {}} onToggleRight={() => {}} />));
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 750 });
    Object.defineProperty(viewport, 'setPointerCapture', { value: vi.fn() });
    act(() => resize());
    click([...host.querySelectorAll<HTMLButtonElement>('.zoom-controls button')].find(button => button.textContent === '1:1')!);
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 20 });
      Object.defineProperty(event, 'pointerId', { value: 7 }); act(() => viewport.dispatchEvent(event));
    };
    pointer('pointerdown', 10); pointer('pointermove', 60);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ panX: 50, panY: 0, interacting: true }));
    pointer('pointerup', 60);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ panX: 50, interacting: false }));
    act(() => viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 })));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ interacting: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ interacting: false }));
    vi.useRealTimers();
  });
  it('keeps native Preview load state aligned with its document across fast loads and JPEG switches', () => {
    const render = (props: { src: string; documentKey?: string; previewStatus?: 'loading' | 'error'; autoLoad: boolean }) =>
      act(() => root.render(<NativePreviewHarness {...props} />));
    const status = () => host.querySelector('.viewer-image-status')?.textContent;

    render({ src: '', documentKey: 'raw-a', previewStatus: 'loading', autoLoad: false });
    expect(status()).toBe('Loading photo…');

    render({ src: 'blob:raw-a', documentKey: 'raw-a', autoLoad: true });
    expect(host.querySelector('.raw-preview-note')?.textContent).toBe('LightCraft RAW Preview');
    expect(status()).toBeUndefined();

    render({ src: '', documentKey: 'raw-a', previewStatus: 'error', autoLoad: false });
    expect(status()).toBe('The preview image could not be loaded.');

    render({ src: '/jpeg', autoLoad: false });
    expect(status()).toBe('Loading photo…');
    render({ src: '/jpeg', autoLoad: true });
    expect(status()).toBeUndefined();
  });

  it('preserves native Preview zoom across frame URLs, resets for a new document and never calls the JPEG renderer', async () => {
    const render = async (src: string, documentKey: string) => act(async () => root.render(<ImageViewer
      src={src} documentKey={documentKey} alt="raw" leftOpen rightOpen previewPixels beforeAvailable={false}
      onToggleLeft={vi.fn()} onToggleRight={vi.fn()} />));
    const before = mockImage.renders;
    await render('blob:raw-1', 'document-a');
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    const image = host.querySelector('img')!;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 800 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 600 });
    act(() => image.dispatchEvent(new Event('load')));
    click([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '1:1')!);
    const zoom = host.querySelector('.zoom-controls output')!.textContent;
    await render('blob:raw-2', 'document-a');
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe(zoom);
    expect(comparisonToggle().disabled).toBe(true);
    expect(mockImage.renders).toBe(before);
    await render('blob:raw-3', 'document-b');
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toContain('0px');
    act(() => host.querySelector('img')!.dispatchEvent(new Event('load')));
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('50%');
  });

  it('compares native frames in the same image element and transform, keeping After during loading or failure', () => {
    const renders = mockImage.renders;
    act(() => root.render(<RawComparisonHarness beforeStatus="loading" />));
    const image = host.querySelector('img')!;
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 800 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 600 });
    act(() => image.dispatchEvent(new Event('load')));
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 300 } as DOMRect);
    act(() => viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
      deltaY: -100, clientX: 300, clientY: 150 })));
    const zoom = host.querySelector('.zoom-controls output')!.textContent;
    const pan = host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform;
    key('keydown');
    expect(image.getAttribute('src')).toBe('blob:after');
    expect(host.textContent).toContain('Preparing RAW Before');
    act(() => root.render(<RawComparisonHarness beforeSrc="blob:before" beforeStatus="ready" />));
    expect(host.querySelector('img')).toBe(image);
    expect(image.getAttribute('src')).toBe('blob:before');
    key('keyup'); expect(image.getAttribute('src')).toBe('blob:after');
    click(comparisonToggle()); expect(image.getAttribute('src')).toBe('blob:before');
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe(zoom);
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe(pan);
    act(() => root.render(<RawComparisonHarness beforeStatus="error" />));
    expect(image.getAttribute('src')).toBe('blob:after');
    expect(host.textContent).toContain('RAW Before could not be compared');
    expect(mockImage.renders).toBe(renders);
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 200 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 100 });
    act(() => image.dispatchEvent(new Event('load')));
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toContain('0px');
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe(zoom);
  });
  it('wires the Settings GPU switch and runtime fallback without changing source, History, or Recipe', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false; } });
    updateSetting('initialImage', 'preview');
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { gpu: {}, language: 'en' });
    const fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['jpeg']), json: async () => ({ edited: {} }) }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('URL', class extends URL { static createObjectURL = () => 'blob:gpu-original'; static revokeObjectURL = vi.fn(); });
    localStorage.removeItem(WEBGPU_STORAGE_KEY);
    const created: WorkspaceGpuRenderer[] = [];
    const create = vi.spyOn(WebGpuAdjustmentRenderer, 'create').mockImplementation(async () => {
      const renderer = { available: true, setSource: vi.fn(), render: vi.fn(), onDeviceLost: () => () => {},
        dispose: vi.fn(() => { renderer.available = false; }) };
      created.push(renderer);
      return renderer as unknown as WebGpuAdjustmentRenderer;
    });
    try {
      await act(async () => root.render(<MemoryRouter initialEntries={['/anshitsu/first']}>
        <SettingsProvider><Routes><Route path="/anshitsu/:assetId" element={<AnshitsuPage />} /></Routes></SettingsProvider></MemoryRouter>));
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click());
      expect(mockImage.gpuRenderer?.available).toBe(true);
      const switchButton = () => host.querySelector<HTMLButtonElement>('[aria-label="Use WebGPU"]')!;
      act(() => mockImage.onBackendChange?.('gpu'));
      expect(host.querySelector('#webgpu-status')!.textContent).toBe('GPU active');
      click(host.querySelector<HTMLButtonElement>('[aria-label="Disable Basic"]')!);
      const recipe = mockImage.recipe, history = host.querySelector('.edit-history')!.innerHTML;
      const source = mockImage.source, requests = fetch.mock.calls.length;
      const old = mockImage.gpuRenderer!;
      await act(async () => switchButton().click());
      expect(mockImage.gpuRenderer).toBeNull(); expect(old.dispose).toHaveBeenCalled();
      expect(localStorage.getItem(WEBGPU_STORAGE_KEY)).toBe('false');
      await act(async () => switchButton().click());
      expect(mockImage.gpuRenderer?.available).toBe(true);
      act(() => mockImage.onBackendChange?.('gpu'));
      act(() => mockImage.onGpuError?.(mockImage.gpuRenderer!, new Error('GPU execution failed')));
      expect(mockImage.gpuRenderer).toBeNull(); expect(switchButton().disabled).toBe(true);
      expect(host.querySelector('#webgpu-status')!.textContent).toBe('GPU error · CPU');
      expect(localStorage.getItem(WEBGPU_STORAGE_KEY)).toBe('true');
      expect(mockImage.source).toEqual(source); expect(mockImage.recipe).toBe(recipe);
      expect(host.querySelector('.edit-history')!.innerHTML).toBe(history); expect(fetch).toHaveBeenCalledTimes(requests);
      click(host.querySelector<HTMLButtonElement>('.settings-dialog header button')!);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Preview / Original"]')!.click());
      expect(mockImage.source?.kind).toBe('jpeg-original'); expect(mockImage.gpuRenderer?.available).toBe(true);
      expect(mockImage.recipe).toBe(recipe); expect(host.querySelector('.edit-history')!.innerHTML).toBe(history);
      act(() => root.unmount()); root = createRoot(host);
      expect(created.every(renderer => !renderer.available)).toBe(true);
    } finally { create.mockRestore(); localStorage.removeItem(WEBGPU_STORAGE_KEY); updateSetting('initialImage', 'auto'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close'); }
  });
  it.each(['loading', 'error'] as const)('keeps original switching disabled and ignores ] while acquisition is %s', (status) => {
    const toggle = vi.fn();
    const beforeDisplay = vi.fn();
    act(() => root.render(<ImageViewer src="/first" editSource={{ kind: 'immich-preview', url: '/first' }}
      originalStatus={status} onOriginalToggle={toggle} recipe={defaultRecipe()} alt="photo" leftOpen rightOpen
      onBeforeAdjustmentsDisplayChange={beforeDisplay} onToggleLeft={vi.fn()} onToggleRight={vi.fn()} />));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Preview / Original"]')?.disabled).toBe(true);
    expect(key('keydown', window, { key: ']', code: 'BracketRight' }).defaultPrevented).toBe(false);
    expect(key('keydown', window, { key: ']', code: 'Backslash' }).defaultPrevented).toBe(true);
    expect(toggle).not.toHaveBeenCalled();
    expect(beforeDisplay).not.toHaveBeenCalledWith(true);
    expect(key('keydown').defaultPrevented).toBe(true);
    key('keyup');
  });
  it('shares edits and History across modes and selects only the displayed source histogram', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, blob: async () => new Blob(['jpeg']), json: async () => ({ edited: {} }) }));
    vi.stubGlobal('fetch', fetch);
    const revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL { static createObjectURL = () => 'blob:original'; static revokeObjectURL = revoke; });
    act(() => root.render(<MemoryRouter initialEntries={['/anshitsu/first']}>
      <Routes><Route path="/anshitsu/:assetId" element={<AnshitsuPage />} /></Routes></MemoryRouter>));
    await act(async () => {});
    const mode = () => host.querySelector<HTMLButtonElement>('[aria-label="Preview / Original"]')!;
    const toolbarSwitches = [...host.querySelectorAll<HTMLButtonElement>('.viewer-toolbar-right .before-after-controls')]
      .map(button => button.getAttribute('aria-label'));
    expect(toolbarSwitches.slice(-2)).toEqual(['Preview / Original', 'Before and after adjustments']);
    expect(mode().disabled).toBe(false); expect(mockImage.source?.kind).toBe('immich-preview');
    expect(host.querySelector('.exif-list')?.textContent).toContain('Display P3');
    const previewCallback = mockImage.onHistogramChange!;
    const before = collectHistogram(new Uint8ClampedArray([7, 8, 9, 255]));
    const after = collectHistogram(new Uint8ClampedArray([200, 201, 202, 255]));
    act(() => previewCallback({ sourceKey: 'immich-preview:/first/preview', before, after }));
    click(host.querySelector<HTMLButtonElement>('[aria-label="Disable Basic"]')!);
    const editedRecipe = mockImage.recipe;
    const history = host.querySelector('.edit-history')?.innerHTML;
    click(mode());
    expect(mockImage.source).toEqual({ kind: 'jpeg-original', url: 'blob:original' });
    expect(mockImage.recipe).toBe(editedRecipe); expect(host.querySelector('.edit-history')?.innerHTML).toBe(history);
    expect(key('keydown', window, { key: ']', code: 'BracketRight' }).defaultPrevented).toBe(true);
    expect(mockImage.source?.kind).toBe('immich-preview');
    expect(key('keydown', window, { key: ']', code: 'BracketRight' }).defaultPrevented).toBe(true);
    expect(mockImage.source?.kind).toBe('jpeg-original');
    expect(key('keydown', window, { key: ']', code: 'Backslash' }).defaultPrevented).toBe(true);
    expect(mockImage.source?.kind).toBe('immich-preview');
    expect(image().dataset.before).toBe('false');
    expect(key('keydown', window, { key: ']', code: 'Backslash' }).defaultPrevented).toBe(true);
    expect(mockImage.source?.kind).toBe('jpeg-original');
    expect(image().dataset.before).toBe('false');
    expect(key('keydown').defaultPrevented).toBe(true);
    expect(mockImage.source?.kind).toBe('jpeg-original');
    key('keyup');
    expect(host.querySelectorAll('.histogram-series')).toHaveLength(0);
    const renders = mockImage.renders;
    act(() => previewCallback({ sourceKey: 'immich-preview:/first/preview', before, after }));
    expect(mockImage.renders).toBe(renders);
    act(() => mockImage.onHistogramChange?.({ sourceKey: 'jpeg-original:blob:original', before, after }));
    expect(host.querySelector('[data-channel="r"]')?.getAttribute('d')).toContain('200,');
    click(comparisonToggle()); expect(host.querySelector('[data-channel="r"]')?.getAttribute('d')).toContain('7,');
    click(host.querySelector<HTMLButtonElement>('.edit-actions button')!);
    expect(mockImage.recipe).toEqual(defaultRecipe());
    click(host.querySelectorAll<HTMLButtonElement>('.edit-actions button')[1]); expect(mockImage.recipe).toEqual(editedRecipe);
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="range"]')].some(slider => !slider.disabled)).toBe(true);
    act(() => mockImage.onLoad?.(4000, 3000));
    click([...host.querySelectorAll<HTMLButtonElement>('.zoom-controls button')].find(button => button.textContent === '1:1')!);
    expect(host.querySelector('.zoom-controls output')?.textContent).toBe('100%');
    click(mode()); expect(mockImage.recipe).toEqual(editedRecipe); expect(image().dataset.before).toBe('true');
    const textInput = document.createElement('input'); textInput.type = 'text'; document.body.append(textInput);
    expect(key('keydown', textInput, { key: ']', code: 'BracketRight' }).defaultPrevented).toBe(false);
    expect(mockImage.source?.kind).toBe('immich-preview');
    textInput.remove();
    click(mode());
    expect(fetch.mock.calls.filter(call => String(call[0]).endsWith('/original'))).toHaveLength(1);
    act(() => root.unmount()); expect(revoke).toHaveBeenCalledWith('blob:original'); root = createRoot(host);
  });
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

  it('selects the matching before or after histogram for the Viewer state without a fallback', async () => {
    const selectedAssets = [{
      id: 'first', filename: 'first.jpg', date: '2026-09-01T10:00:00', thumbnail_url: '/first/thumbnail',
      format: 'JPEG', is_raw: false,
    }];
    act(() => root.render(<MemoryRouter initialEntries={[{
      pathname: '/anshitsu/first', state: { selectedAssets, activeAssetId: 'first' },
    }]}><Routes><Route path="/anshitsu/:assetId" element={<AnshitsuPage />} /></Routes></MemoryRouter>));
    await act(async () => {});
    const before = collectHistogram(new Uint8ClampedArray([7, 8, 9, 255]));
    const after = collectHistogram(new Uint8ClampedArray([200, 201, 202, 255]));
    act(() => mockImage.onHistogramChange?.({ sourceKey: 'immich-preview:/first/preview', before: null, after }));
    expect(host.querySelector('[data-channel="r"]')?.getAttribute('d')).toContain('200,');

    click(comparisonToggle());
    expect(host.textContent).toContain('Histogram is not available yet.');
    expect(host.querySelectorAll('.histogram-series')).toHaveLength(0);
    act(() => mockImage.onHistogramChange?.({ sourceKey: 'immich-preview:/first/preview', before, after }));
    expect(host.querySelector('[data-channel="r"]')?.getAttribute('d')).toContain('7,');

    key('keydown');
    key('keyup');
    expect(host.querySelector('[data-channel="r"]')?.getAttribute('d')).toContain('7,');
    click(comparisonToggle());
    expect(host.querySelector('[data-channel="r"]')?.getAttribute('d')).toContain('200,');
    key('keydown');
    expect(host.querySelector('[data-channel="r"]')?.getAttribute('d')).toContain('7,');
    key('keyup');
    expect(host.querySelector('[data-channel="r"]')?.getAttribute('d')).toContain('200,');
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
    expect(Array.from(menu.querySelectorAll('.edit-settings-action-label'), (item) => item.textContent)).toEqual([
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
  it('shows state-directed panel arrows with localized action tooltips and accessible names', async () => {
    for (const language of ['en', 'ja'] as const) {
      await i18n.changeLanguage(language);
      act(() => root.render(<PanelToggleHarness />));
      const left = host.querySelector<HTMLButtonElement>('.viewer-toolbar > .panel-toggle')!;
      const right = host.querySelector<HTMLButtonElement>('.viewer-toolbar-right > .panel-toggle')!;
      const expected = language === 'en'
        ? [['Collapse left panel', '‹'], ['Collapse right panel', '›'], ['Expand left panel', '›'], ['Expand right panel', '‹']]
        : [['左パネルを閉じる', '‹'], ['右パネルを閉じる', '›'], ['左パネルを開く', '›'], ['右パネルを開く', '‹']];
      for (const [button, index] of [[left, 0], [right, 1]] as const) {
        expect(button.getAttribute('aria-label')).toBe(expected[index][0]);
        expect(button.title).toBe(expected[index][0]);
        expect(button.textContent).toBe(expected[index][1]);
        expect(button.querySelector('[aria-hidden="true"]')).not.toBeNull();
        click(button);
        expect(button.getAttribute('aria-label')).toBe(expected[index + 2][0]);
        expect(button.title).toBe(expected[index + 2][0]);
        expect(button.textContent).toBe(expected[index + 2][1]);
        click(button);
      }
    }
    await i18n.changeLanguage('en');
  });

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
      'tool-button icon-button panel-toggle', 'zoom-controls', 'viewer-toolbar-right',
    ]);
    const rightGroup = host.querySelector('.viewer-toolbar-right')!;
    expect(Array.from(rightGroup.children, (item) => item.className)).toEqual([
      'edit-settings-menu', 'tool-button before-after-controls', 'tool-button icon-button panel-toggle right',
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
    expect(mockImage.beforeDisplay).toBe(false);
    expect(key('keydown', window, { key: '¥' }).defaultPrevented).toBe(true);
    expect(key('keydown').defaultPrevented).toBe(true);
    expect(image().dataset.before).toBe('true');
    expect(mockImage.beforeDisplay).toBe(true);
    expect(key('keydown', window, { repeat: true }).defaultPrevented).toBe(true);
    key('keyup');
    expect(image().dataset.before).toBe('false');
    expect(mockImage.beforeDisplay).toBe(false);
    click(comparisonToggle());
    key('keydown');
    key('keyup');
    expect(image().dataset.before).toBe('true');
    expect(mockImage.beforeDisplay).toBe(true);
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
    expect(mockImage.beforeDisplay).toBe(false);
    key('keydown');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(image().dataset.before).toBe('false');
    expect(mockImage.beforeDisplay).toBe(false);
    Reflect.deleteProperty(document, 'hidden');
    fields.forEach((field) => field.remove());
  });

  it('clears only the temporary Before state when keyboard actions become blocked', () => {
    act(() => root.render(<BlockingBeforeHarness />));
    click(comparisonToggle());
    key('keydown');
    expect(mockImage.beforeDisplay).toBe(true);
    act(() => root.render(<BlockingBeforeHarness keyboardBlocked />));
    expect(mockImage.beforeDisplay).toBe(true);
    key('keyup');
    expect(mockImage.beforeDisplay).toBe(true);
    click(comparisonToggle());
    expect(comparisonToggle().getAttribute('aria-pressed')).toBe('false');
    key('keyup');
    expect(mockImage.beforeDisplay).toBe(false);
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

describe('Viewer Fit restore shortcut', () => {
  it('restores the exact zoom and pan, then clears the saved view on source change without remounting', () => {
    const render = (src: string) => act(() => root.render(<ImageViewer src={src} alt="photo" leftOpen rightOpen
      editSource={{ kind: 'immich-preview', url: src }} recipe={defaultRecipe()} onToggleLeft={vi.fn()} onToggleRight={vi.fn()} />));
    render('/first');
    const saved = zoomViewer();
    fitRestoreKey();
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('50%');
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toContain('0px');
    fitRestoreKey();
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe(saved.zoom);
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe(saved.pan);
    fitRestoreKey(); render('/second'); act(() => mockImage.onLoad?.(800, 600));
    fitRestoreKey();
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('50%');
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe('translate(calc(-50% + 0px), calc(-50% + 0px))');
  });

  it('clears the saved transform with explicit Fit and 1:1 controls', () => {
    act(() => root.render(<Harness />));
    zoomViewer(); fitRestoreKey();
    click([...host.querySelectorAll<HTMLButtonElement>('.zoom-controls button')].find(button => button.textContent === 'Fit')!);
    fitRestoreKey(); expect(host.querySelector('.zoom-controls output')!.textContent).toBe('50%');
    click([...host.querySelectorAll<HTMLButtonElement>('.zoom-controls button')].find(button => button.textContent === '1:1')!);
    fitRestoreKey(); fitRestoreKey(); expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
  });

  it('ignores repeat, composition, modified Redo, prevented events, and blocked workspace', () => {
    act(() => root.render(<BlockingBeforeHarness />));
    const saved = zoomViewer();
    for (const init of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(fitRestoreKey(window, init).defaultPrevented).toBe(false);
      expect(host.querySelector('.zoom-controls output')!.textContent).toBe(saved.zoom);
    }
    const prevented = new KeyboardEvent('keydown', { key: 'Z', shiftKey: true, cancelable: true });
    prevented.preventDefault(); act(() => window.dispatchEvent(prevented));
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe(saved.zoom);
    act(() => root.render(<BlockingBeforeHarness keyboardBlocked />));
    expect(fitRestoreKey().defaultPrevented).toBe(false);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe(saved.zoom);
  });

  it.each(['input', 'textarea', 'select', '[contenteditable]', '[role="textbox"]'])('preserves editing in %s', selector => {
    act(() => root.render(<Harness />)); zoomViewer();
    const container = document.createElement('div');
    container.innerHTML = '<input type="number"><textarea></textarea><select></select><div contenteditable="true"></div><div role="textbox"></div>';
    host.append(container);
    expect(fitRestoreKey(container.querySelector(selector)!).defaultPrevented).toBe(false);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('56%');
  });

  it.each(['dialog[open]', '[role="dialog"]', '[role="alertdialog"]', '[role="menu"]', 'details.edit-settings-menu[open]'])
    ('does not toggle while %s is open', selector => {
      act(() => root.render(<Harness />)); zoomViewer();
      const overlay = document.createElement(selector.startsWith('details') ? 'details' : selector.startsWith('dialog') ? 'dialog' : 'div');
      if (selector.includes('[open]')) overlay.setAttribute('open', '');
      if (selector.startsWith('details')) overlay.className = 'edit-settings-menu';
      const role = selector.match(/role="(.*?)"/)?.[1]; if (role) overlay.setAttribute('role', role);
      host.append(overlay);
      expect(fitRestoreKey().defaultPrevented).toBe(false);
      expect(host.querySelector('.zoom-controls output')!.textContent).toBe('56%');
    });
});

describe('workspace Viewer focus mode', () => {
  async function mountWorkspace() {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['jpeg']), json: async () => ({ edited: {} }) })));
    vi.stubGlobal('URL', class extends URL { static createObjectURL = () => 'blob:focus-original'; static revokeObjectURL = vi.fn(); });
    const selectedAssets = ['first', 'second'].map(id => ({ id, filename: `${id}.jpg`, date: '2026-09-01T10:00:00',
      thumbnail_url: `/${id}/thumbnail`, format: 'JPEG', is_raw: false }));
    await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: '/anshitsu/first', state: { selectedAssets, activeAssetId: 'first' } }]}>
      <SettingsProvider><Routes><Route path="/anshitsu/:assetId" element={<AnshitsuPage />} /></Routes></SettingsProvider></MemoryRouter>));
  }
  const focusKey = (target: EventTarget = window, init: KeyboardEventInit = {}) => key('keydown', target, { key: 'v', code: 'KeyV', ...init });
  const page = () => host.querySelector('.workspace-page')!;

  it('preserves mounted UI, panel choices, focus, and hidden component shortcuts', async () => {
    await mountWorkspace();
    click(host.querySelector<HTMLButtonElement>('.viewer-toolbar > .panel-toggle')!);
    const body = host.querySelector('.workspace-body')!;
    const panels = [...host.querySelectorAll('.workspace-side-panel')];
    const filmstrip = host.querySelector('.filmstrip')!;
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    act(() => viewport.focus());
    expect(key('keydown', viewport, { key: 'f', code: 'KeyF' }).defaultPrevented).toBe(false);
    expect(page().classList.contains('viewer-focus-mode')).toBe(false);
    focusKey(); expect(page().classList.contains('viewer-focus-mode')).toBe(true);
    expect(body.className).toBe('workspace-body right-open viewer-focus-mode');
    expect([...host.querySelectorAll('.workspace-side-panel')]).toEqual(panels);
    expect(host.querySelector('.filmstrip')).toBe(filmstrip);
    expect(host.querySelector('.viewer-viewport')).toBe(viewport);
    expect(document.activeElement).toBe(viewport);
    expect(key('keydown', window, { key: ']', code: 'Backslash' }).defaultPrevented).toBe(true);
    expect(image().dataset.before).toBe('false');
    expect(key('keydown').defaultPrevented).toBe(true); expect(image().dataset.before).toBe('true'); key('keyup');
    const saved = zoomViewer(); fitRestoreKey(); fitRestoreKey();
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe(saved.zoom);
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe(saved.pan);
    key('keydown', window, { key: 'ArrowDown', code: 'Numpad2' });
    expect(host.querySelector('.channel-g')?.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { key('keydown', window, { key: 'ArrowRight', ctrlKey: true, shiftKey: true }); });
    expect(host.querySelector('.workspace-asset-title')!.textContent).toContain('second.jpg');
    expect(page().classList.contains('viewer-focus-mode')).toBe(true);
    expect(host.querySelector('.filmstrip')).toBe(filmstrip);
    await act(async () => { key('keydown', window, { key: 'ArrowLeft', ctrlKey: true, shiftKey: true }); });
    expect(host.querySelector('.workspace-asset-title')!.textContent).toContain('first.jpg');
    focusKey(); expect(page().classList.contains('viewer-focus-mode')).toBe(false);
    expect(body.className).toBe('workspace-body right-open');
    expect(host.querySelector('.channel-g')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('ignores repeat, composition, modifiers, prevented events and native editing', async () => {
    await mountWorkspace();
    for (const init of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { shiftKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(focusKey(window, init).defaultPrevented).toBe(false);
    }
    const prevented = new KeyboardEvent('keydown', { key: 'v', cancelable: true });
    prevented.preventDefault(); act(() => window.dispatchEvent(prevented));
    for (const selector of ['input', 'textarea', 'select', '[contenteditable]', '[role="textbox"]']) {
      const container = document.createElement('div');
      container.innerHTML = '<input type="text"><textarea></textarea><select></select><div contenteditable="true"></div><div role="textbox"></div>';
      host.append(container); expect(focusKey(container.querySelector(selector)!).defaultPrevented).toBe(false); container.remove();
    }
    expect(page().classList.contains('viewer-focus-mode')).toBe(false);
  });

  it('ignores dialogs, menus and the Settings keyboard block', async () => {
    await mountWorkspace();
    for (const markup of ['<dialog open></dialog>', '<div role="dialog"></div>', '<div role="alertdialog"></div>', '<div role="menu"></div>', '<details class="edit-settings-menu" open></details>']) {
      const wrapper = document.createElement('div'); wrapper.innerHTML = markup; host.append(wrapper);
      expect(focusKey().defaultPrevented).toBe(false); wrapper.remove();
    }
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false; } });
    try {
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click());
      focusKey();
      expect(page().classList.contains('viewer-focus-mode')).toBe(false);
      key('keydown', window, { key: 'h' });
      expect(page().classList.contains('viewer-focus-mode')).toBe(false);
      expect(page()).not.toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>('.settings-dialog header button')!.click());
    } finally {
      act(() => root.unmount()); root = createRoot(host);
      Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
      Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    }
  });
});

describe('Viewer image double-click Fit and Actual Size toggle', () => {
  let resize = () => {};
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  });

  function prepareViewport() {
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, width: 400, height: 300, right: 500, bottom: 350 } as DOMRect);
    act(() => resize());
    return viewport;
  }

  function imagePosition() {
    const position = host.querySelector<HTMLElement>('.viewer-image-position')!;
    vi.spyOn(position, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50, width: 400, height: 300, right: 500, bottom: 350 } as DOMRect);
    return position;
  }

  function doubleClick(target: Element, x: number, y: number, button = 0) {
    act(() => target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button, clientX: x, clientY: y })));
  }

  function pointer(viewport: HTMLElement, type: 'pointerdown' | 'pointerup' | 'pointermove', x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 7 });
    act(() => viewport.dispatchEvent(event));
  }

  function ordinaryDoubleClickSequence(viewport: HTMLElement, x: number, y: number, firstClickMovement = 0) {
    pointer(viewport, 'pointerdown', x, y);
    if (firstClickMovement) pointer(viewport, 'pointermove', x + firstClickMovement, y);
    pointer(viewport, 'pointerup', x + firstClickMovement, y);
    act(() => viewport.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1, clientX: x + firstClickMovement, clientY: y })));
    pointer(viewport, 'pointerdown', x, y); pointer(viewport, 'pointerup', x, y);
    act(() => viewport.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 2, clientX: x, clientY: y })));
    doubleClick(viewport, x, y);
  }

  it('toggles JPEG Fit to 100% around the clicked point, clamps at the image edge, then restores Fit', () => {
    act(() => root.render(<Harness />));
    const viewport = prepareViewport();
    act(() => mockImage.onLoad?.(800, 600));
    const position = imagePosition();
    doubleClick(viewport, 400, 200);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
    expect(position.style.transform).toContain('-100px');

    click([...host.querySelectorAll<HTMLButtonElement>('.zoom-controls button')].find(button => button.textContent === 'Fit')!);
    doubleClick(viewport, 100, 50);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
    expect(position.style.transform).toContain('+ 200px');
    expect(position.style.transform).toContain('+ 150px');
    doubleClick(viewport, 400, 200);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('50%');
    expect(position.style.transform).toBe('translate(calc(-50% + 0px), calc(-50% + 0px))');
  });

  it('toggles RAW Fit to physical Actual Size through RawView state and returns to Fit from magnification', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const changed = vi.fn();
    act(() => root.render(<ImageViewer src="blob:raw" documentKey="raw" previewPixels
      rawFrame={{ nativeWidth: 2000, nativeHeight: 1500, geometryId: 'a'.repeat(64) }} onRawViewChange={changed}
      alt="raw" leftOpen rightOpen onToggleLeft={() => {}} onToggleRight={() => {}} />));
    const viewport = prepareViewport();
    const rawImage = host.querySelector<HTMLImageElement>('.raw-whole-base')!;
    Object.defineProperty(rawImage, 'naturalWidth', { configurable: true, value: 2000 });
    Object.defineProperty(rawImage, 'naturalHeight', { configurable: true, value: 1500 });
    act(() => rawImage.dispatchEvent(new Event('load')));
    const position = imagePosition();
    doubleClick(viewport, 300, 200);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ scale: 0.5, dpr: 2, fit: false }));
    doubleClick(viewport, 300, 200);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('40%');
    expect(position.style.transform).toBe('translate(calc(-50% + 0px), calc(-50% + 0px))');
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ fit: true, panX: 0, panY: 0 }));
  });

  it('ignores unloaded images, non-left clicks, active drags, and points outside the image bounds', () => {
    act(() => root.render(<Harness />));
    const viewport = prepareViewport();
    const position = imagePosition();
    act(() => mockImage.onLoad?.(800, 600));
    doubleClick(viewport, 300, 200, 2);
    doubleClick(viewport, 99, 50);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('50%');
    click([...host.querySelectorAll<HTMLButtonElement>('.zoom-controls button')].find(button => button.textContent === '1:1')!);
    const capture = vi.fn();
    Object.defineProperty(viewport, 'setPointerCapture', { value: capture });
    pointer(viewport, 'pointerdown', 200, 150);
    doubleClick(viewport, 300, 200);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('handles the normal pointer capture click sequence when toggling Actual Size back to Fit', () => {
    act(() => root.render(<Harness />));
    const viewport = prepareViewport();
    act(() => mockImage.onLoad?.(800, 600));
    const capture = vi.fn();
    Object.defineProperty(viewport, 'setPointerCapture', { value: capture });
    imagePosition();
    doubleClick(viewport, 300, 200);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
    ordinaryDoubleClickSequence(viewport, 300, 200);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('50%');
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe('translate(calc(-50% + 0px), calc(-50% + 0px))');
  });

  it('treats three pixels of pointer jitter as a click, not a Pan drag', () => {
    act(() => root.render(<Harness />));
    const viewport = prepareViewport();
    act(() => mockImage.onLoad?.(800, 600));
    const capture = vi.fn();
    Object.defineProperty(viewport, 'setPointerCapture', { value: capture });
    imagePosition();
    doubleClick(viewport, 300, 200);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
    ordinaryDoubleClickSequence(viewport, 300, 200, 3);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('50%');
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe('translate(calc(-50% + 0px), calc(-50% + 0px))');
  });

  it('ignores RAW double-clicks before the image is ready', () => {
    const changed = vi.fn();
    act(() => root.render(<ImageViewer src="blob:raw" documentKey="raw" previewPixels
      rawFrame={{ nativeWidth: 2000, nativeHeight: 1500, geometryId: 'a'.repeat(64) }} onRawViewChange={changed}
      alt="raw" leftOpen rightOpen onToggleLeft={() => {}} onToggleRight={() => {}} />));
    prepareViewport();
    imagePosition();
    doubleClick(host.querySelector<HTMLElement>('.viewer-viewport')!, 300, 200);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ fit: true, scale: 0.2, panX: 0, panY: 0 }));
  });

  it('does not turn an actual pan drag into an accidental Fit toggle', () => {
    act(() => root.render(<Harness />));
    const viewport = prepareViewport();
    act(() => mockImage.onLoad?.(800, 600));
    const capture = vi.fn();
    Object.defineProperty(viewport, 'setPointerCapture', { value: capture });
    click([...host.querySelectorAll<HTMLButtonElement>('.zoom-controls button')].find(button => button.textContent === '1:1')!);
    imagePosition();
    pointer(viewport, 'pointerdown', 200, 150);
    pointer(viewport, 'pointermove', 204, 150);
    pointer(viewport, 'pointerup', 204, 150);
    doubleClick(viewport, 300, 200);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toContain('+ 4px');
  });

  it('keeps wheel zoom, pan, Fit, and Actual Size controls available alongside the toggle', () => {
    act(() => root.render(<Harness />));
    const viewport = prepareViewport();
    act(() => mockImage.onLoad?.(800, 600));
    act(() => viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 300, clientY: 200 })));
    expect(host.querySelector('.zoom-controls output')!.textContent).not.toBe('50%');
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.zoom-controls button')];
    click(buttons.find(button => button.textContent === 'Fit')!);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('50%');
    click(buttons.find(button => button.textContent === '1:1')!);
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
  });
});

describe('ImageViewer Zoom Navigator', () => {
  let resize = () => {};
  beforeEach(() => {
    updateSetting('zoomNavigatorPosition', 'bottom-right');
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  });

  function renderJpeg() {
    act(() => root.render(<ImageViewer src="/navigator.jpg" alt="photo" leftOpen rightOpen
      onToggleLeft={() => {}} onToggleRight={() => {}} />));
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 } as DOMRect);
    const image = host.querySelector<HTMLImageElement>('.viewer-image-position > img')!;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 800 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 600 });
    act(() => image.dispatchEvent(new Event('load')));
    act(() => resize());
    return viewport;
  }

  function button(label: string) {
    return [...host.querySelectorAll<HTMLButtonElement>('.zoom-controls button')].find(item => item.textContent === label)!;
  }

  function pointer(viewport: HTMLElement, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', x: number, y: number) {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 31 });
    act(() => viewport.dispatchEvent(event));
  }

  function setNavigatorImageBounds(left = 100, top = 50, width = 180, height = 135) {
    const image = host.querySelector<HTMLElement>('.viewer-navigator img, .viewer-navigator canvas')!;
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ left, top, width, height,
      right: left + width, bottom: top + height } as DOMRect);
    return image;
  }

  function clickAt(target: Element, x: number, y: number, button = 0) {
    act(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true,
      button, detail: 1, clientX: x, clientY: y })));
  }

  function viewerPan() {
    const transform = host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform;
    const values = transform.match(/calc\(-50% \+ ([^p]+)px\), calc\(-50% \+ ([^p]+)px\)/)!;
    return { x: Number(values[1]), y: Number(values[2]) };
  }

  it('hides in Fit, shows for enlargement, and hides again after Fit restore', () => {
    renderJpeg();
    expect(host.querySelector('[data-testid="zoom-navigator"]')).toBeNull();
    click(button('1:1'));
    const navigator = host.querySelector<HTMLElement>('[data-testid="zoom-navigator"]')!;
    expect(navigator).not.toBeNull();
    expect(navigator.style.width).toBe('180px');
    expect(navigator.style.height).toBe('135px');
    expect(navigator.querySelector('img')?.getAttribute('src')).toBe('/navigator.jpg');
    click(button('Fit'));
    expect(host.querySelector('[data-testid="zoom-navigator"]')).toBeNull();
  });

  it('keeps the visible frame full-height when an image edge is smaller than the viewport', () => {
    act(() => root.render(<ImageViewer src="/wide.jpg" alt="photo" leftOpen rightOpen
      onToggleLeft={() => {}} onToggleRight={() => {}} />));
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    const image = host.querySelector<HTMLImageElement>('.viewer-image-position > img')!;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 800 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 200 });
    act(() => image.dispatchEvent(new Event('load')));
    act(() => resize());
    click(button('1:1'));
    const frame = host.querySelector<HTMLElement>('.viewer-navigator-frame')!;
    expect(parseFloat(frame.style.height)).toBeCloseTo(100, 4);
    expect(parseFloat(frame.style.top)).toBeCloseTo(0, 4);
  });

  it('mirrors the currently visible adjusted JPEG canvas for After and Before', () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage } as unknown as CanvasRenderingContext2D));
    const render = (before: boolean) => act(() => root.render(<ImageViewer src="/navigator-edited.jpg" alt="photo" leftOpen rightOpen
      editSource={{ kind: 'immich-preview', url: 'navigator-canvas' }} recipe={defaultRecipe()}
      persistentBeforeAdjustments={before} onToggleLeft={() => {}} onToggleRight={() => {}} />));
    render(false);
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    act(() => mockImage.onLoad?.(800, 600));
    act(() => resize());
    click(button('1:1'));
    const sourceCanvases = () => [...host.querySelectorAll<HTMLCanvasElement>('.viewer-comparison-image canvas')];
    const afterCanvas = sourceCanvases()[1];
    expect(drawImage.mock.calls.at(-1)?.[0]).toBe(afterCanvas);
    render(true);
    expect(drawImage.mock.calls.at(-1)?.[0]).toBe(sourceCanvases()[0]);
  });

  it('uses the shared zoom threshold and follows wheel zoom and pan in the visible frame', () => {
    const viewport = renderJpeg();
    click(button('1:1'));
    const frame = () => host.querySelector<HTMLElement>('.viewer-navigator-frame')!;
    expect(parseFloat(frame().style.width)).toBeCloseTo(50, 4);
    const initialLeft = parseFloat(frame().style.left);
    act(() => viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
      deltaY: -100, clientX: 200, clientY: 150 })));
    expect(parseFloat(frame().style.width)).toBeLessThan(50);
    Object.defineProperty(viewport, 'setPointerCapture', { value: vi.fn() });
    pointer(viewport, 'pointerdown', 200, 150);
    pointer(viewport, 'pointermove', 250, 170);
    pointer(viewport, 'pointerup', 250, 170);
    expect(parseFloat(frame().style.left)).not.toBe(initialLeft);
    fitRestoreKey();
    expect(host.querySelector('.viewer-navigator')).toBeNull();
    fitRestoreKey();
    expect(host.querySelector('.viewer-navigator')).not.toBeNull();
  });

  it('clamps the viewport frame to the image boundary after a large pan', () => {
    const viewport = renderJpeg();
    click(button('1:1'));
    Object.defineProperty(viewport, 'setPointerCapture', { value: vi.fn() });
    pointer(viewport, 'pointerdown', 200, 150);
    pointer(viewport, 'pointermove', 2000, 2000);
    pointer(viewport, 'pointerup', 2000, 2000);
    const frame = host.querySelector<HTMLElement>('.viewer-navigator-frame')!;
    const left = parseFloat(frame.style.left), top = parseFloat(frame.style.top);
    const width = parseFloat(frame.style.width), height = parseFloat(frame.style.height);
    expect(left).toBeGreaterThanOrEqual(0); expect(top).toBeGreaterThanOrEqual(0);
    expect(left + width).toBeLessThanOrEqual(100); expect(top + height).toBeLessThanOrEqual(100);
  });

  it('moves the image point under a Navigator background click to the Viewer center', () => {
    renderJpeg();
    click(button('1:1'));
    setNavigatorImageBounds();
    const navigator = host.querySelector<HTMLElement>('.viewer-navigator')!;
    clickAt(navigator, 118, 63);
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe('translate(calc(-50% + 200px), calc(-50% + 150px))');
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
  });

  it('centers a Navigator midpoint click and clamps all four corner clicks', () => {
    renderJpeg();
    click(button('1:1'));
    setNavigatorImageBounds();
    const navigator = host.querySelector<HTMLElement>('.viewer-navigator')!;
    clickAt(navigator, 118, 63, 2);
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe('translate(calc(-50% + 0px), calc(-50% + 0px))');
    act(() => navigator.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 118, clientY: 63 })));
    act(() => navigator.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0, clientX: 118, clientY: 63 })));
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
    clickAt(navigator, 190, 117.5);
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe('translate(calc(-50% + 0px), calc(-50% + 0px))');
    for (const [x, y, panX, panY] of [
      [100, 50, 200, 150], [280, 185, -200, -150], [100, 185, 200, -150], [280, 50, -200, 150],
    ]) {
      clickAt(navigator, x, y);
      expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform)
        .toBe(`translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px))`);
    }
    expect(host.querySelector('.zoom-controls output')!.textContent).toBe('100%');
  });

  it('drags the viewport frame with the grabbed offset and suppresses the trailing click', () => {
    const viewport = renderJpeg();
    click(button('1:1'));
    setNavigatorImageBounds();
    const navigator = host.querySelector<HTMLElement>('.viewer-navigator')!;
    const frame = host.querySelector<HTMLElement>('.viewer-navigator-frame')!;
    const capture = vi.fn();
    Object.defineProperty(navigator, 'setPointerCapture', { value: capture });
    const original = host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform;

    pointer(frame, 'pointerdown', 154, 97.25);
    pointer(navigator, 'pointerup', 154, 97.25);
    clickAt(navigator, 154, 97.25);
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe(original);

    pointer(frame, 'pointerdown', 154, 97.25);
    pointer(navigator, 'pointermove', 190, 124.25);
    pointer(navigator, 'pointerup', 190, 124.25);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(parseFloat(frame.style.left)).toBeCloseTo(45, 5);
    expect(parseFloat(frame.style.top)).toBeCloseTo(45, 5);
    expect(viewerPan().x).toBeCloseTo(-160, 5);
    expect(viewerPan().y).toBeCloseTo(-120, 5);
    clickAt(navigator, 262, 171.5);
    expect(viewerPan().x).toBeCloseTo(-160, 5);
    expect(viewerPan().y).toBeCloseTo(-120, 5);
  });

  it('clamps a dragged frame at Navigator boundaries and allows the next click after pointercancel', () => {
    const viewport = renderJpeg();
    click(button('1:1'));
    setNavigatorImageBounds();
    const navigator = host.querySelector<HTMLElement>('.viewer-navigator')!;
    const frame = host.querySelector<HTMLElement>('.viewer-navigator-frame')!;
    Object.defineProperty(navigator, 'setPointerCapture', { value: vi.fn() });
    pointer(frame, 'pointerdown', 154, 97.25);
    pointer(navigator, 'pointermove', 600, -200);
    pointer(navigator, 'pointercancel', 600, -200);
    expect(parseFloat(frame.style.left)).toBe(50);
    expect(parseFloat(frame.style.top)).toBe(0);
    expect(parseFloat(frame.style.left) + parseFloat(frame.style.width)).toBeLessThanOrEqual(100);
    expect(parseFloat(frame.style.top) + parseFloat(frame.style.height)).toBeLessThanOrEqual(100);
    expect(viewport.classList.contains('pannable')).toBe(true);
    clickAt(navigator, 118, 63);
    expect(viewerPan().x).toBeCloseTo(200, 5);
    expect(viewerPan().y).toBeCloseTo(150, 5);
  });

  it('shows RAW whole-frame sources for After and Before and excludes Region imagery', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const changed = vi.fn();
    const metadata = regionResponse();
    const geometry = { nativeWidth: 4000, nativeHeight: 3000, geometryId: metadata.geometryId };
    const layer = { url: 'blob:region-after', metadata, planGeneration: 1, ...regionLayerPlacement(metadata, geometry) };
    const whole = { url: 'blob:whole-after', doc: { workspaceId: 'w', handle: 'h', ...metadata.identity, revision: 2 },
      frame: { ...geometry, fullWidth: 4000, fullHeight: 3000, aspect: 4 / 3, window: null }, quality: 'full' as const };
    const display: RawRegionDisplay = { after: layer, wholeAfter: whole,
      before: { ...layer, url: 'blob:region-before' }, wholeBefore: { ...whole, url: 'blob:whole-before' } };
    const render = (before: boolean) => act(() => root.render(<ImageViewer src="blob:raw-source" documentKey="raw-nav"
      rawFrame={geometry} rawRegionDisplay={display} beforeSrc="blob:before-fallback" previewPixels onRawViewChange={changed}
      persistentBeforeAdjustments={before} alt="raw" leftOpen rightOpen onToggleLeft={() => {}} onToggleRight={() => {}} />));
    render(false);
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 } as DOMRect);
    act(() => resize());
    const image = host.querySelector<HTMLImageElement>('.raw-whole-base')!;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 4000 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 3000 });
    act(() => image.dispatchEvent(new Event('load')));
    click(button('1:1'));
    const navigatorImage = () => host.querySelector<HTMLImageElement>('.viewer-navigator img')!;
    expect(navigatorImage().getAttribute('src')).toBe('blob:whole-after');
    expect(navigatorImage().getAttribute('src')).not.toContain('blob:region');
    expect(host.querySelector<HTMLElement>('.viewer-navigator')?.dataset.position).toBe('bottom-right');
    setNavigatorImageBounds(0, 0, 180, 135);
    const navigator = host.querySelector<HTMLElement>('.viewer-navigator')!;
    clickAt(navigator, 0, 0);
    const transform = host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform;
    expect(transform).toBe('translate(calc(-50% + 600px), calc(-50% + 450px))');
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ panX: 600, panY: 450, fit: false }));
    render(true);
    expect(navigatorImage().getAttribute('src')).toBe('blob:whole-before');
    expect(host.querySelector<HTMLElement>('.viewer-image-position')!.style.transform).toBe(transform);
  });

  it('routes RAW frame dragging through RawView and ends with interacting false', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const changed = vi.fn();
    act(() => root.render(<ImageViewer src="blob:raw-drag" documentKey="raw-drag" previewPixels
      rawFrame={{ nativeWidth: 2000, nativeHeight: 1500, geometryId: 'a'.repeat(64) }} onRawViewChange={changed}
      alt="raw" leftOpen rightOpen onToggleLeft={() => {}} onToggleRight={() => {}} />));
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    act(() => resize());
    const image = host.querySelector<HTMLImageElement>('.raw-whole-base')!;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 2000 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 1500 });
    act(() => image.dispatchEvent(new Event('load')));
    click(button('1:1'));
    setNavigatorImageBounds();
    const navigator = host.querySelector<HTMLElement>('.viewer-navigator')!;
    const frame = host.querySelector<HTMLElement>('.viewer-navigator-frame')!;
    Object.defineProperty(navigator, 'setPointerCapture', { value: vi.fn() });
    pointer(frame, 'pointerdown', 163, 97.25);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ interacting: true }));
    pointer(navigator, 'pointermove', 199, 124.25);
    const movingView = changed.mock.calls.map(call => call[0]).find(view => view.interacting && view.panX !== 0)!;
    expect(movingView.panX).toBeCloseTo(-200, 5);
    expect(movingView.panY).toBeCloseTo(-150, 5);
    pointer(navigator, 'pointerup', 199, 124.25);
    const finalView = changed.mock.calls.at(-1)![0];
    expect(finalView.panX).toBeCloseTo(-200, 5);
    expect(finalView.panY).toBeCloseTo(-150, 5);
    expect(finalView.interacting).toBe(false);
    expect(parseFloat(frame.style.left)).toBeCloseTo(50, 5);
    expect(parseFloat(frame.style.top)).toBeCloseTo(50, 5);
  });

  it('returns RAW interaction to false on pointercancel and accepts the next background click', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const changed = vi.fn();
    act(() => root.render(<ImageViewer src="blob:raw-cancel" documentKey="raw-cancel" previewPixels
      rawFrame={{ nativeWidth: 2000, nativeHeight: 1500, geometryId: 'b'.repeat(64) }} onRawViewChange={changed}
      alt="raw" leftOpen rightOpen onToggleLeft={() => {}} onToggleRight={() => {}} />));
    const viewport = host.querySelector<HTMLElement>('.viewer-viewport')!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 300 });
    act(() => resize());
    const image = host.querySelector<HTMLImageElement>('.raw-whole-base')!;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 2000 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 1500 });
    act(() => image.dispatchEvent(new Event('load')));
    click(button('1:1'));
    setNavigatorImageBounds();
    const navigator = host.querySelector<HTMLElement>('.viewer-navigator')!;
    const frame = host.querySelector<HTMLElement>('.viewer-navigator-frame')!;
    Object.defineProperty(navigator, 'setPointerCapture', { value: vi.fn() });
    pointer(frame, 'pointerdown', 163, 97.25);
    pointer(navigator, 'pointermove', 199, 124.25);
    pointer(navigator, 'pointercancel', 199, 124.25);
    const cancelledView = changed.mock.calls.at(-1)![0];
    expect(cancelledView.interacting).toBe(false);
    expect(cancelledView.panX).toBeCloseTo(-200, 5);
    expect(cancelledView.panY).toBeCloseTo(-150, 5);
    clickAt(navigator, 118, 63);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ panX: 300, panY: 225, interacting: true }));
  });

  it('applies all configured positions and turns the Navigator off while zoomed', () => {
    renderJpeg();
    click(button('1:1'));
    expect(host.querySelector<HTMLElement>('.viewer-navigator')?.dataset.position).toBe('bottom-right');
    for (const position of ZOOM_NAVIGATOR_POSITIONS.slice(1)) {
      act(() => updateSetting('zoomNavigatorPosition', position));
      expect(host.querySelector<HTMLElement>('.viewer-navigator')?.dataset.position).toBe(position);
    }
    act(() => updateSetting('zoomNavigatorPosition', 'off'));
    expect(host.querySelector('.viewer-navigator')).toBeNull();
    click(button('Fit'));
    expect(host.querySelector('.viewer-navigator')).toBeNull();
  });

  it('defaults and falls back to bottom-right for an invalid saved position', () => {
    localStorage.removeItem(ZOOM_NAVIGATOR_POSITION_KEY);
    expect(readSettings().zoomNavigatorPosition).toBe('bottom-right');
    localStorage.setItem(ZOOM_NAVIGATOR_POSITION_KEY, 'center');
    expect(readSettings().zoomNavigatorPosition).toBe('bottom-right');
  });
});
