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

  it('does not let an older status response overwrite a refreshed list', async () => {
    const waiting = deferred<Record<string, boolean>>();
    api.statuses.mockReturnValueOnce(waiting.promise);
    await mount();
    expect(host.querySelector('.edited-badge')).toBeNull();
    api.statuses.mockResolvedValue(Object.fromEntries(assets.map(asset => [asset.id, false])));
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Check again')!;
    await act(async () => retry.click());
    expect(api.statuses).toHaveBeenCalledTimes(2);
    await act(async () => waiting.resolve(Object.fromEntries(assets.map(asset => [asset.id, true]))));
    expect(host.querySelector('.edited-badge')).toBeNull();
    expect(api.statuses.mock.calls[0][1].aborted).toBe(true);
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
