// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import styleCss from './style.css?raw';
import i18n from './i18n';
import { updateSetting } from './appSettings';
import { EditedBadge } from './EditedBadge';
const styles = styleCss;

let root: Root;
let host: HTMLDivElement;
async function render(props: React.ComponentProps<typeof EditedBadge>) {
  await act(async () => root.render(<EditedBadge {...props} />));
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  updateSetting('showKeyboardShortcuts', true);
  await i18n.changeLanguage('en');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('EditedBadge', () => {
  it.each([undefined, false])('keeps the badge hidden for unedited or unknown edit state (%s)', async edited => {
    await render({ edited });
    expect(host.querySelector('.edited-badge')).toBeNull();
  });

  it('preserves the legacy edited-only display when Queue state is not provided or unknown', async () => {
    await render({ edited: true });
    const legacy = host.querySelector('.edited-badge')!;
    expect(legacy.tagName).toBe('SPAN');
    expect(legacy.getAttribute('role')).toBe('img');
    expect(legacy.getAttribute('aria-label')).toBe('Edited in GenzoRoom');
    await render({ edited: true, queueKnown: false });
    expect(host.querySelector('.edited-badge')?.getAttribute('aria-label')).toBe('Edited in GenzoRoom');
  });

  it('shows confirmed Queue-out at full contrast and exposes add action with the configured shortcut', async () => {
    await render({ edited: true, queueKnown: true });
    const badge = host.querySelector('.edited-badge')!;
    expect(badge.classList.contains('queue-inactive')).toBe(true);
    expect(badge.getAttribute('aria-label')).toBe('Edited — Add to Export Queue [Q]');
    act(() => updateSetting('showKeyboardShortcuts', false));
    expect(badge.getAttribute('aria-label')).toBe('Edited — Add to Export Queue');
  });

  it('keeps Queue-out opaque, inverts queued colors, and preserves both states on hover', () => {
    expect(styles).toMatch(/\.edited-badge\.queue-aware\s*\{[^}]*opacity:\s*1/);
    expect(styles).toMatch(/\.edited-badge\.queue-inactive\s*\{[^}]*color:\s*#fff/);
    expect(styles).toMatch(/\.edited-badge\.queue-queued\s*\{[^}]*color:\s*#17181b[^}]*background:\s*#f0f1f3/);
    expect(styles).toMatch(/\.edited-badge-interactive\.queue-inactive:hover:not\(:disabled\)\s*\{[^}]*background:\s*#292b2f/);
    expect(styles).toMatch(/\.edited-badge-interactive\.queue-queued:hover:not\(:disabled\)\s*\{[^}]*color:\s*#17181b[^}]*background:\s*#dfe1e5/);
    expect(styles).not.toMatch(/\.edited-badge-interactive:hover:not\(:disabled\)\s*\{[^}]*filter:\s*brightness/);
  });

  it.each([
    ['queued', 'queue-queued', 'Edited — Remove from Export Queue [Q]', false],
    ['waiting', 'queue-waiting', 'Waiting for export', true],
    ['encoding', 'queue-processing', 'Encoding JPEG', true],
    ['registering', 'queue-processing', 'Registering with Immich', true],
    ['failed', 'queue-failed', 'Export failed — Remove from Export Queue [Q]', false],
  ] as const)('describes %s runtime state', async (queueStatus, stateClass, label, locked) => {
    await render({ edited: true, queueKnown: true, queueStatus });
    const badge = host.querySelector('.edited-badge')!;
    expect(badge.classList.contains(stateClass)).toBe(true);
    expect(badge.getAttribute('aria-label')).toBe(label);
    expect(badge.getAttribute('title')).toBe(label);
    expect(badge.classList.contains('queue-locked')).toBe(locked);
  });

  it('represents busy, explicit disabled, and locked interactive states without firing callbacks', async () => {
    const onQueueToggle = vi.fn();
    for (const props of [
      { queueKnown: true, busy: true },
      { queueKnown: true, disabled: true },
      { queueKnown: true, queueStatus: 'waiting' as const },
      { queueKnown: true, queueStatus: 'encoding' as const },
      { queueKnown: true, queueStatus: 'registering' as const },
      { queueKnown: false },
    ]) {
      await render({ edited: true, onQueueToggle, ...props });
      const button = host.querySelector<HTMLButtonElement>('.edited-badge')!;
      expect(button.disabled).toBe(true);
      if (props.busy) expect(button.classList.contains('queue-busy')).toBe(true);
      await act(async () => button.click());
    }
    expect(onQueueToggle).not.toHaveBeenCalled();
  });

  it.each([
    [{ queueKnown: true }, false],
    [{ queueKnown: true, queueStatus: 'queued' as const }, true],
    [{ queueKnown: true, queueStatus: 'failed' as const }, true],
  ])('allows toggle for Queue-out, queued, and failed states', async (state, pressed) => {
    const onQueueToggle = vi.fn();
    await render({ edited: true, onQueueToggle, ...state });
    const button = host.querySelector<HTMLButtonElement>('.edited-badge')!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-pressed')).toBe(String(pressed));
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(onQueueToggle).toHaveBeenCalledOnce();
  });

  it('localizes every Queue tooltip key in Japanese and English', () => {
    for (const language of ['en', 'ja']) for (const key of ['add', 'remove', 'waiting', 'encoding', 'registering', 'failed']) {
      expect(i18n.exists(`photos.exportQueue.${key}`, { lng: language })).toBe(true);
    }
  });
});
