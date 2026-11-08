// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';

const sheets = [];
function attach(path) {
  const sheet = document.createElement('style');
  sheet.textContent = readFileSync(path, 'utf8');
  document.head.append(sheet);
  sheets.push(sheet);
  return sheet;
}

function rule(sheet, selector) {
  return Array.from(sheet.sheet.cssRules).find(item => 'selectorText' in item && item.selectorText === selector);
}

afterEach(() => { sheets.splice(0).forEach(sheet => sheet.remove()); });

it('keeps legacy green button rules inside Developer and uses neutral defaults elsewhere', () => {
  const app = attach('src/style.css');
  const developer = attach('src/developer.css');
  const host = document.createElement('div');
  host.innerHTML = `<main class="home-page"><button id="home">Home</button></main>
    <dialog class="settings-dialog" open><button id="settings">Settings</button></dialog>
    <main class="workspace-page"><button id="workspace">Workspace</button></main>
    <main class="developer-page"><button id="developer">Developer</button></main>`;
  document.body.append(host);
  try {
    const color = id => getComputedStyle(host.querySelector(`#${id}`)).backgroundColor;
    expect(rule(app, ':where(.home-page, .settings-dialog) button')?.style.background).toBe('var(--bg-elevated)');
    expect(rule(app, ':where(.home-page button:hover:not(:disabled), .settings-dialog button:hover:not(:disabled))')
      ?.style.background).toBe('var(--selection)');
    expect(color('workspace')).toBe('rgb(36, 36, 38)');
    expect(color('developer')).toBe('rgb(56, 58, 63)');

    const greenRules = Array.from(app.sheet.cssRules).filter(item => 'selectorText' in item
      && item.style.background === '#d1e2bf');
    const greenHoverRules = Array.from(app.sheet.cssRules).filter(item => 'selectorText' in item
      && item.style.background === '#e3f0d6');
    expect(greenRules.map(item => item.selectorText)).toEqual(['.developer-page button']);
    expect(greenHoverRules.map(item => item.selectorText)).toEqual(['.developer-page button:hover:not(:disabled)']);
    expect(rule(app, '.developer-page button')?.style.background).toBe('#d1e2bf');
    expect(rule(app, '.developer-page button:hover:not(:disabled)')?.style.background).toBe('#e3f0d6');
    expect(rule(developer, '.developer-page button:hover:not(:disabled)')?.style.background).toBe('#494b51');
    expect(rule(app, ':where(.workspace-page button:hover:not(:disabled))')?.style.background).toBe('#303033');
  } finally { host.remove(); }
});

it('retains the RAW curve and picker local hover and selected colors', () => {
  const sheet = attach('src/style.css');
  expect(rule(sheet, '.raw-curve-channel:hover')?.style.background).toBe('#303033');
  expect(rule(sheet, '.raw-curve-channel[aria-pressed="true"]')?.style.background).toBe('#303033');
  expect(Array.from(sheet.sheet.cssRules).findIndex(item => 'selectorText' in item
    && item.selectorText === '.raw-curve-channel[aria-pressed="true"]'))
    .toBeGreaterThan(Array.from(sheet.sheet.cssRules).findIndex(item => 'selectorText' in item && item.selectorText === '.raw-curve-channel:hover'));
  expect(rule(sheet, '.adjustment-category-icon:hover:not(:disabled), .adjustment-category-reset:hover:not(:disabled)')
    ?.style.background).toBe('#303033');
  expect(rule(sheet, '.raw-wb-pick.is-selected')?.style.background).toBe('#3a485b');
  expect(rule(sheet, '.raw-curve-channel:focus-visible')?.style.outline).toContain('2px');
  expect(rule(sheet, 'button:disabled')?.style.opacity).toBe('0.6');
});
