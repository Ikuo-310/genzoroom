import { describe, expect, it, vi } from 'vitest';
import type { AssetDetail } from './assets';
import type { ExportQueueItem } from './exportQueueApi';
import { MAX_EXPORT_ENGINE_CANDIDATES, resolveExportQueueCandidates } from './exportQueueCandidates';

const assetId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const item = (index: number): ExportQueueItem => ({ assetId: assetId(index), status: 'queued',
  queuedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
const detail = (index: number, format = 'JPEG', is_raw = false): AssetDetail => ({ id: assetId(index), filename: `photo-${index}`,
  date: '2026-10-01T00:00:00.000Z', thumbnail_url: `/thumb/${index}`, format, is_raw, preview_url: `/preview/${index}`, exif: {} });

describe('resolveExportQueueCandidates', () => {
  it('keeps Queue order, skips non-JPEG/RAW and detail failures, and stops at ten matches', async () => {
    const items = [item(0), item(1), item(2), ...Array.from({ length: 10 }, (_, index) => item(index + 3)), item(13)];
    const getDetail = vi.fn(async (id: string) => {
      const index = Number(id.slice(-2));
      if (index === 2) throw new Error('PRIVATE_DETAIL_ERROR');
      if (index === 0) return detail(index, 'JPEG', true);
      if (index === 1) return detail(index, 'HEIC');
      return detail(index);
    });
    const result = await resolveExportQueueCandidates(items, new AbortController().signal, getDetail);
    expect(result.map(asset => asset.id)).toEqual(Array.from({ length: 10 }, (_, index) => assetId(index + 3)));
    expect(result).toHaveLength(MAX_EXPORT_ENGINE_CANDIDATES);
    expect(getDetail.mock.calls.map(([id]) => id)).toEqual(items.slice(0, 13).map(row => row.assetId));
    expect(getDetail).not.toHaveBeenCalledWith(assetId(13), expect.any(AbortSignal));
  });

  it('fails safely only when all Queue details are unavailable', async () => {
    const getDetail = vi.fn(async () => { throw new Error('PRIVATE_DETAIL_ERROR'); });
    await expect(resolveExportQueueCandidates([item(1), item(2)], new AbortController().signal, getDetail))
      .rejects.toThrow('queue_candidate_load_failed');
    expect(getDetail).toHaveBeenCalledTimes(2);
  });

  it('propagates cancellation instead of turning it into a partial list', async () => {
    const controller = new AbortController();
    const getDetail = vi.fn(async () => { controller.abort(); throw new Error('aborted'); });
    await expect(resolveExportQueueCandidates([item(1), item(2)], controller.signal, getDetail)).rejects.toThrow('aborted');
    expect(getDetail).toHaveBeenCalledOnce();
  });
});
