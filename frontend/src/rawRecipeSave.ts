import { createEditStateSaveId } from './editStateApi';
import { frontendLogger } from './frontendLogging';
import { RawApiError, RawSaveError, readRawRecipe, saveRawRecipe, type RawSettings, type RawRecipeRequest } from './rawApi';

export const RAW_AUTOSAVE_MS = 5000;

/** Current-document save owner. Unknown outcomes retain one immutable request ahead of newer edits. */
export class RawRecipeSave {
  revision: number;
  savedFingerprint: string;
  error?: string;
  saving = false;
  lastSaveId: string | null = null;
  private active = true;
  private paused = false;
  private timer?: ReturnType<typeof setTimeout>;
  private operation?: Promise<void>;
  private retryRequest?: RawRecipeRequest;
  private conflict = false;
  constructor(public confirmed: RawSettings, private options: {
    schedule: (action: () => Promise<void>) => void; changed: () => void;
  }) {
    this.revision = confirmed.recipeRevision;
    this.savedFingerprint = confirmed.recipeFingerprint ?? confirmed.settingsFingerprint;
  }
  get dirty() { return !!this.retryRequest || this.confirmed.settingsFingerprint !== this.savedFingerprint; }
  observe(settings: RawSettings, settled: boolean) {
    this.confirmed = settings;
    clearTimeout(this.timer);
    if (this.active && !this.paused && !this.error && settled && this.dirty) {
      this.timer = setTimeout(() => { void this.save().catch(() => {}); }, RAW_AUTOSAVE_MS);
    }
  }
  pause() { this.paused = true; clearTimeout(this.timer); }
  resume() { this.paused = false; this.observe(this.confirmed, true); }
  save(retry = false): Promise<void> {
    if (this.operation) return this.operation;
    clearTimeout(this.timer);
    let finish!: () => void, reject!: (error: unknown) => void;
    const operation = new Promise<void>((yes, no) => { finish = yes; reject = no; });
    this.operation = operation;
    this.options.schedule(async () => {
      try {
        if (!this.active) throw new RawApiError('raw_document_closed');
        if (this.error && !retry) throw new RawApiError(this.error);
        this.saving = true;
        this.options.changed();
        if (retry && this.conflict && !this.retryRequest) { await this.resync(); this.conflict = false; }
        // Replay the exact saved document revision before creating a new saveId for newer readback.
        if (this.retryRequest) await this.send(this.retryRequest);
        if (this.confirmed.settingsFingerprint !== this.savedFingerprint) {
          await this.send({ doc: { ...this.confirmed }, expectedRecipeRevision: this.revision, saveId: createEditStateSaveId() });
        }
        if (!this.active) throw new RawApiError('raw_document_closed');
        this.error = undefined;
        finish();
      } catch (cause) {
        if (this.active) this.error = cause instanceof RawApiError ? cause.code : 'raw_connection_failed';
        try { frontendLogger.add({ level: 'error', component: 'raw', event: 'recipe.saveFailed',
          context: { assetId: this.confirmed.assetId, errorCode: this.error ?? 'raw_document_closed' } }); } catch { /* Optional diagnostics. */ }
        reject(cause);
      } finally {
        this.saving = false;
        this.operation = undefined;
        if (this.active) { this.options.changed(); this.observe(this.confirmed, true); }
      }
    });
    return operation;
  }
  private async resync() {
    const saved = await readRawRecipe(this.confirmed);
    if (!this.active) throw new RawApiError('raw_document_closed');
    this.revision = saved.recipeRevision;
    this.lastSaveId = saved.lastSaveId;
    // An absent DB row must not rebase a dirty local recipe to its current values.
    if (saved.recipeFingerprint !== null) this.savedFingerprint = saved.recipeFingerprint;
  }
  private async send(request: RawRecipeRequest) {
    const replay = this.retryRequest === request;
    try {
      const ack = await saveRawRecipe(request);
      if (!this.active) throw new RawApiError('raw_document_closed');
      this.revision = ack.recipeRevision;
      this.lastSaveId = ack.saveId;
      this.savedFingerprint = ack.settingsFingerprint;
      this.retryRequest = undefined;
    } catch (cause) {
      if (this.active) {
        // A busy/stale rejection of a replay cannot prove that its earlier attempt never committed.
        this.retryRequest = !replay && cause instanceof RawSaveError && cause.outcome === 'rejected' ? undefined : request;
        if (cause instanceof RawApiError && cause.code === 'raw_recipe_revision_conflict') {
          this.conflict = true;
          // Resync metadata without overwriting local settings or automatically retrying the conflict.
          await this.resync().catch(() => {});
        }
      }
      throw cause;
    }
  }
  dispose() { this.active = false; clearTimeout(this.timer); }
}
