// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { RealJpegDiagnostics } from './RealJpegDiagnostics';
import type { JpegDiagnosticsDependencies } from './jpegDiagnostics';
import type { RecentAsset } from './assets';
import i18n from './i18n';
import { createDiagnosticsReport, collectDiagnosticsEnvironment, createWebGpuReport } from './developerDiagnostics';

let host: HTMLDivElement, root: Root, originalLanguage: string;
const asset = (id: string): RecentAsset => ({ id, filename: `PRIVATE_${id}.JPG`, date: 'PRIVATE_DATE', thumbnail_url: `/PRIVATE_THUMB/${id}`, format: 'JPEG', is_raw: false });
function setup() {
  const blob = new Blob(['jpeg']);
  const dependencies: Partial<JpegDiagnosticsDependencies> = {
    recent: vi.fn(async () => [asset('first'), asset('raw'), ...Array.from({ length: 12 }, (_, i) => asset(String(i)))]
      .map(row => row.id === 'raw' ? { ...row, is_raw: true } : row)),
    fetch: vi.fn(async () => ({ ok: true, blob: async () => blob }) as Response),
    profile: vi.fn(async () => ({ status: 'none' as const })),
    decode: vi.fn(async () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]), width: 1, height: 1 }) as ImageData),
    cpu: vi.fn(source => source.slice()),
    histogram: vi.fn(() => ({ r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), y: new Uint32Array(256) })),
    gpuAvailable: vi.fn(() => false), createRenderer: vi.fn(async () => null), yield: vi.fn(async () => {}),
  };
  const onReport = vi.fn();
  return { dependencies, onReport };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  originalLanguage = i18n.language;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:jpeg-ui') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(async () => {
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(URL, 'createObjectURL'); Reflect.deleteProperty(URL, 'revokeObjectURL');
  await i18n.changeLanguage(originalLanguage);
});
const button = (key: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === i18n.t(`jpegDiagnostics.${key}`))!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };

it.each(['en', 'ja'])('selects thumbnails, keeps the manual filename, returns to automatic, and exports no private data in %s', async language => {
  await i18n.changeLanguage(language); const fake = setup();
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  await act(async () => root.render(<StrictMode><RealJpegDiagnostics {...fake} /></StrictMode>));
  expect(fake.dependencies.recent).not.toHaveBeenCalled(); expect(fake.dependencies.fetch).not.toHaveBeenCalled();
  expect(fake.dependencies.decode).not.toHaveBeenCalled(); expect(fake.dependencies.createRenderer).not.toHaveBeenCalled();
  expect(host.textContent).toContain(i18n.t('jpegDiagnostics.title'));
  expect(host.querySelectorAll('tbody tr')).toHaveLength(17);
  await click(button('choose'));
  expect(fake.dependencies.recent).toHaveBeenCalledExactlyOnceWith(50, expect.any(AbortSignal));
  const candidates = host.querySelectorAll<HTMLButtonElement>('.developer-jpeg-candidates button');
  expect(candidates).toHaveLength(10); expect(candidates[0].textContent).toContain('PRIVATE_first.JPG');
  expect([...candidates].some(element => element.textContent?.includes('PRIVATE_raw.JPG'))).toBe(false);
  expect(host.querySelectorAll('.developer-jpeg-candidates img')).toHaveLength(10);
  await click(candidates[1]);
  expect(candidates[1].getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('.developer-jpeg-target')!.textContent).toContain(`${i18n.t('jpegDiagnostics.selection.manual')}: PRIVATE_0.JPG`);
  await click(button('run')); await click(button('run'));
  expect(fake.dependencies.recent).toHaveBeenCalledOnce();
  expect(fake.dependencies.fetch).toHaveBeenCalledTimes(2);
  expect(fake.dependencies.fetch).toHaveBeenLastCalledWith('/api/assets/0/original', expect.objectContaining({ cache: 'no-store' }));
  expect(host.textContent).toContain('1 × 1'); expect(host.querySelector('tbody')!.textContent).toMatch(/\d+\.\d{2} ms/);
  expect(host.textContent).not.toMatch(/jpegDiagnostics\./);
  const manualReport = fake.onReport.mock.calls.at(-1)![0];
  expect(manualReport.selectionMode).toBe('manual'); expect(manualReport.timing.assetLookupMs).toBeNull();
  const exported = createDiagnosticsReport(collectDiagnosticsEnvironment(), createWebGpuReport(false, null), new Date(), manualReport);
  // Filenames are intentionally visible above but never part of the exported JPEG report.
  expect(JSON.stringify(exported)).not.toMatch(/PRIVATE_|filename|thumbnail_url|assetId|exif|recipe"|pixels"/i);
  await click(button('automatic')); expect(host.querySelector('.developer-jpeg-target')!.textContent).toBe(i18n.t('jpegDiagnostics.selection.automatic'));
  await click(button('run'));
  expect(fake.dependencies.recent).toHaveBeenCalledTimes(2);
  expect(host.querySelector('.developer-jpeg-target')!.textContent).toBe(`${i18n.t('jpegDiagnostics.selection.automatic')}: PRIVATE_first.JPG`);
  expect(fake.onReport.mock.calls.at(-1)![0].selectionMode).toBe('automatic');
  expect(storage).not.toHaveBeenCalled();
});

