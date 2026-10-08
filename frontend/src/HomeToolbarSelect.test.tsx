// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HomeToolbarSelect } from './HomeToolbarSelect';

function markupFor(value: string, label: string) {
  return renderToStaticMarkup(
    <div>
      <label htmlFor="recent-count">Recent count</label>
      <HomeToolbarSelect id="recent-count" aria-label="Recent count" value={value} selectedLabel={label} onChange={() => {}}>
        <option value="50">50</option>
        <option value="100">100</option>
        <option value="500">500</option>
      </HomeToolbarSelect>
    </div>,
  );
}

function parse(markup: string) {
  const container = document.createElement('div');
  container.innerHTML = markup;
  return container;
}

describe('HomeToolbarSelect', () => {
  it('uses one native sizing option and keeps the full interactive select labelled', () => {
    const container = parse(markupFor('100', '100枚'));
    const sizing = container.querySelector<HTMLSelectElement>('.home-select-sizing')!;
    const interactive = container.querySelector<HTMLSelectElement>('.home-select-interactive')!;

    expect(sizing.tagName).toBe('SELECT');
    expect(sizing.options).toHaveLength(1);
    expect(sizing.value).toBe('100');
    expect(sizing.options[0].textContent).toBe('100枚');
    expect(sizing.getAttribute('aria-hidden')).toBe('true');
    expect(sizing.tabIndex).toBe(-1);
    expect(sizing.id).toBe('');
    expect(sizing.getAttribute('aria-label')).toBeNull();
    expect(interactive.options).toHaveLength(3);
    expect(interactive.id).toBe('recent-count');
    expect(interactive.getAttribute('aria-label')).toBe('Recent count');
    expect(container.querySelector('label')?.control).toBe(interactive);
  });

  it('tracks selected values and localized labels supplied by its controlled owner', () => {
    const english = parse(markupFor('50', '50'));
    const japanese = parse(markupFor('500', '500枚'));

    expect(english.querySelector('.home-select-sizing option')?.textContent).toBe('50');
    expect(english.querySelector<HTMLSelectElement>('.home-select-sizing')?.value).toBe('50');
    expect(japanese.querySelector('.home-select-sizing option')?.textContent).toBe('500枚');
    expect(japanese.querySelector<HTMLSelectElement>('.home-select-sizing')?.value).toBe('500');
  });
});
