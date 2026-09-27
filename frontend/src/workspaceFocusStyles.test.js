// @vitest-environment jsdom
// Keep the filesystem boundary in JavaScript; the frontend has no Node types.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let stylesheet;
let host;
beforeEach(() => {
  stylesheet = document.createElement('style');
  stylesheet.textContent = readFileSync('src/style.css', 'utf8');
  document.head.append(stylesheet);
  host = document.createElement('div'); document.body.append(host);
});
afterEach(() => { stylesheet.remove(); host.remove(); });

describe('explicit workspace focus styling', () => {
  it('shows a confirm ring for actual focus without requiring focus-visible and removes it when disabled', () => {
    host.innerHTML = '<dialog class="adjustment-selection-dialog" open><button class="tool-button selection-confirm-button">Copy</button></dialog>';
    const button = host.querySelector('button'); button.focus();
    expect(document.activeElement).toBe(button);
    expect(getComputedStyle(button).outline).toContain('2px');
    button.disabled = true;
    expect(getComputedStyle(button).outline).toBe('none');
  });

  it.each(['edit-settings-context-menu', 'edit-settings-menu-actions'])('distinguishes mouse and keyboard focus in %s', (className) => {
    host.innerHTML = `<div class="edit-settings-action-list ${className}" data-focus-mode="pointer"><button class="workspace-menu-item">Copy</button></div>`;
    const menu = host.firstElementChild;
    const button = host.querySelector('button'); button.focus();
    expect(getComputedStyle(button).outline).toBe('none');
    menu.dataset.focusMode = 'keyboard';
    expect(getComputedStyle(button).outline).toContain('2px');
    menu.dataset.focusMode = 'pointer';
    expect(getComputedStyle(button).outline).toBe('none');
  });
});
