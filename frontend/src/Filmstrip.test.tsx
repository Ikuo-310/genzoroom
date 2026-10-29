// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Filmstrip } from './Filmstrip';
import type { RecentAsset } from './assets';
import i18n from './i18n';

const assets: RecentAsset[] = ['a', 'b', 'c'].map((id) => ({ id, filename: `${id}.jpg`, date: '2026-09-25',
  thumbnail_url: `/${id}`, format: 'JPEG', is_raw: false }));

it('uses rendered thumbnail URLs without generation POSTs', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await act(async () => root.render(<Harness />));
  expect([...host.querySelectorAll('.filmstrip-item img')].map(image => image.getAttribute('src')))
    .toEqual(assets.map(asset => `/api/assets/${asset.id}/rendered-thumbnail`));
  expect(fetch).not.toHaveBeenCalled();
});

it.each([true, false])('keeps mixed RAW/JPEG URLs across active changes independently of badges (edited=%s)', async edited => {
  const mixed = [assets[0], { ...assets[1], filename: 'b.dng', format: 'DNG', is_raw: true }, assets[2]];
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const urls = () => [...host.querySelectorAll('.filmstrip-item img')].map(image => image.getAttribute('src'));
  const expected = mixed.map(asset => `/api/assets/${asset.id}/rendered-thumbnail`);
  await act(async () => root.render(<Harness items={mixed} edited={edited} />));
  expect(urls()).toEqual(expected);
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[1].click());
  expect(host.querySelector('.filmstrip-item[aria-current="true"]')?.getAttribute('aria-label')).toBe('b.dng');
  expect(urls()).toEqual(expected);
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[2].click());
  expect(urls()).toEqual(expected);
  expect(fetch).not.toHaveBeenCalled();
});
let host: HTMLDivElement;
let root: Root;
let activate = vi.fn<(id: string) => void>();
function Harness({ disabled = false, blocked = false, immersive = false, items = assets, activeAssetId, recipeChangeRevision = 0,
  edited = false }: { disabled?: boolean; blocked?: boolean; immersive?: boolean; items?: RecentAsset[]; activeAssetId?: string;
  recipeChangeRevision?: number; edited?: boolean }) {
  const [active, setActive] = useState('a');
  const current = activeAssetId ?? active;
  return <><Filmstrip assets={items} activeAssetId={current} recipeChangeRevision={recipeChangeRevision} disabled={disabled}
    keyboardBlocked={blocked} viewerFocusMode={immersive} editStatuses={edited ? { [current]: true } : {}}
    onActivate={(id) => { activate(id); setActive(id); }} />
    <input type="range" defaultValue={5} onKeyDown={event => {
      if (!event.defaultPrevented && event.key === 'ArrowRight') event.currentTarget.value = String(Number(event.currentTarget.value) + 1);
    }} /><input type="number" /><input type="text" /><textarea /><select><option>one</option></select>
    <div contentEditable /><div role="textbox" /><button className="other">Other</button></>;
}
const scroll = () => host.querySelector<HTMLElement>('.filmstrip-scroll')!;
const item = (index: number) => host.querySelectorAll<HTMLButtonElement>('.filmstrip-item')[index];
const current = () => host.querySelector('.filmstrip-item[aria-current="true"]')?.getAttribute('aria-label');
function key(value: string, target: EventTarget = window, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event));
  return event;
}
function move(direction: 'previous' | 'next', target: EventTarget = window, init: KeyboardEventInit = {}) {
  return key(direction === 'previous' ? 'ArrowLeft' : 'ArrowRight', target,
    { ctrlKey: true, shiftKey: true, ...init });
}
function wheel(deltaY: number, target: EventTarget = scroll(), init: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event));
  return event;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); activate = vi.fn();
  act(() => root.render(<Harness />));
});
afterEach(async () => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await i18n.changeLanguage('en'); });

