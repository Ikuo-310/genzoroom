// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Filmstrip } from './Filmstrip';
import type { RecentAsset } from './assets';
import i18n from './i18n';

const assets: RecentAsset[] = ['a', 'b', 'c'].map((id) => ({ id, filename: `${id}.jpg`, date: '2026-09-25',
  thumbnail_url: `/${id}`, format: 'JPEG', is_raw: false }));
let host: HTMLDivElement;
let root: Root;
let activate = vi.fn<(id: string) => void>();
function Harness({ disabled = false, blocked = false, items = assets }: { disabled?: boolean; blocked?: boolean; items?: RecentAsset[] }) {
  const [active, setActive] = useState('a');
  return <><Filmstrip assets={items} activeAssetId={active} disabled={disabled} keyboardBlocked={blocked}
    onActivate={(id) => { activate(id); setActive(id); }} />
    <input type="range" /><input type="number" /><input type="text" /><textarea /><select><option>one</option></select>
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
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); activate = vi.fn();
  act(() => root.render(<Harness />));
});
afterEach(async () => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await i18n.changeLanguage('en'); });

describe('Filmstrip keyboard navigation', () => {
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
    expect(move('next', window, { repeat: true }).defaultPrevented).toBe(false);
    expect(move('next', window, { isComposing: true }).defaultPrevented).toBe(false);
    const prevented = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true, cancelable: true });
    prevented.preventDefault(); act(() => window.dispatchEvent(prevented));
    expect(current()).toBe('a.jpg');
    expect(activate).not.toHaveBeenCalled();
  });

  it.each(['input[type="number"]', 'input[type="text"]', 'textarea', 'select', '[contenteditable]', '[role="textbox"]'])
    ('preserves native editing in %s', (selector) => {
      const target = host.querySelector<HTMLElement>(selector)!;
      act(() => target.focus());
      expect(move('next', target).defaultPrevented).toBe(false);
      expect(activate).not.toHaveBeenCalled();
    });

  it('ignores blocked and disabled filmstrips', () => {
    act(() => root.render(<Harness blocked />));
    expect(move('next').defaultPrevented).toBe(false);
    expect(activate).not.toHaveBeenCalled();
    act(() => root.render(<Harness disabled />));
    expect(move('next').defaultPrevented).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  it.each(['dialog', 'alertdialog', 'menu'])('ignores commands while a %s is open', (role) => {
    const overlay = role === 'dialog' ? document.createElement('dialog') : document.createElement('div');
    if (role === 'dialog') (overlay as HTMLDialogElement).setAttribute('open', '');
    else overlay.setAttribute('role', role);
    document.body.append(overlay);
    try {
      expect(move('next').defaultPrevented).toBe(false);
      expect(activate).not.toHaveBeenCalled();
    } finally { overlay.remove(); }
  });

  it('ignores the edit settings menu and preserves active thumbnail reveal', () => {
    const menu = document.createElement('details'); menu.className = 'edit-settings-menu'; menu.open = true;
    document.body.append(menu);
    try { expect(move('next').defaultPrevented).toBe(false); } finally { menu.remove(); }

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
});
