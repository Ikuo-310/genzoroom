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
  host.innerHTML = '<main class="home-page"><div class="home-intro"><header class="app-header"></header><section></section></div><section class="photos"><div class="photos-heading"></div><div class="photo-grid"><article class="photo-card selected"><button class="photo-card-button">Photo</button><div class="thumbnail"><img></div></article></div></section><p class="note"></p></main><div class="filmstrip"><button class="filmstrip-item"><img></button></div>';
  document.body.append(host);
});
afterEach(() => { stylesheet.remove(); host.remove(); });

describe('Home and thumbnail layout', () => {
  it('caps card widths and gives the photo grid its own vertical scroll area', () => {
    const page = host.querySelector('.home-page');
    const intro = host.querySelector('.home-intro');
    const photos = host.querySelector('.photos');
    const heading = host.querySelector('.photos-heading');
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
    expect(getComputedStyle(grid).gridTemplateColumns).toContain('auto-fill');
    expect(getComputedStyle(grid).gridAutoRows).toBe('max-content');
    expect(getComputedStyle(host.querySelector('.photo-card')).maxWidth).toBe('240px');
    expect(getComputedStyle(host.querySelector('.photo-card')).alignSelf).toBe('start');
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
    expect(getComputedStyle(homeImage).objectFit).toBe('contain');
    expect(getComputedStyle(thumbnail).aspectRatio).toBe('1');
    expect(getComputedStyle(homeImage).height).toBe('100%');
    expect(getComputedStyle(thumbnail).backgroundColor).toBe('rgb(9, 14, 12)');
    expect(getComputedStyle(filmstripImage).objectFit).toBe('contain');
    expect(getComputedStyle(filmstripImage).backgroundColor).toBe('rgb(9, 14, 12)');
    expect(getComputedStyle(host.querySelector('.photo-card.selected')).borderColor).toBe('rgb(199, 217, 174)');
  });
});