describe('Filmstrip keyboard navigation', () => {
  it('uses standalone arrows only in immersive mode and prevents range changes through navigation and at either end', () => {
    const range = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(key('ArrowRight', range).defaultPrevented).toBe(false);
    expect(range.value).toBe('6');
    expect(current()).toBe('a.jpg');

    act(() => root.render(<Harness immersive />));
    expect(key('ArrowRight', range).defaultPrevented).toBe(true);
    expect(current()).toBe('b.jpg');
    expect(range.value).toBe('6');
    expect(key('ArrowRight', range).defaultPrevented).toBe(true);
    expect(current()).toBe('c.jpg');
    expect(range.value).toBe('6');
    expect(key('ArrowRight', range).defaultPrevented).toBe(true);
    expect(current()).toBe('c.jpg');
    expect(range.value).toBe('6');
    expect(key('ArrowLeft', range).defaultPrevented).toBe(true);
    expect(current()).toBe('b.jpg');
    expect(range.value).toBe('6');

    act(() => root.render(<Harness />));
    expect(key('ArrowRight', range).defaultPrevented).toBe(false);
    expect(range.value).toBe('7');
    expect(current()).toBe('b.jpg');
  });

  it.each([false, true])('keeps Primary+Shift arrows as photo navigation when immersive=%s', immersive => {
    act(() => root.render(<Harness immersive={immersive} />));
    expect(move('next').defaultPrevented).toBe(true);
    expect(current()).toBe('b.jpg');
    expect(move('previous').defaultPrevented).toBe(true);
    expect(current()).toBe('a.jpg');
  });

  it('moves globally in both directions without hover or Filmstrip focus', () => {
    expect(move('next').defaultPrevented).toBe(true);
    expect(current()).toBe('b.jpg');
    expect(move('next').defaultPrevented).toBe(true);
    expect(current()).toBe('c.jpg');
    expect(move('next').defaultPrevented).toBe(true);
    expect(current()).toBe('c.jpg');
    expect(move('previous').defaultPrevented).toBe(true);
    expect(current()).toBe('b.jpg');
    expect(activate.mock.calls).toEqual([['b'], ['c'], ['b']]);
  });

  it('works while an ordinary Viewer-like control is focused and keeps that focus', () => {
    const target = host.querySelector<HTMLButtonElement>('.other')!;
    act(() => target.focus());
    expect(move('next', target).defaultPrevented).toBe(true);
    expect(current()).toBe('b.jpg');
    expect(document.activeElement).toBe(target);
  });

  it('does not intercept standalone arrows or incomplete/extra modifiers', () => {
    for (const options of [{}, { ctrlKey: true }, { shiftKey: true }, { ctrlKey: true, shiftKey: true, altKey: true },
      { ctrlKey: true, shiftKey: true, metaKey: true }, { ctrlKey: true, shiftKey: true, metaKey: true, altKey: true }]) {
      for (const arrow of ['ArrowLeft', 'ArrowRight']) {
        expect(key(arrow, window, options).defaultPrevented).toBe(false);
      }
    }
    expect(activate).not.toHaveBeenCalled();
  });

  it('ignores repeated, composing, and already prevented commands', () => {
    act(() => root.render(<Harness immersive />));
    expect(key('ArrowRight', window, { repeat: true }).defaultPrevented).toBe(false);
    expect(key('ArrowRight', window, { isComposing: true }).defaultPrevented).toBe(false);
    expect(move('next', window, { repeat: true }).defaultPrevented).toBe(false);
    expect(move('next', window, { isComposing: true }).defaultPrevented).toBe(false);
    const prevented = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true, cancelable: true });
    prevented.preventDefault(); act(() => window.dispatchEvent(prevented));
    expect(current()).toBe('a.jpg');
    expect(activate).not.toHaveBeenCalled();
  });

  it.each(['input[type="number"]', 'input[type="text"]', 'textarea', 'select', '[contenteditable]', '[role="textbox"]'])
    ('preserves native editing in %s', (selector) => {
      act(() => root.render(<Harness immersive />));
      const target = host.querySelector<HTMLElement>(selector)!;
      act(() => target.focus());
      expect(key('ArrowRight', target).defaultPrevented).toBe(false);
      expect(move('next', target).defaultPrevented).toBe(false);
      expect(activate).not.toHaveBeenCalled();
    });

  it('ignores blocked and disabled filmstrips', () => {
    act(() => root.render(<Harness blocked immersive />));
    expect(move('next').defaultPrevented).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    act(() => root.render(<Harness disabled immersive />));
    expect(move('next').defaultPrevented).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  it.each(['dialog', 'alertdialog', 'menu'])('ignores commands while a %s is open', (role) => {
    const overlay = role === 'dialog' ? document.createElement('dialog') : document.createElement('div');
    if (role === 'dialog') (overlay as HTMLDialogElement).setAttribute('open', '');
    else overlay.setAttribute('role', role);
    document.body.append(overlay);
    try {
      act(() => root.render(<Harness immersive />));
      expect(key('ArrowRight').defaultPrevented).toBe(false);
      expect(activate).not.toHaveBeenCalled();
    } finally { overlay.remove(); }
  });

  it('ignores the edit settings menu and preserves active thumbnail reveal', () => {
    const menu = document.createElement('details'); menu.className = 'edit-settings-menu'; menu.open = true;
    document.body.append(menu);
    try { act(() => root.render(<Harness immersive />)); expect(key('ArrowRight').defaultPrevented).toBe(false); } finally { menu.remove(); }

    Object.defineProperty(scroll(), 'clientWidth', { configurable: true, value: 200 });
    vi.spyOn(scroll(), 'getBoundingClientRect').mockReturnValue({ left: 100 } as DOMRect);
    vi.spyOn(item(1), 'getBoundingClientRect').mockImplementation(() => ({
      left: 260 - scroll().scrollLeft, right: 352 - scroll().scrollLeft,
    } as DOMRect));
    move('next');
    expect(current()).toBe('b.jpg');
    expect(scroll().scrollLeft).toBe(52);
    expect(document.activeElement).toBe(document.body);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.documentElement.scrollLeft).toBe(0);
  });

  it('reveals active thumbnails after clicks without moving focus', () => {
    Object.defineProperty(scroll(), 'clientWidth', { configurable: true, value: 200 });
    vi.spyOn(scroll(), 'getBoundingClientRect').mockReturnValue({ left: 100 } as DOMRect);
    vi.spyOn(item(1), 'getBoundingClientRect').mockReturnValue({ left: 260, right: 352 } as DOMRect);
    act(() => item(1).click());
    expect(scroll().scrollLeft).toBe(52);
  });

  it('preserves manual scrolling across asset, status, disabled, and keyboard state rerenders', () => {
    const region = scroll();
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 200 });
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue({ left: 100 } as DOMRect);
    const activeBounds = vi.spyOn(item(0), 'getBoundingClientRect').mockReturnValue({ left: 260, right: 352 } as DOMRect);
    region.scrollLeft = 37;
    act(() => item(1).focus());

    act(() => root.render(<Harness items={[...assets]} disabled blocked edited />));

    expect(region.scrollLeft).toBe(37);
    expect(activeBounds).not.toHaveBeenCalled();
  });

  it('reveals the active item when an actual Recipe change is reported', () => {
    const region = scroll();
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 200 });
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue({ left: 100 } as DOMRect);
    vi.spyOn(item(0), 'getBoundingClientRect').mockReturnValue({ left: 260, right: 352 } as DOMRect);
    region.scrollLeft = 37;

    act(() => root.render(<Harness recipeChangeRevision={1} />));

    expect(region.scrollLeft).toBe(89);
  });

  it('reveals the new active item when the visible photo set excludes the current photo', () => {
    const region = scroll();
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 200 });
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue({ left: 100 } as DOMRect);
    vi.spyOn(item(2), 'getBoundingClientRect').mockReturnValue({ left: 260, right: 352 } as DOMRect);

    act(() => root.render(<Harness items={[assets[0], assets[2]]} activeAssetId="c" />));

    expect(current()).toBe('c.jpg');
    expect(region.scrollLeft).toBe(52);
  });
});

