import { afterEach, expect, it, vi } from 'vitest';
import { fetchThumbnailPublications } from './thumbnailPublicationApi';

const publication = 'a'.repeat(32);

afterEach(() => vi.unstubAllGlobals());

it('parses a mixed 1,000-Asset batch with distinct unsaved, old-engine and current-engine revisions', async () => {
  const assetIds = Array.from({ length: 1000 }, (_, index) => `asset-${index}`);
  const items = Object.fromEntries(assetIds.map((assetId, index) => [assetId,
    index === 1 ? { recipeRevision: 0, state: 'recipe_default', publicationVersion: null }
      : index === 2 ? { recipeRevision: 1, state: 'recipe_default', publicationVersion: null }
        : index === 3 ? { recipeRevision: 2, state: 'published', publicationVersion: publication }
          : { recipeRevision: null, state: 'recipe_missing', publicationVersion: null }]));
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    generationId: 'a'.repeat(32), sequence: 4, items,
  })));
  vi.stubGlobal('fetch', fetch);

  const result = await fetchThumbnailPublications(assetIds, new AbortController().signal);

  expect(Object.keys(result.items)).toHaveLength(1000);
  expect(result.items['asset-0']).toMatchObject({ recipeRevision: null, state: 'recipe_missing' });
  expect(result.items['asset-1']).toMatchObject({ recipeRevision: 0, state: 'recipe_default' });
  expect(result.items['asset-2']).toMatchObject({ recipeRevision: 1, state: 'recipe_default' });
  expect(result.items['asset-3']).toMatchObject({ recipeRevision: 2, state: 'published', publicationVersion: publication });
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([-1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1])('rejects invalid recipe revision %s', async recipeRevision => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
    generationId: 'a'.repeat(32), sequence: 1,
    items: { asset: { recipeRevision, state: 'recipe_default', publicationVersion: null } },
  })));

  await expect(fetchThumbnailPublications(['asset'], new AbortController().signal))
    .rejects.toThrow('thumbnail_publication_invalid_response');
});

it.each([
  { recipeRevision: 0, state: 'published', publicationVersion: publication },
  { recipeRevision: 0, state: 'recipe_default', publicationVersion: publication },
])('rejects an old-engine sentinel with an incompatible publication state: %o', async item => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
    generationId: 'a'.repeat(32), sequence: 1, items: { asset: item },
  })));

  await expect(fetchThumbnailPublications(['asset'], new AbortController().signal))
    .rejects.toThrow('thumbnail_publication_invalid_response');
});

it.each(['123', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(33)])
  ('rejects malformed publication identities %s', async publicationVersion => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      generationId: 'a'.repeat(32), sequence: 1,
      items: { asset: { recipeRevision: 1, state: 'published', publicationVersion } },
    })));

    await expect(fetchThumbnailPublications(['asset'], new AbortController().signal))
      .rejects.toThrow('thumbnail_publication_invalid_response');
  });
