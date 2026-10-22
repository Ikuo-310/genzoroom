import { useSyncExternalStore } from 'react';
import { rawCapability } from './rawApi';

let available = false;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | undefined;
async function poll() {
  const owner = new AbortController();
  request = owner;
  let next = false;
  try { next = await rawCapability(owner.signal); } catch { /* Docker and unavailable Windows hosts stay locked. */ }
  if (owner.signal.aborted || !listeners.size || request !== owner) return;
  if (available !== next) { available = next; listeners.forEach(listener => listener()); }
  timer = setTimeout(() => void poll(), 15_000);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) void poll();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { request?.abort(); clearTimeout(timer); available = false; }
  };
}
export function useRawCapability() {
  return useSyncExternalStore(subscribe, () => available, () => false);
}
