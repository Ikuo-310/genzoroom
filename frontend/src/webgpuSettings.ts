export const WEBGPU_STORAGE_KEY = 'genzoroom.webgpu.enabled';

function browserStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

export function readWebGpuEnabled(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): boolean {
  // Missing, invalid, or inaccessible preferences retain the default opt-in policy.
  try { return storage?.getItem(WEBGPU_STORAGE_KEY) !== 'false'; }
  catch { return true; }
}

export function saveWebGpuEnabled(enabled: boolean, storage: Pick<Storage, 'setItem'> | undefined = browserStorage()): void {
  try { storage?.setItem(WEBGPU_STORAGE_KEY, String(enabled)); }
  catch { /* A storage failure must not interrupt image processing. */ }
}
