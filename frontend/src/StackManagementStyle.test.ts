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
