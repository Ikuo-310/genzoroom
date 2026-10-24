import { frontendLogger } from './frontendLogging';

/** Fixed-size gesture totals: no settings, pointer history, tokens or image content. */
export class RawInteractionMetrics {
  inputs = 0;
  mutations = 0;
  acknowledgements = 0;
  draftRequests = 0;
  draftAdoptions = 0;
  discards = { revision: 0, generation: 0, session: 0, view: 0, departure: 0, ended: 0, frozen: 0, superseded: 0, failed: 0 };
  latestInput = 0;
  ackAt = 0;
  endedAt = 0;
  inputAckMaxMs = 0;
  ackDisplayMaxMs = 0;
  fullDisplayMs: number | null = null;
  constructor(readonly generation: number, readonly gestureId: number) {}
  input() { this.inputs++; this.latestInput = performance.now(); }
  ack(inputAt: number) {
    this.acknowledgements++; this.ackAt = performance.now();
    this.inputAckMaxMs = Math.max(this.inputAckMaxMs, this.ackAt - inputAt);
  }
  report(phase: string) {
    try { frontendLogger.add({ level: 'debug', component: 'raw', event: 'interaction.summary', context: {
      generation: this.generation, gestureId: this.gestureId, phase, inputs: this.inputs, mutations: this.mutations,
      acknowledgements: this.acknowledgements, draftRequests: this.draftRequests, draftAdoptions: this.draftAdoptions,
      discards: { ...this.discards }, inputAckMaxMs: this.inputAckMaxMs, ackDisplayMaxMs: this.ackDisplayMaxMs,
      fullDisplayMs: this.fullDisplayMs,
    } }); } catch { /* Optional diagnostics cannot affect editing or saving. */ }
  }
}