describe('Filmstrip wheel scrolling', () => {
  function setOverflow(width = 600, viewport = 200) {
    Object.defineProperty(scroll(), 'scrollWidth', { configurable: true, value: width });
    Object.defineProperty(scroll(), 'clientWidth', { configurable: true, value: viewport });
  }

  it('maps vertical wheel direction to horizontal scrolling without changing photo selection', () => {
    setOverflow();
    expect(wheel(35).defaultPrevented).toBe(true);
    expect(scroll().scrollLeft).toBe(35);
    expect(wheel(-12).defaultPrevented).toBe(true);
    expect(scroll().scrollLeft).toBe(23);
    expect(current()).toBe('a.jpg');
    expect(activate).not.toHaveBeenCalled();
  });

  it('clamps converted input at both horizontal edges', () => {
    setOverflow();
    expect(wheel(-20).defaultPrevented).toBe(true);
    expect(scroll().scrollLeft).toBe(0);
    scroll().scrollLeft = 400;
    expect(wheel(40).defaultPrevented).toBe(true);
    expect(scroll().scrollLeft).toBe(400);
  });

  it('keeps the position unchanged when there is no horizontal overflow', () => {
    setOverflow(120, 200);
    expect(wheel(40).defaultPrevented).toBe(true);
    expect(scroll().scrollLeft).toBe(0);
  });

  it('leaves native horizontal wheel and touchpad input unconverted', () => {
    setOverflow();
    scroll().scrollLeft = 18;
    const event = wheel(40, scroll(), { deltaX: 25 });
    expect(event.defaultPrevented).toBe(false);
    // jsdom does not perform native scrolling; unchanged position proves there was no second custom scroll.
    expect(scroll().scrollLeft).toBe(18);
  });

  it.each([
    [WheelEvent.DOM_DELTA_LINE, 2, 32],
    [WheelEvent.DOM_DELTA_PAGE, 1, 200],
  ])('converts deltaMode %s using the corresponding scroll unit', (deltaMode, deltaY, expected) => {
    setOverflow();
    expect(wheel(deltaY, scroll(), { deltaMode }).defaultPrevented).toBe(true);
    expect(scroll().scrollLeft).toBe(expected);
  });

  it('handles wheel events from thumbnails and exclusion controls and prevents vertical page propagation', () => {
    setOverflow();
    const exclude = vi.fn();
    act(() => root.render(<Filmstrip assets={assets} activeAssetId="a" onActivate={activate} onExclude={exclude}
      editStatuses={{ a: true }} />));
    setOverflow();
    expect(wheel(24, item(1)).defaultPrevented).toBe(true);
    expect(scroll().scrollLeft).toBe(24);
    const badge = host.querySelector<HTMLElement>('.edited-badge')!;
    expect(wheel(12, badge).defaultPrevented).toBe(true);
    expect(scroll().scrollLeft).toBe(36);
    const excludeButton = host.querySelector<HTMLButtonElement>('.filmstrip-exclude')!;
    expect(wheel(16, excludeButton).defaultPrevented).toBe(true);
    expect(scroll().scrollLeft).toBe(52);
    expect(activate).not.toHaveBeenCalled();
    expect(exclude).not.toHaveBeenCalled();
  });
});

