import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each([
  [{}, { channel: 'development', version: '0.0.0-development', commit: null }],
  [{ VITE_GENZOROOM_CHANNEL: 'validation', VITE_GENZOROOM_VERSION: '0.0.0-validation', VITE_GENZOROOM_COMMIT: 'a'.repeat(40) },
    { channel: 'validation', version: '0.0.0-validation', commit: 'a'.repeat(40) }],
  [{ VITE_GENZOROOM_CHANNEL: 'stable', VITE_GENZOROOM_VERSION: 'v0.1.0', VITE_GENZOROOM_COMMIT: 'b'.repeat(40) },
    { channel: 'stable', version: 'v0.1.0', commit: 'b'.repeat(40) }],
])('resolves embedded build channels', async (env, expected) => {
  const values = env as Record<string, string>;
  for (const key of ['VITE_GENZOROOM_CHANNEL', 'VITE_GENZOROOM_VERSION', 'VITE_GENZOROOM_COMMIT'] as const) {
    vi.stubEnv(key, values[key] ?? '');
  }
  vi.resetModules();
  const { BUILD_INFO } = await import('./buildInfo');
  expect(BUILD_INFO).toEqual({ name: 'GenzoRoom', ...expected });
});

it('rejects incomplete or mismatched release metadata', async () => {
  vi.stubEnv('VITE_GENZOROOM_CHANNEL', 'stable'); vi.stubEnv('VITE_GENZOROOM_VERSION', 'v0.1.0');
  vi.stubEnv('VITE_GENZOROOM_COMMIT', 'short'); vi.resetModules();
  await expect(import('./buildInfo')).rejects.toThrow('Invalid GenzoRoom build metadata');
});
