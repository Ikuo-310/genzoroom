import { RawApiError, readRawSettings, setRawControls, type RawSettings, type RawValues } from './rawApi';

export const RAW_DEBOUNCE_MS = 150;

/** One mutation owner, one latest unsent patch. Native work remains owned after UI disposal. */
export class RawControls {
  desired: Partial<RawValues> = {};
  pending: Partial<RawValues> = {};
  serial = 0;
  busy = false;
  error?: string;
  private active = true;
  private queued = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(public confirmed: RawSettings, private options: {
    schedule: (action: () => Promise<void>) => void;
    changed: () => void;
    preview: (settings: RawSettings, current: () => boolean) => Promise<void>;
  }) {}

  change(values: Partial<RawValues>) {
    if (!this.active || this.error) return;
    this.serial++;
    Object.assign(this.desired, values);
    Object.assign(this.pending, values);
    this.options.changed();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), RAW_DEBOUNCE_MS);
  }
  flush() {
    clearTimeout(this.timer);
    if (!this.active || this.error || this.busy || this.queued || !Object.keys(this.pending).length) return;
    this.queued = true;
    this.options.schedule(async () => {
      this.queued = false;
      if (!this.active || this.error) return;
      this.busy = true;
      this.options.changed();
      let conflicts = 0;
      try {
        while (this.active && Object.keys(this.pending).length) {
          const patch = this.pending;
          this.pending = {};
          try {
            this.confirmed = await setRawControls(this.confirmed, patch);
          } catch (error) {
            // A lost HTTP response is not permission to repeat an unknown native mutation.
            this.pending = { ...patch, ...this.pending };
            if (error instanceof RawApiError && error.code === 'raw_revision_conflict' && conflicts++ === 0) {
              this.confirmed = await readRawSettings(this.confirmed);
              continue;
            }
            throw error;
          }
          if (!this.active) return;
          for (const id of Object.keys(patch) as (keyof RawValues)[]) {
            if (!(id in this.pending)) delete this.desired[id];
          }
          this.options.changed();
          if (!Object.keys(this.pending).length) {
            const serial = this.serial;
            await this.options.preview(this.confirmed, () => this.active && serial === this.serial);
          }
        }
      } catch (error) {
        if (this.active) this.error = error instanceof RawApiError ? error.code : 'raw_connection_failed';
      } finally {
        this.busy = false;
        if (this.active) this.options.changed();
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
          await this.options.preview(this.confirmed, () => this.active && serial === this.serial);
        }
      } catch (error) { this.error = error instanceof RawApiError ? error.code : 'raw_connection_failed'; }
      finally {
        this.busy = false;
        if (this.active) { this.options.changed(); this.flush(); }
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
  dispose() { this.active = false; clearTimeout(this.timer); }
  get unsettled() { return this.busy || Object.keys(this.desired).length > 0; }
}
