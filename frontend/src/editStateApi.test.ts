import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditStateSaveId, getAssetEditState, getAssetEditStatuses, putAssetEditState, EditStateApiError } from './editStateApi';
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
  it('gets 100 statuses in one request and deduplicates requested IDs', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `asset-${index}`);
    const edited = Object.fromEntries(ids.map(id => [id, false]));
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ edited })));
    vi.stubGlobal('fetch', fetcher);
    expect(await getAssetEditStatuses([...ids, ids[0]], new AbortController().signal)).toEqual(edited);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/api/assets/edit-status');
    expect(JSON.parse(fetcher.mock.calls[0][1].body).assetIds).toEqual(ids);
    expect(await getAssetEditStatuses([], new AbortController().signal)).toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([{ edited: {} }, { edited: { a: 'false' } }, { edited: { a: false, b: true } }, {}])
    ('rejects incomplete or malformed status responses %j', async body => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
      await expect(getAssetEditStatuses(['a'], new AbortController().signal)).rejects.toMatchObject({ kind: 'invalid_state' });
    });
  it('creates UUID save IDs when randomUUID is unavailable in an insecure context', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => { bytes.fill(0); return bytes; } } as unknown as Crypto);
    const id = createEditStateSaveId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('reads an absent or saved state and rejects a mismatched source identity', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ state: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(saved), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...saved, state: { ...snapshot, sourceIdentity: { ...sourceIdentity, assetId: 'other' } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await getAssetEditState(assetId, new AbortController().signal)).toEqual({ state: null });
    expect(await getAssetEditState(assetId, new AbortController().signal)).toEqual(saved);
    await expect(getAssetEditState(assetId, new AbortController().signal)).rejects.toMatchObject({ kind: 'invalid_state' });
  });

  it('normalizes a v17 GET in memory without sending PUT', async () => {
    const { adjustmentEnabled: _flags, ...fields } = snapshot.currentRecipe;
    const old = { ...saved, state: { ...snapshot, recipeVersion: 17, currentRecipe: { ...fields, version: 17 } } };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(old), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await getAssetEditState(assetId, new AbortController().signal)).toEqual(saved);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('method', 'PUT');
    expect(old.state.currentRecipe.version).toBe(17);
    expect(old.state.currentRecipe).not.toHaveProperty('adjustmentEnabled');
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

  it.each([408, 500, 502, 503, 504])('treats PUT HTTP %i as uncertain without changing GET classification', async status => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('proxy failure', { status })));
    await expect(putAssetEditState(assetId, snapshot, 0, crypto.randomUUID()))
      .rejects.toMatchObject({ status, saveOutcome: 'unknown' });
    await expect(getAssetEditState(assetId, new AbortController().signal))
      .rejects.toMatchObject({ status, saveOutcome: 'rejected' });
  });

  it.each([409, 413, 422])('treats PUT HTTP %i as a confirmed rejection', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    await expect(putAssetEditState(assetId, snapshot, 0, crypto.randomUUID()))
      .rejects.toMatchObject({ status, saveOutcome: 'rejected' });
  });

  it.each(['broken JSON', '{}', JSON.stringify({ state: null }), JSON.stringify(saved)])
    ('keeps an unreadable or mismatched PUT acknowledgement uncertain: %s', async body => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
      await expect(putAssetEditState(assetId, snapshot, 0, crypto.randomUUID()))
        .rejects.toMatchObject({ kind: 'invalid_state', saveOutcome: 'unknown' });
    });

  it('keeps Abort uncertain and accepts a matching acknowledgement on retry', async () => {
    const saveId = crypto.randomUUID();
    const fetcher = vi.fn().mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...saved, revision: 1, lastSaveId: saveId })));
    vi.stubGlobal('fetch', fetcher);
    await expect(putAssetEditState(assetId, snapshot, 0, saveId)).rejects.toMatchObject({ saveOutcome: 'unknown' });
    await expect(putAssetEditState(assetId, snapshot, 0, saveId)).resolves.toMatchObject({ revision: 1, lastSaveId: saveId });
    expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[0][1].body);
  });
});
