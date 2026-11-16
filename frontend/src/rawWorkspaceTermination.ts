import type { RawRecipeSave } from './rawRecipeSave';

type TerminationKind = 'release' | 'discard' | 'recovery';
type TerminationState =
  | { stage: 'saving' }
  | { stage: 'releasing' }
  | { stage: 'unknown'; failedAt: 'saving' | 'releasing'; error: unknown }
  | { stage: 'complete' };

/** Owns one workspace's termination independently of the component that requested it. */
export class RawWorkspaceTermination {
  state: TerminationState = { stage: 'saving' };
  private operation?: Promise<void>;

  constructor(
    readonly workspaceId: string,
    readonly kind: TerminationKind,
    public saver: RawRecipeSave | undefined,
    private readonly settle: () => Promise<void>,
    private readonly terminate: () => Promise<void>,
  ) {}

  run(): Promise<void> {
    if (this.operation) return this.operation;
    if (this.state.stage === 'complete') return Promise.resolve();
    // Resume at the failed boundary: an uncertain save must be settled before release.
    const stage = this.state.stage === 'unknown' ? this.state.failedAt : this.state.stage;
    this.state = { stage };
    const operation = Promise.resolve().then(async () => {
      if (stage === 'saving') {
        await this.settle();
        this.state = { stage: 'releasing' };
      }
      await this.terminate();
      this.state = { stage: 'complete' };
      this.saver = undefined;
    }).catch(error => {
      const failedAt = this.state.stage === 'releasing' ? 'releasing' : 'saving';
      this.state = { stage: 'unknown', failedAt, error };
      throw error;
    }).finally(() => { this.operation = undefined; });
    this.operation = operation;
    return operation;
  }
}
