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
  expect(contentStyle.paddingLeft).toBe('24px'); expect(contentStyle.paddingRight).toBe('0px');
  expect(contentStyle.paddingTop).toBe('16px'); expect(contentStyle.paddingBottom).toBe('16px');

  for (const frame of document.querySelectorAll<HTMLElement>('.stack-frame')) {
    const style = getComputedStyle(frame);
    expect(style.paddingLeft).toBe('0px'); expect(style.paddingRight).toBe('24px');
    expect(style.paddingTop).toBe('10px'); expect(style.paddingBottom).toBe('10px');
    expect(parseFloat(style.borderTopWidth)).toBe(0); expect(parseFloat(style.borderRadius)).toBe(0);
    expect(style.overflow).toBe('auto');
    expect(style.scrollbarGutter).toBe('stable');
  }
  expect(parseFloat(getComputedStyle(document.querySelector('.stack-candidate-grid')!).minWidth)).toBe(0);
  expect(parseFloat(getComputedStyle(document.querySelector('.stack-unmatched-grid')!).minWidth)).toBe(0);
  expect(getComputedStyle(document.querySelector('.stack-split-separator')!).marginRight).toBe('24px');
});

it('anchors accessibility labels inside Stack scroll containers without changing their hidden presentation', () => {
  document.body.innerHTML = `<main class="stack-management-page">
    <div class="stack-control-bar"><span class="visually-hidden" id="toolbar-label">6 columns</span></div>
    <div class="stack-content"><div class="stack-split-view">
      <section class="stack-frame stack-candidate-frame"><div class="stack-candidate-group">
        <header class="stack-group-header"><div class="stack-group-indicators">
          <span class="stack-evidence matched"><span class="visually-hidden" id="evidence-label">Immich Stack</span></span>
        </div><span class="visually-hidden" id="target-label">Add target</span></header>
      </div></section><section class="stack-frame stack-unmatched-frame"></section>
    </div></div></main>`;
  // jsdom has no layout-based offsetParent; verify the positioned ancestor boundary instead.
  const positionedAncestor = (element: Element) => {
    let ancestor = element.parentElement;
    while (ancestor) {
      const position = getComputedStyle(ancestor).position;
      if (position && position !== 'static') return ancestor;
      ancestor = ancestor.parentElement;
    }
    return null;
  };
  for (const id of ['evidence-label', 'target-label']) {
    const label = document.getElementById(id)!;
    expect(positionedAncestor(label)).toBe(document.querySelector('.stack-candidate-frame'));
    expect(getComputedStyle(label).position).toBe('absolute');
    expect(getComputedStyle(label).clip).toBe('rect(0px, 0px, 0px, 0px)');
    expect(getComputedStyle(label).width).toBe('1px');
    expect(label.textContent).not.toBe('');
  }
  expect(positionedAncestor(document.getElementById('toolbar-label')!)).toBe(document.querySelector('.stack-management-page'));
  expect(getComputedStyle(document.querySelector('.stack-unmatched-frame')!).position).toBe('relative');
});

it('preserves Stack filename padding while fitting the shared middle-ellipsis layout into narrow cards', () => {
  document.body.innerHTML = `<div class="stack-photo" style="width: 120px"><span class="stack-filename">
    <span class="filename-middle-ellipsis" title="PXL_20260402_105016-Genzo01.jpg"><span class="filename-middle-ellipsis-visual">
      <span class="filename-prefix">PXL_20260402_105016</span><span class="filename-suffix">-Genzo01.jpg</span>
    </span></span></span></div>`;
  const label = document.querySelector<HTMLElement>('.stack-filename')!;
  expect(getComputedStyle(label).paddingLeft).toBe('8px');
  expect(getComputedStyle(label).overflow).toBe('hidden');
  const display = document.querySelector<HTMLElement>('.filename-middle-ellipsis')!;
  expect(getComputedStyle(display).width).toBe('100%');
  const prefix = document.querySelector<HTMLElement>('.filename-prefix')!;
  expect(getComputedStyle(prefix).minWidth).toBe('0');
  expect(getComputedStyle(prefix).overflow).toBe('hidden');
  const suffix = document.querySelector<HTMLElement>('.filename-suffix')!;
  expect(getComputedStyle(suffix).flexShrink).toBe('0');
  expect(suffix.textContent).toBe('-Genzo01.jpg');
});

it('lets the empty unmatched frame shrink to its Grid track while retaining its own scroll area', () => {
  document.body.innerHTML = `<div class="stack-split-view">
    <section class="stack-frame stack-unmatched-frame stack-unmatched-empty"><h2>STACK候補外</h2><p class="stack-empty">No unmatched photos</p></section>
  </div>`;
  const frame = document.querySelector<HTMLElement>('.stack-unmatched-frame')!;
  expect(frame.classList.contains('stack-unmatched-empty')).toBe(true);
  expect(getComputedStyle(frame).minHeight).toBe('0');
  expect(getComputedStyle(frame).overflow).toBe('auto');
  expect(frame.querySelector('.stack-empty')?.textContent).toBe('No unmatched photos');

  frame.classList.remove('stack-unmatched-empty');
  expect(getComputedStyle(frame).minHeight).toBe('0');
  expect(getComputedStyle(frame).overflow).toBe('auto');
});
