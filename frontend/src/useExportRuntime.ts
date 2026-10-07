import { useCallback, useEffect, useRef, useState } from 'react';
import { ExportQueueApiError, listExportRuntime, stopExportRuntime, startExportRuntime, type ExportRuntimeState } from './exportQueueApi';

export function useExportRuntime(refreshQueue: () => Promise<void>) {
  const [runtime, setRuntime] = useState<ExportRuntimeState | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [starting, setStarting] = useState(false);
  const current = useRef<ExportRuntimeState | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const cancelBusy = useRef(false);
  const startBusy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!alive) return;
      if (cancelBusy.current || startBusy.current) { timer = setTimeout(() => void poll(), 2000); return; }
      const controller = new AbortController(); controllers.current.add(controller);
      const version = generation.current;
      try {
        const state = await listExportRuntime(controller.signal);
        if (!alive || !mounted.current || controller.signal.aborted || version !== generation.current) return;
        const refresh = state.status === 'active' || current.current?.status === 'active';
        current.current = state; setRuntime(state);
        if (refresh) await refreshQueue();
      } catch {
        // Unknown runtime state cannot authorize Cancel; retry on the next poll.
        if (alive && mounted.current && version === generation.current) { current.current = null; setRuntime(null); }
      } finally {
        controllers.current.delete(controller);
        if (alive && mounted.current) timer = setTimeout(() => void poll(), 2000);
      }
    }
    void poll();
    return () => {
      alive = false; mounted.current = false; generation.current++; clearTimeout(timer);
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, [refreshQueue]);
  const cancel = useCallback(async () => {
    const run = current.current;
    if (cancelBusy.current || !run?.runId || !run.stopAllowed) throw new ExportQueueApiError('locked');
    cancelBusy.current = true; setCancelling(true); generation.current++;
    const version = generation.current;
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const state = await stopExportRuntime(run.runId, controller.signal);
      if (mounted.current && !controller.signal.aborted && version === generation.current) {
        generation.current++; current.current = state; setRuntime(state);
      }
    } finally {
      controllers.current.delete(controller); cancelBusy.current = false;
      if (mounted.current) { setCancelling(false); await refreshQueue(); }
    }
  }, [refreshQueue]);
  const start = useCallback(async (assetIds: readonly string[]) => {
    if (startBusy.current || cancelBusy.current || !current.current || current.current.status !== null) throw new ExportQueueApiError('locked');
    startBusy.current = true; setStarting(true); generation.current++;
    const version = generation.current;
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      const state = await startExportRuntime(assetIds, controller.signal);
      if (mounted.current && !controller.signal.aborted && version === generation.current) {
        generation.current++; current.current = state.status === 'active' ? state : null; setRuntime(state.status === 'active' ? state : null);
      }
    } catch (error) {
      // A lost acknowledgement may follow a committed run; poll before authorizing another Start.
      if (mounted.current && version === generation.current) { current.current = null; setRuntime(null); }
      throw error;
    } finally {
      controllers.current.delete(controller); startBusy.current = false;
      if (mounted.current) { setStarting(false); await refreshQueue(); }
    }
  }, [refreshQueue]);
  return { runtime, cancelling, cancel, starting, start };
}
