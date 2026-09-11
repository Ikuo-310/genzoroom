// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADJUSTMENT_COMMIT_DELAY_MS, AdjustmentSlider } from './AdjustmentSlider';
import { BLACKS, CONTRAST, EXPOSURE, HIGHLIGHTS, SHADOWS, WHITES, formatBlacks, formatContrast, formatHighlights, formatShadows, formatWhites, type EditSession } from './editing';
import { useAssetEdits } from './useAssetEdits';
import { AdjustmentCategory } from './AnshitsuPage';

let host: HTMLDivElement;
let root: Root;
function Harness({ assetId = 'a' }: { assetId?: string }) {
  const { session, dispatch } = useAssetEdits(assetId, true);
  return <>
    <AdjustmentCategory title="Basic" enabled={session.recipe.basicEnabled}
      resetDisabled={Object.values(session.recipe.adjustments).every((value) => value === 0)}
      enableLabel="Enable Basic" disableLabel="Disable Basic" expandLabel="Expand Basic" collapseLabel="Collapse Basic"
      resetLabel="Reset" onToggle={() => dispatch({ type: 'toggleBasic' })} onReset={() => dispatch({ type: 'basicReset' })}>
    <AdjustmentSlider key={assetId} label="Exposure" {...EXPOSURE} value={session.recipe.adjustments.exposure}
      valueText={`${session.recipe.adjustments.exposure} EV`} valueLabel="Exposure value" unit="EV"
      precision={2} defaultValue={0} resetLabel="Reset Exposure" disabled={!session.recipe.basicEnabled}
      onBegin={() => dispatch({ type: 'begin', kind: 'exposure' })}
      onChange={(value) => dispatch({ type: 'exposure', value })} onCommit={() => dispatch({ type: 'commit', kind: 'exposure' })}
      onReset={() => dispatch({ type: 'exposureReset' })} />
    <AdjustmentSlider key={`${assetId}-contrast`} label="Contrast" {...CONTRAST} value={session.recipe.adjustments.contrast}
      valueText={formatContrast(session.recipe.adjustments.contrast)} valueLabel="Contrast value"
      precision={0} defaultValue={0} resetLabel="Reset Contrast" disabled={!session.recipe.basicEnabled}
      onBegin={() => dispatch({ type: 'begin', kind: 'contrast' })}
      onChange={(value) => dispatch({ type: 'contrast', value })} onCommit={() => dispatch({ type: 'commit', kind: 'contrast' })}
      onReset={() => dispatch({ type: 'contrastReset' })} />
    <AdjustmentSlider key={`${assetId}-highlights`} label="Highlights" {...HIGHLIGHTS} value={session.recipe.adjustments.highlights}
      valueText={formatHighlights(session.recipe.adjustments.highlights)} valueLabel="Highlights value"
      precision={0} defaultValue={0} resetLabel="Reset Highlights" disabled={!session.recipe.basicEnabled}
      onBegin={() => dispatch({ type: 'begin', kind: 'highlights' })}
      onChange={(value) => dispatch({ type: 'highlights', value })} onCommit={() => dispatch({ type: 'commit', kind: 'highlights' })}
      onReset={() => dispatch({ type: 'highlightsReset' })} />
    <AdjustmentSlider key={`${assetId}-whites`} label="Whites" {...WHITES} value={session.recipe.adjustments.whites}
      valueText={formatWhites(session.recipe.adjustments.whites)} valueLabel="Whites value"
      precision={0} defaultValue={0} resetLabel="Reset Whites" disabled={!session.recipe.basicEnabled}
      onBegin={() => dispatch({ type: 'begin', kind: 'whites' })}
      onChange={(value) => dispatch({ type: 'whites', value })} onCommit={() => dispatch({ type: 'commit', kind: 'whites' })}
      onReset={() => dispatch({ type: 'whitesReset' })} />
    <AdjustmentSlider key={`${assetId}-shadows`} label="Shadows" {...SHADOWS} value={session.recipe.adjustments.shadows}
      valueText={formatShadows(session.recipe.adjustments.shadows)} valueLabel="Shadows value"
      precision={0} defaultValue={0} resetLabel="Reset Shadows" disabled={!session.recipe.basicEnabled}
      onBegin={() => dispatch({ type: 'begin', kind: 'shadows' })}
      onChange={(value) => dispatch({ type: 'shadows', value })} onCommit={() => dispatch({ type: 'commit', kind: 'shadows' })}
      onReset={() => dispatch({ type: 'shadowsReset' })} />
    <AdjustmentSlider key={`${assetId}-blacks`} label="Blacks" {...BLACKS} value={session.recipe.adjustments.blacks}
      valueText={formatBlacks(session.recipe.adjustments.blacks)} valueLabel="Blacks value"
      precision={0} defaultValue={0} resetLabel="Reset Blacks" disabled={!session.recipe.basicEnabled}
      onBegin={() => dispatch({ type: 'begin', kind: 'blacks' })}
      onChange={(value) => dispatch({ type: 'blacks', value })} onCommit={() => dispatch({ type: 'commit', kind: 'blacks' })}
      onReset={() => dispatch({ type: 'blacksReset' })} />
    </AdjustmentCategory>
    <p className="edit-source-note">Temporary preview note</p>
    <pre>{JSON.stringify(session)}</pre>
    <input type="text" /><textarea /><select><option>one</option></select><div contentEditable />
    <button onClick={() => dispatch({ type: 'allReset' })}>All Reset</button>
  </>;
}
const session = (): EditSession => JSON.parse(host.querySelector('pre')!.textContent!);
const range = () => host.querySelector<HTMLInputElement>('input[type="range"]')!;
const number = () => host.querySelector<HTMLInputElement>('input[type="number"]')!;
const contrastRange = () => host.querySelectorAll<HTMLInputElement>('input[type="range"]')[1];
const contrastNumber = () => host.querySelectorAll<HTMLInputElement>('input[type="number"]')[1];
const highlightsRange = () => host.querySelectorAll<HTMLInputElement>('input[type="range"]')[2];
const highlightsNumber = () => host.querySelectorAll<HTMLInputElement>('input[type="number"]')[2];
const whitesRange = () => host.querySelectorAll<HTMLInputElement>('input[type="range"]')[3];
const whitesNumber = () => host.querySelectorAll<HTMLInputElement>('input[type="number"]')[3];
const shadowsRange = () => host.querySelectorAll<HTMLInputElement>('input[type="range"]')[4];
const shadowsNumber = () => host.querySelectorAll<HTMLInputElement>('input[type="number"]')[4];
const blacksRange = () => host.querySelectorAll<HTMLInputElement>('input[type="range"]')[5];
const blacksNumber = () => host.querySelectorAll<HTMLInputElement>('input[type="number"]')[5];
function key(key: string, target: EventTarget = window, init: KeyboardEventInit = {}, type = 'keydown') {
  const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}
