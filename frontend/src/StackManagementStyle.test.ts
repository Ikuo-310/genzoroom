// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import './style.css';

afterEach(() => { document.body.replaceChildren(); });

it('keeps Stack group and photo close/add controls at their compact icon dimensions', () => {
  document.body.innerHTML = `<main class="stack-management-page">
    <header class="stack-group-header">
      <button class="stack-icon-button stack-purge-group">×</button>
      <button class="stack-icon-button stack-set-target">+</button>
    </header>
    <div class="stack-photo-wrapper"><button class="stack-photo"></button>
      <button class="stack-icon-button stack-purge-member">×</button>
    </div>
  </main>`;

  for (const button of document.querySelectorAll<HTMLButtonElement>('.stack-icon-button')) {
    const style = getComputedStyle(button);
    expect(style.width).toBe('22px');
    expect(style.height).toBe('22px');
    expect(style.padding).toBe('0px');
    expect(style.fontSize).toBe('1rem');
  }
  const photoClose = document.querySelector<HTMLElement>('.stack-purge-member')!;
  expect(getComputedStyle(photoClose).position).toBe('absolute');
  expect(getComputedStyle(photoClose).left).toBe('4px');
  expect(getComputedStyle(photoClose).top).toBe('4px');
});

it('matches Gallery spacing and gives independent Stack frames contained scrollbars', () => {
  document.body.innerHTML = `<main class="stack-management-page"><div class="stack-content">
    <div class="stack-split-view"><section class="stack-frame stack-candidate-frame"><div class="stack-candidate-grid"></div></section>
      <div class="stack-split-separator"></div><section class="stack-frame stack-unmatched-frame"><div class="stack-unmatched-grid"></div></section>
    </div>
  </div></main>`;
  const contentStyle = getComputedStyle(document.querySelector('.stack-content')!);
  expect(contentStyle.paddingLeft).toBe('24px'); expect(contentStyle.paddingRight).toBe('24px');
  expect(contentStyle.paddingTop).toBe('16px'); expect(contentStyle.paddingBottom).toBe('16px');

  for (const frame of document.querySelectorAll<HTMLElement>('.stack-frame')) {
    const style = getComputedStyle(frame);
    expect(style.paddingLeft).toBe('0px'); expect(style.paddingRight).toBe('0px');
    expect(style.paddingTop).toBe('10px'); expect(style.paddingBottom).toBe('10px');
    expect(parseFloat(style.borderTopWidth)).toBe(0); expect(parseFloat(style.borderRadius)).toBe(0);
    expect(style.overflow).toBe('auto');
    expect(style.scrollbarGutter).toBe('stable');
  }
  expect(parseFloat(getComputedStyle(document.querySelector('.stack-candidate-grid')!).minWidth)).toBe(0);
  expect(parseFloat(getComputedStyle(document.querySelector('.stack-unmatched-grid')!).minWidth)).toBe(0);
});