describe('Filmstrip exclusion buttons', () => {
  it.each(['en', 'ja'])('keeps localized exclusion, selection, format and Queue controls independent (%s)', async language => {
    await i18n.changeLanguage(language);
    const exclude = vi.fn(), toggle = vi.fn();
    const items = [assets[0], { ...assets[1], format: 'DNG', is_raw: true }, assets[2]];
    act(() => root.render(<Filmstrip assets={items} activeAssetId="a" onActivate={activate} onExclude={exclude}
      editStatuses={{ a: true }} queueKnown queueStatusFor={() => 'queued'} onQueueToggle={toggle} />));
    const buttons = host.querySelectorAll<HTMLButtonElement>('.filmstrip-exclude');
    expect(buttons).toHaveLength(3);
    expect(buttons[0].getAttribute('aria-label')).toBe(language === 'en'
      ? 'Exclude a.jpg from Filmstrip' : 'a.jpgをフィルムストリップから除外');
    const icon = buttons[0].querySelector('svg')!;
    expect(icon.getAttribute('width')).toBe('14');
    expect(icon.getAttribute('height')).toBe('14');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect([...icon.querySelectorAll('path')].map(path => path.getAttribute('d')))
      .toEqual(['M18 6 6 18', 'm6 6 12 12']);
    expect(buttons[0].title).toContain(language === 'en' ? 'Exclude a.jpg from Filmstrip' : 'a.jpgをフィルムストリップから除外');
    expect(item(0).querySelector('.format-badge')?.textContent).toBe('JPEG');
    expect(item(1).querySelector('.format-badge.raw')?.textContent).toBe('DNG');
    expect(host.querySelector('button button')).toBeNull();
    act(() => buttons[1].click());
    expect(exclude.mock.calls).toEqual([['b']]);
    expect(activate).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    act(() => host.querySelector<HTMLButtonElement>('.edited-badge')!.click());
    expect(toggle).toHaveBeenCalledWith('a');
    expect(exclude).toHaveBeenCalledTimes(1);
    act(() => item(2).click());
    expect(activate).toHaveBeenCalledWith('c');
  });
  it('locks exclusion for the last photo, blocked workspace and busy targets', () => {
    const exclude = vi.fn();
    act(() => root.render(<Filmstrip assets={[assets[0]]} activeAssetId="a" onActivate={activate} onExclude={exclude} />));
    act(() => host.querySelector<HTMLButtonElement>('.filmstrip-exclude')!.click());
    expect(exclude).not.toHaveBeenCalled();
    act(() => root.render(<Filmstrip assets={assets} activeAssetId="a" onActivate={activate} onExclude={exclude} keyboardBlocked />));
    expect([...host.querySelectorAll<HTMLButtonElement>('.filmstrip-exclude')].every(button => button.disabled)).toBe(true);
    act(() => root.render(<Filmstrip assets={assets} activeAssetId="a" onActivate={activate} onExclude={exclude} excludeBusyFor={id => id === 'a'} />));
    const buttons = host.querySelectorAll<HTMLButtonElement>('.filmstrip-exclude');
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[1].disabled).toBe(false);
  });
});

