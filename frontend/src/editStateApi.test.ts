import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAssetEditState, putAssetEditState, EditStateApiError } from './editStateApi';
import { createEditStateSnapshot } from './editState';
import { newSession } from './editing';

const assetId = '12345678-1234-4234-9234-123456789abc';
const sourceIdentity = { provider: 'immich' as const, assetId, inputKind: 'immich-preview' as const };
const snapshotResult = createEditStateSnapshot(newSession(), sourceIdentity);
if (!snapshotResult.ok) throw new Error('Invalid test snapshot');
const snapshot = snapshotResult.value;
const saved = { state: snapshot, revision: 2, updatedAt: '2026-09-25T00:00:00Z', lastSaveId: crypto.randomUUID() };

afterEach(() => vi.unstubAllGlobals());

describe('edit-state API client', () => {
  it('reads an absent or saved state and rejects a mismatched source identity', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ state: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(saved), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...saved, state: { ...snapshot, sourceIdentity: { ...sourceIdentity, assetId: 'other' } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await getAssetEditState(assetId, new AbortController().signal)).toEqual({ state: null });
    expect(await getAssetEditState(assetId, new AbortController().signal)).toEqual(saved);
    await expect(getAssetEditState(assetId, new AbortController().signal)).rejects.toMatchObject({ kind: 'invalid_state' });
  });

  it.each([
    [409, 'revision_conflict', 'conflict'], [409, 'save_id_reused', 'conflict'],
    [413, 'payload_too_large', 'too_large'], [422, 'invalid_payload', 'invalid_state'],
    [503, 'persistence_unavailable', 'unavailable'], [500, 'other', 'unexpected'],
  ] as const)('classifies HTTP %i / %s as %s', async (status, code, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: { code } }), { status })));
    await expect(putAssetEditState(assetId, snapshot, 0, crypto.randomUUID()))
      .rejects.toMatchObject({ kind, status, code });
  });

  it('preserves a network failure without leaking its exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private network address')));
    const error = await getAssetEditState(assetId, new AbortController().signal).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EditStateApiError);
    expect(error).toMatchObject({ kind: 'network', message: 'network' });
  });
});
