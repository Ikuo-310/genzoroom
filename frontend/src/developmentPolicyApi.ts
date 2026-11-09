export type DevelopmentEngine = 'lightcraft' | 'jpeg';

export async function getDevelopmentEngine(signal?: AbortSignal): Promise<DevelopmentEngine> {
  const response = await fetch('/api/development-policy', {
    cache: 'no-store', credentials: 'same-origin', signal,
  });
  if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    throw new Error('development_policy_unavailable');
  }
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error('development_policy_invalid'); }
  if (!value || typeof value !== 'object' || !('engine' in value)
    || value.engine !== 'lightcraft' && value.engine !== 'jpeg') {
    throw new Error('development_policy_invalid');
  }
  return value.engine;
}