describe('Filmstrip Queue buttons', () => {
  it.each(['en', 'ja'])('separates edited, History-only and untouched indicators (%s)', async language => {
    await i18n.changeLanguage(language);
    const toggle = vi.fn();
    act(() => root.render(<Filmstrip assets={assets} activeAssetId="a" onActivate={activate}
      editStatuses={{ a: true, b: false, c: false }} historyOnlyStatuses={{ b: true, c: false }}
      queueKnown queueStatusFor={() => 'queued'} onQueueToggle={toggle} />));
    const entries = host.querySelectorAll('.filmstrip-entry');
    expect(entries[0].querySelector('button.edited-badge.queue-queued')).not.toBeNull();
    const history = entries[1].querySelector<HTMLElement>('.filmstrip-history-badge')!;
    const description = language === 'en' ? 'Edit history retained' : '編集履歴あり';
    expect(history.tagName).toBe('SPAN');
    expect(history.getAttribute('role')).toBe('img');
    expect(history.getAttribute('aria-label')).toBe(description);
    expect(history.title).toBe(description);
    expect(item(1).getAttribute('aria-description')).toBe(description);
    expect(history.className).not.toContain('queue-');
    expect([...history.querySelectorAll('svg path')].map(path => path.getAttribute('d')))
      .toEqual(['M3 5h14M3 10h14M3 15h14', 'M7 3v4M13 8v4M8 13v4']);
    expect(history.getAttribute('aria-pressed')).toBeNull();
    expect(entries[1].querySelector('.edited-badge')).toBeNull();
    act(() => history.click());
    expect(toggle).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(entries[2].querySelector('.edited-badge, .filmstrip-history-badge')).toBeNull();
  });
  it.each([
    [false, undefined, '', true], [true, undefined, 'queue-inactive', false],
    [true, 'queued', 'queue-queued', false], [true, 'waiting', 'queue-waiting', true],
    [true, 'encoding', 'queue-processing', true], [true, 'registering', 'queue-processing', true],
    [true, 'failed', 'queue-failed', false],
  ] as const)('renders known=%s status=%s as a sibling control', (known, status, stateClass, locked) => {
    const toggle = vi.fn();
    act(() => root.render(<Filmstrip assets={assets} activeAssetId="a" onActivate={activate}
      editStatuses={{ a: true }} queueKnown={known} queueStatusFor={() => status} onQueueToggle={toggle} />));
    const badge = host.querySelector<HTMLButtonElement>('.edited-badge')!;
    expect(host.querySelectorAll('.filmstrip-entry')).toHaveLength(3);
    expect(item(0).getAttribute('aria-current')).toBe('true');
    expect(item(0).querySelector('.format-badge')).not.toBeNull();
    expect(item(0).nextElementSibling).toBe(badge);
    expect(host.querySelector('button button')).toBeNull();
    expect(badge.disabled).toBe(locked);
    if (stateClass) expect(badge.classList.contains(stateClass)).toBe(true);
    act(() => badge.click());
    expect(toggle.mock.calls).toEqual(locked ? [] : [['a']]);
    expect(activate).not.toHaveBeenCalled();
    act(() => item(1).click());
    expect(activate).toHaveBeenCalledWith('b');
  });
  it('disables a busy target without blocking other photo controls', () => {
    act(() => root.render(<Filmstrip assets={assets} activeAssetId="a" onActivate={activate}
      editStatuses={{ a: true }} queueKnown queueBusyFor={() => true} onQueueToggle={vi.fn()} />));
    expect(host.querySelector<HTMLButtonElement>('.edited-badge')!.disabled).toBe(true);
    expect(host.querySelector('.edited-badge')!.getAttribute('aria-busy')).toBe('true');
    expect(item(0).disabled).toBe(false);
  });
  it('uses the existing Queue action for a RAW edited badge', () => {
    const toggle = vi.fn();
    const raw = { ...assets[0], is_raw: true, format: 'DNG' };
    act(() => root.render(<Filmstrip assets={[raw]} activeAssetId="a" onActivate={activate}
      editStatuses={{ a: true }} queueKnown queueStatusFor={() => undefined} onQueueToggle={toggle} />));
    const badge = host.querySelector('.edited-badge');
    expect(badge?.tagName).toBe('BUTTON');
    act(() => badge?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(toggle).toHaveBeenCalledWith('a');
  });
});
