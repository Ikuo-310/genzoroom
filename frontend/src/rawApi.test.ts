// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rawCapability, rawPreview, readRawSettings, setRawControls, saveRawRecipe, saveRawHistory, readRawHistory, readRawRecipe, rawWorkspaceEmpty,
  RawSaveError, type RawDocument, type RawHistoryRequest, type RawHistoryOperation } from './rawApi';
import { rawSettings } from './test/rawSettings';
import { RawSuperseded } from './rawApi';
import { rawHistoryResult, rawHistoryPage } from './test/rawHistory';

const doc: RawDocument = { workspaceId: 'a'.repeat(32), handle: 'b'.repeat(32), documentToken: 'c'.repeat(32),
  assetId: 'asset', generation: 1, revision: 2 };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function response(patch: Record<string, string> = {}, bytes = png) {
  return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'X-Raw-Generation': '1',
    'X-Raw-Token': doc.documentToken, 'X-Raw-Revision': '2', 'X-Raw-Serial': '3',
    'X-Raw-Epoch': '1', 'X-Raw-Sequence': '1', 'X-Raw-Width': '16', 'X-Raw-Height': '12', ...patch } });
}
afterEach(() => vi.unstubAllGlobals());

it.each([undefined, 1, 2])('keeps Whole availability independent of optional Region capability %s', async regionContract => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ available: true, version: '0.10.0',
    ...(regionContract === undefined ? {} : { regionContract }) }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  expect(await rawCapability()).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/raw/capabilities');
});

const adaptiveTarget = { quality: 'draft' as const, mode: 'whole' as const, maxSide: 1024, viewGeneration: 4, geometryId: null };
it('accepts an actual larger bitmap and rejects responses larger than their requested target', async () => {
  const frame = { ...geometry, fullWidth: 1600, fullHeight: 1200 };
  vi.stubGlobal('fetch', vi.fn(async () => response({ ...adaptiveHeaders(), 'X-Raw-Width': '1600', 'X-Raw-Height': '1200', 'X-Raw-Frame': JSON.stringify(frame) })));
  expect((await rawPreview(doc, 3, new AbortController().signal, 'after', { ...adaptiveTarget, maxSide: 1600 })).width).toBe(1600);
  await expect(rawPreview(doc, 3, new AbortController().signal, 'after', adaptiveTarget)).rejects.toThrow();
  await expect(rawPreview(doc, 3, new AbortController().signal, 'after', { ...adaptiveTarget, maxSide: 2049 })).rejects.toThrow();
});
const geometry = { geometryId: 'a'.repeat(64), nativeWidth: 6000, nativeHeight: 4500, aspect: 4 / 3,
  fullWidth: 16, fullHeight: 12, window: null };
const adaptiveHeaders = () => ({ 'X-Raw-Preview-Contract': '1', 'X-Raw-Quality': 'draft', 'X-Raw-Mode': 'whole',
  'X-Raw-View-Generation': '4', 'X-Raw-Frame': JSON.stringify(geometry) });
