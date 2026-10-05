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
  host.innerHTML = '<main class="home-page"><header class="app-header"></header><div class="home-tabs-bar"><div class="home-tabs"></div></div><div class="home-toolbar"></div><section class="home-content"><div class="photo-grid"><article class="photo-card selected"><label class="photo-selection-control"><input type="checkbox"></label><button class="photo-card-button"><div class="thumbnail"><img></div><div class="photo-info"><p>Photo.jpg</p><time>2026/09/27</time></div></button></article></div></section></main><div class="filmstrip"><button class="filmstrip-item"><img></button></div>';
  document.body.append(host);
});
afterEach(() => { stylesheet.remove(); host.remove(); });

describe('Home and thumbnail layout', () => {
  it('places compact wrapping selection controls alongside the right toolbar controls', () => {
    const toolbar = host.querySelector('.home-toolbar');
    toolbar.innerHTML = '<div class="selection-bar"><strong>0 selected</strong><div class="selection-actions"><button disabled>Select all</button></div></div><div class="home-toolbar-controls"></div>';
    expect(getComputedStyle(toolbar).justifyContent).toBe('space-between');
    expect(getComputedStyle(toolbar).flexWrap).toBe('wrap');
    const selection = getComputedStyle(toolbar.querySelector('.selection-bar'));
    expect(selection.flexWrap).toBe('wrap');
    expect(selection.visibility).toBe('visible');
    expect(selection.marginBottom).toBe('');
    expect(getComputedStyle(toolbar.querySelector('.home-toolbar-controls')).justifyContent).toBe('flex-end');
  });
  it('uses equal Home and STACK brand sizes without changing darkroom typography', () => {
    const home = host.querySelector('.app-header');
    home.innerHTML = '<div class="home-title-row"><h1><button class="home-title-link">GenzoRoom</button></h1></div>';
    const stack = document.createElement('main'); stack.className = 'stack-management-page';
    stack.innerHTML = '<header class="stack-management-header"><button class="stack-home-title">GenzoRoom</button><h1>STACK</h1></header>';
    host.append(stack);
    const homeBrand = getComputedStyle(home.querySelector('.home-title-row'));
    const stackBrand = getComputedStyle(stack.querySelector('.stack-home-title'));
    expect(homeBrand.fontSize).toBe('1.6rem');
    expect(stackBrand.fontSize).toBe(homeBrand.fontSize);
    expect(stackBrand.fontWeight).toBe(homeBrand.fontWeight);
    expect(getComputedStyle(stack.querySelector('.stack-management-header')).gridTemplateColumns).toBe('minmax(0, 1fr) auto minmax(0, 1fr)');
    expect(getComputedStyle(stack.querySelector('h1')).fontSize).toBe('1.2rem');
  });
  it('lets every content layout grow inside the common scroll region', () => {
    const content = host.querySelector('.home-content');
    for (const className of ['photo-grid', 'album-grid', 'calendar-month', 'calendar-year']) {
      const element = document.createElement('div'); element.className = className; content.append(element);
      expect(getComputedStyle(element).overflowY).toBe('visible');
    }
    expect(getComputedStyle(content).overflowY).toBe('auto');
    expect(getComputedStyle(content).minHeight).toBe('0');
  });
  it('shares only basic theme tokens and removes the gallery enclosure', () => {
    const stack = document.createElement('main'); stack.className = 'stack-management-page'; host.append(stack);
    const home = host.querySelector('.home-page');
    for (const token of ['--bg-app', '--bg-panel', '--bg-elevated', '--border-subtle', '--text-primary', '--text-secondary', '--accent', '--accent-hover', '--selection', '--danger']) {
      expect(getComputedStyle(home).getPropertyValue(token)).toBe(getComputedStyle(stack).getPropertyValue(token));
      expect(getComputedStyle(home).getPropertyValue(token)).not.toBe('');
    }
    expect(getComputedStyle(home).getPropertyValue('--status-match')).toBe('');
    expect(getComputedStyle(stack).getPropertyValue('--status-match')).toBe('#285b3b');
    const photos = getComputedStyle(host.querySelector('.home-content'));
    expect(photos.borderTopWidth).toBe('0px');
    expect(photos.borderRadius).toBe('0');
    expect(photos.marginTop).toBe('0px');
    expect(photos.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  });
  it('uses a compact two-sided title bar with wrapping connection controls', () => {
    const header = host.querySelector('.app-header');
    header.innerHTML = '<div class="home-title-row"><h1>GenzoRoom</h1><details class="connection-control"></details></div><button class="settings-button">Settings</button>';
    expect(getComputedStyle(header).alignItems).toBe('center');
    expect(getComputedStyle(header).paddingTop).toBe('10px');
    // jsdom does not resolve inherited custom properties in border shorthand.
    const headerRule = Array.from(stylesheet.sheet.cssRules).find(rule => rule.selectorText === '.app-header');
    expect(headerRule.style.getPropertyValue('border-bottom')).toBe('1px solid var(--border-subtle)');
    expect(getComputedStyle(header.querySelector('.home-title-row')).fontSize).toBe('1.6rem');
    expect(getComputedStyle(header.querySelector('h1')).letterSpacing).toBe('normal');
    expect(getComputedStyle(header.querySelector('.home-title-row')).flexWrap).toBe('wrap');
    expect(getComputedStyle(header.querySelector('.settings-button')).fontSize).toBe('0.85rem');
  });
  it('keeps the fixed header and content full width', () => {
    const header = host.querySelector('.app-header');
    const photos = host.querySelector('.home-content');
    expect(header.parentElement).toBe(host.querySelector('.home-page'));
    expect(Array.from(header.parentElement.children).map(element => element.className))
      .toEqual(['app-header', 'home-tabs-bar', 'home-toolbar', 'home-content']);
    expect(getComputedStyle(header).justifyContent).toBe('space-between');
    expect(getComputedStyle(photos).width).toBe('100%');
    expect(stylesheet.textContent).toContain('@media (max-width: 520px)');
    expect(stylesheet.textContent).toContain('.app-header { display: flex; flex-wrap: wrap; }');
  });
  it('keeps annual calendars naturally sized with a responsive grid and matching mode-control height', () => {
    const year = document.createElement('div'); year.className = 'calendar-year';
    year.innerHTML = '<div class="calendar-year-grid"><section class="calendar-mini-month"><h3><button class="calendar-mini-month-title">January</button></h3><div class="calendar-days"></div></section></div><div class="calendar-navigation"><select></select><button class="calendar-view-toggle">Year view</button></div>';
    host.querySelector('.home-content').append(year);
    expect(getComputedStyle(year).minWidth).toBe('0');
    expect(getComputedStyle(year).minHeight).toBe('0');
    expect(getComputedStyle(year).overflowY).toBe('visible');
    expect(getComputedStyle(year).maxWidth).toBe('1700px');
    expect(getComputedStyle(year.querySelector('.calendar-year-grid')).gridTemplateColumns).toBe('repeat(auto-fit, minmax(min(100%, 260px), 1fr))');
    expect(getComputedStyle(year.querySelector('.calendar-year-grid')).gridTemplateColumns).not.toContain('scroll');
    expect(getComputedStyle(year.querySelector('.calendar-mini-month')).minWidth).toBe('0');
    expect(getComputedStyle(year.querySelector('.calendar-mini-month-title')).width).toBe('100%');
    expect(getComputedStyle(year.querySelector('.calendar-days')).gridTemplateColumns).toBe('repeat(7, minmax(0, 1fr))');
    expect(getComputedStyle(year.querySelector('.calendar-view-toggle')).height).toBe(getComputedStyle(year.querySelector('select')).height);
  });
  it('keeps the Home tabs and panels flexible at narrow widths', () => {
    const tabs = document.createElement('div'); tabs.className = 'home-tabs';
    const panel = document.createElement('div'); panel.className = 'home-tab-panel';
    host.querySelector('.home-content').prepend(tabs, panel);
    expect(getComputedStyle(tabs).flexWrap).toBe('wrap');
    expect(getComputedStyle(panel).minWidth).toBe('0');
    expect(getComputedStyle(panel).minHeight).toBe('0');
  });
  it('keeps the calendar in seven shrinkable columns at narrow widths', () => {
    const month = document.createElement('div'); month.className = 'calendar-month';
    const days = document.createElement('div'); days.className = 'calendar-days'; month.append(days);
    host.querySelector('.home-content').append(month);
    expect(getComputedStyle(month).minWidth).toBe('0');
    expect(getComputedStyle(month).maxWidth).toBe('840px');
    expect(getComputedStyle(days).minWidth).toBe('0');
    expect(getComputedStyle(days).gridTemplateColumns).toBe('repeat(7, minmax(0, 1fr))');
    const cell = document.createElement('button'); cell.className = 'calendar-day'; days.append(cell);
    expect(getComputedStyle(cell).aspectRatio).toBe('4 / 5');
    const year = document.createElement('div'); year.className = 'calendar-year';
    year.innerHTML = '<section class="calendar-mini-month"><button class="calendar-day"></button></section>';
    host.querySelector('.home-content').append(year);
    expect(getComputedStyle(year.querySelector('.calendar-day')).aspectRatio).toBe('1');
  });
  it('uses neutral semantic colors for Calendar surfaces and cells, reserving green for states', () => {
    const content = host.querySelector('.home-content');
    const month = document.createElement('div'); month.className = 'calendar-month';
    const year = document.createElement('div'); year.className = 'calendar-year';
    const mini = document.createElement('section'); mini.className = 'calendar-mini-month';
    mini.innerHTML = '<h3>January</h3><button class="calendar-mini-month-title">January</button>';
    const weekday = document.createElement('div'); weekday.className = 'calendar-weekday';
    const ordinary = document.createElement('button'); ordinary.className = 'calendar-day';
    const disabled = document.createElement('button'); disabled.className = 'calendar-day'; disabled.disabled = true;
    const photoDay = document.createElement('button'); photoDay.className = 'calendar-day has-assets today';
    content.append(month, year, mini, weekday, ordinary, disabled, photoDay);
    const rule = selector => Array.from(stylesheet.sheet.cssRules).find(item => item.selectorText === selector)?.style;
    for (const selector of ['.calendar-month', '.calendar-mini-month']) {
      expect(rule(selector).getPropertyValue('background')).toBe('var(--bg-panel)');
      expect(rule(selector).getPropertyValue('border')).toContain('var(--border-subtle)');
    }
    expect(rule('.calendar-year').getPropertyValue('background')).toBe('transparent');
    expect(rule('.calendar-year').getPropertyValue('border')).toBe('0');
    expect(rule('.calendar-year').getPropertyValue('border-radius')).toBe('0');
    expect(rule('.calendar-mini-month h3').getPropertyValue('color')).toBe('var(--text-primary)');
    expect(rule('.calendar-weekday').getPropertyValue('color')).toBe('var(--text-secondary)');
    expect(rule('.calendar-day').getPropertyValue('background')).toBe('var(--bg-elevated)');
    expect(rule('.calendar-day').getPropertyValue('border')).toContain('var(--border-subtle)');
    expect(rule('.calendar-day').getPropertyValue('color')).toBe('var(--text-primary)');
    expect(rule('.calendar-day:disabled').getPropertyValue('background')).toBe('var(--bg-app)');
    expect(rule('.calendar-day:disabled').getPropertyValue('color')).toBe('var(--text-secondary)');
    expect(rule('.calendar-day.has-assets').getPropertyValue('border-color')).toBe('#66696f');
    expect(rule('.calendar-day.has-assets').getPropertyValue('background-color')).toBe('#36383c');
    expect(rule('.calendar-day.has-assets:hover').getPropertyValue('border-color')).toBe('#85888f');
    expect(rule('.calendar-day.today').getPropertyValue('box-shadow')).toContain('#ececee');
    expect(rule('.calendar-month .has-thumbnail.today::after').getPropertyValue('box-shadow')).toContain('#ececee');
  });
  it('styles This month like the calendar selects while keeping the navigation responsive', () => {
    const navigation = document.createElement('div'); navigation.className = 'calendar-navigation';
    navigation.innerHTML = '<select><option>2026</option></select><button class="calendar-current-month">This month</button>';
    host.querySelector('.home-content').append(navigation);
    const select = getComputedStyle(navigation.querySelector('select'));
    const button = getComputedStyle(navigation.querySelector('.calendar-current-month'));
    for (const property of ['height', 'fontSize', 'fontWeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderRadius']) {
      expect(button[property]).toBe(select[property]);
    }
    // jsdom cannot resolve inherited variables consistently for button and select defaults.
    const sharedControl = Array.from(stylesheet.sheet.cssRules).find(rule => rule.selectorText?.startsWith('.calendar-navigation select,'));
    expect(sharedControl.selectorText).toContain('.calendar-navigation .calendar-current-month');
    expect(sharedControl.style.getPropertyValue('color')).toBe('var(--text-primary)');
    expect(sharedControl.style.getPropertyValue('background')).toBe('var(--bg-app)');
    expect(sharedControl.style.getPropertyValue('border')).toBe('1px solid var(--border-subtle)');
    expect(button.height).toBe('42px');
    expect(button.whiteSpace).toBe('nowrap');
    expect(getComputedStyle(navigation).flexWrap).toBe('wrap');
    expect(button.backgroundColor).not.toBe('transparent');
  });
  it('anchors the display-only edit badge to both thumbnail frames', () => {
    for (const frame of host.querySelectorAll('.thumbnail, .filmstrip-item')) {
      const badge = document.createElement('span'); badge.className = 'edited-badge'; frame.append(badge);
      expect(getComputedStyle(frame).position).toBe('relative');
      expect(getComputedStyle(badge).position).toBe('absolute');
      expect(getComputedStyle(badge).right).toBe('6px');
      expect(getComputedStyle(badge).bottom).toBe('6px');
      expect(getComputedStyle(badge).pointerEvents).toBe('none');
      expect(getComputedStyle(badge).backgroundColor).toBe(frame.closest('.home-page')
        ? 'rgba(18, 19, 21, 0.82)' : 'rgba(15, 20, 18, 0.82)');
    }
  });
  it('caps card widths and gives only Home content its vertical scroll area', () => {
    const page = host.querySelector('.home-page');
    const photos = host.querySelector('.home-content');
    const heading = document.createElement('div'); heading.className = 'home-toolbar';
    host.querySelector('.home-content').prepend(heading);
    const grid = host.querySelector('.photo-grid');
    expect(getComputedStyle(page).height).toBe('100dvh');
    expect(getComputedStyle(page).maxWidth).toBe('none');
    expect(getComputedStyle(page).overflow).toBe('hidden');
    expect(getComputedStyle(photos).overflowY).toBe('auto');
    expect(getComputedStyle(photos).width).toBe('100%');
    expect(getComputedStyle(photos).minHeight).toBe('0');
    expect(getComputedStyle(heading).flexShrink).toBe('0');
    expect(getComputedStyle(grid).overflowY).toBe('visible');
    expect(getComputedStyle(grid).minHeight).toBe('0');
    expect(getComputedStyle(grid).gridTemplateColumns).toContain('auto-fill');
    expect(getComputedStyle(grid).gridAutoRows).toBe('max-content');
    expect(getComputedStyle(host.querySelector('.photo-card')).maxWidth).toBe('');
    expect(getComputedStyle(host.querySelector('.photo-card')).alignSelf).toBe('start');
  });

  it('adds spacing beside the photo grid scrollbar only in Firefox', () => {
    expect(stylesheet.textContent.replace(/\r\n/g, '\n')).toContain('@-moz-document url-prefix() {\n  .home-content { padding-right: 15px; scrollbar-width: auto; scrollbar-color: #73767d var(--bg-app); }');
    expect(getComputedStyle(host.querySelector('.photo-grid')).paddingRight).toBe('2px');
  });

  it('allows Home header controls to wrap at narrow widths', () => {
    const toolbar = document.createElement('div'); toolbar.className = 'home-toolbar';
    const tabs = document.createElement('div'); tabs.className = 'home-tabs';
    const controls = document.createElement('div');
    controls.className = 'home-toolbar-controls';
    controls.innerHTML = '<label class="home-control photo-filter-control"><span class="home-control-label">Type</span><select><option>All</option></select></label><label class="home-control edit-status-filter-control"><span class="home-control-label">Edit status</span><select><option>All</option><option>Edited</option><option>Not edited</option></select></label><label class="home-control recent-count-control"><span class="home-control-label">Recent count</span><select><option>100</option></select></label><div class="home-control thumbnail-size-setting"><span class="home-control-label">Thumbnail size</span><div class="thumbnail-size-control"></div></div>';
    toolbar.append(tabs, controls); host.querySelector('.home-content').prepend(toolbar);
    expect(getComputedStyle(toolbar).display).toBe('flex');
    expect(getComputedStyle(toolbar).flexWrap).toBe('wrap');
    expect(getComputedStyle(controls).display).toBe('flex');
    expect(getComputedStyle(controls).flexWrap).toBe('wrap');
    expect(controls.querySelectorAll('.home-control')).toHaveLength(4);
    for (const group of controls.querySelectorAll('.home-control')) expect(getComputedStyle(group).flexDirection).toBe('column');
    expect(getComputedStyle(controls.querySelector('.photo-filter-control select')).width).toBe('88px');
    expect(getComputedStyle(controls.querySelector('.edit-status-filter-control select')).width).toBe('auto');
    expect(getComputedStyle(controls.querySelector('.edit-status-filter-control select')).minWidth).toBe('88px');
    expect(getComputedStyle(controls.querySelector('.edit-status-filter-control select')).paddingRight).toBe('8px');
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
    expect(getComputedStyle(host.querySelector('.home-page')).gridTemplateRows).toBe('auto auto auto minmax(0, 1fr)');
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
    const rule = selector => Array.from(stylesheet.sheet.cssRules).find(item => item.selectorText === selector).style;
    expect(rule('.photo-card').getPropertyValue('background')).toBe('var(--bg-panel)');
    expect(rule('.photo-card.selected .photo-card-button').getPropertyValue('color')).toBe('var(--text-primary)');
    expect(rule('.photo-card.selected .photo-card-button').getPropertyValue('background')).toBe('var(--bg-panel)');
    expect(getComputedStyle(selectedButton).userSelect).toBe('none');
    const photoInfo = host.querySelector('.photo-info');
    expect(rule('.photo-info').getPropertyValue('background')).toBe('var(--bg-panel)');
    expect(rule('.photo-info').getPropertyValue('color')).toBe('var(--text-primary)');
    expect(rule('.photo-info p').getPropertyValue('color')).toBe('var(--text-primary)');
    expect(rule('.photo-info time').getPropertyValue('color')).toBe('var(--text-secondary)');
    const hoverRules = Array.from(stylesheet.sheet.cssRules).filter((rule) => rule.selectorText?.includes('photo-card-button:hover'));
    expect(hoverRules.some((rule) => rule.selectorText === 'button.photo-card-button:hover:not(:disabled)'
      && rule.style.background === 'var(--bg-elevated)')).toBe(true);
    expect(hoverRules.some((rule) => rule.selectorText === '.photo-card.selected button.photo-card-button:hover:not(:disabled)'
      && rule.style.background === 'var(--bg-elevated)')).toBe(true);
    expect(Array.from(stylesheet.sheet.cssRules).some((rule) => rule.selectorText === '.photo-card-button:focus-visible'
      && rule.style.outline.includes('3px'))).toBe(true);
    expect(getComputedStyle(homeImage).objectFit).toBe('contain');
    expect(getComputedStyle(thumbnail).aspectRatio).toBe('1');
    expect(getComputedStyle(homeImage).height).toBe('100%');
    expect(getComputedStyle(thumbnail).backgroundColor).toBe('rgb(16, 17, 19)');
    expect(getComputedStyle(filmstripImage).objectFit).toBe('contain');
    expect(getComputedStyle(filmstripImage).backgroundColor).toBe('rgb(9, 14, 12)');
    expect(rule('.photo-card.selected').getPropertyValue('border-color')).toBe('var(--accent)');
    expect(rule('.photo-card.selected').getPropertyValue('box-shadow')).toBe('0 0 0 2px var(--accent)');
  });
});
