import { RawApiError, readRawSettings, setRawControls, type RawSettings, type RawValues } from './rawApi';
import { RawInteractionMetrics } from './rawInteractionMetrics';

export const RAW_THROTTLE_MS = 150;
const RAW_DISPLAY_COURTESY_MS = 1000;

/** One mutation owner, one latest unsent patch. Native work remains owned after UI disposal. */
export class RawControls {
  desired: Partial<RawValues> = {};
  pending: Partial<RawValues> = {};
  serial = 0;
  busy = false;
  mutating = false;
  error?: string;
  private active = true;
  private queued = false;
  private lastAck = -Infinity;
  metrics?: RawInteractionMetrics;
  private drain = false;
  private timer?: ReturnType<typeof setTimeout>;
  interacting = false;
  constructor(public confirmed: RawSettings, private options: {
    schedule: (action: () => Promise<void>) => void;
    changed: () => void;
    hold?: () => boolean;
    previewBusy?: () => boolean;
    preview: (settings: RawSettings, current: () => boolean) => void;
    invalidate?: () => void;
  }) {}

  beginPreview() {
    if (this.interacting) return;
    this.metrics?.report('nextGesture');
    this.metrics = new RawInteractionMetrics(this.confirmed.generation, this.serial + 1);
    this.interacting = true;
    this.options.invalidate?.();
  }
  endPreview() {
    if (this.interacting && this.metrics) { this.metrics.endedAt = performance.now(); this.metrics.report('ended'); }
    this.interacting = false; this.options.invalidate?.();
  }

  change(values: Partial<RawValues>) {
    if (!this.active || this.error) return;
    this.serial++;
    this.metrics?.input();
    if (!this.interacting) this.options.invalidate?.();
    Object.assign(this.desired, values);
    Object.assign(this.pending, values);
    this.options.changed();
    this.arm();
  }
  private arm() {
    if (this.timer || this.busy || this.queued || !this.active || this.error || !Object.keys(this.pending).length || this.options.hold?.()) return;
    // Keep the first unsent deadline; give one display slot a bounded opportunity.
    // A stalled transfer/decode must not indefinitely block native edits.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.interacting && this.options.previewBusy?.() && performance.now() - this.lastAck < RAW_DISPLAY_COURTESY_MS) { this.arm(); return; }
      this.flush(false);
    }, RAW_THROTTLE_MS);
  }
  flush(immediate = true) {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (immediate && this.busy) this.drain = true;
    if (this.options.hold?.() || !this.active || this.error || this.busy || this.queued || !Object.keys(this.pending).length) return;
    this.queued = true;
    this.options.schedule(async () => {
      this.queued = false;
      if (!this.active || this.error) return;
      this.busy = true;
      this.options.changed();
      let conflicts = 0;
      try {
        while (this.active && Object.keys(this.pending).length) {
          // Preserve the latest drag intent without consuming the reserved final-flush budget.
          if (this.options.hold?.()) break;
          const patch = this.pending;
          this.pending = {};
          const metrics = this.metrics, inputAt = metrics?.latestInput ?? performance.now();
          try {
            this.mutating = true;
            if (metrics) metrics.mutations++;
            this.confirmed = await setRawControls(this.confirmed, patch);
            this.lastAck = performance.now();
            metrics?.ack(inputAt);
          } catch (error) {
            // A lost HTTP response is not permission to repeat an unknown native mutation.
            this.pending = { ...patch, ...this.pending };
            if (error instanceof RawApiError && error.code === 'raw_revision_conflict' && conflicts++ === 0) {
              this.confirmed = await readRawSettings(this.confirmed);
              continue;
            }
            throw error;
          } finally { this.mutating = false; }
          if (!this.active) return;
          for (const id of Object.keys(patch) as (keyof RawValues)[]) {
            if (!(id in this.pending)) delete this.desired[id];
          }
          this.options.changed();
          const revision = this.confirmed.revision;
          this.options.preview(this.confirmed, () => this.active && this.confirmed.revision === revision);
          // Drag ACKs yield the owner queue; final flush still drains before its save fence.
          if (this.interacting && !immediate && !this.drain) break;
        }
      } catch (error) {
        if (this.active) this.error = error instanceof RawApiError ? error.code : 'raw_connection_failed';
      } finally {
        this.busy = false;
        this.drain = false;
        if (this.active) { this.options.changed(); this.arm(); }
      }
    });
  }
  retry(force = false) {
    if (!this.active || this.busy || this.queued || !this.error && !force) return;
    this.queued = true;
    this.options.schedule(async () => {
      this.queued = false;
      if (!this.active) return;
      this.busy = true;
      try {
        this.confirmed = await readRawSettings(this.confirmed);
        this.error = undefined;
        if (this.active && !Object.keys(this.pending).length) {
          const serial = this.serial;
          this.options.preview(this.confirmed, () => this.active && serial === this.serial);
        }
      } catch (error) { this.error = error instanceof RawApiError ? error.code : 'raw_connection_failed'; }
      finally {
        this.busy = false;
        if (this.active) { this.options.changed(); if (this.interacting) this.arm(); else this.flush(); }
      }
    });
  }
  async settle(): Promise<RawSettings> {
    for (;;) {
      if (!this.active) throw new RawApiError('raw_document_closed');
      if (this.error && Object.keys(this.desired).length) throw new RawApiError(this.error);
      this.flush();
      // A queue barrier waits for transmitted mutations and their final readback, not just debounce.
      await new Promise<void>(resolve => this.options.schedule(async () => { resolve(); }));
      if (!this.active) throw new RawApiError('raw_document_closed');
      if (this.error && Object.keys(this.desired).length) throw new RawApiError(this.error);
      if (!this.unsettled && !this.queued) return this.confirmed;
    }
  }
  refreshPreview() {
    const serial = this.serial;
    if (this.active) this.options.preview(this.confirmed, () => this.active && serial === this.serial);
  }
  dispose() { this.metrics?.report('disposed'); this.active = false; clearTimeout(this.timer); }
  get unsettled() { return this.busy || Object.keys(this.desired).length > 0; }
}
