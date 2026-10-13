import css from './style.css?raw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exclusionTarget, getExclusionStatuses, saveExclusion } from './developmentExclusionsApi';
import type { RecentAsset } from './assets';
const id = '12345678-1234-4234-9234-123456789abc';
const other = '87654321-4321-4321-8321-cba987654321';
const photo: RecentAsset = { id, filename: 'photo.jpg', date: '2026-10-06', thumbnail_url: '/thumb', format: 'JPEG', is_raw: false };
const target = exclusionTarget(photo)!;
afterEach(() => vi.unstubAllGlobals());
describe('development exclusion API boundary', () => {
  it('sends only the Backend target fields and preserves unknown configuration', async () => {
    const fetcher = vi.fn(async (_path: string, _init: RequestInit) => new Response(JSON.stringify({ items: [{ kind: 'asset', id, excluded: true, configuration: 'unknown' }] })));
    vi.stubGlobal('fetch', fetcher);
    expect((await getExclusionStatuses([target], new AbortController().signal))[0]).toMatchObject({ excluded: true, configuration: 'unknown' });
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ targets: [{ kind: 'asset', id }] });
  });
  it.each([
    { items: [] }, { items: [{ kind: 'asset', id: other, excluded: true, configuration: 'single' }] },
    { items: [{ kind: 'stack', id, excluded: true, configuration: 'confirmed' }] },
    { items: [{ kind: 'asset', id, excluded: 'true', configuration: 'single' }] },
  ])('rejects missing or mismatched status results', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(getExclusionStatuses([target], new AbortController().signal)).rejects.toThrow();
  });
  it('requires a confirmed matching PUT result and an exact DELETE acknowledgement', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'asset', id, excluded: true, configuration: 'stacked' })))
      .mockResolvedValueOnce(new Response('', { status: 200 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(saveExclusion(target, true, new AbortController().signal)).rejects.toThrow();
    await expect(saveExclusion(target, false, new AbortController().signal)).rejects.toThrow();
    await expect(saveExclusion(target, false, new AbortController().signal)).resolves.toBeUndefined();
  });
  it('requires a complete consistent local Stack, independent of member display order', () => {
    const stack = { ...photo, stackId: other, primaryAssetId: id, stackAssetCount: 2, stackMemberIds: [id, other] };
    expect(exclusionTarget(stack)?.signature).toBe(exclusionTarget({ ...stack, stackMemberIds: [other, id] })?.signature);
    expect(exclusionTarget({ ...stack, stackMemberIds: [id, id] })).toBeNull();
    expect(exclusionTarget({ ...stack, stackAssetCount: 3 })).toBeNull();
    expect(exclusionTarget({ ...stack, primaryAssetId: null })).toBeNull();
  });
  it('sends the exact Queue-checked Stack snapshot on PUT, but not on DELETE or single PUT', async () => {
    const stackTarget = exclusionTarget({ ...photo, stackId: other, primaryAssetId: id, stackAssetCount: 2, stackMemberIds: [other, id] })!;
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'stack', id: other, excluded: true, configuration: 'confirmed' })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'asset', id, excluded: true, configuration: 'single' })));
    vi.stubGlobal('fetch', fetcher);
    await saveExclusion(stackTarget, true, new AbortController().signal);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ expectedPrimaryAssetId: id, expectedMemberIds: [id, other].sort() });
    await saveExclusion(stackTarget, false, new AbortController().signal);
    await saveExclusion(target, true, new AbortController().signal);
    expect(fetcher.mock.calls[1][1].body).toBeUndefined();
    expect(fetcher.mock.calls[2][1].body).toBeUndefined();
  });
  it('dims only image and filename, leaving card controls and badges visible', () => {
    expect(css).toMatch(/\.photo-card\.development-excluded \.thumbnail > img,\s*\.photo-card\.development-excluded \.photo-info > p\s*\{\s*opacity: 0\.25;/);
    expect(css).not.toMatch(/\.photo-card\.development-excluded\s*\{/);
  });
});
