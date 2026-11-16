import { expect, it, vi } from 'vitest';
import type { RawRecipeSave } from './rawRecipeSave';
import { RawWorkspaceTermination } from './rawWorkspaceTermination';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('shares one termination and retains its workspace and Saver until completion', async () => {
  const save = deferred(), release = deferred();
  const settle = vi.fn(() => save.promise), terminate = vi.fn(() => release.promise);
  const saver = {} as RawRecipeSave;
  const owner = new RawWorkspaceTermination('workspace-a', 'release', saver, settle, terminate);
  const first = owner.run();
  expect(owner.run()).toBe(first);
  expect(owner).toMatchObject({ workspaceId: 'workspace-a', kind: 'release', state: { stage: 'saving' }, saver });
  await Promise.resolve();
  expect(settle).toHaveBeenCalledOnce();
  expect(terminate).not.toHaveBeenCalled();
  save.resolve();
  await Promise.resolve(); await Promise.resolve();
  expect(owner.state).toEqual({ stage: 'releasing' });
  expect(owner.saver).toBe(saver);
  release.resolve();
  await first;
  expect(owner.state).toEqual({ stage: 'complete' });
  expect(owner.saver).toBeUndefined();
  await owner.run();
  expect(settle).toHaveBeenCalledOnce();
  expect(terminate).toHaveBeenCalledOnce();
});

it.each(['saving', 'releasing'] as const)('retains the %s failure and retries that boundary', async failedAt => {
  const gate = deferred();
  const error = new Error('unconfirmed');
  const saver = {} as RawRecipeSave;
  const settle = vi.fn(() => failedAt === 'saving' ? gate.promise : Promise.resolve());
  const terminate = vi.fn(() => failedAt === 'releasing' ? gate.promise : Promise.resolve());
  const owner = new RawWorkspaceTermination('workspace-b', 'recovery', saver, settle, terminate);
  const first = owner.run();
  const observed = expect(first).rejects.toBe(error);
  await Promise.resolve(); await Promise.resolve();
  gate.reject(error);
  await observed;
  expect(owner).toMatchObject({ workspaceId: 'workspace-b', kind: 'recovery', saver,
    state: { stage: 'unknown', failedAt, error } });
  settle.mockResolvedValue(undefined);
  terminate.mockResolvedValue(undefined);
  const retry = owner.run();
  expect(owner.run()).toBe(retry);
  await retry;
  expect(owner.state).toEqual({ stage: 'complete' });
  expect(owner.saver).toBeUndefined();
  expect(settle).toHaveBeenCalledTimes(failedAt === 'saving' ? 2 : 1);
  expect(terminate).toHaveBeenCalledTimes(failedAt === 'releasing' ? 2 : 1);
});

it('retains the discard kind for a separate owner', () => {
  const owner = new RawWorkspaceTermination('workspace-c', 'discard', undefined, async () => {}, async () => {});
  expect(owner).toMatchObject({ workspaceId: 'workspace-c', kind: 'discard', state: { stage: 'saving' } });
});
