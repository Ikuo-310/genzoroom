export const WEBGPU_STORAGE_KEY = 'genzoroom.webgpu.enabled';
let sessionEnabled: boolean | undefined;

function browserStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

export function readWebGpuEnabled(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): boolean {
  // Missing, invalid, or inaccessible preferences retain the default opt-in policy.
  try { return sessionEnabled ?? (storage?.getItem(WEBGPU_STORAGE_KEY) !== 'false'); }
  catch { return sessionEnabled ?? true; }
}

export function saveWebGpuEnabled(enabled: boolean, storage: Pick<Storage, 'setItem'> | undefined = browserStorage()): void {
  try {
    storage?.setItem(WEBGPU_STORAGE_KEY, String(enabled));
    sessionEnabled = storage ? undefined : enabled;
  }
  catch { sessionEnabled = enabled; /* Keep the choice across Home/workspace mounts when storage is blocked. */ }
  listeners.forEach(listener => listener(enabled));
}

const listeners = new Set<(enabled: boolean) => void>();
export function subscribeWebGpu(listener: (enabled: boolean) => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
