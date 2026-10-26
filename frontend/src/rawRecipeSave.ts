import { createEditStateSaveId } from './editStateApi';
import { frontendLogger } from './frontendLogging';
import { RawApiError, RawSaveError, readRawRecipe, saveRawRecipe, saveRawHistory, readRawHistory,
  type RawSettings, type RawRecipeRequest, type RawHistoryRequest, type RawControlId, type RawHistoryResult, type RawHistoryStep, type RawHistoryOperation } from './rawApi';
import type { RawControls } from './rawControls';

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
  private retryRequest?: RawRecipeRequest | RawHistoryRequest;
  private conflict = false;
  initialized = false;
  history?: RawHistoryResult['history'];
  steps: RawHistoryStep[] = [];
  historyLoading = false;
  historyError?: string;
  moving = false;
  private historyOperation?: Promise<void>;
  private moveIntent?: { action: 'undo' | 'redo' | 'jump' | 'operate'; targetStepId?: string | null; operation?: RawHistoryOperation };
  private gesture?: { control: RawControlId; fingerprint: string };
  // One adjacent control's unsent intent is held until the preceding gesture is acknowledged.
  // It uses the same owner queue; no native mutation or second save queue starts here.
  private handoff?: { control: RawControlId; value?: number; ended: boolean };
  constructor(public confirmed: RawSettings, private options: {
    schedule: (action: () => Promise<void>) => void; changed: () => void;
    controls?: RawControls;
  }) {
    this.revision = confirmed.recipeRevision;
    this.savedFingerprint = confirmed.recipeFingerprint ?? confirmed.settingsFingerprint;
  }
  get dirty() { return !!this.retryRequest || !!this.gesture || !!this.handoff || !!this.moveIntent
    || !!this.options.controls && !this.initialized || this.confirmed.settingsFingerprint !== this.savedFingerprint; }
  get locked() { return !!this.options.controls && (!this.initialized || !!this.operation || !!this.error || this.moving); }
  get gesturing() { return !!this.gesture && !this.operation && !this.paused && !this.moving; }
  get canUndo() { return !!this.history && (this.history.cursor > 0 || !!this.gesture); }
  get canRedo() { return !!this.history && this.history.cursor < this.history.length; }
  async waitHistory(retry = false) { try { await this.historyOperation; } catch (cause) { if (!retry) throw cause; } }
  move(action: 'undo' | 'redo' | 'jump', targetStepId?: string | null): Promise<void> {
    if (!this.active || this.locked || this.historyLoading || this.historyError || !this.history) return Promise.resolve();
    if (action === 'undo' && !this.canUndo || action === 'redo' && !this.canRedo) return Promise.resolve();
    if (action === 'jump' && targetStepId !== null && !this.steps.some(step => step.stepId === targetStepId)) return Promise.resolve();
    this.moving = true;
    this.options.controls?.endPreview();
    this.moveIntent = { action, targetStepId };
    // Reserve the entire commit->move sequence on the existing queue before cleanup can enter.
    const operation = this.save().finally(() => {
      this.moving = false; this.historyOperation = undefined; if (this.active) this.options.changed();
    });
    this.historyOperation = operation;
    return operation;
  }
  operate(intent: RawHistoryOperation): Promise<void> {
    const finishingGesture = !!this.operation && !!this.gesture && !this.moving && !this.error;
    if (!this.active || this.locked && !finishingGesture || this.historyLoading || this.historyError || !this.history) return Promise.resolve();
    this.moving = true;
    this.moveIntent = { action: 'operate', operation: structuredClone(intent) };
    this.options.controls?.endPreview();
    // Share the History fence with navigation and renewal; an accepted Reset drains its gesture first.
    const operation = this.save().finally(() => {
      this.moving = false; this.historyOperation = undefined; if (this.active) this.options.changed();
    });
    this.historyOperation = operation;
    return operation;
  }
  retryHistory() {
    if (!this.active || !this.initialized || this.historyLoading || this.moving || this.operation || this.error || this.dirty) return;
    this.historyLoading = true;
    this.options.changed();
    this.options.schedule(async () => { await this.loadHistory(); });
  }
  private async loadHistory() {
    this.historyLoading = true;
    try {
      const data = await readRawHistory(this.confirmed);
      if (!this.active) return;
      if (data.recipeRevision !== this.revision || data.recipeFingerprint !== this.savedFingerprint || data.historyPending
        || data.nativeState !== 'synced' || !data.nativeMatchesRecipe || !this.history
        || data.history.cursor !== this.history.cursor || data.history.length !== this.history.length
        || data.history.selectedStepId !== this.history.selectedStepId) throw new RawApiError('raw_history_revision_conflict');
      if (new Set(data.steps.map(step => step.stepId)).size !== data.steps.length || data.steps.length > 200)
        throw new RawApiError('raw_invalid_response');
      this.steps = data.steps;
      this.historyError = undefined;
    } catch (cause) {
      if (this.active) {
        this.historyError = cause instanceof RawApiError ? cause.code : 'raw_connection_failed';
        try { frontendLogger.add({ level: 'warn', component: 'raw', event: 'history.loadFailed', context: {
          assetId: this.confirmed.assetId, generation: this.confirmed.generation, recipeRevision: this.revision,
          errorCode: this.historyError } }); } catch { /* Optional diagnostics. */ }
      }
    } finally { this.historyLoading = false; if (this.active) this.options.changed(); }
  }
  private async sendMoveIntent() {
    if (!this.moveIntent) return;
    if (this.historyError) await this.loadHistory();
    if (this.historyError) throw new RawApiError(this.historyError);
    const { action, targetStepId, operation } = this.moveIntent;
    // Cache refresh can hide a still-valid UUID. Let SQLite validate membership; never
    // infer deletion from a page miss or retarget a removed UUID by position.
    const available = action === 'operate' || (action === 'undo' ? this.canUndo : action === 'redo' ? this.canRedo
      : targetStepId !== this.history?.selectedStepId);
    this.moveIntent = undefined;
    if (!available) return;
    this.retryRequest = { doc: structuredClone(this.confirmed), expectedRecipeRevision: this.revision,
      saveId: createEditStateSaveId(), action, ...(action === 'jump' ? { targetStepId } : {}), ...(operation ? { operation } : {}) };
    try { await this.sendHistory(); }
    catch (cause) {
      if (!(cause instanceof RawSaveError) || cause.outcome !== 'rejected' || cause.status !== 409
        || cause.code !== 'raw_history_target_missing') throw cause;
      // B2 rejects this target before native application or receipt creation. The preceding
      // gesture is saved; keeping its obsolete target as an uncertain save would deadlock Retry.
      this.retryRequest = undefined;
      this.historyError = cause.code;
      try { frontendLogger.add({ level: 'warn', component: 'raw', event: 'history.targetMissing', context: {
        assetId: this.confirmed.assetId, recipeRevision: this.revision, errorCode: cause.code } }); } catch { /* Optional diagnostics. */ }
    }
  }
  begin(control: RawControlId) {
    if (!this.active || this.locked || this.paused) return;
    if (this.gesture?.control === control) return;
    if (this.gesture) {
      this.handoff = { control, ended: false };
      void this.save().catch(() => {});
      return;
    }
    this.gesture = { control, fingerprint: this.confirmed.settingsFingerprint };
    this.options.controls?.beginPreview();
    this.options.changed();
  }
  change(control: RawControlId, value: number) {
    if (!this.active || this.error || this.paused) return;
    if (this.handoff?.control === control) { this.handoff.value = value; return; }
    if (this.locked) return;
    this.begin(control);
    if (this.handoff?.control === control) { this.handoff.value = value; return; }
    if (this.gesture?.control === control) this.options.controls?.change({ [control]: value });
  }
  end(control?: RawControlId) {
    if (this.handoff && (control === undefined || control === this.handoff.control)) { this.handoff.ended = true; return; }
    if (this.gesture && (control === undefined || control === this.gesture.control)) {
      this.options.controls?.endPreview();
      void this.save().then(() => this.options.controls?.refreshPreview()).catch(() => {});
    } else if (!this.gesture && !this.locked) {
      this.options.controls?.endPreview();
      this.options.controls?.refreshPreview();
    }
  }
  observe(settings: RawSettings, settled: boolean) {
    this.confirmed = settings;
    clearTimeout(this.timer);
    if (!this.options.controls && this.active && !this.paused && !this.error && settled && this.dirty) {
      this.timer = setTimeout(() => { void this.save().catch(() => {}); }, RAW_AUTOSAVE_MS);
    }
  }
  pause() { this.paused = true; clearTimeout(this.timer); }
  resume() { this.paused = false; this.observe(this.confirmed, true); }
  save(retry = false, force = false): Promise<void> {
    if (this.operation) return this.operation;
    clearTimeout(this.timer);
    let finish!: () => void, reject!: (error: unknown) => void;
    const operation = new Promise<void>((yes, no) => { finish = yes; reject = no; });
    this.operation = operation;
    // Flush before the save barrier. Awaiting controls.settle() inside this queue would deadlock.
    this.options.controls?.flush();
    this.options.schedule(async () => {
      try {
        if (!this.active) throw new RawApiError('raw_document_closed');
        if (this.error && !retry) throw new RawApiError(this.error);
        this.saving = true;
        this.options.changed();
        if (this.options.controls) {
          await this.sendHistory();
          await this.sendMoveIntent();
          this.error = undefined;
          finish();
          return;
        }
        if (retry && this.conflict && !this.retryRequest) { await this.resync(); this.conflict = false; }
        // Replay the exact saved document revision before creating a new saveId for newer readback.
        if (this.retryRequest) await this.send(this.retryRequest);
        // Renewal needs a DB row even when edits returned to an initially unsaved baseline.
        if (force || this.confirmed.settingsFingerprint !== this.savedFingerprint) {
          await this.send({ doc: { ...this.confirmed }, expectedRecipeRevision: this.revision, saveId: createEditStateSaveId() });
        }
        if (!this.active) throw new RawApiError('raw_document_closed');
        this.error = undefined;
        finish();
      } catch (cause) {
        if (this.active) this.error = cause instanceof RawApiError ? cause.code : 'raw_connection_failed';
        try { frontendLogger.add({ level: 'error', component: 'raw', event: 'recipe.saveFailed',
          context: { assetId: this.confirmed.assetId, generation: this.confirmed.generation,
            revision: this.confirmed.revision, saveId: this.retryRequest?.saveId ?? null,
            errorCode: this.error ?? 'raw_document_closed' } }); } catch { /* Optional diagnostics. */ }
        reject(cause);
      } finally {
        this.saving = false;
        this.operation = undefined;
        const next = this.handoff;
        if (this.active && !this.error && next) {
          this.handoff = undefined;
          // Pausing admission for navigation must still drain intent already accepted.
          this.gesture = { control: next.control, fingerprint: this.confirmed.settingsFingerprint };
          this.options.controls?.beginPreview();
          if (next.value !== undefined) this.options.controls?.change({ [next.control]: next.value });
          if (next.ended || this.paused || this.moving) this.end(next.control);
        }
        if (this.active) { this.options.changed(); this.observe(this.confirmed, true); }
        if (this.active && !this.error && !this.gesture && !this.handoff && this.initialized)
          this.options.controls?.refreshPreview();
      }
    });
    this.options.changed();
    return operation;
  }
  private async sendHistory() {
    const controls = this.options.controls!;
    // Preview failure can coexist with verified readback. As in C3 settle(), only
    // unconfirmed desired/native work prevents saving that confirmed edit.
    if (controls.unsettled) throw new RawApiError(controls.error ?? 'raw_save_unconfirmed');
    this.confirmed = controls.confirmed;
    // Render readback may advance native state, but it cannot invent a user History step
    // or rebase a saved checkpoint. Fail closed instead of reporting a no-op save forever.
    if (!this.retryRequest && this.initialized && !this.gesture
      && this.confirmed.settingsFingerprint !== this.savedFingerprint)
      throw new RawApiError('raw_history_readback_mismatch');
    if (this.gesture && this.gesture.fingerprint !== this.savedFingerprint) throw new RawApiError('raw_save_unconfirmed');
    if (!this.retryRequest && (this.gesture || !this.initialized)) {
      this.retryRequest = { doc: structuredClone(this.confirmed), expectedRecipeRevision: this.revision,
        saveId: createEditStateSaveId(), action: this.initialized ? 'commit' : 'initialize', control: this.gesture?.control };
    }
    if (this.retryRequest) {
      const request = this.retryRequest;
      if (!('action' in request)) throw new RawApiError('raw_save_unconfirmed');
      const result = await saveRawHistory(request);
      if (!this.active) throw new RawApiError('raw_document_closed');
      const moving = request.action === 'undo' || request.action === 'redo' || request.action === 'jump' || request.action === 'operate';
      // A valid old receipt does not certify the current native or SQLite checkpoint.
      if (result.generation !== this.confirmed.generation || result.documentToken !== this.confirmed.documentToken
        || result.handle !== this.confirmed.handle || result.workspaceId !== this.confirmed.workspaceId
        || (moving ? result.revision < request.doc.revision : result.revision !== request.doc.revision
          || result.revision !== this.confirmed.revision || result.settingsFingerprint !== request.doc.settingsFingerprint
          || result.settingsFingerprint !== this.confirmed.settingsFingerprint) || result.historyPending
        || result.nativeState !== 'synced' || !result.nativeMatchesRecipe
        || result.recipeFingerprint !== result.settingsFingerprint || result.recipeRevision !== result.ack.revision
        || result.ack.settingsFingerprint !== result.settingsFingerprint
        || result.history.cursor !== result.ack.historyCursor || result.history.length !== result.ack.historyLength
        || result.history.selectedStepId !== result.ack.stepId
        || result.ack.saveId !== request.saveId) throw new RawApiError('raw_save_unconfirmed');
      this.revision = result.recipeRevision;
      this.savedFingerprint = result.recipeFingerprint;
      this.lastSaveId = result.ack.saveId;
      this.initialized = true;
      this.retryRequest = undefined;
      if (this.gesture) controls.endPreview();
      this.gesture = undefined;
      this.confirmed = controls.confirmed = result;
      this.history = result.history;
      // Commits can prune or replace step IDs, while cursor moves preserve the complete list.
      if (!moving || request.action === 'operate' || this.historyError) await this.loadHistory();
      if (moving) controls.refreshPreview();
      try { frontendLogger.add({ level: 'debug', component: 'raw', event: 'history.saved', context: {
        assetId: result.assetId, generation: result.generation, saveId: result.ack.saveId,
        action: request.action, revision: result.revision, recipeRevision: result.recipeRevision, historyCursor: result.history.cursor,
        historyLength: result.history.length, replayed: result.replayed } }); } catch { /* Optional diagnostics. */ }
    }
    if (this.confirmed.settingsFingerprint !== this.savedFingerprint) throw new RawApiError('raw_save_unconfirmed');
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
