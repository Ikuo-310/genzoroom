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
  host = document.createElement('div');
  host.innerHTML = '<main class="home-page"><div class="home-intro"><header class="app-header"></header><section></section></div><section class="photos"><div class="photos-heading"></div><div class="photo-grid"><article class="photo-card selected"><label class="photo-selection-control"><input type="checkbox"></label><button class="photo-card-button"><div class="thumbnail"><img></div><div class="photo-info"><p>Photo.jpg</p><time>2026/09/27</time></div></button></article></div></section></main><div class="filmstrip"><button class="filmstrip-item"><img></button></div>';
  document.body.append(host);
});
afterEach(() => { stylesheet.remove(); host.remove(); });

describe('Home and thumbnail layout', () => {
  it('keeps the Home tabs and panels flexible at narrow widths', () => {
    const tabs = document.createElement('div'); tabs.className = 'home-tabs';
    const panel = document.createElement('div'); panel.className = 'home-tab-panel';
    host.querySelector('.photos').prepend(tabs, panel);
    expect(getComputedStyle(tabs).flexWrap).toBe('wrap');
    expect(getComputedStyle(panel).minWidth).toBe('0');
    expect(getComputedStyle(panel).minHeight).toBe('0');
  });
  it('anchors the display-only edit badge to both thumbnail frames', () => {
    for (const frame of host.querySelectorAll('.thumbnail, .filmstrip-item')) {
      const badge = document.createElement('span'); badge.className = 'edited-badge'; frame.append(badge);
      expect(getComputedStyle(frame).position).toBe('relative');
      expect(getComputedStyle(badge).position).toBe('absolute');
      expect(getComputedStyle(badge).right).toBe('6px');
      expect(getComputedStyle(badge).bottom).toBe('6px');
      expect(getComputedStyle(badge).pointerEvents).toBe('none');
      expect(getComputedStyle(badge).backgroundColor).toBe('rgba(15, 20, 18, 0.82)');
    }
  });
  it('caps card widths and gives the photo grid its own vertical scroll area', () => {
    const page = host.querySelector('.home-page');
    const intro = host.querySelector('.home-intro');
    const photos = host.querySelector('.photos');
    const heading = document.createElement('div'); heading.className = 'home-toolbar';
    host.querySelector('.photos').prepend(heading);
    const grid = host.querySelector('.photo-grid');
    expect(getComputedStyle(page).height).toBe('100dvh');
    expect(getComputedStyle(page).maxWidth).toBe('none');
    expect(getComputedStyle(page).overflowY).toBe('auto');
    expect(getComputedStyle(intro).maxWidth).toBe('1080px');
    expect(getComputedStyle(photos).display).toBe('flex');
    expect(getComputedStyle(photos).width).toBe('100%');
    expect(getComputedStyle(photos).minHeight).toBe('0');
    expect(getComputedStyle(heading).flexShrink).toBe('0');
    expect(getComputedStyle(grid).overflowY).toBe('auto');
    expect(getComputedStyle(grid).minHeight).toBe('0');
    expect(getComputedStyle(grid).gridTemplateColumns).toContain('auto-fit');
    expect(getComputedStyle(grid).gridAutoRows).toBe('max-content');
    expect(getComputedStyle(host.querySelector('.photo-card')).maxWidth).toBe('');
    expect(getComputedStyle(host.querySelector('.photo-card')).alignSelf).toBe('start');
  });

  it('adds spacing beside the photo grid scrollbar only in Firefox', () => {
    expect(stylesheet.textContent).toContain('@-moz-document url-prefix() {\n  .photo-grid { padding-right: 15px; scrollbar-width: auto; scrollbar-color: #718b7d #17221f; }');
    expect(getComputedStyle(host.querySelector('.photo-grid')).paddingRight).toBe('2px');
  });

  it('allows Home header controls to wrap at narrow widths', () => {
    const toolbar = document.createElement('div'); toolbar.className = 'home-toolbar';
    const tabs = document.createElement('div'); tabs.className = 'home-tabs';
    const controls = document.createElement('div');
    controls.className = 'home-toolbar-controls';
    controls.innerHTML = '<label class="home-control photo-filter-control"><span class="home-control-label">Type</span><select><option>All</option></select></label><label class="home-control recent-count-control"><span class="home-control-label">Recent count</span><select><option>100</option></select></label><div class="home-control thumbnail-size-setting"><span class="home-control-label">Thumbnail size</span><div class="thumbnail-size-control"></div></div>';
    toolbar.append(tabs, controls); host.querySelector('.photos').prepend(toolbar);
    expect(getComputedStyle(toolbar).display).toBe('flex');
    expect(getComputedStyle(toolbar).flexWrap).toBe('wrap');
    expect(getComputedStyle(controls).display).toBe('flex');
    expect(getComputedStyle(controls).flexWrap).toBe('wrap');
    expect(controls.querySelectorAll('.home-control')).toHaveLength(3);
    for (const group of controls.querySelectorAll('.home-control')) expect(getComputedStyle(group).flexDirection).toBe('column');
    expect(getComputedStyle(controls.querySelector('.photo-filter-control select')).width).toBe('88px');
    const narrowScreen = Array.from(stylesheet.sheet.cssRules).find((rule) => rule.conditionText?.includes('max-width: 760px'));
    expect(Array.from(narrowScreen.cssRules).some((rule) => rule.selectorText === '.home-toolbar-controls'
      && rule.style.getPropertyValue('justify-content') === 'flex-start')).toBe(true);
  });

  it('lets the Album grid use the shared thumbnail column width setting', () => {
    const grid = document.createElement('div'); grid.className = 'album-grid';
    grid.style.setProperty('--album-column-width', 'calc(25% - 12px)'); host.append(grid);
    expect(getComputedStyle(grid).gridTemplateColumns).toContain('var(--album-column-width, 220px)');
    expect(getComputedStyle(grid).gap).toBe('16px');
  });

  it('has no bottom note or extra grid row', () => {
    expect(host.querySelector('.note')).toBeNull();
    expect(getComputedStyle(host.querySelector('.home-page')).gridTemplateRows).toBe('auto minmax(120px, 1fr)');
    expect(stylesheet.textContent).not.toContain('.note');
  });

  it('keeps connection details outside the heading and restores the Anshitsu brand scale', () => {
    const row = document.createElement('div'); row.className = 'home-title-row';
    row.innerHTML = '<h1><button class="home-title-link">GenzoRoom</button></h1><details class="connection-control"><summary>Status</summary><section class="connection-details">Connection information</section></details>';
    const brand = document.createElement('div'); brand.className = 'workspace-brand';
    brand.innerHTML = '<button class="workspace-title-link">GenzoRoom</button>';
    host.append(row, brand);
    const heading = row.querySelector('h1');
    const details = row.querySelector('.connection-details');
    expect(heading.children).toHaveLength(1);
    expect(details.closest('h1')).toBeNull();
    expect(getComputedStyle(details).letterSpacing).toBe('normal');
    expect(getComputedStyle(details).fontWeight).toBe('400');
    expect(getComputedStyle(details).lineHeight).toBe('1.5');
    expect(getComputedStyle(details).width).toContain('320px');
    expect(getComputedStyle(details).maxWidth).toContain('100vw - 32px');
    expect(getComputedStyle(brand.querySelector('.workspace-title-link')).fontSize).toBe('1.6rem');
    expect(getComputedStyle(brand.querySelector('.workspace-title-link')).fontWeight).toBe('700');
    const narrowScreen = Array.from(stylesheet.sheet.cssRules).find((rule) => rule.conditionText?.includes('max-width: 520px'));
    expect(Array.from(narrowScreen.cssRules).some((rule) => rule.selectorText === '.workspace-brand .workspace-title-link'
      && rule.style.getPropertyValue('font-size') === '1.35rem')).toBe(true);
  });

  it('keeps selected cards dark and shows the whole photo in Home and Filmstrip thumbnails', () => {
    const card = host.querySelector('.photo-card');
    const selectedButton = host.querySelector('.photo-card-button');
    const homeImage = host.querySelector('.thumbnail img');
    const thumbnail = host.querySelector('.thumbnail');
    const filmstripImage = host.querySelector('.filmstrip-item img');
    expect(getComputedStyle(card).backgroundColor).toBe('rgb(23, 34, 31)');
    expect(getComputedStyle(selectedButton).color).toBe('rgb(230, 238, 233)');
    expect(getComputedStyle(selectedButton).backgroundColor).toBe('rgb(23, 34, 31)');
    expect(getComputedStyle(selectedButton).userSelect).toBe('none');
    const photoInfo = host.querySelector('.photo-info');
    expect(getComputedStyle(photoInfo).backgroundColor).toBe('rgb(23, 34, 31)');
    expect(getComputedStyle(photoInfo).color).toBe('rgb(230, 238, 233)');
    expect(getComputedStyle(photoInfo.querySelector('p')).color).toBe('rgb(230, 238, 233)');
    expect(getComputedStyle(photoInfo.querySelector('time')).color).toBe('rgb(159, 178, 168)');
    const hoverRules = Array.from(stylesheet.sheet.cssRules).filter((rule) => rule.selectorText?.includes('photo-card-button:hover'));
    expect(hoverRules.some((rule) => rule.selectorText === 'button.photo-card-button:hover:not(:disabled)'
      && rule.style.background === '#1d2b26')).toBe(true);
    expect(hoverRules.some((rule) => rule.selectorText === '.photo-card.selected button.photo-card-button:hover:not(:disabled)'
      && rule.style.background === '#1d2b26')).toBe(true);
    expect(Array.from(stylesheet.sheet.cssRules).some((rule) => rule.selectorText === '.photo-card-button:focus-visible'
      && rule.style.outline.includes('3px'))).toBe(true);
    expect(getComputedStyle(homeImage).objectFit).toBe('contain');
    expect(getComputedStyle(thumbnail).aspectRatio).toBe('1');
    expect(getComputedStyle(homeImage).height).toBe('100%');
    expect(getComputedStyle(thumbnail).backgroundColor).toBe('rgb(9, 14, 12)');
    expect(getComputedStyle(filmstripImage).objectFit).toBe('contain');
    expect(getComputedStyle(filmstripImage).backgroundColor).toBe('rgb(9, 14, 12)');
    expect(getComputedStyle(host.querySelector('.photo-card.selected')).borderColor).toBe('rgb(199, 217, 174)');
  });
});
