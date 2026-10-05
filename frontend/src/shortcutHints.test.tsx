// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoSelectionBar } from './PhotoSelectionBar';
import { ImageViewer } from './ImageViewer';
import { ScopePanel } from './ScopePanel';
import { EditSettingsMenu } from './EditSettingsMenu';
import { updateSetting } from './appSettings';
import { formatShortcut } from './shortcutDisplay';
import i18n from './i18n';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  updateSetting('showKeyboardShortcuts', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); updateSetting('showKeyboardShortcuts', true); vi.unstubAllGlobals(); });

describe('visual shortcut hints', () => {
  for (const language of ['en', 'ja']) {
    it(`preserves semantic labels and ordinary titles when hints are OFF (${language})`, async () => {
      await i18n.changeLanguage(language);
      const originalToggle = vi.fn();
      await act(async () => root.render(<>
        <PhotoSelectionBar count={1} onClear={() => {}} onOpen={() => {}} />
        <ImageViewer src="/photo" alt="photo" leftOpen rightOpen onToggleLeft={() => {}} onToggleRight={() => {}}
          originalStatus="ready" editSource={{ kind: 'immich-preview', url: '/photo' }} onOriginalToggle={originalToggle} />
        <ScopePanel histogram={null} />
      </>));
      const original = host.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t('workspace.previewOriginal')}"]`)!;
      const before = host.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t('workspace.beforeAfter')}"]`)!;
      const fit = host.querySelector<HTMLButtonElement>('.zoom-controls button')!;
      const open = host.querySelector<HTMLButtonElement>('.selection-open-workspace')!;
      expect(open.title).toContain(`(${formatShortcut('homeOpenSelected')})`);
      expect(original.title).toContain(`(${formatShortcut('viewerOriginal')})`);
      expect(before.title).toBe(i18n.t('workspace.beforeHoldShortcutHint', { shortcut: formatShortcut('viewerBefore') }));
      expect(fit.title).toBe(i18n.t('workspace.fitShortcutHint', { shortcut: formatShortcut('viewerFitRestore') }));
      for (const [selector, id] of [['.channel-r', 'scopeRed'], ['.channel-g', 'scopeGreen'], ['.channel-b', 'scopeBlue'],
        ['.histogram-y-button', 'scopeYOnly'], ['.histogram-scale-toggle', 'scopeScale']] as const) {
        expect(host.querySelector<HTMLButtonElement>(selector)!.title).toContain(`(${formatShortcut(id)})`);
      }
      act(() => updateSetting('showKeyboardShortcuts', false));
      expect(open.title).toBe(i18n.t('photos.openSelected'));
      expect(original.title).toBe(i18n.t('workspace.previewOriginal'));
      expect(before.title).toBe(i18n.t('workspace.beforeAfter'));
      expect(fit.title).toBe(i18n.t('workspace.fit'));
      for (const button of host.querySelectorAll<HTMLButtonElement>('.histogram-channel-button, .histogram-scale-toggle')) {
        expect(button.title).toBe(button.getAttribute('aria-label'));
      }
      expect(host.querySelector<HTMLButtonElement>('.histogram-y-button')!.title).toBe(i18n.t('workspace.yOnly'));
      expect(before.getAttribute('aria-label')).toBe(i18n.t('workspace.beforeAfter'));
      act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true, cancelable: true })));
      expect(originalToggle).toHaveBeenCalledTimes(1);
      act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad1', key: 'End', bubbles: true, cancelable: true })));
      expect(host.querySelector('.channel-r')!.getAttribute('aria-pressed')).toBe('false');
    });
  }
  it('uses the same registry labels in toolbar and context menus and keeps actions when OFF', async () => {
    await i18n.changeLanguage('en');
    const action = vi.fn(() => true);
    await act(async () => root.render(<EditSettingsMenu disabled={false} hasClipboard={false}
      onCopy={action} onPaste={action} onSelectCopy={action} onSelectPaste={action}
      contextPosition={{ x: 0, y: 0 }} />));
    const expected = (['copySettings', 'copySelection', 'pasteSettings', 'pasteSelection'] as const).map(id => formatShortcut(id));
    for (const selector of ['.edit-settings-menu-actions', '.edit-settings-context-menu']) {
      const menu = document.querySelector(selector)!;
      expect([...menu.querySelectorAll('.shortcut-label')].map(label => label.textContent)).toEqual(expected);
      expect([...menu.querySelectorAll('.shortcut-label')].every(label => label.getAttribute('aria-hidden') === 'true')).toBe(true);
      expect(menu.querySelectorAll('button')[2].disabled).toBe(true);
    }
    act(() => updateSetting('showKeyboardShortcuts', false));
    expect(document.querySelector('.shortcut-label')).toBeNull();
    for (const selector of ['.edit-settings-menu-actions', '.edit-settings-context-menu']) {
      expect(document.querySelector(selector)!.querySelectorAll('button')).toHaveLength(4);
    }
    act(() => document.querySelector<HTMLButtonElement>('.edit-settings-menu-actions button')!.click());
    expect(action).toHaveBeenCalledTimes(1);
  });
});
