import { afterEach, expect, it, vi } from 'vitest';
import { getDevelopmentEngine } from './developmentPolicyApi';

afterEach(() => vi.unstubAllGlobals());

it.each(['lightcraft', 'jpeg'] as const)('reads the explicit %s engine policy', async engine => {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ engine }), {
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetch);
  await expect(getDevelopmentEngine()).resolves.toBe(engine);
  expect(fetch.mock.calls[0][0]).toBe('/api/development-policy');
});

it('does not infer the JPEG policy when the policy API fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404 })));
  await expect(getDevelopmentEngine()).rejects.toThrow('development_policy_unavailable');
});

it('rejects an unknown engine value', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ engine: 'fallback' }), {
    headers: { 'Content-Type': 'application/json' },
  })));
  await expect(getDevelopmentEngine()).rejects.toThrow('development_policy_invalid');
});
