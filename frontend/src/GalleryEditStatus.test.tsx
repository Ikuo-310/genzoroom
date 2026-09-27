// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryPage } from './GalleryPage';
import { useEditStatuses } from './useEditStatuses';
import i18n from './i18n';

const api = vi.hoisted(() => ({ recent: vi.fn(), statuses: vi.fn() }));
vi.mock('./api', async original => ({ ...(await original<typeof import('./api')>()), fetchRecentAssets: api.recent }));
vi.mock('./editStateApi', async original => ({ ...(await original<typeof import('./editStateApi')>()), getAssetEditStatuses: api.statuses }));
const assets = Array.from({ length: 100 }, (_, index) => ({ id: `asset-${index}`, filename: `photo-${index}.jpg`,
  date: '2026-09-27', thumbnail_url: `/thumb/${index}`, format: index % 2 ? 'DNG' : 'JPEG', is_raw: !!(index % 2) }));
let root: Root;
let host: HTMLDivElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function mount() { await act(async () => { root.render(<MemoryRouter><GalleryPage /></MemoryRouter>); }); }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await i18n.changeLanguage('en');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.recent.mockReset(); api.statuses.mockReset();
  api.recent.mockResolvedValue(assets);
  api.statuses.mockResolvedValue(Object.fromEntries(assets.map((asset, index) => [asset.id, index === 0])));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
    ? { status: 'ok' } : { configured: true, connected: true }))));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('Home bulk edit status', () => {
  it('fetches all 100 photos once, retains selection and does not refetch for filters', async () => {
    await mount();
    expect(host.querySelectorAll('.photo-card')).toHaveLength(100);
    expect(host.querySelectorAll('.edited-badge')).toHaveLength(1);
    expect(host.querySelector('.photo-card-button')?.getAttribute('aria-description')).toBe('Edited in GenzoRoom');
    expect(api.statuses).toHaveBeenCalledTimes(1);
    expect(api.statuses.mock.calls[0][0]).toEqual(assets.map(asset => asset.id));
    act(() => host.querySelector<HTMLInputElement>('.photo-selection-input')!.click());
    expect(host.querySelector('.selection-bar')?.textContent).toContain('1 selected');
    act(() => host.querySelector<HTMLInputElement>('.photo-filters input')!.click());
    expect(host.querySelectorAll('.photo-card')).toHaveLength(50);
    expect(host.querySelectorAll('.edited-badge')).toHaveLength(1);
    expect(api.statuses).toHaveBeenCalledTimes(1);
    act(() => host.querySelector<HTMLInputElement>('.photo-filters input')!.click());
    expect(host.querySelectorAll('.photo-card')).toHaveLength(100);
    expect(host.querySelector('.photo-card.selected')).not.toBeNull();
  });

  it('rechecks only service status and preserves a pending edit-status response', async () => {
    const waiting = deferred<Record<string, boolean>>();
    api.statuses.mockReturnValueOnce(waiting.promise);
    await mount();
    expect(host.querySelector('.edited-badge')).toBeNull();
    expect(host.querySelector('.connection-control')?.classList.contains('connected')).toBe(true);
    act(() => host.querySelector<HTMLElement>('.connection-control summary')!.click());
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check again')!;
    await act(async () => retry.click());
    expect(api.statuses).toHaveBeenCalledTimes(1);
    expect(api.recent).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.photo-card')).not.toBeNull();
    await act(async () => waiting.resolve(Object.fromEntries(assets.map(asset => [asset.id, true]))));
    expect(host.querySelectorAll('.edited-badge')).toHaveLength(100);
  });

  it('shows detailed connection states and supports keyboard disclosure controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
      ? { status: 'ok' } : { configured: false, connected: false }))));
    await mount();
    const details = host.querySelector<HTMLDetailsElement>('.connection-control')!;
    const summary = details.querySelector<HTMLElement>('summary')!;
    expect(details.classList.contains('not-configured')).toBe(true);
    expect(summary.getAttribute('aria-label')).toContain('Immich not configured');
    await act(async () => summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('Backend: Connected');
    expect(details.textContent).toContain('Immich: Not configured');
    expect(details.textContent).toContain('Set the Immich URL');
    await act(async () => details.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it('keeps the status neutral and the retry action disabled while checks are pending', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string) => url === '/api/health'
      ? pending.promise : Promise.resolve(new Response(JSON.stringify({ configured: true, connected: true })))));
    await mount();
    const details = host.querySelector<HTMLDetailsElement>('.connection-control')!;
    expect(details.classList.contains('checking')).toBe(true);
    expect(details.textContent).toContain('Checking');
    const summary = details.querySelector<HTMLElement>('summary')!;
    await act(async () => summary.click());
    expect(details.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    await act(async () => pending.resolve(new Response(JSON.stringify({ status: 'ok' }))));
    expect(details.classList.contains('connected')).toBe(true);
  });

  it('marks backend or Immich failures without conflating an unconfigured Immich', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/health'
      ? { status: 'failed' } : { configured: true, connected: false }))));
    await mount();
    const details = host.querySelector('.connection-control')!;
    expect(details.classList.contains('error')).toBe(true);
    expect(details.querySelector('summary')?.getAttribute('aria-label')).toContain('Connection problem');
    expect(details.textContent).toContain('Backend: Connection failed');
    expect(details.textContent).toContain('Immich: Connection failed');
  });

  it('keeps the Home title interaction local without clearing photo selection', async () => {
    await mount();
    act(() => host.querySelector<HTMLInputElement>('.photo-selection-input')!.click());
    expect(host.querySelector('.selection-bar')?.textContent).toContain('1 selected');
    act(() => host.querySelector<HTMLButtonElement>('.home-title-link')!.click());
    expect(host.querySelector('.selection-bar')?.textContent).toContain('1 selected');
    expect(host.querySelectorAll('.photo-card')).toHaveLength(100);
  });

  it('keeps a failed lookup unknown and ignores responses after unmount', async () => {
    function Harness() {
      const statuses = useEditStatuses(['a']);
      return <p>{statuses.a === undefined ? 'unknown' : String(statuses.a)}</p>;
    }
    api.statuses.mockRejectedValueOnce(new Error('unavailable'));
    await act(async () => root.render(<Harness />));
    expect(host.textContent).toBe('unknown');
    const waiting = deferred<Record<string, boolean>>();
    api.statuses.mockReturnValueOnce(waiting.promise);
    await act(async () => root.render(<div />));
    await act(async () => root.render(<Harness />));
    const signal = api.statuses.mock.calls.at(-1)![1] as AbortSignal;
    await act(async () => root.render(<div />));
    await act(async () => waiting.resolve({ a: true }));
    expect(signal.aborted).toBe(true);
    expect(host.querySelector('.edited-badge')).toBeNull();
  });
});
