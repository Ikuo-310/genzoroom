// Node's native channel connects independent Vitest workers as if they were app tabs.
// Transport tests inject their own channelFactory; other tests must keep local logger state isolated.
Object.defineProperty(globalThis, 'BroadcastChannel', {
  configurable: true,
  writable: true,
  value: undefined,
});