it.each(['empty', 'failed'])('shows the candidate %s state without starting a run', async mode => {
  const fake = setup();
  if (mode === 'empty') vi.mocked(fake.dependencies.recent!).mockResolvedValue([]);
  else vi.mocked(fake.dependencies.recent!).mockRejectedValue(new Error('private lookup error'));
  await act(async () => root.render(<RealJpegDiagnostics {...fake} />));
  await click(button('choose'));
  expect(host.textContent).toContain(i18n.t(`jpegDiagnostics.candidates.${mode}`));
  expect(fake.dependencies.fetch).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('private lookup error');
});

it('guards double clicks and selection changes during a run, aborts on departure and ignores late results', async () => {
  const fake = setup(); let resolve!: (value: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  vi.mocked(fake.dependencies.fetch!).mockReturnValue(pending);
  await act(async () => root.render(<RealJpegDiagnostics {...fake} />));
  await click(button('choose')); await click(host.querySelector<HTMLButtonElement>('.developer-jpeg-candidates button')!);
  await click(button('run'));
  expect(button('run').disabled).toBe(true); expect(button('choose').disabled).toBe(true); expect(button('automatic').disabled).toBe(true);
  expect([...host.querySelectorAll<HTMLButtonElement>('.developer-jpeg-candidates button')].every(element => element.disabled)).toBe(true);
  await click(button('run')); expect(fake.dependencies.fetch).toHaveBeenCalledOnce();
  const signal = vi.mocked(fake.dependencies.fetch!).mock.calls[0][1]!.signal!;
  act(() => root.unmount()); root = createRoot(host); expect(signal.aborted).toBe(true);
  const updates = fake.onReport.mock.calls.length;
  await act(async () => resolve({ ok: true, blob: async () => new Blob(['jpeg']) } as Response));
  expect(fake.onReport).toHaveBeenCalledTimes(updates); expect(fake.dependencies.decode).not.toHaveBeenCalled();
});

it('aborts pending candidates on pagehide and starts with a fresh owner on history-cache restore', async () => {
  const fake = setup(); let resolve!: (value: RecentAsset[]) => void;
  vi.mocked(fake.dependencies.recent!).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await act(async () => root.render(<RealJpegDiagnostics {...fake} />));
  await click(button('choose'));
  const signal = vi.mocked(fake.dependencies.recent!).mock.calls[0][1];
  act(() => window.dispatchEvent(new PageTransitionEvent('pagehide'))); expect(signal.aborted).toBe(true);
  await act(async () => resolve([asset('late')])); expect(host.querySelector('.developer-jpeg-candidates')).toBeNull();
  await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  expect(button('run').disabled).toBe(false); await click(button('run'));
  expect(fake.dependencies.fetch).toHaveBeenCalledOnce();
});
