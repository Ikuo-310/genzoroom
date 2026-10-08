// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from './i18n';
import { StackContextMenu, type StackQueueRow } from './StackContextMenu';
import type { RecentAsset } from './assets';

let host: HTMLDivElement;
let root: Root;
let resizeCallbacks: ResizeObserverCallback[];
let measuredHeight = 160;
const pointerPoint = { x: 700, y: 500 };

function member(id: string, exported = false): RecentAsset {
  return { id, filename: `${id}.jpg`, date: '2026-10-08', thumbnail_url: `/thumb/${id}`,
    format: 'JPEG', is_raw: false, isGenzoRoomExport: exported };
}

function mount({
  members = [member('upper'), member('lower')], editStatuses = { upper: true, lower: true },
  queueRows = {} as Record<string, StackQueueRow>, queueLoaded = true,
}: {
  members?: RecentAsset[] | null;
  editStatuses?: Record<string, boolean | undefined>;
  queueRows?: Record<string, StackQueueRow>;
  queueLoaded?: boolean;
} = {}) {
  const queueFor = (id: string) => queueRows[id] ?? { status: undefined, known: true, busy: false };
  act(() => root.render(<StackContextMenu point={pointerPoint} members={members}
    selectedIds={new Set()} selectionAvailable={members !== null} editStatuses={editStatuses}
    editStatusState={queueLoaded ? 'ready' : 'loading'} queueLoaded={queueLoaded} queueCurrent={true} queueError={false}
    queueFor={queueFor} onDarkroomToggle={vi.fn()} onQueueToggle={vi.fn()} onClose={vi.fn()} />));
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('innerHeight', 600);
  resizeCallbacks = [];
  measuredHeight = 160;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
    observe() {}
    disconnect() {}
    unobserve() {}
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if ((this as HTMLElement).classList.contains('stack-photo-context-menu')) {
      return { x: 0, y: 0, left: 0, top: 0, right: 300, bottom: measuredHeight, width: 300, height: measuredHeight, toJSON: () => ({}) };
    }
    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('StackContextMenu layout and focus', () => {
  it('focuses only after visible placement commits and never repeats initial focus on reflow or added rows', () => {
    const focus = HTMLElement.prototype.focus;
    const visibilityAtFocus: string[] = [];
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement) {
      const visibility = window.getComputedStyle(this).visibility;
      visibilityAtFocus.push(visibility);
      // jsdom permits hidden focus, so enforce the native focusability boundary for this regression.
      if (visibility !== 'hidden') focus.call(this);
    });
    mount({ members: [member('upper')], queueLoaded: false });
    const upper = document.querySelector<HTMLInputElement>('.stack-photo-context-menu input')!;
    expect(document.activeElement).toBe(upper);
    expect(visibilityAtFocus).toEqual(['visible']);
    measuredHeight = 360;
    act(() => resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver)));
    mount();
    expect(document.activeElement).toBe(upper);
    expect(visibilityAtFocus).toEqual(['visible']);
  });

  it('repositions to the original pointer point when measured size or viewport changes without moving focus', () => {
    mount();
    const menu = document.querySelector<HTMLElement>('.stack-photo-context-menu')!;
    const upper = menu.querySelector<HTMLInputElement>('section input')!;
    expect(document.activeElement).toBe(upper);
    expect(menu.style.top).toBe('432px');
    act(() => upper.focus());

    measuredHeight = 360;
    act(() => resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver)));
    expect(menu.style.top).toBe('232px');
    expect(document.activeElement).toBe(upper);

    vi.stubGlobal('innerWidth', 260);
    vi.stubGlobal('innerHeight', 300);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(menu.style.left).toBe('8px');
    expect(menu.style.top).toBe('8px');
    expect(document.activeElement).toBe(upper);
    expect(menu.classList.contains('stack-photo-context-menu')).toBe(true);
  });

  it('focuses the first enabled control in the upper section, then the lower section', () => {
    mount();
    expect(document.activeElement).toBe(document.querySelector<HTMLElement>('.stack-photo-context-menu section input'));

    act(() => root.render(null));
    mount({ members: [member('exported', true), member('queue-one', true), member('queue-two', true)],
      editStatuses: { 'queue-one': true, 'queue-two': true },
      queueRows: { 'queue-one': { status: 'waiting', known: true, busy: false } } });
    const lowerInputs = [...document.querySelectorAll<HTMLInputElement>('.stack-photo-context-menu section:nth-of-type(2) input')];
    expect(lowerInputs[0].disabled).toBe(true);
    expect(document.activeElement).toBe(lowerInputs[1]);
  });

  it('focuses the menu when all available controls are disabled or there are no candidates', () => {
    mount({ members: [member('exported', true)], editStatuses: { exported: true },
      queueRows: { exported: { status: 'waiting', known: true, busy: false } } });
    expect(document.activeElement).toBe(document.querySelector<HTMLElement>('.stack-photo-context-menu'));

    mount({ members: [], editStatuses: {} });
    expect(document.activeElement).toBe(document.querySelector<HTMLElement>('.stack-photo-context-menu'));
  });

  it('does not steal focus from an active control after asynchronous content updates', () => {
    mount({ queueLoaded: false });
    const upper = document.querySelector<HTMLInputElement>('.stack-photo-context-menu section input')!;
    act(() => upper.focus());
    mount({ queueLoaded: true, queueRows: { lower: { status: 'queued', known: true, busy: false } } });
    expect(document.activeElement).toBe(upper);
  });

  it('keeps focus on the menu when loading completes and controls become enabled', () => {
    const exported = member('exported', true);
    mount({ members: [exported], editStatuses: { exported: true }, queueLoaded: false });
    const menu = document.querySelector<HTMLElement>('.stack-photo-context-menu')!;
    expect(document.activeElement).toBe(menu);
    mount({ members: [exported], editStatuses: { exported: true },
      queueRows: { exported: { status: undefined, known: true, busy: false } } });
    expect(document.querySelector<HTMLInputElement>('.stack-photo-context-menu section:nth-of-type(2) input')).not.toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('moves focus to the menu only when the focused control is removed', () => {
    mount();
    const upper = document.querySelector<HTMLInputElement>('.stack-photo-context-menu section input')!;
    act(() => upper.focus());
    mount({ members: [member('lower')], editStatuses: { lower: true } });
    expect(document.activeElement).toBe(document.querySelector<HTMLElement>('.stack-photo-context-menu'));
  });

  it('retreats from a focused Queue control when queued becomes waiting, even if native focus stays on the disabled input', () => {
    const members = [member('upper', true), member('lower', true)];
    mount({ members, queueRows: { upper: { status: 'queued', known: true, busy: false } } });
    const input = document.querySelector<HTMLInputElement>('.stack-photo-context-menu input')!;
    expect(document.activeElement).toBe(input);
    mount({ members, queueRows: { upper: { status: 'waiting', known: true, busy: false } } });
    expect(input.disabled).toBe(true);
    expect(document.activeElement).toBe(document.querySelector<HTMLElement>('.stack-photo-context-menu'));
  });

  it('preserves focus on another enabled control when a previously focused row becomes disabled', () => {
    const members = [member('upper', true), member('lower', true)];
    mount({ members });
    const inputs = document.querySelectorAll<HTMLInputElement>('.stack-photo-context-menu input');
    act(() => inputs[1].focus());
    mount({ members, queueRows: { upper: { status: 'waiting', known: true, busy: false } } });
    expect(document.activeElement).toBe(inputs[1]);
  });

  it('retreats to the menu when every Queue row becomes disabled', () => {
    const members = [member('upper', true), member('lower', true)];
    mount({ members });
    const inputs = document.querySelectorAll<HTMLInputElement>('.stack-photo-context-menu input');
    act(() => inputs[1].focus());
    mount({ members, queueRows: {
      upper: { status: 'waiting', known: true, busy: false }, lower: { status: 'waiting', known: true, busy: false },
    } });
    expect([...inputs].every(input => input.disabled)).toBe(true);
    expect(document.activeElement).toBe(document.querySelector<HTMLElement>('.stack-photo-context-menu'));
  });
});
