export type ThumbnailPublicationState = 'recipe_missing' | 'recipe_default' | 'recipe_unknown' | 'reserved'
  | 'queued' | 'running' | 'published' | 'failed' | 'reset' | 'cache_missing';

export type ThumbnailPublication = {
  recipeRevision: number | null;
  state: ThumbnailPublicationState;
  publicationVersion: string | null;
};

export type ThumbnailPublicationSnapshot = {
  generationId: string;
  sequence: number;
  items: Record<string, ThumbnailPublication>;
};

const states = new Set<ThumbnailPublicationState>(['recipe_missing', 'recipe_default', 'recipe_unknown', 'reserved',
  'queued', 'running', 'published', 'failed', 'reset', 'cache_missing']);

export function isThumbnailPublicationState(value: unknown): value is ThumbnailPublicationState {
  return typeof value === 'string' && states.has(value as ThumbnailPublicationState);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function fetchThumbnailPublications(assetIds: readonly string[], signal: AbortSignal): Promise<ThumbnailPublicationSnapshot> {
  const normalizedIds = assetIds.map(assetId => assetId.toLowerCase());
  const response = await fetch('/api/thumbnail-publications/status', {
    method: 'POST', signal, cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetIds: normalizedIds }),
  });
  if (!response.ok) throw new Error('thumbnail_publication_request_failed');
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error('thumbnail_publication_invalid_response'); }
  if (!isRecord(body) || typeof body.generationId !== 'string' || !/^[0-9a-f]{32}$/.test(body.generationId)
    || !Number.isSafeInteger(body.sequence) || !isRecord(body.items)) {
    throw new Error('thumbnail_publication_invalid_response');
  }
  const items: Record<string, ThumbnailPublication> = {};
  for (const assetId of normalizedIds) {
    const value = body.items[assetId];
    if (!isRecord(value) || !(value.recipeRevision === null
      || Number.isSafeInteger(value.recipeRevision) && (value.recipeRevision as number) >= 1)
      || !isThumbnailPublicationState(value.state)
      || !(value.publicationVersion === null || typeof value.publicationVersion === 'string' && /^\d{1,24}$/.test(value.publicationVersion))) {
      throw new Error('thumbnail_publication_invalid_response');
    }
    items[assetId] = { recipeRevision: value.recipeRevision as number | null,
      state: value.state, publicationVersion: value.publicationVersion as string | null };
  }
  if (Object.keys(body.items).length !== normalizedIds.length) throw new Error('thumbnail_publication_invalid_response');
  return { generationId: body.generationId, sequence: body.sequence as number, items };
}
