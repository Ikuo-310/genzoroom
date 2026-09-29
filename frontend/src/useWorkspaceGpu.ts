import { useCallback, useEffect, useRef, useState } from 'react';
import { WebGpuAdjustmentRenderer } from './webgpuAdjustmentRenderer';
import { defaultGpu } from './webgpuExposureRenderer';
import { readWebGpuEnabled, saveWebGpuEnabled, subscribeWebGpu } from './webgpuSettings';

export type WorkspaceGpuRenderer = Pick<WebGpuAdjustmentRenderer,
  'available' | 'setSource' | 'render' | 'dispose' | 'onDeviceLost'>;
export type ProcessingBackend = 'cpu' | 'gpu';
export type GpuAvailability = 'checking' | 'available' | 'unavailable' | 'error';
type Snapshot = {
  key: string; enabled: boolean; availability: GpuAvailability; renderer: WorkspaceGpuRenderer | null;
};

export function useWorkspaceGpu(key: string, probeOnly = false) {
  const [enabled, setEnabled] = useState(readWebGpuEnabled);
  useEffect(() => subscribeWebGpu(setEnabled), []);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [paintedRenderer, setPaintedRenderer] = useState<WorkspaceGpuRenderer | null>(null);
  const current = useRef({ key, enabled, snapshot });
  current.current = { key, enabled, snapshot };
  const matches = snapshot?.key === key && snapshot.enabled === enabled;
  const renderer = matches ? snapshot.renderer : null;
  const availability = matches ? snapshot.availability : 'checking';

  useEffect(() => {
    const controller = new AbortController();
    let owned: WorkspaceGpuRenderer | null = null;
    let unsubscribe = () => {};
    const publish = (availability: GpuAvailability, renderer: WorkspaceGpuRenderer | null) => {
      if (!controller.signal.aborted) setSnapshot({ key, enabled, availability, renderer });
    };
    publish('checking', null);
    if (globalThis.isSecureContext !== true || !defaultGpu()) {
      publish('unavailable', null);
      return () => controller.abort();
    }
    void (async () => {
      const created = await WebGpuAdjustmentRenderer.create(defaultGpu(), undefined, controller.signal);
      if (controller.signal.aborted) { created?.dispose(); return; }
      if (!created || !created.available) { created?.dispose(); publish('unavailable', null); return; }
      if (!enabled || probeOnly) {
        // OFF and Home check the full G2 pipeline without retaining a device for image processing.
        created.dispose();
        publish('available', null);
        return;
      }
      owned = created;
      unsubscribe = created.onDeviceLost(() => {
        publish('error', null);
        created.dispose();
      });
      if (created.available) publish('available', created);
    })().catch(() => { owned?.dispose(); publish('unavailable', null); });
    return () => {
      controller.abort();
      unsubscribe();
      owned?.dispose();
    };
  }, [key, enabled, probeOnly]);

  const setPreference = useCallback((next: boolean) => {
    saveWebGpuEnabled(next);
    setEnabled(next);
  }, []);
  const fail = useCallback((failed: WorkspaceGpuRenderer) => {
    const value = current.current;
    if (value.key !== key || value.enabled !== enabled || value.snapshot?.renderer !== failed) return;
    failed.dispose();
    setSnapshot({ key, enabled, availability: 'error', renderer: null });
  }, [key, enabled]);
  const reportBackend = useCallback((backend: ProcessingBackend) => {
    const value = current.current;
    if (value.key !== key || value.enabled !== enabled) return;
    setPaintedRenderer(backend === 'gpu' ? value.snapshot?.renderer ?? null : null);
  }, [key, enabled]);
  return { enabled, availability, renderer, setPreference, fail, reportBackend,
    active: availability === 'available' && !!renderer && renderer.available && paintedRenderer === renderer };
}