it('keeps logical geometry separate from bitmap dimensions and sends display identity', async () => {
  const fetch = vi.fn(async () => response(adaptiveHeaders())); vi.stubGlobal('fetch', fetch);
  const frame = await rawPreview(doc, 3, new AbortController().signal, 'after', adaptiveTarget);
  expect(frame.frame?.nativeWidth).toBe(6000); expect(frame.width).toBe(16); expect(frame.quality).toBe('draft');
  const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(JSON.parse(init.body as string)).toMatchObject(adaptiveTarget);
});
it.each<Record<string, string>>([
  { 'X-Raw-Quality': 'full' }, { 'X-Raw-View-Generation': '3' }, { 'X-Raw-Mode': 'region' },
  { 'X-Raw-Frame': JSON.stringify({ ...geometry, fullWidth: 17 }) },
  { 'X-Raw-Frame': JSON.stringify({ ...geometry, window: {} }) },
  { 'X-Raw-Frame': JSON.stringify({ ...geometry, nativeHeight: 0 }) },
])('rejects malformed adaptive response: %j', async patch => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ ...adaptiveHeaders(), ...patch })));
  await expect(rawPreview(doc, 3, new AbortController().signal, 'after', adaptiveTarget)).rejects.toThrow();
});
it('accepts explicit legacy Full fallback without fabricating native geometry', async () => {
  const headers = adaptiveHeaders(); delete (headers as Partial<typeof headers>)['X-Raw-Frame'];
  vi.stubGlobal('fetch', vi.fn(async () => response({ ...headers, 'X-Raw-Preview-Contract': '0', 'X-Raw-Quality': 'full' })));
  const frame = await rawPreview(doc, 3, new AbortController().signal, 'after', adaptiveTarget);
  expect(frame.quality).toBe('full'); expect(frame.frame).toBeUndefined();
});
it.each(['revision', 'replaced', 'cancelled'])('treats normal %s as superseded, separate from image errors', async reason => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204, headers: { 'X-Raw-Superseded-Reason': reason } })));
  await expect(rawPreview(doc, 3, new AbortController().signal, 'after', adaptiveTarget)).rejects.toBeInstanceOf(RawSuperseded);
});
it.each<Record<string, string>>([
  { 'X-Raw-Kind': 'after', 'X-Raw-Before-Key': 'b'.repeat(64) },
  { 'X-Raw-Kind': 'before', 'X-Raw-Before-Key': 'c'.repeat(64) },
  { 'X-Raw-Before-Key': 'b'.repeat(64) },
])('rejects Before responses with a wrong kind or cache key: %j', async headers => {
  vi.stubGlobal('fetch', vi.fn(async () => response(headers)));
  await expect(rawPreview({ ...doc, beforeKey: 'b'.repeat(64) }, 3, new AbortController().signal, 'before')).rejects.toThrow();
});
it('sends Before kind and validates its opaque key separately from After', async () => {
  const fetch = vi.fn(async () => response({ 'X-Raw-Kind': 'before', 'X-Raw-Before-Key': 'b'.repeat(64) }));
  vi.stubGlobal('fetch', fetch);
  const frame = await rawPreview({ ...doc, beforeKey: 'b'.repeat(64) }, 3, new AbortController().signal, 'before');
  expect(frame.kind).toBe('before'); expect(frame.key).toBe('b'.repeat(64));
  const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(JSON.parse(init.body as string).kind).toBe('before');
});
describe('RAW History transport', () => {
  it.each<RawHistoryOperation>([
    { kind: 'controlReset', metadata: { control: 'wb.tint' } },
    { kind: 'sectionToggle', metadata: { section: 'color', enabled: false } },
    { kind: 'sectionReset', metadata: { section: 'light' } },
    { kind: 'allReset', metadata: {} },
  ])('sends allowlisted operation metadata for $kind without native settings', async operation => {
    const request: RawHistoryRequest = { doc: rawSettings(doc), action: 'operate', operation,
      expectedRecipeRevision: 4, saveId: '00000000-0000-4000-8000-000000000001' };
    const fetch = vi.fn(async () => new Response(JSON.stringify(rawHistoryResult(request)), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await saveRawHistory(request);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/history/operate');
    expect(JSON.parse(init.body as string)).toEqual({ workspaceId: doc.workspaceId, generation: doc.generation,
      documentToken: doc.documentToken, documentRevision: doc.revision, settingsFingerprint: request.doc.settingsFingerprint,
      expectedRecipeRevision: 4, saveId: request.saveId, ...operation });
  });
  const historyRequest = (action: 'initialize' | 'commit'): RawHistoryRequest => ({ doc: rawSettings(doc),
    action, control: action === 'commit' ? 'light.exposure' : undefined,
    expectedRecipeRevision: 4, saveId: '00000000-0000-4000-8000-000000000001' });
  it.each(['initialize', 'commit'] as const)('sends bounded %s metadata without settings bodies', async action => {
    const request = historyRequest(action), result = rawHistoryResult(request);
    const fetch = vi.fn(async () => new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    expect(await saveRawHistory(request)).toEqual(result);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/raw/documents/${doc.handle}/history/${action}`);
    expect(init.method).toBe('POST'); expect(JSON.parse(init.body as string)).toEqual({ workspaceId: doc.workspaceId,
      generation: doc.generation, documentToken: doc.documentToken, documentRevision: doc.revision,
      settingsFingerprint: request.doc.settingsFingerprint, expectedRecipeRevision: 4, saveId: request.saveId,
      ...(action === 'commit' ? { kind: 'control', metadata: { control: 'light.exposure' } } : {}) });
  });
  it.each([{ generation: 2 }, { documentToken: 'd'.repeat(32) }, { handle: 'd'.repeat(32) },
    { ack: null }, { history: { initialized: true, cursor: 3, length: 2, selectedStepId: null } }])(
    'treats malformed or stale successful responses as unknown: %j', async patch => {
      const request = historyRequest('commit');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...rawHistoryResult(request), ...patch }),
        { headers: { 'Content-Type': 'application/json' } })));
      await expect(saveRawHistory(request)).rejects.toMatchObject({ outcome: 'unknown', code: 'raw_invalid_response' });
    });
  it('keeps replay ack separate from current state and exposes pending/desync to the coordinator', async () => {
    const request = historyRequest('commit');
    const result = rawHistoryResult(request, { recipeRevision: 9, historyPending: true, nativeMatchesRecipe: false,
      nativeState: 'desynchronized', replayed: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })));
    const response = await saveRawHistory(request);
    expect(response.recipeRevision).toBe(9); expect(response.ack.revision).toBe(5); expect(response.historyPending).toBe(true);
  });
  it.each([409, 503])('classifies HTTP %i without silently rebasing the request', async status => {
    const request = historyRequest('commit');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'raw_history_save_failed' }), { status })));
    await expect(saveRawHistory(request)).rejects.toMatchObject({ outcome: status === 409 ? 'rejected' : 'unknown' });
    expect(request.expectedRecipeRevision).toBe(4);
  });
  it.each(['undo', 'redo', 'jump'] as const)('sends a %s operation without controls or snapshots', async action => {
    const request: RawHistoryRequest = { ...historyRequest('commit'), action, targetStepId: null };
    const result = rawHistoryResult(request, { revision: doc.revision + 1 });
    const fetch = vi.fn(async () => new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch); expect(await saveRawHistory(request)).toEqual(result);
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toContain(`/history/${action}`);
    expect(JSON.parse(init.body as string)).toEqual({ workspaceId: doc.workspaceId, generation: doc.generation,
      documentToken: doc.documentToken, documentRevision: doc.revision, settingsFingerprint: request.doc.settingsFingerprint,
      expectedRecipeRevision: 4, saveId: request.saveId, ...(action === 'jump' ? { targetStepId: null } : {}) });
  });
  it('reads 20 display-diff rows within the History-only 16 KiB boundary without exposing snapshots', async () => {
    const result = rawHistoryResult(historyRequest('commit'), { history: { initialized: true, cursor: 200, length: 200,
      selectedStepId: historyRequest('commit').saveId } });
    const page = rawHistoryPage(result, 180);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...page, internal: 'excluded', settings: { private: true } }),
      { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const value = await readRawHistory(result, 180); expect(value.steps).toHaveLength(20);
    expect(value.steps[0].changes).toEqual([{ control: 'light.exposure', before: 180, after: 181 }]);
    expect(value).not.toHaveProperty('settings');
    expect(value).not.toHaveProperty('internal');
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/raw/documents/${doc.handle}/history?offset=180&limit=20`);
    expect(init.headers).toEqual({ 'X-Raw-Workspace': doc.workspaceId, 'X-Raw-Generation': '1', 'X-Raw-Token': doc.documentToken });
  });
  it.each(['generation', 'rows', 'cursor', 'metadata', 'changes', 'oversize'])('rejects invalid History %s', async invalid => {
    const result = rawHistoryResult(historyRequest('commit')), page = rawHistoryPage(result, 0);
    if (invalid === 'generation') page.generation++;
    if (invalid === 'rows') page.steps.push(page.steps[0]);
    if (invalid === 'cursor') page.history = { ...page.history, selectedStepId: '00000000-0000-4000-8000-000000000009' };
    if (invalid === 'metadata') page.steps[0].metadata.control = 'native.unknown' as never;
    if (invalid === 'changes') page.steps[0].changes = [{ control: 'light.exposure', before: Number.NaN, after: 1 }];
    const content = invalid === 'oversize' ? JSON.stringify(page) + ' '.repeat(16384) : JSON.stringify(page);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(content, { headers: { 'Content-Type': 'application/json' } })));
    await expect(readRawHistory(result, 0)).rejects.toThrow('raw_invalid_response');
  });
});
describe('bounded RAW binary contract', () => {
  it('sends metadata only for RAW saves and validates the exact acknowledged revision/fingerprint/saveId', async () => {
    const request = { doc: rawSettings(doc), expectedRecipeRevision: 3, saveId: '00000000-0000-4000-8000-000000000001' };
    const ack = { ...doc, documentRevision: doc.revision, recipeRevision: 4, settingsFingerprint: request.doc.settingsFingerprint,
      saveId: request.saveId, updatedAt: '2026-10-22T00:00:00.000Z' };
    const fetch = vi.fn(async () => new Response(JSON.stringify(ack), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    expect((await saveRawRecipe(request)).recipeRevision).toBe(4);
    const options = vi.mocked(globalThis.fetch).mock.calls[0][1]!;
    expect(options.method).toBe('PUT'); expect(JSON.parse(options.body as string)).toEqual({ workspaceId: doc.workspaceId,
      generation: doc.generation, documentToken: doc.documentToken, documentRevision: doc.revision,
      expectedRecipeRevision: 3, saveId: request.saveId });
    for (const patch of [{ generation: 99 }, { recipeRevision: 3 }, { saveId: 'wrong' }, { settingsFingerprint: '0'.repeat(64) }]) {
      fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ ...ack, ...patch }), { headers: { 'Content-Type': 'application/json' } }));
      await expect(saveRawRecipe(request)).rejects.toMatchObject({ outcome: 'unknown' });
    }
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ code: 'raw_recipe_revision_conflict' }), { status: 409 }));
    await expect(saveRawRecipe(request)).rejects.toMatchObject({ outcome: 'rejected', code: 'raw_recipe_revision_conflict' });
    fetch.mockRejectedValueOnce(new Error('lost'));
    await expect(saveRawRecipe(request)).rejects.toBeInstanceOf(RawSaveError);
  });
  it('reads persisted metadata with document token/generation authentication', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...doc, recipeRevision: 0, recipeFingerprint: null,
      lastSaveId: null, updatedAt: null }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    expect((await readRawRecipe(doc)).recipeRevision).toBe(0);
    expect(vi.mocked(globalThis.fetch).mock.calls[0][1]!.headers).toMatchObject({ 'X-Raw-Token': doc.documentToken,
      'X-Raw-Generation': String(doc.generation), 'X-Raw-Workspace': doc.workspaceId });
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ ...doc, recipeRevision: 0,
      recipeFingerprint: 'a'.repeat(64), lastSaveId: null, updatedAt: null }), { headers: { 'Content-Type': 'application/json' } }));
    await expect(readRawRecipe(doc)).rejects.toThrow('raw_invalid_response');
  });
  it('resynchronizes settings and sends allowlisted changes with the confirmed expectedRevision', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ...rawSettings(doc), revision: doc.revision + 1 }),
      { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const result = await setRawControls(doc, { 'light.exposure': 1 });
    expect(result.revision).toBe(doc.revision + 1);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ workspaceId: doc.workspaceId, generation: doc.generation,
      documentToken: doc.documentToken, expectedRevision: doc.revision, values: { 'light.exposure': 1 } });
    expect((await readRawSettings(doc)).revision).toBe(result.revision);
    expect(fetch.mock.calls[1][0]).toBe(`/api/raw/documents/${doc.handle}/settings`);
  });
  it('rejects stale identity and malformed control metadata in settings responses', async () => {
    for (const patch of [{ generation: doc.generation + 1 }, { documentToken: 'other' }, { controls: [] }, { values: {} }, { mutationAttempts: -1 }, { mutationAttempts: 257 }, { mutationLimit: 999 }, { regenerationThreshold: 256 }, { wb: { available: 'yes' } }]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...rawSettings(doc), ...patch }),
        { headers: { 'Content-Type': 'application/json' } })));
      await expect(readRawSettings(doc)).rejects.toThrow('raw_invalid_response');
    }
  });
  it('accepts an engine-identified PNG without exposing paths or JPEG requests', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response()); vi.stubGlobal('fetch', fetch);
    const frame = await rawPreview(doc, 3, new AbortController().signal);
    expect(frame.blob.type).toBe('image/png'); expect(frame.width).toBe(16);
    expect(fetch.mock.calls[0][0]).toBe(`/api/raw/documents/${doc.handle}/preview`);
  });
  it.each(['generation', 'token', 'revision', 'serial', 'epoch', 'sequence', 'width', 'height'])('rejects invalid %s', async key => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ [`X-Raw-${key}`]: 'invalid' })));
    await expect(rawPreview(doc, 3, new AbortController().signal)).rejects.toThrow();
  });
  it('rejects HTML, invalid PNG bytes and oversized binary responses', async () => {
    for (const res of [response({ 'Content-Type': 'text/html' }), response({}, new Uint8Array([1])),
      response({}, new Uint8Array(17 * 1024 * 1024 + 1))]) {
      vi.stubGlobal('fetch', vi.fn(async () => res));
      await expect(rawPreview(doc, 3, new AbortController().signal)).rejects.toThrow();
    }
  });
  it('treats a missing Docker API as unsupported', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404 })));
    await expect(rawCapability()).rejects.toThrow('raw_unsupported');
  });
});


it('permits release-ack recovery only for an observed empty workspace with no cleanup pending', async () => {
  for (const state of [
    { workspaceState: 'active', cleanupPending: false }, { workspaceState: 'cleanup_failed', cleanupPending: false },
    { workspaceState: 'empty', cleanupPending: true }, {}, { workspaceState: 'empty', cleanupPending: false },
  ]) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } })));
    expect(await rawWorkspaceEmpty()).toBe(state.workspaceState === 'empty' && state.cleanupPending === false);
  }
});