function pointer(type: string, target: EventTarget = range()) {
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 })); });
}
function wheel(deltaY: number, target: EventTarget = range(), init: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}
function change(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range(), value);
    range().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function changeNumber(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(number(), value);
    number().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function changeInput(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('edit controls DOM interaction', () => {
  it('renders every adjustment as one shared label-range-value row', () => {
    const controls = host.querySelectorAll('.adjustment-control');
    expect(controls).toHaveLength(6);
    for (const control of controls) {
      expect(Array.from(control.children).map((child) => child.tagName)).toEqual(['LABEL', 'INPUT', 'DIV']);
      expect(control.children[1].classList.contains('adjustment-range')).toBe(true);
      expect(control.children[2].classList.contains('adjustment-value-controls')).toBe(true);
    }
    const unitSlots = host.querySelectorAll('.adjustment-unit');
    expect(unitSlots).toHaveLength(6);
    expect(Array.from(unitSlots).map((unit) => unit.textContent)).toEqual(['EV', '', '', '', '', '']);
  });
  it('starts Basic expanded, collapses without changing its recipe, and keeps the preview note visible', () => {
    act(() => number().focus());
    changeNumber('0.5');
    key('Enter', number());
    const before = session().recipe;
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Collapse Basic"]')!.click());
    expect(host.querySelectorAll('.adjustment-control')).toHaveLength(0);
    expect(host.querySelector('.edit-source-note')?.textContent).toBe('Temporary preview note');
    expect(session().recipe).toEqual(before);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Expand Basic"]')!.click());
    expect(host.querySelectorAll('.adjustment-control')).toHaveLength(6);
    expect(number().value).toBe('0.50');
  });
  it('groups hover keyboard input until inactivity and supports every undo/redo binding', () => {
    pointer('pointerover');
    expect(document.activeElement).not.toBe(range());
    key('ArrowRight');
    act(() => vi.advanceTimersByTime(300));
    key('ArrowRight');
    act(() => vi.advanceTimersByTime(300));
    key('ArrowUp'); key('ArrowLeft'); key('ArrowDown');
    expect(session().recipe.adjustments.exposure).toBe(0.01);
    expect(number().value).toBe('0.01');
    expect(session().history).toHaveLength(0);
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS - 1));
    expect(session().history).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(session().history).toHaveLength(1);
    key('z', window, { ctrlKey: true });
    expect(session().recipe.adjustments.exposure).toBe(0);
    key('z', window, { ctrlKey: true, shiftKey: true });
    expect(session().recipe.adjustments.exposure).toBe(0.01);
    key('z', window, { ctrlKey: true });
    key('y', window, { ctrlKey: true });
    expect(session().recipe.adjustments.exposure).toBe(0.01);
  });
  it('groups wheel input into one edit and supports Undo and Redo after 500ms inactivity', () => {
    expect(wheel(-0.1).defaultPrevented).toBe(true);
    act(() => vi.advanceTimersByTime(300));
    expect(wheel(-120).defaultPrevented).toBe(true);
    act(() => vi.advanceTimersByTime(300));
    expect(wheel(-1).defaultPrevented).toBe(true);
    expect(session().recipe.adjustments.exposure).toBe(0.3);
    expect(session().history).toHaveLength(0);
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS - 1));
    expect(session().history).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(session().history).toHaveLength(1);
    expect(session().history[0].before.adjustments.exposure).toBe(0);
    expect(session().history[0].after.adjustments.exposure).toBe(0.3);
    key('z', window, { ctrlKey: true });
    expect(session().recipe.adjustments.exposure).toBe(0);
    key('y', window, { ctrlKey: true });
    expect(session().recipe.adjustments.exposure).toBe(0.3);
  });
  it('uses the wheel delta sign for ten steps normally and one step with Shift', () => {
    expect(wheel(-500).defaultPrevented).toBe(true);
    expect(session().recipe.adjustments.exposure).toBe(0.1);
    expect(wheel(0.25).defaultPrevented).toBe(true);
    expect(session().recipe.adjustments.exposure).toBe(0);
    expect(wheel(-500, range(), { shiftKey: true }).defaultPrevented).toBe(true);
    expect(session().recipe.adjustments.exposure).toBe(0.01);
    expect(wheel(0.25, range(), { shiftKey: true }).defaultPrevented).toBe(true);
    expect(session().recipe.adjustments.exposure).toBe(0);
    expect(wheel(0).defaultPrevented).toBe(false);
    act(() => number().focus());
    changeNumber('5');
    key('Enter', number());
    expect(wheel(-1).defaultPrevented).toBe(false);
    expect(session().recipe.adjustments.exposure).toBe(5);
    expect(wheel(1).defaultPrevented).toBe(true);
    expect(session().recipe.adjustments.exposure).toBe(4.9);
    changeNumber('-5');
    key('Enter', number());
    expect(wheel(1).defaultPrevented).toBe(false);
    expect(session().recipe.adjustments.exposure).toBe(-5);
  });
  it('commits an active direct edit before starting a wheel transaction on its range', () => {
    act(() => number().focus());
    changeNumber('0.37');
    expect(wheel(-1, range()).defaultPrevented).toBe(true);
    expect(number().value).toBe('0.47');
    expect(session().history.map((entry) => entry.kind)).toEqual(['exposure']);
    expect(session().pending?.kind).toBe('exposure');
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS));
    expect(session().history).toHaveLength(2);
    expect(session().history[1].before.adjustments.exposure).toBe(0.37);
    expect(session().history[1].after.adjustments.exposure).toBe(0.47);
  });
  it('steps all adjustment types and commits the previous parameter when wheel input switches controls', () => {
    expect(wheel(-1, range()).defaultPrevented).toBe(true);
    expect(wheel(-1, contrastRange()).defaultPrevented).toBe(true);
    expect(wheel(-1, highlightsRange()).defaultPrevented).toBe(true);
    expect(wheel(-1, whitesRange()).defaultPrevented).toBe(true);
    expect(wheel(-1, shadowsRange()).defaultPrevented).toBe(true);
    expect(wheel(-1, blacksRange()).defaultPrevented).toBe(true);
    expect(session().recipe.adjustments).toEqual({ exposure: 0.1, contrast: 10, highlights: 10, whites: 10, shadows: 10, blacks: 10 });
    expect(session().history.map((entry) => entry.kind)).toEqual(['exposure', 'contrast', 'highlights', 'whites', 'shadows']);
    expect(session().pending?.kind).toBe('blacks');
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS));
    expect(session().history.map((entry) => entry.kind)).toEqual(['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks']);
  });
  it('uses one step for Shift+wheel across all adjustment types', () => {
    expect(wheel(-100, range(), { shiftKey: true }).defaultPrevented).toBe(true);
    expect(wheel(-100, contrastRange(), { shiftKey: true }).defaultPrevented).toBe(true);
    expect(wheel(-100, highlightsRange(), { shiftKey: true }).defaultPrevented).toBe(true);
    expect(wheel(-100, whitesRange(), { shiftKey: true }).defaultPrevented).toBe(true);
    expect(wheel(-100, shadowsRange(), { shiftKey: true }).defaultPrevented).toBe(true);
    expect(wheel(-100, blacksRange(), { shiftKey: true }).defaultPrevented).toBe(true);
    expect(session().recipe.adjustments).toEqual({ exposure: 0.01, contrast: 1, highlights: 1, whites: 1, shadows: 1, blacks: 1 });
  });
  it('does not treat disabled sliders, number inputs, or content outside a slider as wheel adjustments', () => {
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Disable Basic"]')!.click());
    expect(wheel(-1).defaultPrevented).toBe(false);
    expect(session().recipe.adjustments.exposure).toBe(0);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Enable Basic"]')!.click());
    expect(wheel(-1, number()).defaultPrevented).toBe(false);
    expect(wheel(-1, host.querySelector('textarea')!).defaultPrevented).toBe(false);
    expect(session().recipe.adjustments.exposure).toBe(0);
  });
  it('keeps direct input, range, and preview state synchronized and commits with Enter', () => {
    act(() => number().focus());
    changeNumber('0.37');
    expect(session().recipe.adjustments.exposure).toBe(0.37);
    expect(range().value).toBe('0.37');
    expect(session().history).toHaveLength(0);
    key('Enter', number());
    expect(session().history).toHaveLength(1);
    expect(number().value).toBe('0.37');
  });
  it('commits direct input on blur', () => {
    act(() => number().focus());
    changeNumber('-0.45');
    act(() => number().blur());
    expect(session().recipe.adjustments.exposure).toBe(-0.45);
    expect(session().history).toHaveLength(1);
  });
  it('clears the direct-input draft when a slider pointer gesture starts before blur', () => {
    act(() => number().focus());
    changeNumber('0.37');
    pointer('pointerdown');
    act(() => number().blur());
    change('0.5');
    pointer('pointerup', window);
    expect(session().recipe.adjustments.exposure).toBe(0.5);
    expect(number().value).toBe('0.50');
  });
  it('reflects slider, hover keyboard, reset, undo, and redo updates after direct input', () => {
    act(() => number().focus());
    changeNumber('0.37');
    key('Enter', number());
    pointer('pointerdown');
    change('0.5');
    pointer('pointerup', window);
    expect(number().value).toBe('0.50');
    pointer('pointerover');
    key('ArrowRight');
    expect(number().value).toBe('0.51');
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS));
    act(() => host.querySelector<HTMLButtonElement>('.adjustment-reset')!.click());
    expect(number().value).toBe('0.00');
    key('z', window, { ctrlKey: true });
    expect(number().value).toBe('0.51');
    key('y', window, { ctrlKey: true });
    expect(number().value).toBe('0.00');
  });
  it('cancels direct input with Escape', () => {
    act(() => number().focus());
    changeNumber('0.75');
    expect(session().recipe.adjustments.exposure).toBe(0.75);
    key('Escape', number());
    expect(session().recipe.adjustments.exposure).toBe(0);
    expect(range().value).toBe('0');
    expect(number().value).toBe('0.00');
    expect(session().history).toHaveLength(0);
  });
  it('clamps direct input to Exposure boundaries and step precision', () => {
    act(() => number().focus());
    changeNumber('9');
    expect(session().recipe.adjustments.exposure).toBe(5);
    key('Enter', number());
    expect(number().value).toBe('5.00');
    act(() => number().focus());
    changeNumber('-9');
    expect(session().recipe.adjustments.exposure).toBe(-5);
    act(() => number().blur());
    expect(number().value).toBe('-5.00');
    expect(session().history).toHaveLength(2);
  });
  it('restores the starting value for an empty or invalid direct input', () => {
    act(() => number().focus());
    changeNumber('');
    expect(session().recipe.adjustments.exposure).toBe(0);
    act(() => number().blur());
    expect(number().value).toBe('0.00');
    expect(session().history).toHaveLength(0);
  });
  it('resets Exposure inline and disables reset at its default value', () => {
    const reset = host.querySelector<HTMLButtonElement>('.adjustment-reset')!;
    expect(reset.disabled).toBe(true);
    act(() => number().focus());
    changeNumber('0.5');
    key('Enter', number());
    expect(reset.disabled).toBe(false);
    act(() => reset.click());
    expect(session().recipe.adjustments.exposure).toBe(0);
    expect(session().history).toHaveLength(2);
    expect(reset.disabled).toBe(true);
  });
  it('does not treat number-field arrow keys as hovered slider shortcuts', () => {
    pointer('pointerover');
    act(() => number().focus());
    const event = key('ArrowUp', number());
    expect(event.defaultPrevented).toBe(false);
    expect(session().recipe.adjustments.exposure).toBe(0);
    changeNumber('0.01');
    expect(session().recipe.adjustments.exposure).toBe(0.01);
  });
  it('reuses direct input, hover keyboard, grouped commit, and reset for Contrast', () => {
    const input = contrastNumber();
    const slider = contrastRange();
    const reset = host.querySelectorAll<HTMLButtonElement>('.adjustment-reset')[1];
    expect(input.value).toBe('0');
    expect(reset.disabled).toBe(true);
    act(() => input.focus());
    changeInput(input, '25');
    expect(slider.value).toBe('25');
    key('Enter', input);
    expect(session().history.map((entry) => entry.kind)).toEqual(['contrast']);
    pointer('pointerover', slider);
    key('ArrowUp');
    expect(session().recipe.adjustments.contrast).toBe(35);
    expect(input.value).toBe('35');
    expect(session().history).toHaveLength(1);
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS));
    expect(session().history.map((entry) => entry.kind)).toEqual(['contrast', 'contrast']);
    act(() => reset.click());
    expect(session().recipe.adjustments.contrast).toBe(0);
    expect(input.value).toBe('0');
    expect(reset.disabled).toBe(true);
    key('z', window, { ctrlKey: true });
    expect(session().recipe.adjustments.contrast).toBe(35);
    key('y', window, { ctrlKey: true });
    expect(session().recipe.adjustments.contrast).toBe(0);
  });
  it('reuses direct input, hover keyboard, grouped commit, and reset for Highlights', () => {
    const input = highlightsNumber();
    const slider = highlightsRange();
    const reset = host.querySelectorAll<HTMLButtonElement>('.adjustment-reset')[2];
    expect(input.value).toBe('0');
    expect(reset.disabled).toBe(true);
    act(() => input.focus());
    changeInput(input, '-25');
    expect(slider.value).toBe('-25');
    key('Enter', input);
    expect(session().history.map((entry) => entry.kind)).toEqual(['highlights']);
    pointer('pointerover', slider);
    key('ArrowUp');
    expect(session().recipe.adjustments.highlights).toBe(-15);
    expect(input.value).toBe('-15');
    expect(session().history).toHaveLength(1);
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS));
    expect(session().history.map((entry) => entry.kind)).toEqual(['highlights', 'highlights']);
    act(() => reset.click());
    expect(session().recipe.adjustments.highlights).toBe(0);
    expect(input.value).toBe('0');
    expect(reset.disabled).toBe(true);
    key('z', window, { ctrlKey: true });
    expect(session().recipe.adjustments.highlights).toBe(-15);
    key('y', window, { ctrlKey: true });
    expect(session().recipe.adjustments.highlights).toBe(0);
  });
  it('reuses direct input, hover keyboard, grouped commit, and reset for Whites', () => {
    const input = whitesNumber();
    const slider = whitesRange();
    const reset = host.querySelectorAll<HTMLButtonElement>('.adjustment-reset')[3];
    expect(input.value).toBe('0');
    expect(reset.disabled).toBe(true);
    act(() => input.focus());
    changeInput(input, '30');
    expect(slider.value).toBe('30');
    key('Enter', input);
    expect(session().history.map((entry) => entry.kind)).toEqual(['whites']);
    pointer('pointerover', slider);
    key('ArrowDown');
    expect(session().recipe.adjustments.whites).toBe(20);
    expect(input.value).toBe('20');
    expect(session().history).toHaveLength(1);
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS));
    expect(session().history.map((entry) => entry.kind)).toEqual(['whites', 'whites']);
    act(() => reset.click());
    expect(session().recipe.adjustments.whites).toBe(0);
    expect(input.value).toBe('0');
    expect(reset.disabled).toBe(true);
    key('z', window, { ctrlKey: true });
    expect(session().recipe.adjustments.whites).toBe(20);
    key('y', window, { ctrlKey: true });
    expect(session().recipe.adjustments.whites).toBe(0);
  });
  it('reuses direct input, hover keyboard, grouped commit, and reset for Shadows', () => {
    const input = shadowsNumber();
    const slider = shadowsRange();
    const reset = host.querySelectorAll<HTMLButtonElement>('.adjustment-reset')[4];
    expect(input.value).toBe('0');
    expect(reset.disabled).toBe(true);
    act(() => input.focus());
    changeInput(input, '30');
    expect(slider.value).toBe('30');
    key('Enter', input);
    expect(session().history.map((entry) => entry.kind)).toEqual(['shadows']);
    pointer('pointerover', slider);
    key('ArrowDown');
    expect(session().recipe.adjustments.shadows).toBe(20);
    expect(input.value).toBe('20');
    expect(session().history).toHaveLength(1);
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS));
    expect(session().history.map((entry) => entry.kind)).toEqual(['shadows', 'shadows']);
    act(() => reset.click());
    expect(session().recipe.adjustments.shadows).toBe(0);
    expect(input.value).toBe('0');
    expect(reset.disabled).toBe(true);
    key('z', window, { ctrlKey: true });
    expect(session().recipe.adjustments.shadows).toBe(20);
    key('y', window, { ctrlKey: true });
    expect(session().recipe.adjustments.shadows).toBe(0);
  });
  it('reuses direct input, hover keyboard, grouped commit, reset, undo, and redo for Blacks', () => {
    const input = blacksNumber();
    const slider = blacksRange();
    const reset = host.querySelectorAll<HTMLButtonElement>('.adjustment-reset')[5];
    expect(input.value).toBe('0');
    expect(reset.disabled).toBe(true);
    act(() => input.focus());
    changeInput(input, '-30');
    expect(slider.value).toBe('-30');
    key('Enter', input);
    expect(session().history.map((entry) => entry.kind)).toEqual(['blacks']);
    pointer('pointerover', slider);
    key('ArrowUp');
    expect(session().recipe.adjustments.blacks).toBe(-20);
    expect(input.value).toBe('-20');
    expect(session().history).toHaveLength(1);
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS));
    expect(session().history.map((entry) => entry.kind)).toEqual(['blacks', 'blacks']);
    act(() => reset.click());
    expect(session().recipe.adjustments.blacks).toBe(0);
    expect(input.value).toBe('0');
    expect(reset.disabled).toBe(true);
    key('z', window, { ctrlKey: true });
    expect(session().recipe.adjustments.blacks).toBe(-20);
    key('y', window, { ctrlKey: true });
    expect(session().recipe.adjustments.blacks).toBe(0);
  });
  it('disables every adjustment control while Basic is bypassed and restores retained values', () => {
    act(() => number().focus());
    changeNumber('0.5');
    key('Enter', number());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Disable Basic"]')!.click());
    expect(session().recipe.basicEnabled).toBe(false);
    expect(session().recipe.adjustments.exposure).toBe(0.5);
    expect(Array.from(host.querySelectorAll<HTMLInputElement>('input[type="range"], input[type="number"]')).every((input) => input.disabled)).toBe(true);
    expect(Array.from(host.querySelectorAll<HTMLButtonElement>('.adjustment-reset')).every((button) => button.disabled)).toBe(true);
    pointer('pointerover');
    expect(key('ArrowUp').defaultPrevented).toBe(false);
    expect(session().recipe.adjustments.exposure).toBe(0.5);
    key('z', window, { ctrlKey: true });
    expect(session().recipe.basicEnabled).toBe(true);
    expect(number().value).toBe('0.50');
    key('y', window, { ctrlKey: true });
    expect(session().recipe.basicEnabled).toBe(false);
  });
  it('resets all Basic controls as one operation and restores them together with Undo', () => {
    act(() => number().focus());
    changeNumber('0.5');
    key('Enter', number());
    act(() => contrastNumber().focus());
    changeInput(contrastNumber(), '20');
    key('Enter', contrastNumber());
    act(() => host.querySelector<HTMLButtonElement>('.adjustment-category-reset')!.click());
    expect(session().recipe.adjustments).toEqual({ exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0 });
    expect(session().history.at(-1)?.kind).toBe('basicReset');
    expect(session().history).toHaveLength(3);
    key('z', window, { ctrlKey: true });
    expect(session().recipe.adjustments.exposure).toBe(0.5);
    expect(session().recipe.adjustments.contrast).toBe(20);
  });
  it('keeps rapid alternating edits across all sliders as correctly typed History entries', () => {
    pointer('pointerover');
    key('ArrowRight');
    pointer('pointerout');
    pointer('pointerover', contrastRange());
    key('ArrowRight');
    pointer('pointerout', contrastRange());
    pointer('pointerover', highlightsRange());
    key('ArrowLeft');
    pointer('pointerout', highlightsRange());
    pointer('pointerover', whitesRange());
    key('ArrowRight');
    pointer('pointerout', whitesRange());
    pointer('pointerover', shadowsRange());
    key('ArrowRight');
    pointer('pointerout', shadowsRange());
    pointer('pointerover', blacksRange());
    key('ArrowLeft');
    expect(session().history.map((entry) => entry.kind)).toEqual(['exposure', 'contrast', 'highlights', 'whites', 'shadows']);
    expect(session().pending?.kind).toBe('blacks');
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS));
    expect(session().history.map((entry) => entry.kind)).toEqual(['exposure', 'contrast', 'highlights', 'whites', 'shadows', 'blacks']);
    expect(session().recipe.adjustments).toEqual({ exposure: 0.01, contrast: 1, highlights: -1, whites: 1, shadows: 1, blacks: -1 });
  });
  it('does not commit keyboard input on keyup, pointer leave, or focus departure', () => {
    pointer('pointerover');
    key('ArrowRight');
    key('ArrowRight', window, {}, 'keyup');
    pointer('pointerout');
    act(() => range().focus());
    act(() => host.querySelector('button')!.focus());
    expect(session().recipe.adjustments.exposure).toBe(0.01);
    expect(session().history).toHaveLength(0);
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS));
    expect(session().history).toHaveLength(1);
  });
  it('keeps a pointer gesture open across initial focus and a long pause', () => {
    pointer('pointerdown');
    act(() => range().focus());
    change('0.1');
    act(() => vi.advanceTimersByTime(1000));
    expect(session().history).toHaveLength(0);
    change('0.3');
    pointer('pointerup', window);
    expect(session().history).toHaveLength(1);
    expect(session().history[0].before.adjustments.exposure).toBe(0);
    expect(session().history[0].after.adjustments.exposure).toBe(0.3);
  });
  it('merges a pointer gesture started during keyboard debounce into one edit', () => {
    pointer('pointerover');
    key('ArrowRight');
    pointer('pointerdown');
    change('0.3');
    expect(session().history).toHaveLength(0);
    pointer('pointerup', window);
    expect(session().history).toHaveLength(1);
    expect(session().history[0].before.adjustments.exposure).toBe(0);
    expect(session().history[0].after.adjustments.exposure).toBe(0.3);
  });
  it.each(['input[type="text"]', 'textarea', 'select', '[contenteditable]'])('preserves native shortcuts in %s while hovered', (selector) => {
    pointer('pointerover');
    key('ArrowUp');
    const target = host.querySelector<HTMLElement>(selector)!;
    act(() => target.focus());
    for (const init of [{ key: 'ArrowRight' }, { key: 'z', ctrlKey: true }, { key: 'z', ctrlKey: true, shiftKey: true }, { key: 'y', ctrlKey: true }]) {
      expect(key(init.key, target, init).defaultPrevented).toBe(false);
    }
    expect(session().recipe.adjustments.exposure).toBe(0.1);
  });
  it('supports focused sliders and commits only after keyboard inactivity', () => {
    act(() => range().focus());
    key('ArrowUp', range());
    expect(session().recipe.adjustments.exposure).toBe(0.1);
    act(() => host.querySelector('button')!.focus());
    expect(session().history).toHaveLength(0);
    act(() => vi.advanceTimersByTime(ADJUSTMENT_COMMIT_DELAY_MS));
    expect(session().history).toHaveLength(1);
  });
  it('does not intercept keys for hidden controls, other focused ranges, or IME', () => {
    pointer('pointerover');
    const other = document.createElement('input'); other.type = 'range'; host.append(other);
    expect(key('ArrowUp', other).defaultPrevented).toBe(false);
    expect(key('ArrowUp', window, { isComposing: true }).defaultPrevented).toBe(false);
    host.hidden = true;
    expect(key('ArrowUp').defaultPrevented).toBe(false);
    expect(session().recipe.adjustments.exposure).toBe(0);
  });
  it('commits pending edits to the old asset when switching, and restores its history', () => {
    pointer('pointerover'); key('ArrowUp');
    act(() => root.render(<Harness assetId="b" />));
    expect(session().recipe.adjustments.exposure).toBe(0);
    act(() => vi.advanceTimersByTime(500));
    expect(session().history).toHaveLength(0);
    act(() => root.render(<Harness assetId="a" />));
    expect(session().recipe.adjustments.exposure).toBe(0.1);
    expect(session().history).toHaveLength(1);
  });
});
